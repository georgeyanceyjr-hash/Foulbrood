use crate::{Board, Bug, Color, Hex, HiveMove, Piece, MAX_PIECES};
#[cfg(test)]
use crate::fast_hash::FastHashSet;

const ANT_SEEN_SIDE: i32 = 64;
const ANT_SEEN_OFFSET: i32 = 32;
// E, NE, NW, W, SW, SE in a packed row*64 + column grid index.
const ANT_GRID_STEPS: [i16; 6] = [1, -63, -64, -1, 63, 64];

// For each six-bit occupancy pattern around an empty perimeter hex, bit i is
// set when an Ant may slide from the center to neighbor i: the destination
// itself is empty and exactly one of the two shared-edge flank hexes is
// occupied. This replaces six modulo/shift/branch gate tests in the hottest
// Ant loop with one table lookup plus bit iteration.
const ANT_LEGAL_STEP_MASK: [u8; 64] = [
     0, 34,  5, 36, 10, 40,  9, 40,
    20, 54, 17, 48, 18, 48, 17, 48,
    40, 10, 45, 12, 34,  0, 33,  0,
    36,  6, 33,  0, 34,  0, 33,  0,
    17, 18, 20, 20, 27, 24, 24, 24,
     5,  6,  0,  0,  3,  0,  0,  0,
     9, 10, 12, 12,  3,  0,  0,  0,
     5,  6,  0,  0,  3,  0,  0,  0,
];

/// Allocation-free Ant flood-fill membership set.
///
/// Legal Base+MLP positions contain at most 28 occupied hexes. Because the Hive
/// is connected before the moving Ant is lifted, every occupied hex is at most
/// 27 adjacency steps from the source; every traversable perimeter hex is one
/// more step away. Therefore a ±28 coordinate-component window around the
/// source contains every legal Ant destination. A 64x64 relative bit grid gives
/// generous room while turning membership into one indexed bit test/set instead
/// of hashing a Hex and probing a 256-slot table.
///
/// `insert` returns None only for malformed/imported positions outside that
/// legal geometry; callers then use the cold heap fallback.
struct AntSeen {
    rows: [u64; ANT_SEEN_SIDE as usize],
    origin: Hex,
}

impl AntSeen {
    #[inline(always)]
    fn new(origin: Hex) -> Self {
        Self {
            rows: [0; ANT_SEEN_SIDE as usize],
            origin,
        }
    }

    /// Some(true) = newly inserted, Some(false) = already present,
    /// None = outside the compact legal-position window.
    #[inline(always)]
    fn insert(&mut self, hex: Hex) -> Option<bool> {
        let x = i32::from(hex.q) - i32::from(self.origin.q) + ANT_SEEN_OFFSET;
        let y = i32::from(hex.r) - i32::from(self.origin.r) + ANT_SEEN_OFFSET;
        if (x as u32) >= ANT_SEEN_SIDE as u32 || (y as u32) >= ANT_SEEN_SIDE as u32 {
            return None;
        }

        let bit = 1_u64 << (x as u32);
        let row = &mut self.rows[y as usize];
        let is_new = (*row & bit) == 0;
        *row |= bit;
        Some(is_new)
    }
}

/// Whole-board snapshot, built lazily for the first Ant and shared for the rest
/// of this move-generation call. Each Ant temporarily removes its own source.
/// The first source anchors the grid; legal connected Hive geometry keeps every
/// occupied cell and perimeter destination within ±28 of that anchor.
struct AntOccupancy {
    grid: AntSeen,
}

impl AntOccupancy {
    fn new(board: &Board, source: Hex) -> Option<Self> {
        // Check once that every represented grid coordinate can be emitted as
        // an i16 Hex. This removes two overflow checks per Ant destination.
        // Extreme translated positions retain the general heap traversal.
        if source.q < i16::MIN + 32 || source.q > i16::MAX - 31
            || source.r < i16::MIN + 32 || source.r > i16::MAX - 31
        {
            return None;
        }
        let mut grid = AntSeen::new(source);
        for hex in board.occupied_hexes() {
            grid.insert(hex)?;
        }
        Some(Self { grid })
    }

    /// Remove one ground source and return the row/bit needed to restore it.
    #[inline(always)]
    fn lift_source(&mut self, source: Hex) -> Option<(usize, u64)> {
        let x = i32::from(source.q) - i32::from(self.grid.origin.q) + ANT_SEEN_OFFSET;
        let y = i32::from(source.r) - i32::from(self.grid.origin.r) + ANT_SEEN_OFFSET;
        if x as u32 >= 64 || y as u32 >= 64 {
            return None;
        }
        let bit = 1_u64 << x;
        let row = y as usize;
        self.grid.rows[row] &= !bit;
        Some((row, bit))
    }

    #[cfg(test)]
    fn neighbor_mask(&self, current: Hex) -> Option<u8> {
        let x = i32::from(current.q) - i32::from(self.grid.origin.q) + ANT_SEEN_OFFSET;
        let y = i32::from(current.r) - i32::from(self.grid.origin.r) + ANT_SEEN_OFFSET;
        if x as u32 >= 64 || y as u32 >= 64 {
            return None;
        }
        self.neighbor_mask_at((y * 64 + x) as u16)
    }

    #[inline(always)]
    fn neighbor_mask_at(&self, index: u16) -> Option<u8> {
        let x = i32::from(index & 63);
        let y = i32::from(index >> 6);
        // Need one cell of padding for the six neighbor queries. Legal connected
        // positions stay inside ±28; a boundary hit uses the general fallback.
        if (x - 1) as u32 >= 62 || (y - 1) as u32 >= 62 {
            return None;
        }
        let center = self.grid.rows[y as usize];
        let above = self.grid.rows[(y - 1) as usize];
        let below = self.grid.rows[(y + 1) as usize];
        Some((((center >> (x + 1)) & 1)
            | (((above >> (x + 1)) & 1) << 1)
            | (((above >> x) & 1) << 2)
            | (((center >> (x - 1)) & 1) << 3)
            | (((below >> (x - 1)) & 1) << 4)
            | (((below >> x) & 1) << 5)) as u8)
    }
}

struct MoveGenBuffer {
    moves: Vec<HiveMove>,
    hexes: Vec<Hex>,
}

impl MoveGenBuffer {
    fn new() -> Self {
        Self {
            moves: Vec::with_capacity(192),
            hexes: Vec::with_capacity(96),
        }
    }
}

impl Board {
    /// Full legal move generation for Base + optional M/L/P.
    ///
    /// Public/UHP callers use this convenience wrapper. Search and perft reuse
    /// buffers through `legal_moves_into` so they do not allocate a move list
    /// and a destination list at every node.
    pub fn legal_moves(&self) -> Vec<HiveMove> {
        let mut moves = Vec::with_capacity(192);
        let mut scratch = Vec::with_capacity(96);
        self.legal_moves_into(&mut moves, &mut scratch);
        moves
    }

    /// Targeted membership for search hints. None requires full-list membership.
    /// A sibling's remembered move is never assumed legal in this position.
    pub(crate) fn is_legal_search_hint(&self, mv: HiveMove) -> Option<bool> {
        if self.game_over() { return Some(false); }
        match mv {
            HiveMove::Place { piece, to } => {
                // The general generator remains the oracle at coordinate edges.
                if to.q == i16::MIN || to.q == i16::MAX
                    || to.r == i16::MIN || to.r == i16::MAX { return None; }
                Some(self.is_legal_placement_hint(piece, to))
            }
            HiveMove::Move { piece, from, to } => {
                let color = self.side_to_move();
                if piece.color != color || piece.number == 0 || piece.number > piece.bug.copies()
                    || !self.game_type().includes(piece.bug) || !self.queen_is_placed(color)
                    || self.location(piece) != Some(from) || self.top(from) != Some(piece)
                    || (self.game_type().pillbug && self.last_physically_moved_piece() == Some(piece))
                { return Some(false); }
                let direct=direct_step_hint(self,piece,from,to);
                if direct==Some(false) {return Some(false);}
                if self.stack_height(from) == 1
                    && !locally_connected_after_lift(self, from)
                    && articulation_piece_mask(self) & (1_u32 << piece.id()) != 0
                { return Some(false); }
                if direct==Some(true) {return Some(true);}
                if let Some(legal)=complex_target_hint(self,piece,from,to) {return Some(legal);}
                let mut destinations = Vec::with_capacity(96);
                movement_destinations_into(self, piece, from, &mut destinations, &mut None);
                Some(destinations.contains(&to))
            }
            HiveMove::Pillbug { .. } | HiveMove::Pass => None,
        }
    }

    fn legal_moves_into(&self, moves: &mut Vec<HiveMove>, scratch: &mut Vec<Hex>) {
        moves.clear();
        scratch.clear();

        if self.game_over() {
            return;
        }

        self.append_legal_placements(moves, scratch);
        let color = self.side_to_move();

        // No piece may move, and no Pillbug ability may be used, until that
        // player's Queen has been placed.
        if self.queen_is_placed(color) {
            let articulation_mask = articulation_piece_mask(self);
            let immobilized = if self.game_type().pillbug {
                self.last_physically_moved_piece()
            } else {
                None
            };

            // None = uninitialized; Some(None) = unavailable for imported geometry.
            // Keep this local so no occupancy survives a board move or undo.
            let mut ant_occupancy: Option<Option<AntOccupancy>> = None;

            // Reuse the same per-ply hex buffer after placement generation.
            for bug in Bug::ALL {
                if !self.game_type().includes(bug) {
                    continue;
                }
                for number in 1..=bug.copies() {
                    let piece = Piece::new(color, bug, number);
                    let Some(source) = self.location(piece) else {
                        continue;
                    };
                    if self.top(source) != Some(piece) || Some(piece) == immobilized {
                        continue;
                    }
                    if !can_lift_piece(self, piece, source, articulation_mask) {
                        continue;
                    }

                    scratch.clear();
                    movement_destinations_into(self, piece, source, scratch, &mut ant_occupancy);
                    for &destination in scratch.iter() {
                        moves.push(HiveMove::Move {
                            piece,
                            from: source,
                            to: destination,
                        });
                    }
                }
            }

            // Pillbug special moves can be available even when the acting
            // Pillbug is pinned by One-Hive. The actor itself is not lifted.
            for bug in [Bug::Mosquito, Bug::Pillbug] {
                if !self.game_type().includes(bug) {
                    continue;
                }
                let actor = Piece::new(color, bug, 1);
                let Some(actor_hex) = self.location(actor) else {
                    continue;
                };
                if self.top(actor_hex) != Some(actor) || Some(actor) == immobilized {
                    continue;
                }
                if !can_use_pillbug_ability(self, actor, actor_hex) {
                    continue;
                }

                append_pillbug_relocations(
                    self,
                    actor,
                    actor_hex,
                    immobilized,
                    articulation_mask,
                    moves,
                );
            }
        }

        if moves.is_empty() {
            moves.push(HiveMove::Pass);
        }
    }

    pub fn queen_surrounded(&self, color: Color) -> bool {
        let queen = Piece::new(color, Bug::Queen, 1);
        let Some(hex) = self.location(queen) else {
            return false;
        };
        hex.neighbors()
            .into_iter()
            .all(|neighbor| self.is_occupied(neighbor))
    }

    pub fn game_over(&self) -> bool {
        // Surrounding a Queen requires that Queen's occupied cell plus all six
        // neighboring cells. This cheap guard dominates opening search and
        // avoids up to twelve board probes when mate is geometrically impossible.
        if self.occupied_hex_count() < 7 {
            return false;
        }
        self.queen_surrounded(Color::White) || self.queen_surrounded(Color::Black)
    }

    /// Performance-test tree walk. Counts move sequences of exactly `depth`
    /// plies. One move/hex buffer is allocated per depth, then reused for every
    /// node at that ply. This mirrors how the timed searcher will operate.
    pub fn perft(&mut self, depth: u8) -> u64 {
        if depth == 0 {
            return 1;
        }
        let mut buffers: Vec<MoveGenBuffer> =
            (0..depth).map(|_| MoveGenBuffer::new()).collect();
        self.perft_buffered(&mut buffers)
    }

    fn perft_buffered(&mut self, buffers: &mut [MoveGenBuffer]) -> u64 {
        let Some((current, rest)) = buffers.split_first_mut() else {
            return 1;
        };

        self.legal_moves_into(&mut current.moves, &mut current.hexes);
        let mut nodes = 0_u64;
        for i in 0..current.moves.len() {
            let mv = current.moves[i];
            let undo = self.make_generated(mv);
            nodes = nodes.saturating_add(self.perft_buffered(rest));
            self.undo_generated(undo);
        }
        nodes
    }
}

#[inline]
fn push_unique(out: &mut Vec<Hex>, hex: Hex) {
    if !out.contains(&hex) {
        out.push(hex);
    }
}

fn movement_destinations_into(
    board: &Board, piece: Piece, source: Hex, out: &mut Vec<Hex>,
    ant_occupancy: &mut Option<Option<AntOccupancy>>,
) {
    match piece.bug {
        Bug::Queen | Bug::Pillbug => queen_like_moves_into(board, source, out),
        Bug::Beetle => beetle_moves_into(board, source, out),
        Bug::Grasshopper => grasshopper_moves_into(board, source, out),
        Bug::Ant => ant_moves_shared(board, source, out, ant_occupancy),
        Bug::Spider => spider_moves_into(board, source, out),
        Bug::Ladybug => ladybug_moves_into(board, source, out),
        Bug::Mosquito => mosquito_moves_into(board, source, out, ant_occupancy),
    }
}

fn queen_like_moves_into(board: &Board, source: Hex, out: &mut Vec<Hex>) {
    // A Queen/Pillbug cannot naturally be on top of a stack. If an imported
    // position says otherwise, do not invent Beetle-like movement for it.
    if board.stack_height(source) != 1 {
        return;
    }

    for destination in source.neighbors() {
        if board.is_occupied(destination) {
            continue;
        }
        if ground_gate_open(board, source, destination, source) {
            out.push(destination);
        }
    }
}

fn beetle_moves_into(board: &Board, source: Hex, out: &mut Vec<Hex>) {
    let source_height = board.stack_height(source);
    for destination in source.neighbors() {
        let destination_height = board.stack_height(destination);

        // Ground-to-ground movement is the overwhelmingly common Beetle case.
        // Once the moving Beetle is lifted, legal sliding is exactly one open
        // and one occupied shared flank. That both enforces Freedom-to-Move
        // and guarantees continuous contact, so no six-neighbor attachment
        // scan is needed. Elevated edges retain the full height-aware test.
        let open = if source_height == 1 && destination_height == 0 {
            ground_gate_open(board, source, destination, source)
        } else {
            elevated_gate_open(board, source, destination, source)
        };
        if open {
            out.push(destination);
        }
    }
}

fn grasshopper_moves_into(board: &Board, source: Hex, out: &mut Vec<Hex>) {
    for direction in crate::Direction::ALL {
        let mut cursor = source.neighbor(direction);
        if !board.is_occupied(cursor) {
            continue;
        }
        while board.is_occupied(cursor) {
            cursor = cursor.neighbor(direction);
        }
        out.push(cursor);
    }
}

#[cfg(test)]
fn ant_moves_into(board: &Board, source: Hex, out: &mut Vec<Hex>) {
    ant_moves_shared(board, source, out, &mut None);
}

// Private snapshot: an early return cannot leak a lifted source to another call.
fn ant_target_hint(board:&Board,source:Hex,target:Hex) -> Option<bool> {
    if board.stack_height(source)!=1 || source==target || board.is_occupied(target) {return Some(false);}
    let x=i32::from(target.q)-i32::from(source.q)+32;
    let y=i32::from(target.r)-i32::from(source.r)+32;
    if x as u32>=64 || y as u32>=64 {return None;}
    let target=(y*64+x) as u16;
    let mut occupancy=AntOccupancy::new(board,source)?;
    let (row,bit)=occupancy.lift_source(source)?;
    let start=(row as u16)*64+bit.trailing_zeros() as u16;
    let mut seen=[0_u64;64];let mut queue=[0_u16;128];let mut head=0;let mut tail=1;
    queue[0]=start;seen[row]=bit;
    while head<tail {
        let current=queue[head];head+=1;
        let mask=occupancy.neighbor_mask_at(current)?;
        let mut steps=ANT_LEGAL_STEP_MASK[mask as usize];
        while steps!=0 {
            let i=steps.trailing_zeros() as usize;steps&=steps-1;
            let next=(current as i16+ANT_GRID_STEPS[i]) as u16;
            if next==target {return Some(true);}
            let row=(next>>6) as usize;let bit=1_u64<<(next&63);
            if seen[row]&bit!=0 {continue;}
            seen[row]|=bit;
            if tail>=queue.len() {return None;}
            queue[tail]=next;tail+=1;
        }
    }
    Some(false)
}

fn complex_target_hint(board:&Board,piece:Piece,source:Hex,target:Hex) -> Option<bool> {
    if piece.bug==Bug::Ant {return ant_target_hint(board,source,target);}
    if piece.bug!=Bug::Mosquito {return None;}
    if board.stack_height(source)>1 {
        return direct_step_hint(board,Piece::new(piece.color,Bug::Beetle,1),source,target);
    }
    let mut copied=0_u8;
    for h in source.neighbors() {
        if let Some(p)=board.top(h) {
            if p.bug!=Bug::Mosquito {copied|=1<<p.bug as u8;}
        }
    }
    let mut scratch=Vec::new();let mut cache=None;
    for bug in Bug::ALL {
        if copied&(1<<bug as u8)==0 {continue;}
        let virtual_piece=Piece::new(piece.color,bug,1);
        let quick=if bug==Bug::Ant {ant_target_hint(board,source,target)}
            else {direct_step_hint(board,virtual_piece,source,target)};
        if let Some(found)=quick {if found{return Some(true);}continue;}
        scratch.clear();movement_destinations_into(board,virtual_piece,source,&mut scratch,&mut cache);
        if scratch.contains(&target) {return Some(true);}
    }
    Some(false)
}

fn ant_moves_shared(
    board: &Board, source: Hex, out: &mut Vec<Hex>,
    cache: &mut Option<Option<AntOccupancy>>,
) {
    if board.stack_height(source) != 1 {
        return;
    }
    let Some(occupancy) = cache.get_or_insert_with(|| AntOccupancy::new(board, source)).as_mut() else {
        ant_moves_heap_fallback(board, source, out, out.len());
        return;
    };
    let Some((row, bit)) = occupancy.lift_source(source) else {
        ant_moves_heap_fallback(board, source, out, out.len());
        return;
    };
    // The inner traversal may return through a fallback. Always restore the
    // source before the shared snapshot is used by another Ant or Mosquito.
    let start = (row as u16) * 64 + bit.trailing_zeros() as u16;
    ant_moves_on_grid(board, source, out, occupancy, start);
    occupancy.grid.rows[row] |= bit;
}

fn ant_moves_on_grid(
    board: &Board, source: Hex, out: &mut Vec<Hex>, occupancy: &AntOccupancy, start: u16,
) {
    // Ant destinations are perimeter cells around a connected Hive. Keep the
    // traversal entirely on the stack: no HashSet allocation and no Vec queue
    // allocation for each Ant at each search node. 4*n+2 is an upper bound on
    // the boundary edges of an n-cell connected polyhex; 128 entries therefore
    // safely covers the 28-cell MLP board plus the source sentinel.
    const ANT_QUEUE_CAPACITY: usize = 128;
    let out_start_len = out.len();
    // Queue and visited set use the occupancy grid's coordinates. Convert to a
    // Hex only when emitting a newly discovered destination.
    let mut seen = [0_u64; ANT_SEEN_SIDE as usize];
    let mut queue = [0_u16; ANT_QUEUE_CAPACITY];
    let mut head = 0_usize;
    let mut tail = 1_usize;
    queue[0] = start;
    seen[(start >> 6) as usize] = 1_u64 << (start & 63);

    while head < tail {
        let current = queue[head];
        head += 1;

        let Some(occupied_mask) = occupancy.neighbor_mask_at(current) else {
            ant_moves_heap_fallback(board, source, out, out_start_len);
            return;
        };

        let mut legal_steps = ANT_LEGAL_STEP_MASK[occupied_mask as usize];
        while legal_steps != 0 {
            let i = legal_steps.trailing_zeros() as usize;
            legal_steps &= legal_steps - 1;

            // The mask query checked a one-cell border, so these six offsets
            // cannot wrap a row or leave the 64×64 grid.
            let next = (current as i16 + ANT_GRID_STEPS[i]) as u16;
            let row = (next >> 6) as usize;
            let bit = 1_u64 << (next & 63);
            if seen[row] & bit != 0 {
                continue;
            }
            seen[row] |= bit;

            let origin = occupancy.grid.origin;
            // Snapshot construction guarantees these sums fit in an i16.
            let q = origin.q + ((next & 63) as i16 - 32);
            let r = origin.r + ((next >> 6) as i16 - 32);

            debug_assert!(tail < ANT_QUEUE_CAPACITY, "Ant perimeter queue exceeded legal MLP bound");
            if tail >= ANT_QUEUE_CAPACITY {
                // Defensive fallback for malformed/imported positions far outside
                // legal piece-count geometry. Correctness beats speed here.
                ant_moves_heap_fallback(board, source, out, out_start_len);
                return;
            }
            queue[tail] = next;
            tail += 1;
            out.push(Hex::new(q, r));
        }
    }
}

#[cold]
fn ant_moves_heap_fallback(
    board: &Board,
    source: Hex,
    out: &mut Vec<Hex>,
    out_start_len: usize,
) {
    use crate::fast_hash::FastHashSet;
    // Discard only destinations appended by the compact path. This matters when
    // Ant movement is being copied by a Mosquito after another copied bug has
    // already contributed destinations to `out`.
    out.truncate(out_start_len);

    let mut visited = FastHashSet::default();
    visited.reserve(board.occupied_hex_count() * 4 + 16);
    let mut queue = Vec::with_capacity(board.occupied_hex_count() * 4 + 16);
    visited.insert(source);
    queue.push(source);
    let mut head = 0_usize;

    while head < queue.len() {
        let current = queue[head];
        head += 1;
        for next in current.neighbors() {
            if board.is_occupied(next) || !ground_gate_open(board, current, next, source) {
                continue;
            }
            if visited.insert(next) {
                out.push(next);
                queue.push(next);
            }
        }
    }
}

fn spider_moves_into(board: &Board, source: Hex, out: &mut Vec<Hex>) {
    if board.stack_height(source) != 1 {
        return;
    }

    // A Spider path is only three steps, so a tiny flat path beats allocating a
    // hash table for visited cells.
    let mut path = [Hex::ORIGIN; 4];
    path[0] = source;
    spider_dfs::<0>(board, source, source, &mut path, out);
}

#[inline]
fn spider_dfs<const DEPTH: usize>(
    board: &Board,
    lifted_source: Hex,
    current: Hex,
    path: &mut [Hex; 4],
    out: &mut Vec<Hex>,
) {
    if DEPTH == 3 {
        push_unique(out, current);
        return;
    }

    // Each destination and its two gate flanks belong to the same six-cell
    // ring. Query occupancy once per neighbor, with the source lifted, then
    // reuse the ground-slide lookup table already used by Ant traversal.
    let neighbors = current.neighbors();
    let mut occupied = 0_usize;
    for (i, &hex) in neighbors.iter().enumerate() {
        if hex != lifted_source && board.is_occupied(hex) {
            occupied |= 1 << i;
        }
    }
    let mut steps = ANT_LEGAL_STEP_MASK[occupied];
    while steps != 0 {
        let i = steps.trailing_zeros() as usize;
        steps &= steps - 1;
        let next = neighbors[i];
        if path[..=DEPTH].contains(&next) {
            continue;
        }

        path[DEPTH + 1] = next;
        match DEPTH {
            0 => spider_dfs::<1>(board, lifted_source, next, path, out),
            1 => spider_dfs::<2>(board, lifted_source, next, path, out),
            2 => spider_dfs::<3>(board, lifted_source, next, path, out),
            _ => unreachable!(),
        }
    }
}

#[cfg(test)]
fn spider_dfs_reference(
    board: &Board,
    lifted_source: Hex,
    current: Hex,
    depth: u8,
    path: &mut [Hex; 4],
    out: &mut Vec<Hex>,
) {
    if depth == 3 {
        push_unique(out, current);
        return;
    }

    for next in current.neighbors() {
        if path[..=depth as usize].contains(&next) || board.is_occupied(next) {
            continue;
        }
        if !ground_gate_open(board, current, next, lifted_source) {
            continue;
        }

        path[depth as usize + 1] = next;
        spider_dfs_reference(board, lifted_source, next, depth + 1, path, out);
    }
}

fn ladybug_moves_into(board: &Board, source: Hex, out: &mut Vec<Hex>) {
    if board.stack_height(source) != 1 {
        return;
    }

    // Step 1: onto the Hive.
    for first in source.neighbors() {
        if !board.is_occupied(first) {
            continue;
        }
        if !elevated_gate_open(board, source, first, source) {
            continue;
        }

        // Step 2: across the top of the Hive.
        for second in first.neighbors() {
            if second == source || second == first {
                continue;
            }
            if !board.is_occupied(second) {
                continue;
            }
            if !elevated_gate_open(board, first, second, source) {
                continue;
            }

            // Step 3: down to an empty space. Ending where it started would be
            // a no-op position and is not a legal Hive move.
            let neighbors = second.neighbors();
            let heights = neighbors.map(|hex| height_after_lift(board, hex, source));
            let threshold = board.stack_height(second);
            for i in 0..6 {
                let destination = neighbors[i];
                if destination == source || heights[i] != 0 {
                    continue;
                }
                // The occupied second step supplies contact. An empty drop
                // destination has height zero, so only flanks taller than the
                // second stack can block the edge. Reuse the six ring probes.
                if heights[(i + 5) % 6] > threshold && heights[(i + 1) % 6] > threshold {
                    continue;
                }
                push_unique(out, destination);
            }
        }
    }
}

#[cfg(test)]
fn ladybug_moves_reference(board: &Board, source: Hex, out: &mut Vec<Hex>) {
    if board.stack_height(source) != 1 {
        return;
    }

    // Step 1: onto the Hive.
    for first in source.neighbors() {
        if !board.is_occupied(first) {
            continue;
        }
        if !elevated_gate_open(board, source, first, source) {
            continue;
        }

        // Step 2: across the top of the Hive.
        for second in first.neighbors() {
            if second == source || second == first {
                continue;
            }
            if !board.is_occupied(second) {
                continue;
            }
            if !elevated_gate_open(board, first, second, source) {
                continue;
            }

            // Step 3: down to an empty space. Ending where it started would be
            // a no-op position and is not a legal Hive move.
            for destination in second.neighbors() {
                if destination == source {
                    continue;
                }
                if board.is_occupied(destination) {
                    continue;
                }
                if !elevated_gate_open(board, second, destination, source) {
                    continue;
                }
                push_unique(out, destination);
            }
        }
    }
}

fn mosquito_moves_into(
    board: &Board, source: Hex, out: &mut Vec<Hex>,
    ant_occupancy: &mut Option<Option<AntOccupancy>>,
) {
    // Once a Mosquito is on top of the Hive, it remains Beetle-like until it
    // comes back down, regardless of what it touches.
    if board.stack_height(source) > 1 {
        beetle_moves_into(board, source, out);
        return;
    }

    // Bug::repr values fit in a byte. A bitmask avoids allocating a set merely
    // to deduplicate the at-most-six neighboring bug types.
    let mut copied_mask = 0_u8;
    for neighbor in source.neighbors() {
        let Some(adjacent_piece) = board.top(neighbor) else {
            continue;
        };
        if adjacent_piece.bug != Bug::Mosquito {
            copied_mask |= 1_u8 << adjacent_piece.bug as u8;
        }
    }

    for bug in Bug::ALL {
        if copied_mask & (1_u8 << bug as u8) == 0 {
            continue;
        }
        match bug {
            Bug::Queen | Bug::Pillbug => queen_like_moves_into(board, source, out),
            Bug::Beetle => beetle_moves_into(board, source, out),
            Bug::Grasshopper => grasshopper_moves_into(board, source, out),
            Bug::Ant => ant_moves_shared(board, source, out, ant_occupancy),
            Bug::Spider => spider_moves_into(board, source, out),
            Bug::Ladybug => ladybug_moves_into(board, source, out),
            Bug::Mosquito => {}
        }
    }
    out.sort_unstable();
    out.dedup();
}

fn can_use_pillbug_ability(board: &Board, actor: Piece, actor_hex: Hex) -> bool {
    if !board.game_type().pillbug || board.stack_height(actor_hex) != 1 {
        return false;
    }

    match actor.bug {
        Bug::Pillbug => true,
        Bug::Mosquito => actor_hex
            .neighbors()
            .into_iter()
            .filter_map(|hex| board.top(hex))
            .any(|piece| piece.bug == Bug::Pillbug),
        _ => false,
    }
}

fn append_pillbug_relocations(
    board: &Board,
    actor: Piece,
    actor_hex: Hex,
    immobilized: Option<Piece>,
    articulation_mask: u32,
    moves: &mut Vec<HiveMove>,
) {
    // The caller guarantees an uncovered actor (height one). A relocated
    // singleton cannot change whether either gate flank is taller than one.
    // Snapshot the ring once; the same gates apply to lifting and dropping.
    debug_assert_eq!(board.stack_height(actor_hex), 1);
    let neighbors = actor_hex.neighbors();
    let heights = neighbors.map(|hex| board.stack_height(hex));
    let gates: [bool; 6] = std::array::from_fn(|i| {
        !(heights[(i + 5) % 6] > 1 && heights[(i + 1) % 6] > 1)
    });
    let mut destinations = [Hex::ORIGIN; 6];
    let mut destination_count = 0;
    for i in 0..6 {
        if heights[i] == 0 && gates[i] {
            destinations[destination_count] = neighbors[i];
            destination_count += 1;
        }
    }
    if destination_count == 0 {
        return;
    }
    let mut available = [0_u8; 28];
    let mut sources = [(actor, actor_hex); 6];
    let mut source_count = 0;
    for i in 0..6 {
        if heights[i] != 1 || !gates[i] { continue; }
        let from = neighbors[i];
        let Some(piece) = board.top(from) else { continue; };
        if Some(piece) == immobilized || (articulation_mask & (1_u32 << piece.id())) != 0 {
            continue;
        }
        sources[source_count] = (piece, from);
        source_count += 1;
        available[piece.id()] = (1_u8 << destination_count) - 1;
    }
    if source_count == 0 { return; }

    // Check existing ordinary and ability moves once per actor. Each source
    // piece is unique, so moves appended for it cannot suppress another source.
    for mv in moves.iter() {
        let (piece, destination) = match *mv {
            HiveMove::Move { piece, to, .. }
            | HiveMove::Pillbug { piece, to, .. } => (piece, to),
            _ => continue,
        };
        let mask = &mut available[piece.id()];
        if *mask == 0 { continue; }
        for (j, &to) in destinations[..destination_count].iter().enumerate() {
            if destination == to {
                *mask &= !(1 << j);
                break;
            }
        }
    }
    for &(piece, from) in &sources[..source_count] {
        for (j, &to) in destinations[..destination_count].iter().enumerate() {
            if available[piece.id()] & (1 << j) != 0 {
                moves.push(HiveMove::Pillbug { actor, piece, from, to });
            }
        }
    }
}

#[cfg(test)]
fn append_pillbug_relocations_reference(
    board: &Board,
    actor: Piece,
    actor_hex: Hex,
    immobilized: Option<Piece>,
    articulation_mask: u32,
    moves: &mut Vec<HiveMove>,
) {
    for from in actor_hex.neighbors() {
        let Some(piece) = board.top(from) else {
            continue;
        };

        // Pillbug may move only an unstacked piece, and not the piece physically
        // moved on the immediately preceding turn.
        if board.stack_height(from) != 1 || Some(piece) == immobilized {
            continue;
        }
        if !can_lift_piece(board, piece, from, articulation_mask) {
            continue;
        }

        // Lift from source onto the Pillbug/Mosquito. Tall stacks on both sides
        // can form a vertical gate.
        if !elevated_gate_open(board, from, actor_hex, from) {
            continue;
        }

        for to in actor_hex.neighbors() {
            if to == from || board.is_occupied(to) {
                continue;
            }
            if !elevated_gate_open(board, actor_hex, to, from) {
                continue;
            }

            // Two possible actors (P + M), or ordinary movement and a Pillbug
            // relocation, can describe the same resulting turn. This path is
            // rare, so scanning the already-built flat move list is cheaper than
            // allocating a second hash table at every search node.
            let duplicate = moves.iter().any(|mv| match *mv {
                HiveMove::Move { piece: p, to: d, .. }
                | HiveMove::Pillbug { piece: p, to: d, .. } => p == piece && d == to,
                _ => false,
            });
            if !duplicate {
                moves.push(HiveMove::Pillbug {
                    actor,
                    piece,
                    from,
                    to,
                });
            }
        }
    }
}

#[inline(always)]
// Sufficient, not necessary: a connected ring links every incident edge
// without the source. Also valid component-wise on disconnected imports.
// One-step pieces can test the requested edge without building all destinations.
fn direct_step_hint(board:&Board, piece:Piece, from:Hex, to:Hex) -> Option<bool> {
    if !matches!(piece.bug,Bug::Queen|Bug::Pillbug|Bug::Beetle) {return None;}
    if from.q==i16::MIN || from.q==i16::MAX || from.r==i16::MIN || from.r==i16::MAX {return None;}
    if !matches!((i32::from(to.q)-i32::from(from.q),i32::from(to.r)-i32::from(from.r)),
        (1,0)|(1,-1)|(0,-1)|(-1,0)|(-1,1)|(0,1)) {return Some(false);}
    let height=board.stack_height(from);
    let destination=board.stack_height(to);
    if piece.bug!=Bug::Beetle {
        return Some(height==1 && destination==0 && ground_gate_open(board,from,to,from));
    }
    Some(if height==1 && destination==0 {ground_gate_open(board,from,to,from)}
        else {elevated_gate_open(board,from,to,from)})
}

fn locally_connected_after_lift(board: &Board, source: Hex) -> bool {
    if source.q == i16::MIN || source.q == i16::MAX || source.r == i16::MIN || source.r == i16::MAX {return false;}
    let mut mask=0_u8;
    for (i,h) in source.neighbors().into_iter().enumerate() {
        if board.is_occupied(h) {mask |= 1<<i;}
    }
    let rotated=((mask<<1)|(mask>>5))&63;
    (mask & !rotated).count_ones() <= 1
}

fn can_lift_piece(board: &Board, piece: Piece, source: Hex, articulation_mask: u32) -> bool {
    board.stack_height(source) > 1 || (articulation_mask & (1_u32 << piece.id())) == 0
}

#[inline(always)]
fn height_after_lift(board: &Board, hex: Hex, lifted_source: Hex) -> usize {
    let height = board.stack_height(hex);
    if hex == lifted_source {
        height.saturating_sub(1)
    } else {
        height
    }
}

/// Fast ground-level Freedom-to-Move test. For a piece sliding between two
/// empty ground cells after its original source has been lifted, exactly one
/// of the two shared flank cells must remain occupied: zero would detach the
/// piece from the Hive; two would squeeze it through a closed gate.
#[inline(always)]
fn ground_gate_open(board: &Board, from: Hex, to: Hex, lifted_source: Hex) -> bool {
    let Some((left, right)) = from.gate_flanks(to) else {
        return false;
    };
    let left_occupied = height_after_lift(board, left, lifted_source) != 0;
    let right_occupied = height_after_lift(board, right, lifted_source) != 0;
    left_occupied ^ right_occupied
}

#[inline(always)]
/// Height-aware Freedom-to-Move gate *and* continuous-contact test.
///
/// Temporarily remove the moving piece from `lifted_source`. For an elevated
/// edge A-B, movement is blocked only when both flanking stacks are strictly
/// taller than both A and B. Ground-to-ground movement additionally requires
/// at least one occupied shared flank so the piece remains in contact.
fn elevated_gate_open(board: &Board, from: Hex, to: Hex, lifted_source: Hex) -> bool {
    let Some((left, right)) = from.gate_flanks(to) else {
        return false;
    };

    let from_height = height_after_lift(board, from, lifted_source);
    let to_height = height_after_lift(board, to, lifted_source);
    let threshold = from_height.max(to_height);
    let left_height = height_after_lift(board, left, lifted_source);
    let right_height = height_after_lift(board, right, lifted_source);

    if threshold == 0 && left_height == 0 && right_height == 0 {
        return false;
    }

    !(left_height > threshold && right_height > threshold)
}

/// Identify singleton cells whose removal would disconnect their component.
/// Larger hives use physical top-piece IDs directly as graph vertices, avoiding
/// temporary compact-cell maps and the final conversion back to piece IDs.
fn articulation_piece_mask(board: &Board) -> u32 {
    if board.occupied_hex_count() <= 8 {
        return articulation_piece_mask_pairwise(board);
    }
    let mut adjacency = [0_u32; MAX_PIECES];
    let mut occupied = 0_u32;
    let mut singletons = 0_u32;
    for (hex, top, height) in board.occupied_cell_summaries() {
        let i = top.id();
        let bit = 1_u32 << i;
        occupied |= bit;
        if height == 1 { singletons |= bit; }
        // These three directions visit each undirected edge once. A covered
        // piece is never a vertex; its stack's top identifies the occupied cell.
        for (dq, dr) in [(1_i16, 0_i16), (1, -1), (0, -1)] {
            let Some(q) = hex.q.checked_add(dq) else { continue; };
            let Some(r) = hex.r.checked_add(dr) else { continue; };
            if let Some(neighbor) = board.top(Hex::new(q, r)) {
                let j = neighbor.id();
                adjacency[i] |= 1_u32 << j;
                adjacency[j] |= bit;
            }
        }
    }
    let mut discovery = [0_u8; MAX_PIECES];
    let mut low = [0_u8; MAX_PIECES];
    let mut parent = [u8::MAX; MAX_PIECES];
    let mut articulation = 0_u32;
    let mut time = 0_u8;
    // Imported disconnected positions require a DFS root per component.
    while occupied != 0 {
        let root = occupied.trailing_zeros() as usize;
        occupied &= occupied - 1;
        if discovery[root] == 0 {
            articulation_dfs_bitset(root, &adjacency, &mut time, &mut discovery,
                                   &mut low, &mut parent, &mut articulation);
        }
    }
    articulation & singletons
}

fn articulation_piece_mask_pairwise(board: &Board) -> u32 {
    let occupied = board.occupied_hex_count();
    if occupied <= 2 {
        return 0;
    }

    let mut hexes = [Hex::ORIGIN; MAX_PIECES];
    let mut piece_ids = [0_u8; MAX_PIECES];
    let mut singleton = [false; MAX_PIECES];
    let mut len = 0_usize;

    for (hex, top, height) in board.occupied_cell_summaries() {
        debug_assert!(len < MAX_PIECES);
        hexes[len] = hex;
        piece_ids[len] = top.id() as u8;
        singleton[len] = height == 1;
        len += 1;
    }

    let mut adjacency = [0_u32; MAX_PIECES];
    for i in 0..len {
        for j in (i + 1)..len {
            if hexes_adjacent(hexes[i], hexes[j]) {
                adjacency[i] |= 1_u32 << j;
                adjacency[j] |= 1_u32 << i;
            }
        }
    }

    let mut discovery = [0_u8; MAX_PIECES];
    let mut low = [0_u8; MAX_PIECES];
    let mut parent = [u8::MAX; MAX_PIECES];
    let mut articulation = 0_u32;
    let mut time = 0_u8;

    for root in 0..len {
        if discovery[root] == 0 {
            articulation_dfs_bitset(
                root,
                &adjacency,
                &mut time,
                &mut discovery,
                &mut low,
                &mut parent,
                &mut articulation,
            );
        }
    }

    let mut piece_mask = 0_u32;
    let mut bits = articulation;
    while bits != 0 {
        let index = bits.trailing_zeros() as usize;
        bits &= bits - 1;
        if singleton[index] {
            piece_mask |= 1_u32 << piece_ids[index];
        }
    }
    piece_mask
}

#[inline(always)]
fn hexes_adjacent(a: Hex, b: Hex) -> bool {
    matches!(
        (b.q - a.q, b.r - a.r),
        (1, 0) | (1, -1) | (0, -1) | (-1, 0) | (-1, 1) | (0, 1)
    )
}

fn articulation_dfs_bitset(
    current: usize,
    adjacency: &[u32; MAX_PIECES],
    time: &mut u8,
    discovery: &mut [u8; MAX_PIECES],
    low: &mut [u8; MAX_PIECES],
    parent: &mut [u8; MAX_PIECES],
    articulation: &mut u32,
) {
    *time += 1;
    discovery[current] = *time;
    low[current] = *time;
    let mut child_count = 0_u8;
    let mut neighbors = adjacency[current];

    while neighbors != 0 {
        let neighbor = neighbors.trailing_zeros() as usize;
        neighbors &= neighbors - 1;

        if discovery[neighbor] == 0 {
            child_count += 1;
            parent[neighbor] = current as u8;
            articulation_dfs_bitset(
                neighbor,
                adjacency,
                time,
                discovery,
                low,
                parent,
                articulation,
            );

            low[current] = low[current].min(low[neighbor]);
            let is_root = parent[current] == u8::MAX;
            if (is_root && child_count > 1)
                || (!is_root && low[neighbor] >= discovery[current])
            {
                *articulation |= 1_u32 << current;
            }
        } else if parent[current] != neighbor as u8 {
            low[current] = low[current].min(discovery[neighbor]);
        }
    }
}

#[cfg(test)]
fn queen_like_moves(board: &Board, source: Hex) -> Vec<Hex> {
    let mut out = Vec::new();
    queen_like_moves_into(board, source, &mut out);
    out
}

#[cfg(test)]
fn beetle_moves(board: &Board, source: Hex) -> Vec<Hex> {
    let mut out = Vec::new();
    beetle_moves_into(board, source, &mut out);
    out
}

#[cfg(test)]
fn grasshopper_moves(board: &Board, source: Hex) -> Vec<Hex> {
    let mut out = Vec::new();
    grasshopper_moves_into(board, source, &mut out);
    out
}

#[cfg(test)]
fn mosquito_moves(board: &Board, source: Hex) -> Vec<Hex> {
    let mut out = Vec::new();
    mosquito_moves_into(board, source, &mut out, &mut None);
    out
}

#[cfg(test)]
fn articulation_points(board: &Board) -> FastHashSet<Hex> {
    let mask = articulation_piece_mask(board);
    board
        .occupied_hexes()
        .filter(|hex| {
            board
                .top(*hex)
                .is_some_and(|piece| mask & (1_u32 << piece.id()) != 0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GameType, HiveMove};

    fn put(board: &mut Board, piece: Piece, hex: Hex) {
        if board.side_to_move() != piece.color {
            board.make_unchecked(HiveMove::Pass).unwrap();
        }
        board
            .make_unchecked(HiveMove::Place { piece, to: hex })
            .unwrap();
    }

    #[test]
    fn pillbug_cached_ring_matches_reference_for_all_height_patterns() {
        // All 3^6 rings: empty, singleton, and tall on each side. Compare
        // ordered moves with the previous height-aware implementation, also
        // exercising immobilization, articulation and existing duplicates.
        for actor_bug in [Bug::Pillbug, Bug::Mosquito] {
            let actor = Piece::new(Color::White, actor_bug, 1);
            for pattern in 0..729 {
                let mut board = Board::new(GameType::mlp());
                put(&mut board, actor, Hex::ORIGIN);
                let mut pieces = Piece::all_for(Color::Black, GameType::mlp()).into_iter();
                let mut encoded = pattern;
                for hex in Hex::ORIGIN.neighbors() {
                    let height = encoded % 3;
                    encoded /= 3;
                    for level in 0..height {
                        let piece = pieces.next().unwrap();
                        if level == 0 {
                            put(&mut board, piece, hex);
                        } else {
                            let staging = Hex::new(10, 10);
                            put(&mut board, piece, staging);
                            if board.side_to_move() != piece.color {
                                board.make_unchecked(HiveMove::Pass).unwrap();
                            }
                            board.make_unchecked(HiveMove::Move { piece, from: staging, to: hex }).unwrap();
                        }
                    }
                }
                let mut seed = Vec::new();
                append_pillbug_relocations_reference(&board, actor, Hex::ORIGIN, None, 0, &mut seed);
                // Seed an ordinary move equivalent to one relocation.
                if let Some(HiveMove::Pillbug { piece, from, to, .. }) = seed.first().copied() {
                    seed = vec![HiveMove::Move { piece, from, to }];
                }
                for mode in 0..3 {
                    let immobilized = if mode == 1 { board.top(Hex::ORIGIN.neighbors()[0]) } else { None };
                    let mask = if mode == 2 { 0x5555_5555 } else { 0 };
                    let mut expected = seed.clone();
                    let mut actual = seed.clone();
                    append_pillbug_relocations_reference(&board, actor, Hex::ORIGIN, immobilized, mask, &mut expected);
                    append_pillbug_relocations(&board, actor, Hex::ORIGIN, immobilized, mask, &mut actual);
                    assert_eq!(actual, expected, "pattern {pattern}, actor {actor}, mode {mode}");
                    append_pillbug_relocations(&board, actor, Hex::ORIGIN, immobilized, mask, &mut actual);
                    assert_eq!(actual, expected, "duplicate relocations were appended");
                }
            }
        }
    }

    #[test]
    fn spider_neighbor_mask_matches_reference_paths_and_prefixes() {
        let source = Hex::new(25, -30);
        let spider = Piece::new(Color::White, Bug::Spider, 1);
        let mut cells = Vec::new();
        for q in -3_i16..=3 {
            for r in -3_i16..=3 {
                if (q != 0 || r != 0) && (q + r).abs() <= 3 {
                    cells.push(Hex::new(source.q + q, source.r + r));
                }
            }
        }
        let mut random = 17_u64;
        for case in 0..320 {
            let mut board = Board::new(GameType::mlp());
            put(&mut board, spider, source);
            let mut pieces = Piece::all_for(Color::Black, GameType::mlp()).into_iter();
            let ring = source.neighbors();
            for (i, &hex) in cells.iter().enumerate() {
                random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                let occupied = if case < 64 {
                    ring.iter().position(|&h| h == hex).is_some_and(|bit| case & (1 << bit) != 0)
                } else {
                    (random >> 60) < 5 && i % 2 == case % 2
                };
                if occupied {
                    if let Some(piece) = pieces.next() { put(&mut board, piece, hex); }
                }
            }
            let before = board.position_key();
            let mut expected = vec![source.neighbors()[0], Hex::new(100, 100)];
            let mut actual = expected.clone();
            let mut path = [source; 4];
            spider_dfs_reference(&board, source, source, 0, &mut path, &mut expected);
            spider_moves_into(&board, source, &mut actual);
            assert_eq!(actual, expected, "Spider path/order mismatch in case {case}");
            assert_eq!(board.position_key(), before);
        }
    }

    #[test]
    fn ladybug_drop_ring_matches_reference_with_tall_gates_and_prefixes() {
        let source = Hex::new(-20, 35);
        let ladybug = Piece::new(Color::White, Bug::Ladybug, 1);
        let mut random = 91_u64;
        for case in 0..512 {
            let mut board = Board::new(GameType::mlp());
            put(&mut board, ladybug, source);
            let mut pieces = Color::ALL.into_iter()
                .flat_map(|color| Piece::all_for(color, GameType::mlp()))
                .filter(|&piece| piece != ladybug);
            for q in -3_i16..=3 {
                for r in -3_i16..=3 {
                    if (q == 0 && r == 0) || (q + r).abs() > 3 { continue; }
                    random = random.wrapping_mul(6364136223846793005).wrapping_add(1);
                    let height = if random >> 60 < 5 { 1 + ((random >> 32) % 3) } else { 0 };
                    let hex = Hex::new(source.q + q, source.r + r);
                    for level in 0..height {
                        if let Some(piece) = pieces.next() {
                            if level == 0 {
                                put(&mut board, piece, hex);
                            } else {
                                let staging = Hex::new(10, 10);
                                put(&mut board, piece, staging);
                                if board.side_to_move() != piece.color {
                                    board.make_unchecked(HiveMove::Pass).unwrap();
                                }
                                board.make_unchecked(HiveMove::Move { piece, from: staging, to: hex }).unwrap();
                            }
                        }
                    }
                }
            }
            let before = board.position_key();
            let mut expected = vec![source.neighbors()[0], Hex::new(100, 100)];
            let mut actual = expected.clone();
            ladybug_moves_reference(&board, source, &mut expected);
            ladybug_moves_into(&board, source, &mut actual);
            assert_eq!(actual, expected, "Ladybug path/order mismatch in case {case}");
            assert_eq!(board.position_key(), before);
        }
    }

    #[test]
    fn pillbug_destination_mask_preserves_mixed_duplicate_prefixes() {
        let mut board = Board::new(GameType::mlp());
        let actor = Piece::new(Color::White, Bug::Pillbug, 1);
        put(&mut board, actor, Hex::ORIGIN);
        put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), Hex::new(1, 0));
        put(&mut board, Piece::new(Color::Black, Bug::Ant, 1), Hex::new(1, -1));
        let mut all = Vec::new();
        append_pillbug_relocations_reference(&board, actor, Hex::ORIGIN, None, 0, &mut all);
        assert!(all.len() >= 4);
        for subset in 0..(1_usize << all.len()) {
            let mut prefix = vec![HiveMove::Pass];
            for (i, &mv) in all.iter().enumerate() {
                if subset & (1 << i) == 0 { continue; }
                let HiveMove::Pillbug { piece, from, to, .. } = mv else { unreachable!() };
                prefix.push(if i % 2 == 0 {
                    HiveMove::Move { piece, from, to }
                } else {
                    HiveMove::Pillbug { actor: Piece::new(Color::White, Bug::Mosquito, 1), piece, from, to }
                });
            }
            let mut expected = prefix.clone();
            let mut actual = prefix.clone();
            append_pillbug_relocations_reference(&board, actor, Hex::ORIGIN, None, 0, &mut expected);
            append_pillbug_relocations(&board, actor, Hex::ORIGIN, None, 0, &mut actual);
            assert_eq!(actual, expected, "existing destination subset {subset}");
            assert_eq!(&actual[..prefix.len()], prefix.as_slice());
        }
    }

    #[test]
    fn initial_perft_counts_match_canonical_opening_counts() {
        let mut base = Board::new(GameType::base());
        assert_eq!(base.perft(1), 4);
        assert_eq!(base.perft(2), 96);

        let mut mlp = Board::new(GameType::mlp());
        assert_eq!(mlp.perft(1), 7);
        assert_eq!(mlp.perft(2), 294);
    }

    #[test]
    fn ant_traversal_excludes_source_and_preserves_existing_destinations() {
        let mut board = Board::new(GameType::mlp());
        let source = Hex::new(1, 0);
        put(&mut board, Piece::new(Color::White, Bug::Queen, 1), Hex::new(-1, 0));
        put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), Hex::new(0, 0));
        put(&mut board, Piece::new(Color::White, Bug::Ant, 1), source);

        let prefix = Hex::new(20, 20);
        let mut actual = vec![prefix];
        ant_moves_into(&board, source, &mut actual);
        assert_eq!(actual[0], prefix);
        assert!(actual.len() > 1);
        assert!(!actual[1..].contains(&source), "Ant cannot move to its own source");

        let mut expected = vec![prefix];
        ant_moves_heap_fallback(&board, source, &mut expected, 1);
        actual[1..].sort_unstable();
        expected[1..].sort_unstable();
        assert_eq!(actual, expected);

        // A fallback must discard partial Ant results but keep earlier copied moves.
        let mut partial = vec![prefix, Hex::new(25, 25), Hex::new(26, 26)];
        ant_moves_heap_fallback(&board, source, &mut partial, 1);
        partial[1..].sort_unstable();
        assert_eq!(partial, expected);
    }

    #[test]
    fn ant_shared_snapshot_edges_preserve_fallback_and_prefix() {
        for origin in [Hex::ORIGIN, Hex::new(-500, 500)] {
            for axis in 0..2 {
                for coordinate in [0, 1, 2, 61, 62, 63] {
                    let mut board = Board::new(GameType::mlp());
                    put(&mut board, Piece::new(Color::White, Bug::Ant, 1), origin);
                    put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), origin.neighbor(crate::Direction::E));
                    let delta = coordinate - 32;
                    let far = if axis == 0 { Hex::new(origin.q + delta, origin.r) }
                              else { Hex::new(origin.q, origin.r + delta) };
                    put(&mut board, Piece::new(Color::White, Bug::Ant, 2), far);
                    let inward = if coordinate < 32 { 1 } else { -1 };
                    let neighbor = if axis == 0 { Hex::new(far.q + inward, far.r) }
                                   else { Hex::new(far.q, far.r + inward) };
                    put(&mut board, Piece::new(Color::Black, Bug::Ant, 1), neighbor);
                    let occupancy = AntOccupancy::new(&board, origin).unwrap();
                    let prefix = Hex::new(123, 456);
                    let original_rows = occupancy.grid.rows;
                    let mut cache = Some(Some(occupancy));
                    for moving_source in [origin, far] {
                        let mut actual = vec![prefix];
                        let mut expected = actual.clone();
                        ant_moves_shared(&board, moving_source, &mut actual, &mut cache);
                        ant_moves_heap_fallback(&board, moving_source, &mut expected, 1);
                        assert_eq!(actual, expected);
                        assert_eq!(cache.as_ref().unwrap().as_ref().unwrap().grid.rows, original_rows);
                    }
                }
            }
        }
    }

    #[test]
    fn ant_occupancy_matches_board_and_heap_for_all_neighbor_patterns() {
        for source in [Hex::ORIGIN, Hex::new(-500, 500), Hex::new(30000, -30000)] {
            for pattern in 0_u8..64 {
                let mut board = Board::new(GameType::mlp());
                put(&mut board, Piece::new(Color::White, Bug::Ant, 1), source);
                for (i, hex) in source.neighbors().into_iter().enumerate() {
                    if pattern & (1 << i) != 0 {
                        put(&mut board, Piece::new(Color::Black, Bug::ALL[i], 1), hex);
                    }
                }
                let mut occupancy = AntOccupancy::new(&board, source).unwrap();
                occupancy.lift_source(source).unwrap();
                for dq in -2..=2 {
                    for dr in -2..=2 {
                        let current = Hex::new(source.q + dq, source.r + dr);
                        let mut expected = 0;
                        for (i, hex) in current.neighbors().into_iter().enumerate() {
                            if hex != source && board.is_occupied(hex) {
                                expected |= 1 << i;
                            }
                        }
                        assert_eq!(occupancy.neighbor_mask(current), Some(expected));
                    }
                }
                let mut actual = vec![Hex::new(100, 100)];
                let mut expected = actual.clone();
                ant_moves_into(&board, source, &mut actual);
                ant_moves_heap_fallback(&board, source, &mut expected, 1);
                // Preserve order as well as the destination set.
                assert_eq!(actual, expected);
            }
        }
    }

    #[test]
    fn ant_occupancy_out_of_window_falls_back_without_losing_prefix() {
        let source = Hex::ORIGIN;
        for far in [Hex::new(-33, 0), Hex::new(32, 0), Hex::new(0, -33), Hex::new(0, 32)] {
            let mut board = Board::new(GameType::mlp());
            put(&mut board, Piece::new(Color::White, Bug::Ant, 1), source);
            put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), Hex::new(1, 0));
            put(&mut board, Piece::new(Color::White, Bug::Queen, 1), far);
            assert!(AntOccupancy::new(&board, source).is_none());
            let mut actual = vec![Hex::new(100, 100)];
            let mut expected = actual.clone();
            ant_moves_into(&board, source, &mut actual);
            ant_moves_heap_fallback(&board, source, &mut expected, 1);
            assert_eq!(actual, expected);
        }
        let board = Board::new(GameType::mlp());
        let occupancy = AntOccupancy::new(&board, source).unwrap();
        for hex in [Hex::new(-32, 0), Hex::new(31, 0), Hex::new(0, -32), Hex::new(0, 31)] {
            assert_eq!(occupancy.neighbor_mask(hex), None);
        }
        for hex in [Hex::new(-28, 0), Hex::new(28, 0), Hex::new(0, -28), Hex::new(0, 28)] {
            assert_eq!(occupancy.neighbor_mask(hex), Some(0));
        }
    }

    #[test]
    fn shared_ant_occupancy_restores_sources_for_ants_and_mosquito() {
        let mut board = Board::new(GameType::mlp());
        let a = Hex::new(-1, 0);
        let b = Hex::new(2, 0);
        let mosquito = Hex::new(-1, 1);
        put(&mut board, Piece::new(Color::White, Bug::Queen, 1), Hex::ORIGIN);
        put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), Hex::new(1, 0));
        put(&mut board, Piece::new(Color::White, Bug::Ant, 1), a);
        put(&mut board, Piece::new(Color::White, Bug::Ant, 2), b);
        put(&mut board, Piece::new(Color::White, Bug::Mosquito, 1), mosquito);
        let mut cache = None;
        let original = AntOccupancy::new(&board, a).unwrap().grid.rows;
        for source in [a, b, a, b] {
            let mut actual = vec![Hex::new(90, 90)];
            let mut expected = actual.clone();
            ant_moves_shared(&board, source, &mut actual, &mut cache);
            ant_moves_heap_fallback(&board, source, &mut expected, 1);
            assert_eq!(actual, expected);
            let grid = &cache.as_ref().unwrap().as_ref().unwrap().grid;
            assert_eq!(grid.origin, a);
            assert_eq!(grid.rows, original);
        }
        let mut actual = Vec::new();
        let mut expected = Vec::new();
        mosquito_moves_into(&board, mosquito, &mut actual, &mut cache);
        mosquito_moves_into(&board, mosquito, &mut expected, &mut None);
        assert_eq!(actual, expected);
        assert_eq!(cache.as_ref().unwrap().as_ref().unwrap().grid.rows, original);
    }

    #[test]
    fn shared_ant_occupancy_restores_source_after_boundary_fallback() {
        let mut board = Board::new(GameType::mlp());
        let a = Hex::ORIGIN;
        let b = Hex::new(-2, 0);
        put(&mut board, Piece::new(Color::White, Bug::Ant, 1), a);
        put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), Hex::new(-1, 0));
        put(&mut board, Piece::new(Color::White, Bug::Ant, 2), b);
        // Force the first source onto column 63: lifting succeeds, then the
        // traversal falls back because its neighbor query needs column 64.
        let occupancy = AntOccupancy::new(&board, Hex::new(-31, 0)).unwrap();
        let original = occupancy.grid.rows;
        let mut cache = Some(Some(occupancy));
        for source in [a, b, a] {
            let mut actual = vec![Hex::new(90, 90)];
            let mut expected = actual.clone();
            ant_moves_shared(&board, source, &mut actual, &mut cache);
            ant_moves_heap_fallback(&board, source, &mut expected, 1);
            assert_eq!(actual, expected);
            assert_eq!(cache.as_ref().unwrap().as_ref().unwrap().grid.rows, original);
        }
    }

    #[test]
    fn shared_ant_occupancy_remembers_unavailable_imported_geometry() {
        let mut board = Board::new(GameType::mlp());
        let a = Hex::ORIGIN;
        let b = Hex::new(40, 0);
        put(&mut board, Piece::new(Color::White, Bug::Ant, 1), a);
        put(&mut board, Piece::new(Color::White, Bug::Ant, 2), b);
        put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), Hex::new(1, 0));
        let mut cache = None;
        for source in [a, b, a] {
            let mut actual = vec![Hex::new(90, 90)];
            let mut expected = actual.clone();
            ant_moves_shared(&board, source, &mut actual, &mut cache);
            ant_moves_heap_fallback(&board, source, &mut expected, 1);
            assert_eq!(actual, expected);
            assert!(matches!(cache, Some(None)));
        }
    }

    #[test]
    fn packed_ant_grid_extreme_coordinates_use_general_traversal() {
        for source in [
            Hex::new(i16::MIN + 4, 100), Hex::new(i16::MAX - 4, 100),
            Hex::new(100, i16::MIN + 4), Hex::new(100, i16::MAX - 4),
        ] {
            let mut board = Board::new(GameType::mlp());
            put(&mut board, Piece::new(Color::White, Bug::Ant, 1), source);
            put(&mut board, Piece::new(Color::Black, Bug::Queen, 1), Hex::new(source.q + 1, source.r));
            assert!(AntOccupancy::new(&board, source).is_none());
            let mut actual = vec![Hex::new(90, 90)];
            let mut expected = actual.clone();
            ant_moves_into(&board, source, &mut actual);
            ant_moves_heap_fallback(&board, source, &mut expected, 1);
            assert_eq!(actual, expected);
            assert!(actual.len() > 1);
        }
        let board = Board::new(GameType::mlp());
        assert!(AntOccupancy::new(&board, Hex::new(i16::MIN + 32, i16::MAX - 31)).is_some());
        assert!(AntOccupancy::new(&board, Hex::new(i16::MAX - 31, i16::MIN + 32)).is_some());
    }

    #[test]
    fn packed_ant_grid_steps_match_hex_neighbors_without_row_wrap() {
        for y in 1_u16..63 {
            for x in 1_u16..63 {
                let index = y * 64 + x;
                let hex = Hex::new(x as i16 - 32, y as i16 - 32);
                for (i, expected) in hex.neighbors().into_iter().enumerate() {
                    let next = (index as i16 + ANT_GRID_STEPS[i]) as u16;
                    assert_eq!(Hex::new((next & 63) as i16 - 32, (next >> 6) as i16 - 32), expected);
                }
            }
        }
    }

    #[test]
    fn packed_ant_grid_handles_full_inventory_chains_in_all_directions() {
        let ant = Piece::new(Color::White, Bug::Ant, 1);
        for origin in [Hex::ORIGIN, Hex::new(-500, 500), Hex::new(30000, -30000)] {
            for direction in crate::Direction::ALL {
                let mut board = Board::new(GameType::mlp());
                put(&mut board, ant, origin);
                let mut cursor = origin;
                for color in Color::ALL {
                    for piece in Piece::all_for(color, GameType::mlp()) {
                        if piece == ant { continue; }
                        cursor = cursor.neighbor(direction);
                        put(&mut board, piece, cursor);
                    }
                }
                assert_eq!(board.occupied_hex_count(), 28);
                let mut actual = vec![Hex::new(90, 90)];
                let mut expected = actual.clone();
                ant_moves_into(&board, origin, &mut actual);
                ant_moves_heap_fallback(&board, origin, &mut expected, 1);
                assert_eq!(actual, expected);
                assert!(!actual[1..].contains(&origin));
            }
        }
    }

    #[test]
    fn ant_seen_relative_bitset_tracks_legal_window_without_hashing() {
        let origin = Hex::new(7, -11);
        let mut seen = AntSeen::new(origin);

        for dq in -28_i16..=28 {
            for dr in -28_i16..=28 {
                let hex = Hex::new(origin.q + dq, origin.r + dr);
                assert_eq!(seen.insert(hex), Some(true));
                assert_eq!(seen.insert(hex), Some(false));
            }
        }

        assert_eq!(seen.insert(Hex::new(origin.q + 40, origin.r)), None);
        assert_eq!(seen.insert(Hex::new(origin.q, origin.r - 40)), None);
    }

    #[test]
    fn ant_step_mask_matches_slide_rule_for_all_neighbor_patterns() {
        for occupied_mask in 0_u8..64 {
            let mut expected = 0_u8;
            for i in 0..6 {
                if (occupied_mask & (1_u8 << i)) != 0 {
                    continue;
                }
                let left = (occupied_mask & (1_u8 << ((i + 5) % 6))) != 0;
                let right = (occupied_mask & (1_u8 << ((i + 1) % 6))) != 0;
                if left != right {
                    expected |= 1_u8 << i;
                }
            }
            assert_eq!(ANT_LEGAL_STEP_MASK[occupied_mask as usize], expected);
        }
    }

    #[test]
    fn articulation_neighbors_match_pairwise_reference() {
        let pieces: Vec<_> = Color::ALL.into_iter().flat_map(|color| {
            Bug::ALL.into_iter().flat_map(move |bug| {
                (1..=bug.copies()).map(move |n| Piece::new(color, bug, n))
            })
        }).collect();
        // All 4x3 subsets exercise connected/disconnected shapes and both
        // adjacency construction paths. Additional stacked variants ensure
        // that a covered articulation piece never pins its movable top bug.
        for mask in 0_u16..4096 {
            let mut board = Board::new(GameType::mlp());
            let mut next = 0;
            for cell in 0..12 {
                if mask & (1 << cell) == 0 { continue; }
                put(&mut board, pieces[next], Hex::new(cell % 4, cell / 4));
                next += 1;
            }
            assert_eq!(articulation_piece_mask(&board),
                       articulation_piece_mask_pairwise(&board), "mask {mask}");
            if next > 0 {
                let top = Piece::new(Color::Black, Bug::Beetle, 1);
                put(&mut board, top, Hex::new(8, 0));
                let destination = board.occupied_hexes().find(|h| *h != Hex::new(8, 0)).unwrap();
                if board.side_to_move() != top.color {
                    board.make_unchecked(HiveMove::Pass).unwrap();
                }
                board.make_unchecked(HiveMove::Move {
                    piece: top, from: Hex::new(8, 0), to: destination,
                }).unwrap();
                assert_eq!(articulation_piece_mask(&board),
                           articulation_piece_mask_pairwise(&board), "stack mask {mask}");
            }
        }
        // Large connected and disconnected fixtures, translated away from the
        // origin, include all 28 physical pieces and longer table probe chains.
        for spacing in [1, 3] {
            for count in 0..=28 {
                let mut board = Board::new(GameType::mlp());
                for (i, &piece) in pieces[..count].iter().enumerate() {
                    put(&mut board, piece, Hex::new(-120 + i as i16 * spacing, 85));
                }
                assert_eq!(articulation_piece_mask(&board), articulation_piece_mask_pairwise(&board));
            }
        }
    }

    #[test]
    fn direct_piece_connectivity_matches_pairwise_in_all_variants() {
        for mask in 0..8 {
            let game_type = GameType { mosquito: mask & 1 != 0,
                ladybug: mask & 2 != 0, pillbug: mask & 4 != 0 };
            for seed in 1..=8_u64 {
                let mut board = Board::new(game_type);
                let mut rng = seed;
                for _ in 0..100 {
                    assert_eq!(articulation_piece_mask(&board),
                               articulation_piece_mask_pairwise(&board));
                    let moves = board.legal_moves();
                    if moves.is_empty() { break; }
                    rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
                    let mv = moves[rng as usize % moves.len()];
                    let undo = board.make_unchecked(mv).unwrap();
                    assert_eq!(articulation_piece_mask(&board),
                               articulation_piece_mask_pairwise(&board));
                    board.undo(undo).unwrap();
                    assert_eq!(articulation_piece_mask(&board),
                               articulation_piece_mask_pairwise(&board));
                    board.make_unchecked(mv).unwrap();
                }
            }
        }
    }

    #[test]
    fn targeted_hints_match_full_membership_across_variants_and_mutations() {
        let mut checked = 0;
        for mask in 0..8 {
            let gt = GameType { mosquito: mask & 1 != 0, ladybug: mask & 2 != 0,
                                pillbug: mask & 4 != 0 };
            for seed in 1..=4_u64 {
                let mut board = Board::new(gt);
                let mut rng = seed;
                let mut previous = Vec::new();
                for _ in 0..100 {
                    let legal = board.legal_moves();
                    let check = |mv| {
                        if let Some(actual) = board.is_legal_search_hint(mv) {
                            assert_eq!(actual, legal.contains(&mv), "mask {mask}, {mv:?}");
                        }
                    };
                    for &mv in legal.iter().chain(previous.iter()) {
                        check(mv);
                        match mv {
                            HiveMove::Place { piece, to } => {
                                check(HiveMove::Place { piece, to: Hex::new(to.q + 1, to.r) });
                                check(HiveMove::Place { piece: Piece::new(piece.color.other(), piece.bug, piece.number), to });
                                check(HiveMove::Place { piece: Piece::new(piece.color, piece.bug, 0), to });
                            }
                            HiveMove::Move { piece, from, to } => {
                                check(HiveMove::Move { piece, from, to: from });
                                check(HiveMove::Move { piece, from: to, to: from });
                                check(HiveMove::Move { piece, from, to: Hex::new(to.q + 1, to.r) });
                                check(HiveMove::Move { piece: Piece::new(piece.color.other(), piece.bug, piece.number), from, to });
                            }
                            _ => {}
                        }
                        checked += 1;
                    }
                    check(HiveMove::Place { piece: Piece::new(board.side_to_move(), Bug::Ant, 1), to: Hex::new(99, 99) });
                    assert!(board.is_legal_search_hint(HiveMove::Pass).is_none() || board.game_over());
                    if legal.is_empty() { break; }
                    rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
                    let mv = legal[rng as usize % legal.len()];
                    let undo = board.make_unchecked(mv).unwrap();
                    board.undo(undo).unwrap();
                    for &candidate in &legal {
                        if let Some(actual) = board.is_legal_search_hint(candidate) { assert!(actual); }
                    }
                    previous = legal;
                    board.make_unchecked(mv).unwrap();
                }
            }
        }
        assert!(checked > 10000);
    }

    #[test]
    fn targeted_hints_reject_pinned_covered_and_relocated_pieces() {
        let mut board = Board::new(GameType::mlp());
        let wq = Piece::new(Color::White, Bug::Queen, 1);
        let bq = Piece::new(Color::Black, Bug::Queen, 1);
        let wb = Piece::new(Color::White, Bug::Beetle, 1);
        put(&mut board, wq, Hex::new(0, 0));
        put(&mut board, bq, Hex::new(2, 0));
        put(&mut board, wb, Hex::new(1, 0));
        if board.side_to_move() != Color::White { board.make_unchecked(HiveMove::Pass).unwrap(); }
        let pinned = HiveMove::Move { piece: wb, from: Hex::new(1, 0), to: Hex::new(1, 1) };
        assert_eq!(board.is_legal_search_hint(pinned), Some(false));
        assert!(!board.legal_moves().contains(&pinned));
        // Structural fixture: cover the Queen, then restore White's turn.
        board.make_unchecked(HiveMove::Move { piece: wb, from: Hex::new(1, 0), to: Hex::ORIGIN }).unwrap();
        board.make_unchecked(HiveMove::Pass).unwrap();
        let covered = HiveMove::Move { piece: wq, from: Hex::ORIGIN, to: Hex::new(0, 1) };
        assert_eq!(board.is_legal_search_hint(covered), Some(false));
        assert!(!board.legal_moves().contains(&covered));
        for mv in board.legal_moves() {
            if let Some(legal) = board.is_legal_search_hint(mv) { assert!(legal); }
        }

        let mut board = Board::new(GameType::mlp());
        let bp = Piece::new(Color::Black, Bug::Pillbug, 1);
        let wa = Piece::new(Color::White, Bug::Ant, 1);
        for (piece, hex) in [(wq, Hex::ORIGIN), (bq, Hex::new(2, 0)),
                             (bp, Hex::new(1, 0)), (wa, Hex::new(0, 1))] {
            put(&mut board, piece, hex);
        }
        if board.side_to_move() != Color::Black { board.make_unchecked(HiveMove::Pass).unwrap(); }
        let relocation = HiveMove::Pillbug { actor: bp, piece: wa,
            from: Hex::new(0, 1), to: Hex::new(1, 1) };
        assert_eq!(board.is_legal_search_hint(relocation), None);
        board.make_unchecked(relocation).unwrap();
        let stunned = HiveMove::Move { piece: wa, from: Hex::new(1, 1), to: Hex::new(0, 1) };
        assert_eq!(board.is_legal_search_hint(stunned), Some(false));
        assert!(!board.legal_moves().contains(&stunned));
    }

    #[test]
    fn articulation_finds_middle_of_three_cell_line() {
        let mut board = Board::new(GameType::mlp());
        put(
            &mut board,
            Piece::new(Color::White, Bug::Queen, 1),
            Hex::new(-1, 0),
        );
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Queen, 1),
            Hex::new(0, 0),
        );
        put(
            &mut board,
            Piece::new(Color::White, Bug::Ant, 1),
            Hex::new(1, 0),
        );

        let points = articulation_points(&board);
        assert_eq!(points.len(), 1);
        assert!(points.contains(&Hex::new(0, 0)));
    }

    #[test]
    fn ordinary_ground_gate_blocks_queen_slide() {
        let mut board = Board::new(GameType::mlp());
        let wq = Piece::new(Color::White, Bug::Queen, 1);
        put(&mut board, wq, Hex::new(0, 0));
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Queen, 1),
            Hex::new(0, -1),
        );
        put(
            &mut board,
            Piece::new(Color::White, Bug::Ant, 1),
            Hex::new(1, -1),
        );
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Ant, 1),
            Hex::new(-1, 0),
        );
        put(
            &mut board,
            Piece::new(Color::White, Bug::Spider, 1),
            Hex::new(-1, 1),
        );
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Spider, 1),
            Hex::new(0, 1),
        );

        let destinations = queen_like_moves(&board, Hex::new(0, 0));
        assert!(!destinations.contains(&Hex::new(1, 0)));
    }

    #[test]
    fn ground_slider_cannot_detach_and_reattach_across_empty_shared_flanks() {
        let mut board = Board::new(GameType::mlp());
        let wb = Piece::new(Color::White, Bug::Beetle, 1);

        // The Beetle at (0, 0) and the empty destination (-1, 0) each touch
        // the same connected Hive, but the two hexes shared by that movement
        // edge, (0, -1) and (-1, 1), are both empty. A ground-level move
        // would therefore lose contact with the Hive during the slide.
        put(&mut board, wb, Hex::new(0, 0));
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Queen, 1),
            Hex::new(1, -1),
        );
        put(
            &mut board,
            Piece::new(Color::White, Bug::Queen, 1),
            Hex::new(1, -2),
        );
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Ant, 1),
            Hex::new(0, -2),
        );
        put(
            &mut board,
            Piece::new(Color::White, Bug::Ant, 1),
            Hex::new(-1, -1),
        );

        assert!(!ground_gate_open(
            &board,
            Hex::new(0, 0),
            Hex::new(-1, 0),
            Hex::new(0, 0),
        ));
        assert!(!beetle_moves(&board, Hex::new(0, 0)).contains(&Hex::new(-1, 0)));
    }

    #[test]
    fn beetle_can_climb_through_ground_level_gate() {
        let mut board = Board::new(GameType::mlp());
        let wb = Piece::new(Color::White, Bug::Beetle, 1);
        put(&mut board, wb, Hex::new(0, 0));
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Queen, 1),
            Hex::new(1, 0),
        );
        put(
            &mut board,
            Piece::new(Color::White, Bug::Ant, 1),
            Hex::new(1, -1),
        );
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Ant, 1),
            Hex::new(0, 1),
        );

        assert!(beetle_moves(&board, Hex::new(0, 0)).contains(&Hex::new(1, 0)));
    }

    #[test]
    fn grasshopper_jumps_first_contiguous_run() {
        let mut board = Board::new(GameType::mlp());
        let wg = Piece::new(Color::White, Bug::Grasshopper, 1);
        put(&mut board, wg, Hex::new(0, 0));
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Queen, 1),
            Hex::new(1, 0),
        );
        put(
            &mut board,
            Piece::new(Color::White, Bug::Queen, 1),
            Hex::new(2, 0),
        );

        let destinations = grasshopper_moves(&board, Hex::new(0, 0));
        assert!(destinations.contains(&Hex::new(3, 0)));
    }

    #[test]
    fn mosquito_on_stack_is_beetle_only() {
        let mut board = Board::new(GameType::mlp());
        let wm = Piece::new(Color::White, Bug::Mosquito, 1);
        put(
            &mut board,
            Piece::new(Color::White, Bug::Queen, 1),
            Hex::new(0, 0),
        );
        put(
            &mut board,
            Piece::new(Color::Black, Bug::Queen, 1),
            Hex::new(1, 0),
        );
        put(&mut board, wm, Hex::new(-1, 0));
        if board.side_to_move() != Color::White {
            board.make_unchecked(HiveMove::Pass).unwrap();
        }
        board
            .make_unchecked(HiveMove::Move {
                piece: wm,
                from: Hex::new(-1, 0),
                to: Hex::new(0, 0),
            })
            .unwrap();

        assert_eq!(board.stack_height(Hex::new(0, 0)), 2);
        assert_eq!(
            mosquito_moves(&board, Hex::new(0, 0)),
            beetle_moves(&board, Hex::new(0, 0))
        );
    }

    #[test]
    fn local_ring_shortcut_matches_graph_for_all_patterns() {
        let source=Piece::new(Color::White,Bug::Queen,1);
        let inventory=Piece::all_for(Color::Black,GameType::mlp());
        for mask in 0..64 {
            for disconnected in [false,true] {
                let mut board=Board::new(GameType::mlp());put(&mut board,source,Hex::ORIGIN);
                for (i,h) in Hex::ORIGIN.neighbors().into_iter().enumerate() {
                    if mask & (1<<i)!=0 {put(&mut board,inventory[i],h);}
                }
                if disconnected {put(&mut board,inventory[7],Hex::new(20,20));}
                let local=locally_connected_after_lift(&board,Hex::ORIGIN);
                let graph=articulation_piece_mask_pairwise(&board)&(1<<source.id())==0;
                assert_eq!(local,graph,"mask {mask} disconnected {disconnected}");
            }
        }
    }

    #[test]
    fn direct_steps_match_all_destinations_on_ring_and_stack_patterns() {
        fn add(board:&mut Board,piece:Piece,hex:Hex) {
            if !board.is_occupied(hex) {put(board,piece,hex);return;}
            let staging=Hex::new(100+piece.id() as i16*3,100);
            put(board,piece,staging);
            if board.side_to_move()!=piece.color {board.make_unchecked(HiveMove::Pass).unwrap();}
            board.make_unchecked(HiveMove::Move{piece,from:staging,to:hex}).unwrap();
        }
        for bug in [Bug::Queen,Bug::Pillbug,Bug::Beetle] {
            for mask in 0..64 {
                for tall in 0..3 {
                    let mut board=Board::new(GameType::mlp());
                    let mut inventory=Piece::all_for(Color::Black,GameType::mlp()).into_iter();
                    for (i,h) in Hex::ORIGIN.neighbors().into_iter().enumerate() {
                        if mask&(1<<i)!=0 {
                            add(&mut board,inventory.next().unwrap(),h);
                            if tall==2 {add(&mut board,inventory.next().unwrap(),h);}
                        }
                    }
                    if tall>0 {add(&mut board,inventory.next().unwrap(),Hex::ORIGIN);}
                    let piece=Piece::new(Color::White,bug,1);add(&mut board,piece,Hex::ORIGIN);
                    let mut expected=Vec::new();movement_destinations_into(&board,piece,Hex::ORIGIN,&mut expected,&mut None);
                    for to in Hex::ORIGIN.neighbors().into_iter().chain([Hex::ORIGIN,Hex::new(2,0),Hex::new(i16::MAX,i16::MIN)]) {
                        assert_eq!(direct_step_hint(&board,piece,Hex::ORIGIN,to),Some(expected.contains(&to)));
                    }
                }
            }
        }
    }

    #[test]
    fn ant_target_matches_full_traversal_and_declines_wide_geometry() {
        for mask in 0..64 {
            let mut board=Board::new(GameType::mlp());
            let piece=Piece::new(Color::White,Bug::Ant,1);put(&mut board,piece,Hex::ORIGIN);
            let inventory=Piece::all_for(Color::Black,GameType::mlp());
            for (i,h) in Hex::ORIGIN.neighbors().into_iter().enumerate() {
                if mask&(1<<i)!=0 {put(&mut board,inventory[i],h);}
            }
            let before=board.position_key();let mut expected=Vec::new();ant_moves_shared(&board,Hex::ORIGIN,&mut expected,&mut None);
            for q in -4..=4 {for r in -4..=4 {
                let target=Hex::new(q,r);
                assert_eq!(ant_target_hint(&board,Hex::ORIGIN,target),Some(expected.contains(&target)));
                assert_eq!(board.position_key(),before);
            }}
            assert_eq!(ant_target_hint(&board,Hex::ORIGIN,Hex::new(100,100)),None);
        }
        let mut board=Board::new(GameType::mlp());let ant=Piece::new(Color::White,Bug::Ant,1);
        put(&mut board,ant,Hex::ORIGIN);put(&mut board,Piece::new(Color::Black,Bug::Ant,1),Hex::new(100,100));
        assert_eq!(ant_target_hint(&board,Hex::ORIGIN,Hex::new(1,0)),None);
    }
}
