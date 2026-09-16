//! Bounded diagnostic: no heuristic at leaves, no pruning based on evaluation.
use foulbrood::{Board, Color, UhpGame, move_to_uhp};
fn forced_loss(board: &mut Board, loser: Color, depth: u8, budget: &mut u64) -> Option<bool> {
    if *budget == 0 { return None; }
    *budget -= 1;
    let ours = board.queen_surrounded(loser);
    let theirs = board.queen_surrounded(loser.other());
    if ours || theirs { return Some(ours && !theirs); }
    if depth == 0 { return Some(false); }
    let defender = board.side_to_move() == loser;
    let mut unknown = false;
    for mv in board.legal_moves() {
        let undo = board.make_unchecked(mv).unwrap();
        let result = forced_loss(board, loser, depth - 1, budget);
        board.undo(undo).unwrap();
        match result {
            Some(false) if defender => return Some(false),
            Some(true) if !defender => return Some(true),
            None => unknown = true,
            _ => (),
        }
    }
    if unknown { None } else { Some(defender) }
}
fn snapshot(board: &Board) -> String {
    let mut cells: Vec<_> = board.occupied_hexes().map(|h| (h, board.stack(h).unwrap().to_vec())).collect();
    cells.sort_by_key(|v| v.0);
    let pieces: Vec<_> = Color::ALL.into_iter().flat_map(|c| foulbrood::Piece::all_for(c, board.game_type()))
        .map(|p| (p, board.location(p), board.is_in_hand(p))).collect();
    format!("{:?}|{:?}|{:?}|{:?}|{}|{:?}|{:?}|{:?}", cells, pieces, board.game_type(),
        board.side_to_move(), board.ply(), board.turns_taken(Color::White),
        board.turns_taken(Color::Black), board.last_move())
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!((3..=5).contains(&args.len()), "usage: analyze_loss GAMESTRING HORIZON [MOVE|ROOT|DEFENSE] [NODE_BUDGET]");
    let game = UhpGame::from_game_string(&args[1]).unwrap();
    let horizon: u8 = args[2].parse().unwrap();
    assert!((1..=8).contains(&horizon));
    let original = game.board();
    let mut board = original.clone();
    let limit = args.get(4).map(|s| s.parse::<u64>().unwrap()).unwrap_or(2_000_000);
    if args.get(3).map(String::as_str) == Some("ROOT") {
        let mut budget = limit;
        let result = forced_loss(&mut board, original.side_to_move(), horizon, &mut budget);
        println!("ROOT\t{}\t{}", match result {Some(true)=>"loss",Some(false)=>"survives",None=>"unknown"}, limit-budget);
        assert_eq!(snapshot(&board), snapshot(original));
        return;
    }
    for mv in original.legal_moves() {
        if args.len() >= 4 && args[3] != "DEFENSE" && move_to_uhp(original, mv).unwrap() != args[3] { continue; }
        let undo = board.make_unchecked(mv).unwrap();
        let mut budget = limit;
        let result = forced_loss(&mut board, original.side_to_move(), horizon - 1, &mut budget);
        board.undo(undo).unwrap();
        println!("{}\t{}\t{}", move_to_uhp(original, mv).unwrap(),
            match result {Some(true)=>"loss",Some(false)=>"survives",None=>"unknown"}, limit-budget);
        if args.get(3).map(String::as_str) == Some("DEFENSE") && result == Some(false) { break; }
    }
    assert_eq!(snapshot(&board), snapshot(original));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminals_and_zero_budget_are_distinct() {
        for text in include_str!("../../tests/defense_terminal_positions.txt").lines() {
            let game = UhpGame::from_game_string(text).unwrap();
            for color in Color::ALL {
                let expected = game.board().queen_surrounded(color) && !game.board().queen_surrounded(color.other());
                assert_eq!(forced_loss(&mut game.board().clone(), color, 0, &mut 1), Some(expected));
                assert_eq!(forced_loss(&mut game.board().clone(), color, 4, &mut 0), None);
            }
        }
    }
    #[test]
    fn horizon_and_interruption_restore_semantic_state() {
        let game = UhpGame::from_game_string(include_str!("../../tests/defense_reference_position.txt").trim()).unwrap();
        let mut board = game.board().clone();
        let before = snapshot(&board);
        let side = board.side_to_move();
        assert_eq!(forced_loss(&mut board, side, 0, &mut 1), Some(false));
        assert_eq!(forced_loss(&mut board, side, 6, &mut 10), None);
        assert_eq!(snapshot(&board), before);
    }
    #[test]
    fn independently_proves_known_blunder_and_defense() {
        let position = include_str!("../../tests/defense_reference_position.txt").trim();
        for (mv, expected) in [("wB2 \\wA1", true), ("wS1 /bB2", false)] {
            let mut game = UhpGame::from_game_string(position).unwrap();
            let side = game.board().side_to_move();
            game.play(mv).unwrap();
            assert_eq!(forced_loss(&mut game.board().clone(), side, 5, &mut 2_000_000), Some(expected));
        }
    }
}
