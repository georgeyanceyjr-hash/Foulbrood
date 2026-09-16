use foulbrood::{Board, Bug, Color, GameType, Hex, HiveMove};

#[test]
fn generated_placement_can_be_made_and_undone() {
    let mut board = Board::new(GameType::mlp());
    let before = board.position_key();
    let mv = board
        .legal_placements()
        .into_iter()
        .find(|mv| matches!(mv, HiveMove::Place { piece, .. } if piece.bug == Bug::Ant))
        .unwrap();

    let undo = board.make_unchecked(mv).unwrap();
    assert_eq!(board.side_to_move(), Color::Black);
    assert_eq!(board.piece_count_on_board(), 1);
    assert!(board.is_occupied(Hex::ORIGIN));

    board.undo(undo).unwrap();
    assert_eq!(board.position_key(), before);
    assert_eq!(board.piece_count_on_board(), 0);
}
