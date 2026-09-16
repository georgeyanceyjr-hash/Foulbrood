//! Exact rule-state identity shared by search and game history.
use crate::{Board, Bug, Color, Piece, HiveMove};

// The hash selects a slot; full rule-state equality guards even hash collisions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Position {
    pub(crate) pieces: [u32; 28],
    heights: [u8; 28],
    pub(crate) state: u64,
    repetition_hash: u64,
}
impl Position {
    pub(crate) fn new(board: &Board) -> Self {
        let mut pieces = [0; 28];
        let mut heights = [0; 28];
        for hex in board.occupied_hexes() {
            for (height, piece) in board.stack(hex).unwrap().iter().enumerate() {
                pieces[piece.id()] = u32::from(hex.q as u16)
                    | (u32::from(hex.r as u16) << 16);
                heights[piece.id()] = height as u8 + 1;
            }
        }
        let game = board.game_type();
        let mut reserve = 0_u64;
        for color in Color::ALL {
            for bug in Bug::ALL {
                if !game.includes(bug) { continue; }
                for number in 1..=bug.copies() {
                    let piece = Piece::new(color, bug, number);
                    if board.is_in_hand(piece) { reserve |= 1 << piece.id(); }
                }
            }
        }
        let state = reserve | ((board.side_to_move().index() as u64) << 28)
            | ((game.mosquito as u64) << 29) | ((game.ladybug as u64) << 30)
            | ((game.pillbug as u64) << 31)
            | (u64::from(board.turns_taken(Color::White).min(3)) << 32)
            | (u64::from(board.turns_taken(Color::Black).min(3)) << 34)
            | (if game.pillbug { board.last_physically_moved_piece().map_or(0, |p| p.id() as u64 + 1) } else { 0 } << 36);
        let mut out=Self { pieces, heights, state, repetition_hash:0 };
        out.repetition_hash=out.build_repetition_hash();out
    }
    /// Derive the child descriptor after applying one legal move to `board`.
    /// Only the physically moved top piece changes coordinates/stack level.
    #[inline(always)]
    pub(crate) fn after(&self, board: &Board, mv: HiveMove) -> Self {
        let mut next = *self;
        if let HiveMove::Place {piece,to} | HiveMove::Move {piece,to,..}
            | HiveMove::Pillbug {piece,to,..} = mv {
            next.pieces[piece.id()] = u32::from(to.q as u16)
                | (u32::from(to.r as u16) << 16);
            next.heights[piece.id()] = board.stack_height(to) as u8;
            if matches!(mv, HiveMove::Place {..}) { next.state &= !(1 << piece.id()); }
        }
        // Retain reserves and expansion bits; replace side, deadline and Pillbug state.
        next.state = (next.state & ((1_u64 << 32) - 1) & !(1 << 28))
            | ((board.side_to_move().index() as u64) << 28)
            | (u64::from(board.turns_taken(Color::White).min(3)) << 32)
            | (u64::from(board.turns_taken(Color::Black).min(3)) << 34)
            | (if board.game_type().pillbug { board.last_physically_moved_piece().map_or(0, |p| p.id() as u64 + 1) } else { 0 } << 36);
        next.repetition_hash=if matches!(mv, HiveMove::Place{piece,..}|HiveMove::Move{piece,..}|HiveMove::Pillbug{piece,..} if piece.bug==Bug::Queen) {
            next.build_repetition_hash()
        } else {
            let mut sum=self.repetition_hash ^ self.phase_hash();
            if let HiveMove::Place{piece,..}|HiveMove::Move{piece,..}|HiveMove::Pillbug{piece,..}=mv {
                sum=sum.wrapping_sub(self.repetition_piece(piece.id())).wrapping_add(next.repetition_piece(piece.id()));
            }
            sum ^ next.phase_hash()
        };
        debug_assert_eq!(next, Self::new(board));
        next
    }
    fn coordinates(&self,id:usize)->(i32,i32) {
        (self.pieces[id] as u16 as i16 as i32,(self.pieces[id]>>16) as u16 as i16 as i32)
    }
    fn kind(id:usize)->u8 {
        const KINDS:[u8;14]=[0,1,1,2,2,3,3,3,4,4,4,5,6,7];
        KINDS[id%14]+8*(id/14) as u8
    }
    fn mix(mut x:u64)->u64 {
        x=(x^(x>>30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        x=(x^(x>>27)).wrapping_mul(0x94d0_49bb_1331_11eb);x^(x>>31)
    }
    fn repetition_phase(&self)->u64 {
        ((self.state>>28)&15)
            | if self.heights[0]==0 {(self.state>>28)&48} else {0}
            | if self.heights[14]==0 {(self.state>>28)&192} else {0}
    }
    fn phase_hash(&self)->u64 {self.repetition_phase().rotate_left(56)}
    fn repetition_piece(&self,id:usize)->u64 {
        if self.heights[id]==0 {return 0;}
        let (q,r)=self.coordinates(id);
        let distance=|queen:usize|->u64 {
            if self.heights[queen]==0 {return 0;}
            let (x,y)=self.coordinates(queen);let dq=q-x;let dr=r-y;
            dq.abs().max(dr.abs()).max((dq+dr).abs()) as u64
        };
        Self::mix((u64::from(Self::kind(id))<<56)|(u64::from(self.heights[id])<<48)|(distance(0)<<24)|distance(14))
    }
    fn build_repetition_hash(&self)->u64 {
        (0..28).fold(0u64,|sum,id|sum.wrapping_add(self.repetition_piece(id))) ^ self.phase_hash()
    }
    fn anchor(&self)->(i32,i32) {
        if self.heights[0]>0 {self.coordinates(0)} else if self.heights[14]>0 {self.coordinates(14)} else {(0,0)}
    }
    fn transform((mut q,mut r):(i32,i32),rotation:u8,mirror:bool)->(i32,i32) {
        for _ in 0..rotation {(q,r)=(-r,q+r);}
        if mirror {q=-q-r;}(q,r)
    }
    /// Exact repetition equivalence, deliberately separate from physical TT
    /// identity: exchanging same-type bugs must not corrupt stored move IDs.
    #[inline(always)]
    pub(crate) fn same_repetition(&self,other:&Self,board:&Board)->bool {
        if self.repetition_hash!=other.repetition_hash {return false;}
        if self==other {return true;}
        self.same_repetition_slow(other,board)
    }
    #[inline(never)]
    fn same_repetition_slow(&self,other:&Self,board:&Board)->bool {
        if self.repetition_phase()!=other.repetition_phase() {return false;}
        let mut ours=Vec::with_capacity(28);
        for id in 0..28 {if self.heights[id]>0 {let(q,r)=self.coordinates(id);ours.push((q,r,self.heights[id],Self::kind(id)));}}
        ours.sort_unstable();
        let self_anchor=self.anchor();let other_anchor=other.anchor();
        let queens=self.heights[0]>0||self.heights[14]>0;
        let old_last=if other.state>>36==0 {None} else {Some((other.state>>36) as usize-1)};
        let our_last=board.last_physically_moved_piece();
        let mut our_moves=None;
        for mirror in [false,true] {for rotation in 0..6 {
            let mut theirs=Vec::with_capacity(28);
            for id in 0..28 {if other.heights[id]>0 {
                let(q,r)=other.coordinates(id);let(x,y)=Self::transform((q-other_anchor.0,r-other_anchor.1),rotation,mirror);
                theirs.push((x+self_anchor.0,y+self_anchor.1,other.heights[id],Self::kind(id)));
            }}
            if ours.len()!=theirs.len() {return false;}
            // Before a Queen is placed, normalize translation by coordinate
            // minima; no move-history origin is part of repetition identity.
            let shift=if !queens&&!ours.is_empty() {
                (ours.iter().map(|x|x.0).min().unwrap()-theirs.iter().map(|x|x.0).min().unwrap(),
                 ours.iter().map(|x|x.1).min().unwrap()-theirs.iter().map(|x|x.1).min().unwrap())
            } else {(0,0)};
            for p in &mut theirs {p.0+=shift.0;p.1+=shift.1;}
            theirs.sort_unstable();if ours!=theirs {continue;}
            let mapped_last=old_last.and_then(|id|{
                let(q,r)=other.coordinates(id);let(x,y)=Self::transform((q-other_anchor.0,r-other_anchor.1),rotation,mirror);
                let hex=crate::Hex::new((x+self_anchor.0+shift.0) as i16,(y+self_anchor.1+shift.1) as i16);
                board.stack(hex).and_then(|s|s.get(other.heights[id].checked_sub(1)? as usize)).copied()
            });
            if our_last==mapped_last {return true;}
            let actual=our_moves.get_or_insert_with(|| Self::physical_moves(board));
            let alternative=board.with_repetition_last_piece(mapped_last);
            if *actual==Self::physical_moves(&alternative) {return true;}
        }}
        false
    }
    fn physical_moves(board:&Board)->Vec<(u8,usize,i16,i16)> {
        let mut moves:Vec<_>=board.legal_moves().into_iter().map(|mv|match mv {
            HiveMove::Place{piece,to}=>(0,Self::kind(piece.id()) as usize,to.q,to.r),
            HiveMove::Move{piece,to,..}|HiveMove::Pillbug{piece,to,..}=>(1,piece.id(),to.q,to.r),
            HiveMove::Pass=>(2,0,0,0),
        }).collect();moves.sort_unstable();moves.dedup();moves
    }
    pub(crate) fn key(&self) -> u64 {
        let mut key = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        for (&coordinates, &height) in self.pieces.iter().zip(&self.heights) {
            let piece = u64::from(coordinates) | (u64::from(height) << 32);
            key = (key ^ piece).wrapping_mul(0x100_0000_01b3).rotate_left(23);
        }
        key ^= key >> 30;
        key = key.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        key ^ (key >> 27)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_legacy_identity(board: &Board, packed: Position) {
        let mut old = [0_u64; 28];
        for hex in board.occupied_hexes() {
            for (level, piece) in board.stack(hex).unwrap().iter().enumerate() {
                old[piece.id()] = u64::from(hex.q as u16)
                    | (u64::from(hex.r as u16) << 16) | ((level as u64 + 1) << 32);
            }
        }
        let mut key = packed.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        for (i, &piece) in old.iter().enumerate() {
            assert_eq!(u64::from(packed.pieces[i]) | (u64::from(packed.heights[i]) << 32), piece);
            key = (key ^ piece).wrapping_mul(0x100_0000_01b3).rotate_left(23);
        }
        key ^= key >> 30;
        key = key.wrapping_mul(0xbf58_476d_1ce4_e5b9);
        assert_eq!(packed.key(), key ^ (key >> 27));
    }

    #[test]
    fn compact_identity_retains_full_coordinate_range_and_stack_levels() {
        assert_eq!(std::mem::size_of::<Position>(), 160);
        for q in [i16::MIN, -1, 0, i16::MAX] {
            for r in [i16::MIN, -1, 0, i16::MAX] {
                for height in 0_u8..=7 {
                    let coordinates = u32::from(q as u16) | (u32::from(r as u16) << 16);
                    let old = u64::from(q as u16) | (u64::from(r as u16) << 16)
                        | (u64::from(height) << 32);
                    assert_eq!(u64::from(coordinates) | (u64::from(height) << 32), old);
                }
            }
        }
    }
    #[test]
    fn incremental_descriptors_match_full_rebuild_for_all_variants_and_undo() {
        let mut checked=0;
        let mut kinds=[0;4];
        for mask in 0..8 {
            let mut board=Board::new(crate::GameType {mosquito:mask&1!=0,ladybug:mask&2!=0,pillbug:mask&4!=0});
            for ply in 0..100 {
                let parent=Position::new(&board);
                let moves=board.legal_moves();
                if moves.is_empty() {break;}
                for &mv in &moves {
                    let undo=board.make_generated(mv);
                    let incremental=parent.after(&board,mv);
                    assert_eq!(incremental,Position::new(&board));
                    assert_legacy_identity(&board, incremental);
                    assert_eq!(incremental.key(),Position::new(&board).key());
                    kinds[match mv {HiveMove::Place{..}=>0,HiveMove::Move{..}=>1,HiveMove::Pillbug{..}=>2,HiveMove::Pass=>3}]+=1;
                    board.undo_generated(undo);assert_eq!(Position::new(&board),parent);checked+=1;
                }
                // Exercise pass bookkeeping even on a position where pass is not legal.
                let undo=board.make_generated(HiveMove::Pass);
                assert_eq!(parent.after(&board,HiveMove::Pass),Position::new(&board));
                board.undo_generated(undo);assert_eq!(Position::new(&board),parent);
                board.make_generated(moves[(ply*37+mask*19)%moves.len()]);
            }
        }
        assert!(checked>10000,"{checked}");
        assert!(kinds[0]>0 && kinds[1]>0 && kinds[2]>0,"{kinds:?}");
    }
    fn root(text:&str)->Board {crate::UhpGame::from_root(text).unwrap().board().clone()}
    #[test]
    fn repetition_ignores_only_ineffective_last_move_restrictions() {
        let b=root("Base+MLP~0~20~wQ:0:0:0,bQ:1:0:0,wA1:-1:0:0,bA1:2:0:0~");
        let irrelevant=b.with_repetition_last_piece(Some(crate::parse_piece("bA1").unwrap()));
        let actual=Position::new(&b);let other=Position::new(&irrelevant);
        assert_ne!(actual,other);assert!(actual.same_repetition(&other,&b));
        let stunned=b.with_repetition_last_piece(Some(crate::parse_piece("wA1").unwrap()));
        let restricted=Position::new(&stunned);
        assert!(!actual.same_repetition(&restricted,&b));
        assert!(!restricted.same_repetition(&actual,&stunned));
    }
    #[test]
    fn repetition_matches_all_perspectives_translations_and_same_type_swaps() {
        let board=root("Base+MLP~0~20~wQ:0:0:0,bQ:1:0:0,wA1:-1:0:0,wA2:0:-1:0,bB1:1:0:1~");
        let expected=Position::new(&board);
        for mirror in [false,true] {for turn in 0..6 {
            let mut pieces=Vec::new();
            for hex in board.occupied_hexes() {for (z,&piece) in board.stack(hex).unwrap().iter().enumerate() {
                let(q,r)=Position::transform((hex.q.into(),hex.r.into()),turn,mirror);
                let p=if piece.bug==Bug::Ant {Piece::new(piece.color,piece.bug,3-piece.number)} else {piece};
                pieces.push((p,crate::Hex::new((q+17) as i16,(r-11) as i16),z));
            }}
            let changed=Board::from_setup(board.game_type(),board.side_to_move(),20,&pieces,None).unwrap();
            let p=Position::new(&changed);
            assert_eq!(expected.repetition_hash,p.repetition_hash);
            assert!(expected.same_repetition(&p,&board));assert!(p.same_repetition(&expected,&changed));
        }}
        let wrong=root("Base+MLP~0~20~wQ:0:0:0,bQ:1:0:0,wA1:-1:0:0,wS1:0:-1:0,bB1:1:0:1~");
        let mut collision=Position::new(&wrong);collision.repetition_hash=expected.repetition_hash;
        assert!(!expected.same_repetition(&collision,&board));
    }
    #[test]
    fn queen_deadline_phase_matters_only_while_queen_is_unplaced() {
        let a=root("Base~0~3~wQ:0:0:0,bQ:1:0:0~");
        let b=root("Base~0~20~wQ:0:0:0,bQ:1:0:0~");
        assert_ne!(Position::new(&a),Position::new(&b));
        assert!(Position::new(&a).same_repetition(&Position::new(&b),&a));
        let a=root("Base~0~3~wS1:0:0:0,bS1:1:0:0~");
        let b=root("Base~0~4~wS1:0:0:0,bS1:1:0:0~");
        assert!(!Position::new(&a).same_repetition(&Position::new(&b),&a));
    }

}
