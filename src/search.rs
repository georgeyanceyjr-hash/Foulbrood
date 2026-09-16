//! First search milestone: deterministic iterative deepening and alpha-beta.
//! Evaluation weights are starting hypotheses, not tournament-tuned values.
use crate::{Board, Bug, Color, HiveMove, Piece};
use std::time::{Duration, Instant};

const WIN: i32 = 100_000;
const MAX_DEPTH: u8 = 64;

#[derive(Clone, Copy, Debug)]
pub enum SearchLimit {
    Depth(u8),
    Time(Duration),
}

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub best_move: Option<HiveMove>,
    /// Score from the root side's perspective; None means only a fallback exists.
    pub score: Option<i32>,
    pub completed_depth: u8,
    pub nodes: u64,
    pub elapsed: Duration,
}

use crate::position::Position;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Bound { Exact, Lower, Upper }
#[derive(Clone, Copy)]
struct Entry { key: u64, position: Position, depth: u8, score: i32, bound: Bound, best_move: Option<HiveMove> }

fn store_score(score: i32, ply: u8) -> i32 {
    if score >= WIN - i32::from(MAX_DEPTH) { score + i32::from(ply) }
    else if score <= -WIN + i32::from(MAX_DEPTH) { score - i32::from(ply) }
    else { score }
}
fn load_score(score: i32, ply: u8) -> i32 {
    if score >= WIN - i32::from(MAX_DEPTH) { score - i32::from(ply) }
    else if score <= -WIN + i32::from(MAX_DEPTH) { score + i32::from(ply) }
    else { score }
}

struct Search {
    history: Option<Vec<Position>>,
    table: Vec<Option<Entry>>,
    killers: [[Option<HiveMove>; 2]; 65],
    deadline: Option<Instant>,
    nodes: u64,
    #[cfg(test)]
    node_limit: Option<u64>,
}

impl Search {
    fn expired(&self) -> bool {
        #[cfg(test)]
        if self.node_limit.is_some_and(|n| self.nodes >= n) { return true; }
        self.deadline.is_some_and(|d| Instant::now() >= d)
    }

    // Score child positions from the mover's perspective. Sorting changes only
    // exploration order, never evaluation, legality or alpha-beta bounds.
    fn order_moves(&self, board: &mut Board, moves: &mut [HiveMove], ply: u8)
        -> Result<(), ()>
    {
        let parent_queens = Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1)));
        let parent_total = piece_total_q(board,&parent_queens);
        let parent_counts = queen_counts(board);
        let mut ranked = Vec::with_capacity(moves.len());
        for &mv in moves.iter() {
            if self.expired() { return Err(()); }
            let score = if let Some(score) = projected_ranking_score(board,mv,ply+1,&parent_queens,parent_counts,parent_total) {
                score
            } else {
                let undo = board.make_generated(mv);
                let score = -terminal(board, ply+1).unwrap_or_else(|| evaluate(board));
                board.undo_generated(undo);
                score
            };
            ranked.push((score, mv));
        }
        ranked.sort_by_key(|&(score, _)| std::cmp::Reverse(score));
        for (slot, (_, mv)) in moves.iter_mut().zip(ranked) { *slot = mv; }
        Ok(())
    }

    #[cfg(test)]
    fn negamax(&mut self, board: &mut Board, depth: u8, ply: u8,
               alpha: i32, beta: i32) -> Result<i32, ()> {
        let total = piece_total(board);
        self.negamax_parts(board, depth, ply, alpha, beta, total, queen_counts(board), None)
    }
    fn negamax_parts(&mut self, board: &mut Board, depth: u8, ply: u8,
               alpha: i32, beta: i32, total: i32, counts: [u8;2], played: Option<HiveMove>) -> Result<i32, ()> {
        if self.expired() { return Err(()); }
        // A placement strictly reduces reserve inventory. No earlier position
        // on this path can match it. At a leaf there are no descendants or TT
        // probes needing a history entry, so avoid constructing/copying one.
        if depth==0 && (matches!(played,Some(HiveMove::Place{..})) || (played.is_some() && self.history.as_ref().is_some_and(|h| {
            // Three occurrences of the same side require at least four plies
            // with unchanged inventory. Any recent placement rules that out.
            h.last().is_some_and(|p| ((p.state^h[h.len().saturating_sub(4)].state)&((1<<28)-1))!=0)
        }))) {
            return self.negamax_inner(board,depth,ply,alpha,beta,total,counts);
        }
        let repeated = if let Some(history) = self.history.as_mut() {
            let position = match (history.last(), played) {
                (Some(parent), Some(mv)) => parent.after(board, mv),
                _ => Position::new(board),
            };
            // Reserve inventory only decreases on a legal path. Earlier entries
            // beyond the last placement cannot repeat this position.
            let repeated = history.iter().rev().take_while(|p| ((p.state ^ position.state) & ((1_u64 << 28)-1)) == 0)
                .filter(|p| position.same_repetition(p,board)).take(2).count() == 2;
            history.push(position);
            repeated
        } else { false };
        let result = if repeated {
            self.nodes += 1;
            Ok(counted_terminal(board, ply, counts).unwrap_or(0))
        } else {
            self.negamax_inner(board, depth, ply, alpha, beta, total, counts)
        };
        // Pop even when the subtree exits through an error or cutoff.
        if let Some(history) = self.history.as_mut() { history.pop(); }
        result
    }
    fn negamax_inner(&mut self, board: &mut Board, depth: u8, ply: u8,
               mut alpha: i32, beta: i32, total: i32, counts: [u8;2]) -> Result<i32, ()> {
        // The sole caller, negamax_parts, checks expiry before history bookkeeping.
        // Subsequent move-loop checks still bound longer work in this node.
        self.nodes += 1;
        debug_assert_eq!(evaluate_parts(board, total), evaluate(board));
        debug_assert_eq!(counts, queen_counts(board));
        if depth == 0 { return Ok(evaluate_counted_leaf(board,total,ply,counts)); }
        if let Some(score) = counted_terminal(board, ply, counts) { return Ok(score); }
        let original_alpha = alpha;
        let mut hint = None;
        // Require the same horizon for score reuse, preserving exact fixed-depth
        // semantics across transpositions reached at different plies.
        let cached = if depth >= 2 && !self.table.is_empty() {
            let position = self.history.as_ref().and_then(|h| h.last()).copied().unwrap_or_else(|| Position::new(board));
            let key = position.key();
            let slot = key as usize & (self.table.len() - 1);
            if let Some(entry) = self.table[slot] {
                if entry.key == key && entry.position == position {
                    hint = entry.best_move;
                    let value = load_score(entry.score, ply);
                    // Board identity alone cannot validate a history-dependent score.
                    // Keep the legal move hint, but require a future exact history context
                    // before enabling score reuse in repetition-aware searches.
                    if self.history.is_none() && entry.depth == depth && (entry.bound == Bound::Exact
                        || (entry.bound == Bound::Lower && value >= beta)
                        || (entry.bound == Bound::Upper && value <= alpha)) {
                        return Ok(value);
                    }
                }
            }
            Some((key, slot, position))
        } else { None };
        // Validate each remembered move before paying for the full move list.
        // Capture the priority once; unsupported move kinds use the full oracle.
        let mut preferred = [hint, self.killers[ply as usize][0], self.killers[ply as usize][1]].into_iter();
        let mut tried = [None; 3];
        let mut tried_len = 0;
        let mut moves: Option<Vec<HiveMove>> = None;
        let mut remainder_ready = false;
        let mut index = 0;
        let queens = Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1)));
        let mut best_move = None;
        let mut best_score = -WIN - 1;
        loop {
            let mv = if let Some(candidate) = preferred.next() {
                let Some(mv) = candidate else { continue; };
                if tried[..tried_len].contains(&Some(mv)) { continue; }
                // Empty/duplicate hint slots do no board work; check before validation.
                if self.expired() { return Err(()); }
                let legal = if let Some(all) = moves.as_ref() { all.contains(&mv) }
                    else { match board.is_legal_search_hint(mv) {
                        Some(legal) => legal,
                        None => moves.get_or_insert_with(|| board.legal_moves()).contains(&mv),
                    }};
                if !legal { continue; }
                tried[tried_len] = Some(mv);
                tried_len += 1;
                mv
            } else {
                if self.expired() { return Err(()); }
                let remaining = moves.get_or_insert_with(|| board.legal_moves());
                if !remainder_ready {
                    // Removing the prefix preserves the generator's stable order.
                    remaining.retain(|mv| !tried[..tried_len].contains(&Some(*mv)));
                    if depth >= 2 { self.order_moves(board, remaining, ply)?; }
                    remainder_ready = true;
                }
                let Some(mv) = remaining.get(index).copied() else { break; };
                index += 1;
                mv
            };
            // Child entry checks the deadline after the bounded make/update work.
            // Its error path still undoes this move before returning.
            let delta = piece_move_delta(board,mv,&queens);
            let next_counts = projected_queen_counts(board,mv,&queens,counts);
            let undo = board.make_generated(mv);
            let child_counts = next_counts.unwrap_or_else(|| queen_counts(board));
            let child_total = if queen_moved(mv) {piece_total(board)} else {total+delta};
            let child = self.negamax_parts(board, depth - 1, ply + 1, -beta, -alpha, child_total, child_counts, Some(mv));
            // Always restore, including an interrupted subtree.
            board.undo_generated(undo);
            let score = -child?;
            if score > best_score { best_score = score; best_move = Some(mv); }
            if score >= beta {
                let killers = &mut self.killers[ply as usize];
                if killers[0] != Some(mv) { killers[1] = killers[0]; killers[0] = Some(mv); }
                if let Some((key, slot, position)) = cached {
                    self.table[slot] = Some(Entry { key, position, depth,
                        score: store_score(score, ply), bound: Bound::Lower, best_move: Some(mv) });
                }
                return Ok(score);
            }
            alpha = alpha.max(score);
        }
        if let Some((key, slot, position)) = cached {
            self.table[slot] = Some(Entry { key, position, depth, score: store_score(alpha, ply),
                bound: if alpha <= original_alpha { Bound::Upper } else { Bound::Exact }, best_move });
        }
        Ok(alpha)
    }
}

/// Search a private clone, treating this board as the start of known history.
/// Use UhpGame::search when the played history is available.
/// A legal fallback is retained even when no iteration fits the budget.
/// Deadline checks are cooperative, with a 5% (at most 10ms) output reserve;
/// operating-system scheduling and one move generation can still cause overshoot.
/// Unrepresentable deadlines return the fallback rather than searching unbounded.
pub fn search(board: &Board, limit: SearchLimit) -> SearchResult {
    // Board-only callers have no preceding game history. UHP callers use UhpGame::search.
    search_with_history(board, limit, &[Position::new(board)])
}

pub(crate) fn search_with_history(board: &Board, limit: SearchLimit, history: &[Position]) -> SearchResult {
    search_with_progress(board, limit, history, |_| {})
}

pub(crate) fn search_with_progress(board: &Board, limit: SearchLimit, history: &[Position], mut progress: impl FnMut(&SearchResult)) -> SearchResult {
    let start = Instant::now();
    let (depth_limit, deadline) = match limit {
        SearchLimit::Depth(d) => (d.min(MAX_DEPTH), None),
        SearchLimit::Time(t) => {
            let reserve = (t / 20).min(Duration::from_millis(10));
            (MAX_DEPTH, Some(start.checked_add(t.saturating_sub(reserve)).unwrap_or(start)))
        }
    };
    let mut worker = Search { history: Some(history.to_vec()), killers: [[None; 2]; 65], table: vec![None; 16384], deadline, nodes: 0, #[cfg(test)] node_limit: None };
    let mut result = SearchResult { best_move: None, score: terminal(board, 0),
        completed_depth: 0, nodes: 0, elapsed: Duration::ZERO };
    let root_position = Position::new(board);
    if result.score.is_none() && history.iter().filter(|p| root_position.same_repetition(p,board)).take(3).count() == 3 {
        result.score = Some(0);
    }
    if result.score.is_none() {
        let mut moves = board.legal_moves();
        result.best_move = moves.first().copied();
        let mut position = board.clone();
        let root_queens = Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1)));
        let root_total = piece_total_q(board,&root_queens);
        let root_counts = queen_counts(board);
        for depth in 1..=depth_limit {
            if worker.expired() { break; }
            // Rank the root once; later depths reuse it with the completed PV first.
            if depth == 2 && worker.order_moves(&mut position, &mut moves, 0).is_err() {
                break;
            }
            // Previous completed iteration's winner is searched first.
            if let Some(i) = moves.iter().position(|m| Some(*m) == result.best_move) {
                moves.swap(0, i);
            }
            let mut best = None;
            let mut alpha = -WIN - 1;
            let mut complete = true;
            for &mv in &moves {
                if worker.expired() { complete = false; break; }
                let delta = piece_move_delta(&position,mv,&root_queens);
                let next_counts = projected_queen_counts(&position,mv,&root_queens,root_counts);
                let undo = position.make_generated(mv);
                let child_counts = next_counts.unwrap_or_else(|| queen_counts(&position));
                let child_total = if queen_moved(mv) {piece_total(&position)} else {root_total+delta};
                let child = worker.negamax_parts(&mut position, depth - 1, 1, -WIN - 1, -alpha, child_total, child_counts, Some(mv));
                position.undo_generated(undo);
                match child {
                    Ok(value) => {
                        let score = -value;
                        if score > alpha { alpha = score; best = Some(mv); }
                    }
                    Err(()) => { complete = false; break; }
                }
            }
            if !complete { break; }
            result.best_move = best.or(result.best_move);
            result.score = Some(alpha);
            result.completed_depth = depth;
            result.nodes = worker.nodes;
            result.elapsed = start.elapsed();
            progress(&result);
            if alpha.abs() >= WIN - i32::from(MAX_DEPTH) { break; }
        }
    }
    result.nodes = worker.nodes;
    result.elapsed = start.elapsed();
    result
}

fn terminal(board: &Board, ply: u8) -> Option<i32> {
    let side = board.side_to_move();
    match (board.queen_surrounded(side), board.queen_surrounded(side.other())) {
        (true, true) => Some(0),
        (true, false) => Some(-WIN + i32::from(ply)),
        (false, true) => Some(WIN - i32::from(ply)),
        _ => None,
    }
}


fn stack_value(board: &Board, hex: crate::Hex, stack: &[Piece], queens: &[Option<crate::Hex>; 2]) -> i32 {
    let mut total = 0;
    for (level, &piece) in stack.iter().enumerate() {
        if !board.game_type().includes(piece.bug) { continue; }
        let mut score = 12 - if level + 1 < stack.len() { 15 } else { 0 };
        if piece.bug != Bug::Queen {
            if let Some(q) = queens[piece.color.other().index()] {
                score += 3 * (6 - i32::from(hex.distance(q)).min(6));
            }
        }
        total += if piece.color == Color::White { score } else { -score };
    }
    total
}
fn piece_total_q(board: &Board, queens: &[Option<crate::Hex>; 2]) -> i32 {
    board.occupied_stacks().map(|(hex, stack)| stack_value(board, hex, stack, queens)).sum()
}
fn piece_total(board: &Board) -> i32 {
    piece_total_q(board, &Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1))))
}
// Rank non-Queen children without mutating the board. Search still makes the
// selected move normally; Queen movement retains the reference ranking path.
fn projected_ranking_score(board:&Board,mv:HiveMove,ply:u8,queens:&[Option<crate::Hex>;2],parent_counts:[u8;2],total:i32)->Option<i32> {
    let counts=projected_queen_counts(board,mv,queens,parent_counts)?;
    let side=board.side_to_move();
    match (counts[side.index()]==6,counts[side.other().index()]==6) {
        (true,true)=>return Some(0),
        (true,false)=>return Some(-WIN+i32::from(ply)),
        (false,true)=>return Some(WIN-i32::from(ply)),
        _=>{},
    }
    let (from,to)=match mv {
        HiveMove::Place{to,..}=>(None,Some(to)),
        HiveMove::Move{from,to,..}|HiveMove::Pillbug{from,to,..}=>(Some(from),Some(to)),
        HiveMove::Pass=>(None,None),
    };
    let mut white=total+piece_move_delta(board,mv,queens);
    for color in Color::ALL {
        let Some(hex)=queens[color.index()] else {continue};
        let queen=Piece::new(color,Bug::Queen,1);
        let covered=if to==Some(hex) {true} else if from==Some(hex) {
            let stack=board.stack(hex).expect("queen source missing");
            stack.get(stack.len().saturating_sub(2)).copied()!=Some(queen)
        } else {board.top(hex)!=Some(queen)};
        let penalty=[0,20,55,110,220,450,0][usize::from(counts[color.index()])]+if covered {80} else {0};
        white+=if color==Color::White {-penalty} else {penalty};
    }
    Some(if side==Color::White {white} else {-white})
}

// Exact white-perspective piece-score change for a generated move. Queen
// movement changes every enemy distance term and keeps the full-recompute path.
fn piece_move_delta(board: &Board, mv: HiveMove, queens: &[Option<crate::Hex>; 2]) -> i32 {
    let (piece, from, to) = match mv {
        HiveMove::Place {piece,to} => (piece,None,to),
        HiveMove::Move {piece,from,to} | HiveMove::Pillbug {piece,from,to,..} => (piece,Some(from),to),
        HiveMove::Pass => return 0,
    };
    if piece.bug == Bug::Queen || from == Some(to) { return 0; }
    let sign = |p:Piece| if p.color == Color::White {1} else {-1};
    let mut delta = 0;
    if board.game_type().includes(piece.bug) {
        let proximity = |h:crate::Hex| queens[piece.color.other().index()]
            .map_or(0, |q| 3 * (6 - i32::from(h.distance(q)).min(6)));
        delta = sign(piece) * (proximity(to) - from.map_or(-12, proximity));
    }
    if let Some(from) = from {
        let stack = board.stack(from).expect("generated source missing");
        if stack.len() >= 2 {
            let uncovered = stack[stack.len()-2];
            if board.game_type().includes(uncovered.bug) { delta += 15 * sign(uncovered); }
        }
    }
    if let Some(covered) = board.top(to) {
        if board.game_type().includes(covered.bug) { delta -= 15 * sign(covered); }
    }
    delta
}
#[cfg(test)]
fn changed_cells(mv: HiveMove) -> [Option<crate::Hex>; 2] {
    match mv {
        HiveMove::Place {to,..} => [Some(to),None],
        HiveMove::Move {from,to,..} | HiveMove::Pillbug {from,to,..} => [Some(from), if from != to {Some(to)} else {None}],
        HiveMove::Pass => [None,None],
    }
}
#[cfg(test)]
fn changed_total_q(board: &Board, mv: HiveMove, queens: &[Option<crate::Hex>; 2]) -> i32 {
    changed_cells(mv).into_iter().flatten().map(|h| stack_value(board,h,board.stack(h).unwrap_or(&[]),queens)).sum()
}
#[cfg(test)]
fn changed_total(board: &Board, mv: HiveMove) -> i32 {
    changed_total_q(board,mv,&Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1))))
}
fn queen_moved(mv: HiveMove) -> bool {
    match mv { HiveMove::Place{piece,..} | HiveMove::Move{piece,..} | HiveMove::Pillbug{piece,..} => piece.bug == Bug::Queen, HiveMove::Pass => false }
}
// Terminal detection and static Queen safety share the same ring counts.
#[cfg(test)]
fn evaluate_leaf(board: &Board, total: i32, ply: u8) -> i32 {
    let mut white=total;
    let mut surrounded=[false;2];
    for color in Color::ALL {
        let queen=Piece::new(color,Bug::Queen,1);
        if let Some(hex)=board.location(queen) {
            let occupied=hex.neighbors().iter().filter(|&&h|board.is_occupied(h)).count();
            surrounded[color.index()]=occupied==6;
            let penalty=[0,20,55,110,220,450,0][occupied]
                + if board.top(hex)!=Some(queen) {80} else {0};
            white+=if color==Color::White {-penalty} else {penalty};
        }
    }
    let side=board.side_to_move();
    match (surrounded[side.index()],surrounded[side.other().index()]) {
        (true,true)=>0,
        (true,false)=>-WIN+i32::from(ply),
        (false,true)=>WIN-i32::from(ply),
        _=>if side==Color::White {white} else {-white},
    }
}


fn queen_counts(board: &Board) -> [u8;2] {
    Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1)).map_or(0, |h|
        h.neighbors().iter().filter(|&&n| board.is_occupied(n)).count() as u8))
}
fn projected_queen_counts(board: &Board, mv: HiveMove, queens: &[Option<crate::Hex>;2], mut counts: [u8;2]) -> Option<[u8;2]> {
    if queen_moved(mv) { return None; }
    let (from,to) = match mv {
        HiveMove::Place{to,..} => (None,Some(to)),
        HiveMove::Move{from,to,..} | HiveMove::Pillbug{from,to,..} => (Some(from),Some(to)),
        HiveMove::Pass => return Some(counts),
    };
    let removed = from.filter(|&h| board.stack_height(h)==1);
    let added = to.filter(|&h| !board.is_occupied(h));
    for (i,queen) in queens.iter().enumerate() {
        let Some(q)=queen else {continue};
        let adjacent=|h:crate::Hex| matches!((i32::from(h.q)-i32::from(q.q),i32::from(h.r)-i32::from(q.r)),(1,0)|(1,-1)|(0,-1)|(-1,0)|(-1,1)|(0,1));
        if removed.is_some_and(adjacent) {counts[i]-=1;}
        if added.is_some_and(adjacent) {counts[i]+=1;}
    }
    Some(counts)
}
fn counted_terminal(board:&Board,ply:u8,counts:[u8;2])->Option<i32> {
    let side=board.side_to_move();
    match (counts[side.index()]==6,counts[side.other().index()]==6) {
        (true,true)=>Some(0), (true,false)=>Some(-WIN+i32::from(ply)),
        (false,true)=>Some(WIN-i32::from(ply)), _=>None,
    }
}
fn evaluate_counted_leaf(board: &Board, total: i32, ply: u8, counts: [u8;2]) -> i32 {
    let mut white=total;
    let mut surrounded=[false;2];
    for color in Color::ALL {
        let queen=Piece::new(color,Bug::Queen,1);
        if let Some(hex)=board.location(queen) {
            let occupied=usize::from(counts[color.index()]);
            surrounded[color.index()]=occupied==6;
            let penalty=[0,20,55,110,220,450,0][occupied]
                + if board.top(hex)!=Some(queen) {80} else {0};
            white+=if color==Color::White {-penalty} else {penalty};
        }
    }
    let side=board.side_to_move();
    match (surrounded[side.index()],surrounded[side.other().index()]) {
        (true,true)=>0,
        (true,false)=>-WIN+i32::from(ply),
        (false,true)=>WIN-i32::from(ply),
        _=>if side==Color::White {white} else {-white},
    }
}

fn evaluate_parts(board: &Board, total: i32) -> i32 {
    let mut white = total;
    for color in Color::ALL {
        if let Some(hex) = board.location(Piece::new(color,Bug::Queen,1)) {
            let occupied = hex.neighbors().iter().filter(|&&h| board.is_occupied(h)).count();
            let penalty = [0,20,55,110,220,450,0][occupied]
                + if board.top(hex) != Some(Piece::new(color,Bug::Queen,1)) {80} else {0};
            white += if color == Color::White {-penalty} else {penalty};
        }
    }
    if board.side_to_move()==Color::White {white} else {-white}
}

fn evaluate(board: &Board) -> i32 {
    let queens = Color::ALL.map(|color| board.location(Piece::new(color, Bug::Queen, 1)));
    let mut scores = [0_i32; 2];
    for color in Color::ALL {
        if let Some(hex) = queens[color.index()] {
            let occupied = hex.neighbors().iter().filter(|&&h| board.is_occupied(h)).count();
            scores[color.index()] -= [0, 20, 55, 110, 220, 450, 0][occupied];
            if board.top(hex) != Some(Piece::new(color, Bug::Queen, 1)) {
                scores[color.index()] -= 80;
            }
        }
    }
    for (hex, stack) in board.occupied_stacks() {
        for (level, &piece) in stack.iter().enumerate() {
            if !board.game_type().includes(piece.bug) { continue; }
            let score = &mut scores[piece.color.index()];
            *score += 12;
            if level + 1 < stack.len() { *score -= 15; }
            if piece.bug != Bug::Queen {
                if let Some(target) = queens[piece.color.other().index()] {
                    *score += 3 * (6 - i32::from(hex.distance(target)).min(6));
                }
            }
        }
    }
    scores[board.side_to_move().index()] - scores[board.side_to_move().other().index()]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn carried_queen_counts_match_full_recount() {
        let mut checked=0;
        for line in include_str!("../tests/search_positions.txt").lines().filter(|x| !x.is_empty()) {
            let game=crate::UhpGame::from_game_string(line).unwrap();
            let mut board=game.board().clone();
            for _ in 0..12 {
                let queens=Color::ALL.map(|c|board.location(Piece::new(c,Bug::Queen,1)));
                let counts=queen_counts(&board);
                let moves=board.legal_moves();
                if moves.is_empty() {break;}
                for &mv in &moves {
                    let before=Position::new(&board);
                    let next=projected_queen_counts(&board,mv,&queens,counts);
                    let undo=board.make_generated(mv);
                    let child=next.unwrap_or_else(||queen_counts(&board));
                    assert_eq!(child,queen_counts(&board));
                    for ply in [0,3,64] {
                        assert_eq!(counted_terminal(&board,ply,child),terminal(&board,ply));
                        assert_eq!(evaluate_counted_leaf(&board,piece_total(&board),ply,child),evaluate_leaf(&board,piece_total(&board),ply));
                    }
                    board.undo_generated(undo);
                    assert_eq!(Position::new(&board),before);
                    assert_eq!(queen_counts(&board),counts);
                    checked+=1;
                }
                board.make_generated(moves[checked % moves.len()]);
            }
        }
        assert!(checked>1000,"{checked}");
    }

    use crate::GameType;

    // Frozen eager-ranking reference from v0.10.4. It deliberately retains
    // full ranking before hint selection to verify scheduling equivalence.
    fn eager_negamax(worker: &mut Search, board: &mut Board, depth: u8, ply: u8,
               mut alpha: i32, beta: i32) -> Result<i32, ()> {
        if worker.expired() { return Err(()); }
        worker.nodes += 1;
        if let Some(score) = terminal(board, ply) { return Ok(score); }
        if depth == 0 { return Ok(evaluate(board)); }
        let original_alpha = alpha;
        let mut hint = None;
        // Require the same horizon for score reuse, preserving exact fixed-depth
        // semantics across transpositions reached at different plies.
        let cached = if depth >= 2 && !worker.table.is_empty() {
            let position = Position::new(board);
            let key = position.key();
            let slot = key as usize & (worker.table.len() - 1);
            if let Some(entry) = worker.table[slot] {
                if entry.key == key && entry.position == position {
                    hint = entry.best_move;
                    let value = load_score(entry.score, ply);
                    if entry.depth == depth && (entry.bound == Bound::Exact
                        || (entry.bound == Bound::Lower && value >= beta)
                        || (entry.bound == Bound::Upper && value <= alpha)) {
                        return Ok(value);
                    }
                }
            }
            Some((key, slot, position))
        } else { None };
        let mut moves = board.legal_moves();
        if depth >= 2 { worker.order_moves(board, &mut moves, ply)?; }
        // Reuse sibling cutoff moves only if present in this node's legal list.
        // Keep remaining static order stable and prefer the position-specific hint.
        let mut front = 0;
        for preferred in [hint, worker.killers[ply as usize][0], worker.killers[ply as usize][1]] {
            if let Some(mv) = preferred {
                if moves[..front].contains(&mv) { continue; }
                if let Some(offset) = moves[front..].iter().position(|m| *m == mv) {
                    moves[front..=front + offset].rotate_right(1);
                    front += 1;
                }
            }
        }
        let mut best_move = None;
        let mut best_score = -WIN - 1;
        for mv in moves {
            if worker.expired() { return Err(()); }
            let undo = board.make_generated(mv);
            let child = eager_negamax(worker, board, depth - 1, ply + 1, -beta, -alpha);
            // Always restore, including an interrupted subtree.
            board.undo_generated(undo);
            let score = -child?;
            if score > best_score { best_score = score; best_move = Some(mv); }
            if score >= beta {
                let killers = &mut worker.killers[ply as usize];
                if killers[0] != Some(mv) { killers[1] = killers[0]; killers[0] = Some(mv); }
                if let Some((key, slot, position)) = cached {
                    worker.table[slot] = Some(Entry { key, position, depth,
                        score: store_score(score, ply), bound: Bound::Lower, best_move: Some(mv) });
                }
                return Ok(score);
            }
            alpha = alpha.max(score);
        }
        if let Some((key, slot, position)) = cached {
            worker.table[slot] = Some(Entry { key, position, depth, score: store_score(alpha, ply),
                bound: if alpha <= original_alpha { Bound::Upper } else { Bound::Exact }, best_move });
        }
        Ok(alpha)
    }

    #[test]
    fn deferred_ranking_matches_eager_tree_and_restores_on_interrupt() {
        for text in include_str!("../tests/search_positions.txt").lines() {
            let game = crate::UhpGame::from_game_string(text).unwrap();
            for slots in [0, 1, 16384] {
                let mut eager = Search { history: None, killers: [[None; 2]; 65], table: vec![None; slots], deadline: None, nodes: 0, node_limit: None };
                let mut deferred = Search { history: None, killers: [[None; 2]; 65], table: vec![None; slots], deadline: None, nodes: 0, node_limit: None };
                let mut a = game.board().clone();
                let mut b = a.clone();
                for depth in 1..=3 {
                    assert_eq!(eager_negamax(&mut eager, &mut a, depth, 0, -WIN-1, WIN+1),
                        deferred.negamax(&mut b, depth, 0, -WIN-1, WIN+1));
                    assert_eq!(eager.nodes, deferred.nodes);
                    assert_eq!(eager.killers, deferred.killers);
                    assert_eq!(Position::new(&a), Position::new(game.board()));
                    assert_eq!(Position::new(&b), Position::new(game.board()));
                }
                deferred.table.fill(None);
                deferred.node_limit = Some(deferred.nodes + 20);
                assert!(deferred.negamax(&mut b, 5, 0, -WIN-1, WIN+1).is_err());
                assert_eq!(Position::new(&b), Position::new(game.board()));
            }
        }
    }

    fn reference_evaluate(board: &Board) -> i32 {
        fn value(board: &Board, color: Color) -> i32 {
            let queen = Piece::new(color, Bug::Queen, 1);
            let mut score = 0;
            if let Some(hex) = board.location(queen) {
                let occupied = hex.neighbors().iter().filter(|&&h| board.is_occupied(h)).count();
                score -= [0, 20, 55, 110, 220, 450, 0][occupied];
                if board.top(hex) != Some(queen) { score -= 80; }
            }
            for piece in Piece::all_for(color, board.game_type()) {
                if let Some(hex) = board.location(piece) {
                    score += 12; // modest development preference
                    if board.top(hex) != Some(piece) { score -= 15; }
                    if piece.bug != Bug::Queen {
                        if let Some(target) = board.location(Piece::new(color.other(), Bug::Queen, 1)) {
                            score += 3 * (6 - i32::from(hex.distance(target)).min(6));
                        }
                    }
                }
            }
            score
        }
        value(board, board.side_to_move()) - value(board, board.side_to_move().other())
    }

    #[test]
    fn allocation_free_evaluation_matches_reference_across_variants() {
        let mut count = 0;
        let mut covered = false;
        let mut queen_in_hand = false;
        for flags in 0..8 {
            let game_type = GameType { mosquito: flags & 1 != 0,
                ladybug: flags & 2 != 0, pillbug: flags & 4 != 0 };
            for seed in 1..=8u64 {
                let mut random = seed * 0x9e3779b9 + flags;
                let mut board = Board::new(game_type);
                for _ in 0..100 {
                    assert_eq!(evaluate(&board), reference_evaluate(&board));
                    count += 1;
                    for color in Color::ALL {
                        queen_in_hand |= board.location(Piece::new(color, Bug::Queen, 1)).is_none();
                    }
                    covered |= board.occupied_hexes().any(|h| board.stack(h).unwrap().len() > 1);
                    let moves = board.legal_moves();
                    if moves.is_empty() { break; }
                    let before = Position::new(&board);
                    for &mv in moves.iter().step_by((moves.len()/4).max(1)) {
                        let parent = piece_total(&board);
                        let old = changed_total(&board,mv);
                        let predicted = projected_ranking_score(&board,mv,1,&Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1))),queen_counts(&board),parent);
                        let delta = piece_move_delta(&board,mv,&Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1))));
                        let undo = board.make_generated(mv);
                        let parts = if queen_moved(mv) {piece_total(&board)} else {parent-old+changed_total(&board,mv)};
                        assert_eq!(if queen_moved(mv) {piece_total(&board)} else {parent+delta}, piece_total(&board));
                        assert_eq!(evaluate_parts(&board,parts), reference_evaluate(&board));
                        if let Some(score)=predicted {assert_eq!(score,-terminal(&board,1).unwrap_or_else(|| reference_evaluate(&board)));}
                        assert_eq!(evaluate(&board), reference_evaluate(&board));
                        board.undo_generated(undo);
                        assert_eq!(Position::new(&board), before);
                    }
                    random ^= random << 13; random ^= random >> 7; random ^= random << 17;
                    board.make_generated(moves[random as usize % moves.len()]);
                }
            }
        }
        assert!(count > 3000 && covered && queen_in_hand);
    }

    #[test]
    fn stack_evaluation_matches_reference_on_translated_mixed_stacks() {
        for offset in [-12000_i16, 0, 12000] {
            let mut board = Board::new(GameType::mlp());
            let wq = Piece::new(Color::White, Bug::Queen, 1);
            let bq = Piece::new(Color::Black, Bug::Queen, 1);
            let wb = Piece::new(Color::White, Bug::Beetle, 1);
            let bb = Piece::new(Color::Black, Bug::Beetle, 1);
            let hex = |q| crate::Hex::new(offset + q, -offset);
            for (piece, q) in [(wq, 0), (bq, 1), (wb, -1), (bb, 2)] {
                board.make_unchecked(HiveMove::Place { piece, to: hex(q) }).unwrap();
                assert_eq!(evaluate(&board), reference_evaluate(&board));
            }
            for (piece, from) in [(wb, -1), (bb, 2)] {
                let mv = HiveMove::Move { piece, from: hex(from), to: hex(1) };
                let undo = board.make_unchecked(mv).unwrap();
                assert_eq!(evaluate(&board), reference_evaluate(&board));
                board.undo(undo).unwrap();
                assert_eq!(evaluate(&board), reference_evaluate(&board));
                board.make_unchecked(mv).unwrap();
            }
            assert_eq!(board.stack(hex(1)).unwrap().len(), 3);
            // Both sides, including leaving mixed stacks, must match a full total.
            for _ in 0..2 {
                let queens = Color::ALL.map(|c| board.location(Piece::new(c,Bug::Queen,1)));
                let parent = piece_total(&board);
                assert_eq!(piece_move_delta(&board,HiveMove::Pass,&queens),0);
                for mv in board.legal_moves() {
                    let delta = piece_move_delta(&board,mv,&queens);
                    let undo = board.make_generated(mv);
                    if !queen_moved(mv) { assert_eq!(parent+delta,piece_total(&board)); }
                    board.undo_generated(undo);
                }
                board.make_generated(HiveMove::Pass);
            }
        }
    }

    fn exhaustive(board: &mut Board, depth: u8, ply: u8) -> i32 {
        if let Some(s) = terminal(board, ply) { return s; }
        if depth == 0 { return evaluate(board); }
        board.legal_moves().into_iter().map(|mv| {
            let undo = board.make_generated(mv);
            let score = -exhaustive(board, depth - 1, ply + 1);
            board.undo_generated(undo);
            score
        }).max().unwrap()
    }

    #[test]
    fn alpha_beta_matches_exhaustive_and_preserves_board() {
        for game_type in [GameType::base(), GameType::mlp()] {
            let mut board = Board::new(game_type);
            for step in 0..7 {
                let before = format!("{board:?}");
                let expected = exhaustive(&mut board.clone(), 2, 0);
                let result = search(&board, SearchLimit::Depth(2));
                assert_eq!(result.score, Some(expected));
                let mv = result.best_move.unwrap();
                assert!(board.legal_moves().contains(&mv));
                let mut child = board.clone();
                child.make_generated(mv);
                assert_eq!(-exhaustive(&mut child, 1, 1), expected);
                assert_eq!(format!("{board:?}"), before);
                let moves = board.legal_moves();
                board.make_generated(moves[(step * 13) % moves.len()]);
            }
        }
    }

    #[test]
    fn full_mlp_midgames_match_exhaustive_minimax() {
        for text in include_str!("../tests/search_positions.txt").lines() {
            let game = crate::UhpGame::from_game_string(text).unwrap();
            let board = game.board();
            let expected = exhaustive(&mut board.clone(), 3, 0);
            let result = search(board, SearchLimit::Depth(3));
            assert_eq!(result.score, Some(expected));
            let mut child = board.clone();
            child.make_generated(result.best_move.unwrap());
            assert_eq!(-exhaustive(&mut child, 2, 1), expected);
        }
    }

    #[test]
    fn table_bounds_horizons_and_collisions_match_exhaustive() {
        let game = crate::UhpGame::from_game_string(include_str!("../tests/search_positions.txt").lines().next().unwrap()).unwrap();
        let mut board = game.board().clone();
        let expected = exhaustive(&mut board.clone(), 3, 0);
        for slots in [0, 1, 16384] {
            let mut worker = Search { history: None, killers: [[None; 2]; 65], table: vec![None; slots], deadline: None, nodes: 0, node_limit: None };
            for (a,b) in [(expected-2,expected-1),(expected+1,expected+2),(-WIN-1,WIN+1)] {
                let score = worker.negamax(&mut board, 3, 0, a, b).unwrap();
                if score <= a { assert!(expected <= score); }
                else if score >= b { assert!(expected >= score); }
                else { assert_eq!(score, expected); }
            }
            assert_eq!(worker.negamax(&mut board, 2, 0, -WIN-1, WIN+1).unwrap(), exhaustive(&mut board.clone(), 2, 0));
            if slots != 0 {
                let key = Position::new(&board).key();
                let mut wrong = Position::new(&board);
                wrong.pieces[0] ^= 1;
                worker.table[key as usize & (slots-1)] = Some(Entry {key, position:wrong, depth:3, score:12345, bound:Bound::Exact, best_move:None});
                assert_eq!(worker.negamax(&mut board, 3, 0, -WIN-1, WIN+1).unwrap(), expected);
            }
        }
    }

    #[test]
    fn stale_and_duplicate_cutoff_moves_preserve_minimax() {
        let game = crate::UhpGame::from_game_string(include_str!("../tests/search_positions.txt").lines().next().unwrap()).unwrap();
        let mut board = game.board().clone();
        let expected = exhaustive(&mut board.clone(), 2, 0);
        let legal = board.legal_moves()[0];
        let stale = HiveMove::Place { piece: Piece::new(Color::White, Bug::Queen, 1),
            to: crate::Hex::new(100, 100) };
        assert!(!board.legal_moves().contains(&stale));
        for hints in [[Some(stale), Some(legal)], [Some(legal), Some(legal)]] {
            let mut worker = Search { history: None, killers: [hints; 65], table: vec![], deadline: None, nodes: 0, node_limit: None };
            let before = Position::new(&board);
            assert_eq!(worker.negamax(&mut board, 2, 0, -WIN-1, WIN+1).unwrap(), expected);
            assert_eq!(Position::new(&board), before);
        }
    }

    #[test]
    fn table_mate_scores_are_relative_to_the_position() {
        for ply in 0..=32 {
            for score in [WIN-40, -WIN+40, -350, 0, 350] {
                assert_eq!(load_score(store_score(score, ply), ply), score);
            }
        }
        assert_eq!(load_score(store_score(WIN-7, 3), 5), WIN-9);
        assert_eq!(load_score(store_score(-WIN+7, 3), 5), -WIN+9);
    }

    #[test]
    fn last_moved_restriction_is_part_of_pillbug_identity() {
        for game_type in [GameType::base(), GameType::mlp()] {
            let mut board = Board::new(game_type);
            place(&mut board, Color::White, Bug::Queen, 1, 0, 0);
            place(&mut board, Color::Black, Bug::Queen, 1, -1, 0);
            place(&mut board, Color::White, Bug::Ant, 1, 1, 0);
            place(&mut board, Color::Black, Bug::Beetle, 1, -2, 0);
            for _ in 0..8 { board.make_unchecked(HiveMove::Pass).unwrap(); }
            board.make_unchecked(HiveMove::Move {piece:Piece::new(Color::White,Bug::Ant,1),
                from:crate::Hex::new(1,0),to:crate::Hex::new(1,-1)}).unwrap();
            let moved = Position::new(&board);
            board.make_unchecked(HiveMove::Pass).unwrap();
            board.make_unchecked(HiveMove::Pass).unwrap();
            let cleared = Position::new(&board);
            assert_eq!(moved.pieces, cleared.pieces);
            assert_eq!(moved == cleared, !game_type.pillbug);
        }
    }

    #[test]
    fn exact_position_tracks_rule_state_and_restores() {
        for game_type in [GameType::base(),GameType::mlp()] {
            let mut board = Board::new(game_type);
            let first = Position::new(&board);
            let undo = board.make_unchecked(HiveMove::Pass).unwrap();
            assert_ne!(first, Position::new(&board));
            board.undo(undo).unwrap();
            assert_eq!(first, Position::new(&board));
            for step in 0..20 {
                let before = Position::new(&board);
                let moves = board.legal_moves();
                for &mv in moves.iter().take(12) {
                    let undo = board.make_generated(mv);
                    assert_ne!(before, Position::new(&board));
                    board.undo_generated(undo);
                    assert_eq!(before, Position::new(&board));
                }
                board.make_generated(moves[(step*7)%moves.len()]);
            }
        }
    }

    fn place(board: &mut Board, color: Color, bug: Bug, number: u8, q: i16, r: i16) {
        if board.side_to_move() != color { board.make_unchecked(HiveMove::Pass).unwrap(); }
        board.make_unchecked(HiveMove::Place {
            piece: Piece::new(color, bug, number), to: crate::Hex::new(q, r),
        }).unwrap();
    }

    #[test]
    fn finds_immediate_surround_for_either_color_and_handles_forced_pass() {
        for side in Color::ALL {
            let mut board = Board::new(GameType::base());
            place(&mut board, side.other(), Bug::Queen, 1, 0, 0);
            place(&mut board, side, Bug::Queen, 1, -2, 0);
            for (bug, number, q, r) in [
                (Bug::Beetle, 1, 1, -1), (Bug::Spider, 1, 0, -1),
                (Bug::Spider, 2, -1, 0), (Bug::Grasshopper, 1, -1, 1),
                (Bug::Grasshopper, 2, 0, 1), (Bug::Ant, 1, 2, -1),
            ] { place(&mut board, side, bug, number, q, r); }
            if board.side_to_move() != side { board.make_unchecked(HiveMove::Pass).unwrap(); }
            let before = format!("{board:?}");
            let result = search(&board, SearchLimit::Depth(1));
            assert_eq!(result.score, Some(WIN - 1));
            assert_eq!(format!("{board:?}"), before);
            let mut won = board.clone();
            won.make_generated(result.best_move.unwrap());
            assert!(won.queen_surrounded(side.other()));
            let terminal = search(&won, SearchLimit::Depth(4));
            assert_eq!(terminal.best_move, None);
            assert_eq!(terminal.score, Some(-WIN));
            board.make_unchecked(HiveMove::Pass).unwrap();
            assert_eq!(board.legal_moves(), vec![HiveMove::Pass]);
            let forced = search(&board, SearchLimit::Depth(2));
            assert_eq!(forced.best_move, Some(HiveMove::Pass));
            assert_eq!(forced.score, Some(-WIN + 2));
            let mut worker = Search { history: None, killers: [[None; 2]; 65], table: vec![None; 64], deadline: None, nodes: 0, node_limit: None };
            assert_eq!(worker.negamax(&mut board, 2, 0, -WIN-1, WIN+1).unwrap(), -WIN+2);
            assert_eq!(worker.negamax(&mut board, 2, 5, -WIN-1, WIN+1).unwrap(), -WIN+7);
        }
    }

    #[test]
    fn simultaneous_surround_is_a_draw() {
        let mut board = Board::new(GameType::mlp());
        place(&mut board, Color::White, Bug::Queen, 1, 0, 0);
        place(&mut board, Color::Black, Bug::Queen, 1, 1, 0);
        let mut cells = std::collections::BTreeSet::new();
        cells.extend(crate::Hex::ORIGIN.neighbors());
        cells.extend(crate::Hex::new(1, 0).neighbors());
        let mut pieces = Piece::all_for(Color::White, GameType::mlp()).into_iter()
            .filter(|p| p.bug != Bug::Queen);
        for hex in cells {
            if board.is_occupied(hex) { continue; }
            let p = pieces.next().unwrap();
            place(&mut board, p.color, p.bug, p.number, hex.q, hex.r);
        }
        let result = search(&board, SearchLimit::Depth(3));
        assert_eq!(result.best_move, None);
        assert_eq!(result.score, Some(0));
    }

    #[test]
    fn zero_and_short_deadlines_return_legal_moves_without_mutation() {
        let board = Board::new(GameType::mlp());
        let before = format!("{board:?}");
        for time in [Duration::ZERO, Duration::from_millis(20), Duration::MAX] {
            let result = search(&board, SearchLimit::Time(time));
            assert!(board.legal_moves().contains(&result.best_move.unwrap()));
            assert!(result.elapsed < Duration::from_secs(1));
            if time.is_zero() { assert_eq!(result.completed_depth, 0); }
        }
        assert_eq!(format!("{board:?}"), before);
        let mut working = board.clone();
        let mut worker = Search { history: None, killers: [[None; 2]; 65], table: vec![None; 16384], deadline: Some(Instant::now()), nodes: 0, node_limit: None };
        assert!(worker.negamax(&mut working, 4, 0, -WIN-1, WIN+1).is_err());
        assert_eq!(format!("{working:?}"), before);
        // Cancel after entering descendants, not merely at the root.
        worker.deadline = None;
        worker.node_limit = Some(10);
        assert!(worker.negamax(&mut working, 4, 0, -WIN-1, WIN+1).is_err());
        assert_eq!(worker.nodes, 10);
        assert_eq!(format!("{working:?}"), before);
    }

    #[test]
    fn fused_leaf_matches_independent_terminal_and_evaluation() {
        let mut checked=0;
        let check=|board:&Board| {
            for ply in [0,3,64] {
                assert_eq!(evaluate_leaf(board,piece_total(board),ply),terminal(board,ply).unwrap_or_else(||reference_evaluate(board)));
                assert_eq!(evaluate_counted_leaf(board,piece_total(board),ply,queen_counts(board)),terminal(board,ply).unwrap_or_else(||reference_evaluate(board)));
                assert_eq!(counted_terminal(board,ply,queen_counts(board)),terminal(board,ply));
            }
        };
        for text in include_str!("../tests/defense_terminal_positions.txt").lines() {
            let game=crate::UhpGame::from_game_string(text).unwrap();check(game.board());
        }
        for mask in 0..8 {
            let mut board=Board::new(GameType{mosquito:mask&1!=0,ladybug:mask&2!=0,pillbug:mask&4!=0});
            for step in 0..100 {
                check(&board);let legal=board.legal_moves();if legal.is_empty(){break;}
                for &mv in &legal {
                    let queens=Color::ALL.map(|c|board.location(Piece::new(c,Bug::Queen,1)));
                    let counts=queen_counts(&board);
                    assert_eq!(projected_queen_counts(&board,HiveMove::Pass,&queens,counts),Some(counts));
                    let projected=projected_queen_counts(&board,mv,&queens,counts);
                    let u=board.make_generated(mv);
                    assert_eq!(projected.unwrap_or_else(||queen_counts(&board)),queen_counts(&board));
                    check(&board);board.undo_generated(u);assert_eq!(queen_counts(&board),counts);checked+=1;
                }
                board.make_generated(legal[(step*17+mask as usize)%legal.len()]);
            }
        }
        assert!(checked>10000);
        eprintln!("fused leaf checked {checked} child positions");
    }
}

#[cfg(test)]
mod repetition_tests {
    use super::*;
    fn worker(history:Vec<Position>) -> Search {
        Search { history:Some(history), table:vec![None;64],killers:[[None;2];65],deadline:None,nodes:0,node_limit:None }
    }
    #[test]
    fn leaf_shortcut_matches_full_history_check_through_archived_draws() {
        let mut draws=0;
        let mut placements=0;
        for line in include_str!("../tests/archive_repetition.txt").lines() {
            let mut fields=line.split('|');let id=fields.next().unwrap();
            let end:usize=fields.next().unwrap().parse().unwrap();
            let mut game=crate::UhpGame::new(crate::GameType::mlp());
            let mut history=vec![Position::new(game.board())];
            for (index,text) in fields.next().unwrap().split(';').take(end).enumerate() {
                game.play(text).unwrap();
                let mut board=game.board().clone();
                let played=board.last_move().unwrap_or(HiveMove::Pass);
                placements+=usize::from(matches!(played,HiveMove::Place{..}));
                let mut full=worker(history.clone());
                let expected=full.negamax(&mut board,0,1,-WIN-1,WIN+1);
                let total=piece_total(&board);let counts=queen_counts(&board);
                let mut fast=worker(history.clone());
                assert_eq!(fast.negamax_parts(&mut board,0,1,-WIN-1,WIN+1,total,counts,Some(played)),expected,"{id} ply {}",index+1);
                assert_eq!(fast.history.as_ref(),Some(&history));
                assert_eq!(fast.nodes,full.nodes);
                if index+1==end {assert_eq!(expected,Ok(0));draws+=1;}
                history.push(Position::new(&board));
            }
        }
        assert_eq!(draws,62);assert!(placements>500);
    }
    #[test]
    fn third_occurrence_is_draw_even_at_leaf_and_restores_path() {
        let g=crate::UhpGame::from_game_string(include_str!("../tests/search_positions.txt").lines().next().unwrap()).unwrap();
        let mut b=g.board().clone();let p=Position::new(&b);
        let mut w=worker(vec![p,p]);
        for depth in [0,2] {
            assert_eq!(w.negamax(&mut b,depth,1,-WIN-1,WIN+1),Ok(0));
            assert_eq!(w.history,Some(vec![p,p]));assert_eq!(Position::new(&b),p);
        }
        // A second occurrence is searched, not adjudicated as a draw.
        let mut w=worker(vec![p]);
        assert_eq!(w.negamax(&mut b,0,1,-WIN-1,WIN+1),Ok(evaluate_counted_leaf(&b,piece_total(&b),1,queen_counts(&b))));
        assert_eq!(w.history,Some(vec![p]));
    }
    #[test]
    fn history_sensitive_search_ignores_cached_scores_and_restores_on_interrupt() {
        let g=crate::UhpGame::from_game_string(include_str!("../tests/search_positions.txt").lines().next().unwrap()).unwrap();
        let mut b=g.board().clone();let p=Position::new(&b);let key=p.key();
        let mut w=worker(vec![]);
        w.table[key as usize & 63]=Some(Entry{key,position:p,depth:2,score:123456,bound:Bound::Exact,best_move:None});
        let expected=worker(vec![]).negamax(&mut b,2,0,-WIN-1,WIN+1);
        assert_eq!(w.negamax(&mut b,2,0,-WIN-1,WIN+1),expected);
        for limit in [0,1,5,20] {
            let mut w=worker(vec![p]);w.node_limit=Some(limit);
            assert!(w.negamax(&mut b,6,1,-WIN-1,WIN+1).is_err());
            assert_eq!(w.history,Some(vec![p]));assert_eq!(Position::new(&b),p);
        }
    }
}
