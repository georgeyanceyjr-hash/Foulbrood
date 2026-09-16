use crate::{Board, Bug, Color, Hex, HiveMove};

impl Board {
    /// Generates legal placements only. This public convenience method owns its
    /// buffers; the search/perft path uses `append_legal_placements` so those
    /// allocations are reused across millions of nodes.
    ///
    /// Copies of the same bug are physically distinct in state, but reserve
    /// placement uses only the lowest-numbered remaining copy because choosing
    /// A2 instead of A1 cannot create a different Hive position.
    pub fn legal_placements(&self) -> Vec<HiveMove> {
        let mut moves = Vec::with_capacity(64);
        let mut targets = Vec::with_capacity(64);
        self.append_legal_placements(&mut moves, &mut targets);
        moves
    }

    pub(crate) fn append_legal_placements(
        &self,
        moves: &mut Vec<HiveMove>,
        targets: &mut Vec<Hex>,
    ) {
        let color = self.side_to_move();
        targets.clear();
        let first_turn = self.turns_taken(color) == 0;
        let force_queen = self.turns_taken(color) >= 3 && !self.queen_is_placed(color);

        // Reserve choices depend on the position, not the destination. Compute
        // them once, and avoid finding targets when no piece can be placed.
        let mut pieces = [crate::Piece::new(color, Bug::Queen, 1); 8];
        let mut count = 0;
        for bug in Bug::ALL {
            if (first_turn && bug == Bug::Queen) || (force_queen && bug != Bug::Queen) {
                continue;
            }
            if let Some(piece) = self.canonical_piece_in_hand(color, bug) {
                pieces[count] = piece;
                count += 1;
            }
        }
        if count == 0 {
            return;
        }

        self.placement_targets_into(color, targets);
        for &target in targets.iter() {
            for &piece in &pieces[..count] {
                moves.push(HiveMove::Place { piece, to: target });
            }
        }
    }

    pub(crate) fn is_legal_placement_hint(&self, piece: crate::Piece, to: Hex) -> bool {
        let color = self.side_to_move();
        let first = self.turns_taken(color) == 0;
        let force_queen = self.turns_taken(color) >= 3 && !self.queen_is_placed(color);
        if piece.color != color || (first && piece.bug == Bug::Queen)
            || (force_queen && piece.bug != Bug::Queen)
            || self.canonical_piece_in_hand(color, piece.bug) != Some(piece)
        { return false; }
        if self.occupied_hex_count() == 0 { return to == Hex::ORIGIN; }
        if first {
            return !self.is_occupied(to) && to.neighbors().iter().any(|&hex| self.is_occupied(hex));
        }
        self.is_legal_normal_placement_target(color, to)
    }

    #[cfg(test)]
    fn append_legal_placements_reference(&self, moves: &mut Vec<HiveMove>, targets: &mut Vec<Hex>) {
        let color = self.side_to_move();
        self.placement_targets_reference(color, targets);
        if targets.is_empty() {
            return;
        }

        let first_turn = self.turns_taken(color) == 0;
        let force_queen = self.turns_taken(color) >= 3 && !self.queen_is_placed(color);

        for &target in targets.iter() {
            for bug in Bug::ALL {
                if !self.game_type().includes(bug) {
                    continue;
                }
                if first_turn && bug == Bug::Queen {
                    continue;
                }
                if force_queen && bug != Bug::Queen {
                    continue;
                }
                if let Some(piece) = self.canonical_piece_in_hand(color, bug) {
                    moves.push(HiveMove::Place { piece, to: target });
                }
            }
        }
    }
    fn placement_targets_into(&self, color: Color, targets: &mut Vec<Hex>) {
        targets.clear();
        if self.occupied_hex_count() == 0 || self.turns_taken(color) == 0 {
            self.placement_targets_reference(color, targets);
            return;
        }
        let origin = self.occupied_hexes().next().unwrap();
        let mut friendly = [0_u64; 64];
        let mut blocked = [0_u64; 64];
        let mut first = 63_usize;
        let mut last = 0_usize;
        for (hex, top, _) in self.occupied_cell_summaries() {
            let q = i32::from(hex.q) - i32::from(origin.q) + 32;
            let r = i32::from(hex.r) - i32::from(origin.r) + 32;
            // Connected legal hives fit with room for their frontier. Imported
            // wide positions use the general coordinate-based implementation.
            if !(1..63).contains(&q) || !(1..63).contains(&r)
                || hex.q <= i16::MIN + 1 || hex.q >= i16::MAX - 1
                || hex.r <= i16::MIN + 1 || hex.r >= i16::MAX - 1
            {
                self.placement_targets_reference(color, targets);
                return;
            }
            let q = q as usize;
            let bit = 1_u64 << r;
            blocked[q] |= bit;
            let neighbors = if top.color == color { &mut friendly } else { &mut blocked };
            neighbors[q - 1] |= bit | (bit << 1);
            neighbors[q] |= (bit >> 1) | (bit << 1);
            neighbors[q + 1] |= bit | (bit >> 1);
            first = first.min(q - 1);
            last = last.max(q + 1);
        }
        // q-major, then ascending r is exactly Hex's derived ordering.
        for q in first..=last {
            let mut bits = friendly[q] & !blocked[q];
            while bits != 0 {
                let r = bits.trailing_zeros() as i32;
                bits &= bits - 1;
                targets.push(Hex::new(
                    (i32::from(origin.q) + q as i32 - 32) as i16,
                    (i32::from(origin.r) + r - 32) as i16,
                ));
            }
        }
    }

    fn placement_targets_reference(&self, color: Color, targets: &mut Vec<Hex>) {
        targets.clear();
        if self.occupied_hex_count() == 0 {
            targets.push(Hex::ORIGIN);
            return;
        }

        // A player's first piece is the sole exception to the normal
        // "touch friendly, touch no enemy" placement rule. In ordinary play
        // this is Black's first turn, adjacent to White's first piece.
        if self.turns_taken(color) == 0 {
            for occupied in self.occupied_hexes() {
                for neighbor in occupied.neighbors() {
                    if !self.is_occupied(neighbor) {
                        targets.push(neighbor);
                    }
                }
            }
            targets.sort_unstable();
            targets.dedup();
            return;
        }

        // A flat reusable Vec is substantially cheaper than allocating tree
        // nodes (or a fresh Vec) at every search node.
        for occupied in self.occupied_hexes() {
            if self.top_color(occupied) != Some(color) {
                continue;
            }
            for neighbor in occupied.neighbors() {
                if !self.is_occupied(neighbor) {
                    targets.push(neighbor);
                }
            }
        }
        targets.sort_unstable();
        targets.dedup();
        targets.retain(|target| self.is_legal_normal_placement_target(color, *target));
    }

    fn is_legal_normal_placement_target(&self, color: Color, target: Hex) -> bool {
        if self.is_occupied(target) {
            return false;
        }

        let mut touches_friendly = false;
        for neighbor in target.neighbors() {
            match self.top_color(neighbor) {
                Some(neighbor_color) if neighbor_color == color => touches_friendly = true,
                Some(_) => return false,
                None => {}
            }
        }
        touches_friendly
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use crate::{GameType, Piece};
    
    fn placement(board: &Board, bug: Bug, to: Hex) -> HiveMove {
        let piece = board
            .canonical_piece_in_hand(board.side_to_move(), bug)
            .expect("piece should be in hand");
        HiveMove::Place { piece, to }
    }

    #[test]
    fn reserve_list_matches_reference_across_reachable_games() {
        let mut positions = 0;
        for mask in 0..8 {
            let game_type = GameType {
                mosquito: mask & 1 != 0,
                ladybug: mask & 2 != 0,
                pillbug: mask & 4 != 0,
            };
            for seed in 1..=8_u64 {
                let mut rng = seed;
                let mut board = Board::new(game_type);
                for _ in 0..100 {
                    let mut expected = vec![HiveMove::Pass];
                    let mut actual = expected.clone();
                    let mut targets = vec![Hex::new(99, 99)];
                    board.append_legal_placements_reference(&mut expected, &mut Vec::new());
                    board.append_legal_placements(&mut actual, &mut targets);
                    assert_eq!(actual, expected, "mask {mask}, seed {seed}");
                    positions += 1;
                    let legal = board.legal_moves();
                    if legal.is_empty() { break; }
                    rng ^= rng << 13;
                    rng ^= rng >> 7;
                    rng ^= rng << 17;
                    let mv = legal[rng as usize % legal.len()];
                    let undo = board.make_unchecked(mv).unwrap();
                    board.undo(undo).unwrap();
                    assert_eq!(board.legal_placements(), expected[1..]);
                    board.make_unchecked(mv).unwrap();
                }
            }
        }
        assert!(positions > 1000);
    }

    #[test]
    fn mask_targets_match_general_path_on_translated_and_wide_positions() {
        for (q, r, spread) in [(0, 0, 1), (32000, -32000, 1),
                                (-32765, 32765, 1), (0, 0, 80), (0, 0, 30)] {
            let mut board = Board::new(GameType::mlp());
            for (color, hex) in [(Color::White, Hex::new(q, r)),
                                 (Color::Black, Hex::new(q + spread, r))] {
                board.make_unchecked(HiveMove::Place {
                    piece: Piece::new(color, Bug::Queen, 1), to: hex,
                }).unwrap();
            }
            for color in Color::ALL {
                let mut actual = vec![Hex::ORIGIN];
                let mut expected = Vec::new();
                board.placement_targets_into(color, &mut actual);
                board.placement_targets_reference(color, &mut expected);
                assert_eq!(actual, expected, "{q}, {r}, {spread}, {color:?}");
            }
        }
    }

    #[test]
    fn exhausted_reserve_clears_scratch_and_preserves_prefix() {
        for game_type in [GameType::base(), GameType::mlp()] {
            let mut board = Board::new(game_type);
            let mut q = 0;
            // Structural fixture: exhaust both hands, including all numbered
            // copies, independently of whether this line would end a real game.
            for bug in Bug::ALL {
                if !game_type.includes(bug) { continue; }
                for number in 1..=bug.copies() {
                    for color in Color::ALL {
                        board.make_unchecked(HiveMove::Place {
                            piece: Piece::new(color, bug, number),
                            to: Hex::new(q, 0),
                        }).unwrap();
                        q += 1;
                    }
                }
            }
            for _ in 0..2 {
                let mut moves = vec![HiveMove::Pass];
                let mut scratch = vec![Hex::ORIGIN];
                board.append_legal_placements(&mut moves, &mut scratch);
                assert_eq!(moves, vec![HiveMove::Pass]);
                assert!(scratch.is_empty());
                let mut expected = Vec::new();
                board.append_legal_placements_reference(&mut expected, &mut scratch);
                assert!(expected.is_empty());
                board.make_unchecked(HiveMove::Pass).unwrap();
            }
        }
    }

    #[test]
    fn first_mlp_turn_has_seven_distinct_non_queen_choices_at_origin() {
        let board = Board::new(GameType::mlp());
        let moves = board.legal_placements();
        assert_eq!(moves.len(), 7);
        assert!(moves.iter().all(|mv| match mv {
            HiveMove::Place { piece, to } => *to == Hex::ORIGIN && piece.bug != Bug::Queen,
            _ => false,
        }));
    }

    #[test]
    fn first_base_turn_has_four_distinct_non_queen_choices_at_origin() {
        let board = Board::new(GameType::base());
        assert_eq!(board.legal_placements().len(), 4);
        assert!(board.legal_placements().iter().all(|mv| match mv {
            HiveMove::Place { piece, .. } => piece.bug != Bug::Queen,
            _ => false,
        }));
    }

    #[test]
    fn black_first_turn_has_six_edges_times_seven_mlp_bug_types() {
        let mut board = Board::new(GameType::mlp());
        let mv = placement(&board, Bug::Ant, Hex::ORIGIN);
        board.make_unchecked(mv).unwrap();
        assert_eq!(board.legal_placements().len(), 42);
        assert!(board.legal_placements().iter().all(|mv| match mv {
            HiveMove::Place { piece, .. } => piece.bug != Bug::Queen,
            _ => false,
        }));
    }

    #[test]
    fn normal_placement_must_touch_friend_and_no_enemy() {
        let mut board = Board::new(GameType::mlp());
        let wq = placement(&board, Bug::Queen, Hex::ORIGIN);
        board.make_unchecked(wq).unwrap();
        let bq = placement(&board, Bug::Queen, Hex::new(1, 0));
        board.make_unchecked(bq).unwrap();

        let targets: BTreeSet<_> = board
            .legal_placements()
            .into_iter()
            .filter_map(|mv| match mv {
                HiveMove::Place { to, .. } => Some(to),
                _ => None,
            })
            .collect();

        let expected = BTreeSet::from([
            Hex::new(-1, 0),
            Hex::new(-1, 1),
            Hex::new(0, -1),
        ]);
        assert_eq!(targets, expected);
        // White used its Queen, leaving 7 MLP bug types x 3 targets.
        assert_eq!(board.legal_placements().len(), 21);
    }

    #[test]
    fn queen_is_forced_on_fourth_personal_turn() {
        let mut board = Board::new(GameType::mlp());

        // W A, B A, W S, B S, W B, B B -- all extend away from contact.
        for (bug, to) in [
            (Bug::Ant, Hex::new(0, 0)),
            (Bug::Ant, Hex::new(1, 0)),
            (Bug::Spider, Hex::new(-1, 0)),
            (Bug::Spider, Hex::new(2, 0)),
            (Bug::Beetle, Hex::new(-2, 0)),
            (Bug::Beetle, Hex::new(3, 0)),
        ] {
            let mv = placement(&board, bug, to);
            board.make_unchecked(mv).unwrap();
        }

        assert_eq!(board.side_to_move(), Color::White);
        assert_eq!(board.turns_taken(Color::White), 3);
        assert!(!board.queen_is_placed(Color::White));

        let moves = board.legal_placements();
        assert!(!moves.is_empty());
        assert!(moves.iter().all(|mv| match mv {
            HiveMove::Place { piece, .. } => piece.bug == Bug::Queen,
            _ => false,
        }));
    }

    #[test]
    fn only_top_color_of_stack_controls_placement_adjacency() {
        let mut board = Board::new(GameType::mlp());

        // Establish both Queens and White's Beetle.
        let mv = placement(&board, Bug::Queen, Hex::new(0, 0));
        board.make_unchecked(mv).unwrap();
        let mv = placement(&board, Bug::Queen, Hex::new(1, 0));
        board.make_unchecked(mv).unwrap();
        let mv = placement(&board, Bug::Beetle, Hex::new(-1, 0));
        board.make_unchecked(mv).unwrap();
        board.make_unchecked(HiveMove::Pass).unwrap();

        // Structural fast-path move: put the White Beetle on top of Black Q.
        let wb = Piece::new(Color::White, Bug::Beetle, 1);
        board
            .make_unchecked(HiveMove::Move {
                piece: wb,
                from: Hex::new(-1, 0),
                to: Hex::new(1, 0),
            })
            .unwrap();
        board.make_unchecked(HiveMove::Pass).unwrap();

        assert_eq!(board.top_color(Hex::new(1, 0)), Some(Color::White));

        // (2,0) touches only the stack whose top is White, so White may spawn there.
        let targets: BTreeSet<_> = board
            .legal_placements()
            .into_iter()
            .filter_map(|mv| match mv {
                HiveMove::Place { to, .. } => Some(to),
                _ => None,
            })
            .collect();
        assert!(targets.contains(&Hex::new(2, 0)));
    }
}
