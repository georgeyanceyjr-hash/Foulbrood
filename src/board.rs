use crate::{Bug, Color, GameType, Hex, HiveMove, Piece};
use std::error::Error;
use std::fmt;

pub const MAX_PIECES: usize = 28;
const MAX_STACK_HEIGHT: usize = 7;

/// Compact stack storage with no per-cell heap allocation. In legal MLP Hive,
/// only the four Beetles and two Mosquitoes can climb, so a stack can contain
/// at most one ground piece plus those six climbers.
#[derive(Clone, Copy, Debug)]
struct CellStack {
    pieces: [Piece; MAX_STACK_HEIGHT],
    len: u8,
}

impl Default for CellStack {
    #[inline]
    fn default() -> Self {
        Self {
            pieces: [Piece::new(Color::White, Bug::Queen, 1); MAX_STACK_HEIGHT],
            len: 0,
        }
    }
}

impl CellStack {
    #[inline]
    fn single(piece: Piece) -> Self {
        let mut stack = Self::default();
        stack.push(piece);
        stack
    }

    #[inline(always)]
    fn len(&self) -> usize {
        self.len as usize
    }

    #[inline(always)]
    fn is_empty(&self) -> bool {
        self.len == 0
    }

    #[inline(always)]
    fn as_slice(&self) -> &[Piece] {
        &self.pieces[..self.len()]
    }

    #[inline(always)]
    fn last(&self) -> Option<&Piece> {
        self.as_slice().last()
    }

    #[inline(always)]
    fn push(&mut self, piece: Piece) {
        let index = self.len();
        assert!(index < MAX_STACK_HEIGHT, "legal Hive stack exceeded fixed capacity");
        self.pieces[index] = piece;
        self.len += 1;
    }

    #[inline(always)]
    fn pop(&mut self) -> Option<Piece> {
        if self.len == 0 {
            return None;
        }
        self.len -= 1;
        Some(self.pieces[self.len()])
    }
}


const BOARD_TABLE_CAPACITY: usize = 64;
const BOARD_TABLE_MASK: usize = BOARD_TABLE_CAPACITY - 1;

/// Fixed-capacity open-addressed table for the at-most-28 occupied Hive hexes.
///
/// `HashMap` is excellent general-purpose machinery, but search performs board
/// probes far more often than it changes strategic state.  A 64-slot linear-
/// probe table keeps the entire index inline with `Board`, avoids allocator and
/// hash-table metadata traffic, and never exceeds 44% load in legal MLP Hive.
#[derive(Clone, Debug)]
struct BoardCells {
    slots: [Option<(Hex, CellStack)>; BOARD_TABLE_CAPACITY],
    len: u8,
}

impl Default for BoardCells {
    #[inline]
    fn default() -> Self {
        Self {
            slots: [None; BOARD_TABLE_CAPACITY],
            len: 0,
        }
    }
}

impl BoardCells {
    #[inline(always)]
    fn len(&self) -> usize {
        self.len as usize
    }

    #[inline(always)]
    fn hash(hex: Hex) -> usize {
        // Mix axial coordinates independently, then take the high six bits.
        // Keep full coordinate comparisons in the table: this chooses a bucket
        // only, and collisions still use the existing linear-probe algorithm.
        let q = (hex.q as i32 as u32).wrapping_mul(0x9e37_79b1);
        let r = (hex.r as i32 as u32).wrapping_mul(0x85eb_ca77);
        ((q ^ r) >> 26) as usize
    }

    #[inline(always)]
    fn find_index(&self, hex: Hex) -> Option<usize> {
        let mut index = Self::hash(hex);
        loop {
            match self.slots[index] {
                Some((key, _)) if key == hex => return Some(index),
                Some(_) => index = (index + 1) & BOARD_TABLE_MASK,
                None => return None,
            }
        }
    }

    #[inline(always)]
    fn vacant_index(&self, hex: Hex) -> usize {
        let mut index = Self::hash(hex);
        loop {
            match self.slots[index] {
                Some((key, _)) if key == hex => return index,
                Some(_) => index = (index + 1) & BOARD_TABLE_MASK,
                None => return index,
            }
        }
    }

    #[inline(always)]
    fn contains_key(&self, hex: Hex) -> bool {
        self.find_index(hex).is_some()
    }

    #[inline(always)]
    fn get(&self, hex: Hex) -> Option<&CellStack> {
        let index = self.find_index(hex)?;
        self.slots[index].as_ref().map(|(_, stack)| stack)
    }

    #[inline(always)]
    fn get_mut(&mut self, hex: Hex) -> Option<&mut CellStack> {
        let index = self.find_index(hex)?;
        self.slots[index].as_mut().map(|(_, stack)| stack)
    }

    #[inline(always)]
    fn insert(&mut self, hex: Hex, stack: CellStack) {
        let index = self.vacant_index(hex);
        if self.slots[index].is_none() {
            debug_assert!((self.len as usize) < MAX_PIECES);
            self.len += 1;
        }
        self.slots[index] = Some((hex, stack));
    }

    #[inline(always)]
    fn get_or_insert_default(&mut self, hex: Hex) -> &mut CellStack {
        let index = self.vacant_index(hex);
        if self.slots[index].is_none() {
            debug_assert!((self.len as usize) < MAX_PIECES);
            self.slots[index] = Some((hex, CellStack::default()));
            self.len += 1;
        }
        match self.slots[index].as_mut() {
            Some((_, stack)) => stack,
            None => unreachable!(),
        }
    }

    #[inline]
    fn remove(&mut self, hex: Hex) -> Option<CellStack> {
        let mut hole = self.find_index(hex)?;
        let removed = self.slots[hole].take().map(|(_, stack)| stack);
        self.len -= 1;

        // Back-shift deletion preserves lookup chains without tombstones.
        //
        // Important: encountering an entry in its own ideal/home slot does
        // *not* mean we may stop scanning. A later displaced entry can still
        // have a probe chain that crosses the hole (especially across table
        // wrap-around or when home buckets are interleaved). Move an entry
        // exactly when the hole lies earlier on that entry's circular probe
        // path than its current slot.
        let mut next = (hole + 1) & BOARD_TABLE_MASK;
        while let Some((key, stack)) = self.slots[next] {
            let ideal = Self::hash(key);
            let distance_to_current =
                (next + BOARD_TABLE_CAPACITY - ideal) & BOARD_TABLE_MASK;
            let distance_to_hole =
                (hole + BOARD_TABLE_CAPACITY - ideal) & BOARD_TABLE_MASK;

            if distance_to_hole < distance_to_current {
                self.slots[hole] = Some((key, stack));
                self.slots[next] = None;
                hole = next;
            }
            next = (next + 1) & BOARD_TABLE_MASK;
        }
        removed
    }

    #[inline]
    fn keys(&self) -> impl Iterator<Item = Hex> + '_ {
        self.slots.iter().filter_map(|slot| slot.as_ref().map(|(hex, _)| *hex))
    }

    #[inline]
    fn values(&self) -> impl Iterator<Item = &CellStack> + '_ {
        self.slots.iter().filter_map(|slot| slot.as_ref().map(|(_, stack)| stack))
    }
}

#[derive(Clone, Debug)]
pub struct Board {
    game_type: GameType,
    cells: BoardCells,
    locations: [Option<Hex>; MAX_PIECES],
    in_hand: u32,
    side_to_move: Color,
    ply: u16,
    turns_taken: [u8; 2],
    last_move: Option<HiveMove>,
}

#[derive(Clone, Debug)]
pub struct Undo {
    mv: HiveMove,
    previous_side_to_move: Color,
    previous_ply: u16,
    previous_turns_taken: [u8; 2],
    previous_last_move: Option<HiveMove>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MoveError {
    WrongColor { piece: Piece, side_to_move: Color },
    PieceNotInHand(Piece),
    PieceAlreadyOnBoard(Piece),
    DestinationOccupied(Hex),
    PieceNotOnBoard(Piece),
    SourceMismatch { piece: Piece, expected: Hex, actual: Hex },
    PieceCovered(Piece),
    CorruptStack(Hex),
}

impl fmt::Display for MoveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MoveError::WrongColor { piece, side_to_move } => {
                write!(f, "{piece} does not belong to side to move {side_to_move:?}")
            }
            MoveError::PieceNotInHand(piece) => write!(f, "{piece} is not in hand"),
            MoveError::PieceAlreadyOnBoard(piece) => write!(f, "{piece} is already on board"),
            MoveError::DestinationOccupied(hex) => write!(f, "destination {hex} is occupied"),
            MoveError::PieceNotOnBoard(piece) => write!(f, "{piece} is not on board"),
            MoveError::SourceMismatch {
                piece,
                expected,
                actual,
            } => write!(
                f,
                "source mismatch for {piece}: expected {expected}, got {actual}"
            ),
            MoveError::PieceCovered(piece) => write!(f, "{piece} is covered"),
            MoveError::CorruptStack(hex) => write!(f, "board stack at {hex} is inconsistent"),
        }
    }
}

impl Error for MoveError {}

impl Board {
    pub fn new(game_type: GameType) -> Self {
        let mut in_hand = 0_u32;
        for color in Color::ALL {
            for piece in Piece::all_for(color, game_type) {
                in_hand |= 1_u32 << piece.id();
            }
        }

        let cells = BoardCells::default();

        Self {
            game_type,
            cells,
            locations: [None; MAX_PIECES],
            in_hand,
            side_to_move: Color::White,
            ply: 0,
            turns_taken: [0; 2],
            last_move: None,
        }
    }

    /// Construct a manually arranged analysis root, without inventing move history.
    pub fn from_setup(game_type: GameType, side: Color, turn: u8,
        pieces: &[(Piece, Hex, usize)], last: Option<(Piece, Hex)>) -> Result<Self, String> {
        if !(1..=200).contains(&turn) { return Err("Choose a turn number from 1 to 200.".into()); }
        let mut board = Self::new(game_type);
        board.side_to_move = side;
        board.turns_taken = [turn - 1 + u8::from(side == Color::Black), turn - 1];
        board.ply = u16::from(board.turns_taken[0]) + u16::from(board.turns_taken[1]);
        let mut ordered = pieces.to_vec(); ordered.sort_by_key(|(_,h,z)| (*h,*z));
        let mut counts = [0u8;2];
        for (piece, hex, level) in ordered {
            if i32::from(hex.q).abs() > 100 || i32::from(hex.r).abs() > 100 { return Err("Keep the position within 100 hexes of the center.".into()); }
            if !board.is_in_hand(piece) { return Err(format!("{piece} is duplicated or unavailable in this game type.")); }
            if level != board.stack_height(hex) || level >= MAX_STACK_HEIGHT { return Err("Stack levels must be consecutive, with no gaps.".into()); }
            if level > 0 && !matches!(piece.bug, Bug::Beetle | Bug::Mosquito) { return Err("Only Beetles and Mosquitoes can be above another piece.".into()); }
            board.cells.get_or_insert_default(hex).push(piece);
            board.locations[piece.id()] = Some(hex); board.in_hand &= !(1u32 << piece.id());
            counts[piece.color.index()] += 1;
        }
        for color in Color::ALL {
            if counts[color.index()] > board.turns_taken[color.index()] { return Err("Increase the turn number to allow all the placed pieces.".into()); }
            if board.turns_taken[color.index()] >= 4 && !board.queen_is_placed(color) { return Err(format!("Place the {color:?} Queen, or choose an earlier turn number.")); }
        }
        let occupied: std::collections::HashSet<_> = board.occupied_hexes().collect();
        if let Some(&start) = occupied.iter().next() {
            let mut seen = std::collections::HashSet::new(); let mut pending = vec![start]; seen.insert(start);
            while let Some(hex) = pending.pop() { for next in hex.neighbors() { if occupied.contains(&next) && seen.insert(next) { pending.push(next); } } }
            if seen.len() != occupied.len() { return Err("Connect every piece into one hive before analyzing.".into()); }
        }
        if let Some((piece, from)) = last {
            let to = board.location(piece).ok_or("The last moved piece must be on the board.")?;
            if board.top(to) != Some(piece) { return Err("The last moved piece must be on top of its stack.".into()); }
            if from == to || i32::from(from.q).abs()>100 || i32::from(from.r).abs()>100 || board.ply==0 { return Err("Choose a different previous hex for the last moved piece.".into()); }
            board.last_move = Some(HiveMove::Move {piece,from,to});
        }
        Ok(board)
    }

    pub fn game_type(&self) -> GameType {
        self.game_type
    }

    pub fn side_to_move(&self) -> Color {
        self.side_to_move
    }

    pub fn ply(&self) -> u16 {
        self.ply
    }

    pub fn turns_taken(&self, color: Color) -> u8 {
        self.turns_taken[color.index()]
    }

    pub fn last_move(&self) -> Option<HiveMove> {
        self.last_move
    }

    pub(crate) fn with_repetition_last_piece(&self,piece:Option<Piece>)->Self {
        let mut board=self.clone();
        board.last_move=piece.and_then(|piece|self.location(piece).map(|to|HiveMove::Move{piece,from:to,to}));
        board
    }

    pub fn last_physically_moved_piece(&self) -> Option<Piece> {
        self.last_move.and_then(HiveMove::physical_piece)
    }

    pub fn occupied_hex_count(&self) -> usize {
        self.cells.len()
    }

    pub fn piece_count_on_board(&self) -> usize {
        self.cells.values().map(CellStack::len).sum()
    }

    pub fn is_occupied(&self, hex: Hex) -> bool {
        self.cells.contains_key(hex)
    }

    pub fn stack(&self, hex: Hex) -> Option<&[Piece]> {
        self.cells.get(hex).map(CellStack::as_slice)
    }

    pub fn stack_height(&self, hex: Hex) -> usize {
        self.cells.get(hex).map_or(0, CellStack::len)
    }

    pub fn top(&self, hex: Hex) -> Option<Piece> {
        self.cells.get(hex).and_then(|stack| stack.last().copied())
    }

    pub fn top_color(&self, hex: Hex) -> Option<Color> {
        self.top(hex).map(|piece| piece.color)
    }

    pub fn location(&self, piece: Piece) -> Option<Hex> {
        self.locations[piece.id()]
    }

    pub fn is_in_hand(&self, piece: Piece) -> bool {
        (self.in_hand & (1_u32 << piece.id())) != 0
    }

    pub fn queen_is_placed(&self, color: Color) -> bool {
        let queen = Piece::new(color, Bug::Queen, 1);
        self.location(queen).is_some()
    }

    pub fn canonical_piece_in_hand(&self, color: Color, bug: Bug) -> Option<Piece> {
        if !self.game_type.includes(bug) {
            return None;
        }
        (1..=bug.copies())
            .map(|number| Piece::new(color, bug, number))
            .find(|piece| self.is_in_hand(*piece))
    }

    pub fn occupied_hexes(&self) -> impl Iterator<Item = Hex> + '_ {
        self.cells.keys()
    }

    /// Iterates occupied cells without re-probing the board table. This is used
    /// by graph algorithms that need the coordinate, top piece, and stack height
    /// together for every occupied cell.
    pub(crate) fn occupied_cell_summaries(&self) -> impl Iterator<Item = (Hex, Piece, usize)> + '_ {
        self.cells.slots.iter().filter_map(|slot| {
            let (hex, stack) = slot.as_ref()?;
            let top = stack.last().copied()?;
            Some((*hex, top, stack.len()))
        })
    }

    /// Borrow occupied stacks directly, avoiding repeated top/coordinate probes.
    pub(crate) fn occupied_stacks(&self) -> impl Iterator<Item = (Hex, &[Piece])> + '_ {
        self.cells.slots.iter().filter_map(|slot| {
            let (hex, stack) = slot.as_ref()?;
            Some((*hex, stack.as_slice()))
        })
    }

    /// Applies a move after checking state integrity, but deliberately does not
    /// check the complete Hive movement rules. Legal generators should produce
    /// moves that are then applied through this fast path during search.
    pub fn make_unchecked(&mut self, mv: HiveMove) -> Result<Undo, MoveError> {
        let moving_side = self.side_to_move;

        match mv {
            HiveMove::Place { piece, to } => {
                self.check_piece_color(piece)?;
                if !self.is_in_hand(piece) {
                    if self.location(piece).is_some() {
                        return Err(MoveError::PieceAlreadyOnBoard(piece));
                    }
                    return Err(MoveError::PieceNotInHand(piece));
                }
                if self.is_occupied(to) {
                    return Err(MoveError::DestinationOccupied(to));
                }

                self.cells.insert(to, CellStack::single(piece));
                self.locations[piece.id()] = Some(to);
                self.in_hand &= !(1_u32 << piece.id());
            }
            HiveMove::Move { piece, from, to } => {
                self.check_piece_color(piece)?;
                let actual = self.location(piece).ok_or(MoveError::PieceNotOnBoard(piece))?;
                if actual != from {
                    return Err(MoveError::SourceMismatch {
                        piece,
                        expected: actual,
                        actual: from,
                    });
                }

                if self.top(from) != Some(piece) {
                    return Err(MoveError::PieceCovered(piece));
                }

                let remove_source = {
                    let source_stack = self
                        .cells
                        .get_mut(from)
                        .ok_or(MoveError::CorruptStack(from))?;
                    let popped = source_stack.pop();
                    if popped != Some(piece) {
                        return Err(MoveError::CorruptStack(from));
                    }
                    source_stack.is_empty()
                };
                if remove_source {
                    self.cells.remove(from);
                }

                self.cells.get_or_insert_default(to).push(piece);
                self.locations[piece.id()] = Some(to);
            }
            HiveMove::Pillbug {
                actor,
                piece,
                from,
                to,
            } => {
                self.check_piece_color(actor)?;
                let actual = self.location(piece).ok_or(MoveError::PieceNotOnBoard(piece))?;
                if actual != from {
                    return Err(MoveError::SourceMismatch {
                        piece,
                        expected: actual,
                        actual: from,
                    });
                }
                if self.top(from) != Some(piece) {
                    return Err(MoveError::PieceCovered(piece));
                }
                if self.is_occupied(to) {
                    return Err(MoveError::DestinationOccupied(to));
                }

                let remove_source = {
                    let source_stack = self
                        .cells
                        .get_mut(from)
                        .ok_or(MoveError::CorruptStack(from))?;
                    let popped = source_stack.pop();
                    if popped != Some(piece) {
                        return Err(MoveError::CorruptStack(from));
                    }
                    source_stack.is_empty()
                };
                if remove_source {
                    self.cells.remove(from);
                }
                self.cells.insert(to, CellStack::single(piece));
                self.locations[piece.id()] = Some(to);
            }
            HiveMove::Pass => {}
        }

        let undo = Undo {
            mv,
            previous_side_to_move: self.side_to_move,
            previous_ply: self.ply,
            previous_turns_taken: self.turns_taken,
            previous_last_move: self.last_move,
        };

        self.last_move = Some(mv);
        self.turns_taken[moving_side.index()] =
            self.turns_taken[moving_side.index()].saturating_add(1);
        self.side_to_move = moving_side.other();
        self.ply = self.ply.saturating_add(1);

        Ok(undo)
    }

    /// Applies a move emitted by this board's legal move generator.
    ///
    /// Search calls this millions of times. The public `make_unchecked` path
    /// intentionally performs integrity checks for protocol/import callers;
    /// this path relies on the generator's invariants and keeps only
    /// `debug_assert!` verification, which disappears from release builds.
    pub(crate) fn make_generated(&mut self, mv: HiveMove) -> Undo {
        let moving_side = self.side_to_move;

        match mv {
            HiveMove::Place { piece, to } => {
                debug_assert_eq!(piece.color, moving_side);
                debug_assert!(self.is_in_hand(piece));
                debug_assert!(!self.is_occupied(to));
                self.cells.insert(to, CellStack::single(piece));
                self.locations[piece.id()] = Some(to);
                self.in_hand &= !(1_u32 << piece.id());
            }
            HiveMove::Move { piece, from, to } => {
                debug_assert_eq!(piece.color, moving_side);
                debug_assert_eq!(self.location(piece), Some(from));
                debug_assert_eq!(self.top(from), Some(piece));

                let remove_source = {
                    let source_stack = self.cells.get_mut(from).expect("generated source missing");
                    let popped = source_stack.pop();
                    debug_assert_eq!(popped, Some(piece));
                    source_stack.is_empty()
                };
                if remove_source {
                    self.cells.remove(from);
                }
                self.cells.get_or_insert_default(to).push(piece);
                self.locations[piece.id()] = Some(to);
            }
            HiveMove::Pillbug { piece, from, to, .. } => {
                debug_assert_eq!(self.location(piece), Some(from));
                debug_assert_eq!(self.top(from), Some(piece));
                debug_assert!(!self.is_occupied(to));

                let remove_source = {
                    let source_stack = self.cells.get_mut(from).expect("generated pillbug source missing");
                    let popped = source_stack.pop();
                    debug_assert_eq!(popped, Some(piece));
                    source_stack.is_empty()
                };
                if remove_source {
                    self.cells.remove(from);
                }
                self.cells.insert(to, CellStack::single(piece));
                self.locations[piece.id()] = Some(to);
            }
            HiveMove::Pass => {}
        }

        let undo = Undo {
            mv,
            previous_side_to_move: self.side_to_move,
            previous_ply: self.ply,
            previous_turns_taken: self.turns_taken,
            previous_last_move: self.last_move,
        };

        self.last_move = Some(mv);
        self.turns_taken[moving_side.index()] =
            self.turns_taken[moving_side.index()].saturating_add(1);
        self.side_to_move = moving_side.other();
        self.ply = self.ply.saturating_add(1);
        undo
    }

    /// Exact inverse of `make_generated`, likewise optimized for the search
    /// path. Debug builds retain invariant checks; release builds do not pay
    /// for validation already guaranteed by move generation.
    pub(crate) fn undo_generated(&mut self, undo: Undo) {
        match undo.mv {
            HiveMove::Place { piece, to } => {
                debug_assert_eq!(self.top(to), Some(piece));
                self.cells.remove(to);
                self.locations[piece.id()] = None;
                self.in_hand |= 1_u32 << piece.id();
            }
            HiveMove::Move { piece, from, to } => {
                let remove_destination = {
                    let destination_stack = self.cells.get_mut(to).expect("generated destination missing");
                    let popped = destination_stack.pop();
                    debug_assert_eq!(popped, Some(piece));
                    destination_stack.is_empty()
                };
                if remove_destination {
                    self.cells.remove(to);
                }
                self.cells.get_or_insert_default(from).push(piece);
                self.locations[piece.id()] = Some(from);
            }
            HiveMove::Pillbug { piece, from, to, .. } => {
                debug_assert_eq!(self.top(to), Some(piece));
                self.cells.remove(to);
                self.cells.get_or_insert_default(from).push(piece);
                self.locations[piece.id()] = Some(from);
            }
            HiveMove::Pass => {}
        }

        self.side_to_move = undo.previous_side_to_move;
        self.ply = undo.previous_ply;
        self.turns_taken = undo.previous_turns_taken;
        self.last_move = undo.previous_last_move;
    }

    pub fn undo(&mut self, undo: Undo) -> Result<(), MoveError> {
        match undo.mv {
            HiveMove::Place { piece, to } => {
                let stack = self.cells.get(to).ok_or(MoveError::CorruptStack(to))?;
                if stack.len() != 1 || stack.as_slice()[0] != piece {
                    return Err(MoveError::CorruptStack(to));
                }
                self.cells.remove(to);
                self.locations[piece.id()] = None;
                self.in_hand |= 1_u32 << piece.id();
            }
            HiveMove::Move { piece, from, to } => {
                let remove_destination = {
                    let destination_stack = self
                        .cells
                        .get_mut(to)
                        .ok_or(MoveError::CorruptStack(to))?;
                    let popped = destination_stack.pop();
                    if popped != Some(piece) {
                        return Err(MoveError::CorruptStack(to));
                    }
                    destination_stack.is_empty()
                };
                if remove_destination {
                    self.cells.remove(to);
                }

                self.cells.get_or_insert_default(from).push(piece);
                self.locations[piece.id()] = Some(from);
            }
            HiveMove::Pillbug {
                piece,
                from,
                to,
                ..
            } => {
                let destination_stack = self.cells.get(to).ok_or(MoveError::CorruptStack(to))?;
                if destination_stack.len() != 1 || destination_stack.as_slice()[0] != piece {
                    return Err(MoveError::CorruptStack(to));
                }
                self.cells.remove(to);
                self.cells.get_or_insert_default(from).push(piece);
                self.locations[piece.id()] = Some(from);
            }
            HiveMove::Pass => {}
        }

        self.side_to_move = undo.previous_side_to_move;
        self.ply = undo.previous_ply;
        self.turns_taken = undo.previous_turns_taken;
        self.last_move = undo.previous_last_move;
        Ok(())
    }

    fn check_piece_color(&self, piece: Piece) -> Result<(), MoveError> {
        if piece.color != self.side_to_move {
            return Err(MoveError::WrongColor {
                piece,
                side_to_move: self.side_to_move,
            });
        }
        Ok(())
    }

    /// Deterministic full-position key. This intentionally recomputes the key
    /// for now; milestone 2 can replace it with incremental Zobrist hashing
    /// without changing callers.
    pub fn position_key(&self) -> u64 {
        let mut key = 0xCBF2_9CE4_8422_2325_u64;

        key = mix(key, self.side_to_move as u64 + 1);
        key = mix(key, self.in_hand as u64);
        key = mix(
            key,
            self.game_type.mosquito as u64
                | ((self.game_type.ladybug as u64) << 1)
                | ((self.game_type.pillbug as u64) << 2),
        );
        // Absolute turn counts are not part of the strategic position once a
        // side's Queen has been placed. Before that, only the Queen-placement
        // deadline matters. Omitting irrelevant history lets future
        // transposition tables merge genuinely equivalent positions.
        let white_deadline = if self.queen_is_placed(Color::White) {
            0
        } else {
            self.turns_taken[Color::White.index()].min(3) as u64 + 1
        };
        let black_deadline = if self.queen_is_placed(Color::Black) {
            0
        } else {
            self.turns_taken[Color::Black.index()].min(3) as u64 + 1
        };
        key = mix(key, white_deadline | (black_deadline << 8));

        // With Pillbug in play, only the identity of the piece that physically
        // moved on the immediately preceding turn affects current legality.
        // The route, source, destination, and which Pillbug/Mosquito performed
        // a lift are already reflected in the board or are strategically
        // irrelevant.
        let immobilized = if self.game_type.pillbug {
            self.last_physically_moved_piece()
                .map_or(0, |piece| piece.id() as u64 + 1)
        } else {
            0
        };
        key = mix(key, immobilized);

        let mut hexes: Vec<_> = self.cells.keys().collect();
        hexes.sort_unstable();
        for hex in hexes {
            key = mix(key, zigzag(hex.q) | (zigzag(hex.r) << 16));
            if let Some(stack) = self.cells.get(hex) {
                key = mix(key, stack.len() as u64);
                for (height, piece) in stack.as_slice().iter().enumerate() {
                    key = mix(key, ((piece.id() as u64 + 1) << 8) | height as u64);
                }
            }
        }
        key
    }
}

impl Default for Board {
    fn default() -> Self {
        Self::new(GameType::mlp())
    }
}

fn zigzag(value: i16) -> u64 {
    let v = i32::from(value);
    ((v << 1) ^ (v >> 31)) as u32 as u64
}

fn mix(mut state: u64, value: u64) -> u64 {
    state ^= value.wrapping_add(0x9E37_79B9_7F4A_7C15);
    state = state.rotate_left(27).wrapping_mul(0x3C79_AC49_2BA7_B653);
    state ^ (state >> 33)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_board_table_survives_collisions_and_backshift_delete() {
        let mut colliding = Vec::new();
        let target_bucket = BoardCells::hash(Hex::new(-20, -20));
        'outer: for q in -24..=24 {
            for r in -24..=24 {
                let hex = Hex::new(q, r);
                if BoardCells::hash(hex) == target_bucket {
                    colliding.push(hex);
                    if colliding.len() == 5 {
                        break 'outer;
                    }
                }
            }
        }
        assert_eq!(colliding.len(), 5);

        let mut cells = BoardCells::default();
        for (i, hex) in colliding.iter().copied().enumerate() {
            cells.insert(
                hex,
                CellStack::single(Piece::new(Color::White, Bug::Ant, (i % 3 + 1) as u8)),
            );
        }
        assert_eq!(cells.len(), 5);
        for hex in colliding.iter().copied() {
            assert!(cells.contains_key(hex));
        }

        // Delete from the middle of a probe cluster. Later colliding entries
        // must remain discoverable after backward shifting.
        cells.remove(colliding[1]);
        assert!(!cells.contains_key(colliding[1]));
        assert_eq!(cells.len(), 4);
        for &hex in &colliding[2..] {
            assert!(cells.contains_key(hex), "lost colliding key {hex}");
        }
    }

    #[test]
    fn fixed_board_table_delete_scans_past_home_slot_for_later_collision() {
        // Preserve the home-slot deletion regression under any hash. Also
        // exercise the same chain across the end of the circular table.
        for home in [0, BOARD_TABLE_MASK] {
            let mut colliding = Vec::new();
            let mut next_home = None;
            for q in -50..=50 {
                for r in -50..=50 {
                    let hex = Hex::new(q, r);
                    let bucket = BoardCells::hash(hex);
                    if bucket == home && colliding.len() < 2 { colliding.push(hex); }
                    if bucket == ((home + 1) & BOARD_TABLE_MASK) { next_home = Some(hex); }
                }
            }
            assert_eq!(colliding.len(), 2);
            let (a, b, c) = (colliding[0], next_home.unwrap(), colliding[1]);
            assert_eq!(BoardCells::hash(a), home);
            assert_eq!(BoardCells::hash(b), (home + 1) & BOARD_TABLE_MASK);
            assert_eq!(BoardCells::hash(c), home);
            let mut cells = BoardCells::default();
            cells.insert(a, CellStack::single(Piece::new(Color::White, Bug::Ant, 1)));
            cells.insert(b, CellStack::single(Piece::new(Color::White, Bug::Ant, 2)));
            cells.insert(c, CellStack::single(Piece::new(Color::White, Bug::Ant, 3)));
            assert!(cells.remove(a).is_some());
            assert!(!cells.contains_key(a));
            assert!(cells.contains_key(b));
            assert!(cells.contains_key(c), "later collision stranded across home slot");
            assert_eq!(cells.len(), 2);
        }
    }

    #[test]
    fn board_table_collision_stacks_clone_and_reuse() {
        let mut keys = Vec::new();
        for q in -50..=50 {
            for r in -50..=50 {
                let hex = Hex::new(q, r);
                if BoardCells::hash(hex) == BOARD_TABLE_MASK && keys.len() < 7 { keys.push(hex); }
            }
        }
        assert_eq!(keys.len(), 7);
        let pieces = Piece::all_for(Color::White, GameType::mlp());
        let mut cells = BoardCells::default();
        for (i, &key) in keys.iter().enumerate() {
            let mut stack = CellStack::default();
            for &piece in &pieces[..i + 1] { stack.push(piece); }
            cells.insert(key, stack);
        }
        let mut copy = cells.clone();
        for i in [0, 3, 6, 1, 5, 2, 4] {
            assert_eq!(copy.remove(keys[i]).unwrap().as_slice(), &pieces[..i + 1]);
            // Reusing the emptied slot must not expose the stale stack.
            assert!(copy.get_or_insert_default(keys[i]).is_empty());
            copy.get_mut(keys[i]).unwrap().push(pieces[13]);
            assert_eq!(copy.remove(keys[i]).unwrap().as_slice(), &[pieces[13]]);
            for (j, &key) in keys.iter().enumerate() {
                if let Some(stack) = copy.get(key) { assert_eq!(stack.as_slice(), &pieces[..j + 1]); }
                assert_eq!(cells.get(key).unwrap().as_slice(), &pieces[..j + 1]);
            }
        }
        assert_eq!(copy.len(), 0);
        assert_eq!(copy.values().count(), 0);
    }

    #[test]
    fn board_table_matches_reference_through_mixed_operations() {
        use std::collections::BTreeMap;
        for seed in 1..=16_u64 {
            let mut rng = seed;
            let mut cells = BoardCells::default();
            let mut reference = BTreeMap::new();
            for step in 0..2000 {
                rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
                let hex = Hex::new((rng as i16 % 16) - 8, ((rng >> 16) as i16 % 16) - 8);
                let piece = Piece::new(Color::White, Bug::Ant, (step % 3 + 1) as u8);
                if rng & 3 == 0 {
                    assert_eq!(cells.remove(hex).map(|s| s.pieces[0]), reference.remove(&hex));
                } else if reference.len() < MAX_PIECES || reference.contains_key(&hex) {
                    cells.insert(hex, CellStack::single(piece));
                    reference.insert(hex, piece);
                } else {
                    let key = *reference.keys().nth(rng as usize % reference.len()).unwrap();
                    assert_eq!(cells.remove(key).map(|s| s.pieces[0]), reference.remove(&key));
                }
                assert_eq!(cells.len(), reference.len());
                for (&key, &expected) in &reference {
                    assert_eq!(cells.get(key).unwrap().as_slice(), &[expected]);
                }
                assert_eq!(cells.get(hex).map(|s| s.pieces[0]), reference.get(&hex).copied());
            }
        }
    }

    #[test]
    fn board_table_preserves_translated_shapes_through_deletion() {
        for origin in [Hex::ORIGIN, Hex::new(-123, 87), Hex::new(32000, -32000)] {
            for shape in 0..4 {
                let mut cells = BoardCells::default();
                let mut keys = Vec::new();
                for i in 0..28_i16 {
                    let (q, r) = match shape {
                        0 => (i, 0), 1 => (0, i), 2 => (i, -i), _ => (i % 7, i / 7),
                    };
                    let hex = Hex::new(origin.q + q, origin.r + r);
                    cells.insert(hex, CellStack::single(Piece::new(Color::White, Bug::Queen, 1)));
                    keys.push(hex);
                }
                while !keys.is_empty() {
                    let removed = keys.remove(keys.len() / 2);
                    assert!(cells.remove(removed).is_some());
                    assert!(!cells.contains_key(removed));
                    assert_eq!(cells.len(), keys.len());
                    for &hex in &keys { assert!(cells.contains_key(hex)); }
                }
            }
        }
    }

    #[test]
    fn fixed_board_table_insert_remove_round_trip() {
        let mut cells = BoardCells::default();
        let hexes = [
            Hex::new(0, 0),
            Hex::new(1, 0),
            Hex::new(0, -1),
            Hex::new(-1, 1),
            Hex::new(7, -4),
            Hex::new(-9, 13),
        ];
        for (i, hex) in hexes.iter().copied().enumerate() {
            cells.insert(
                hex,
                CellStack::single(Piece::new(Color::White, Bug::Grasshopper, (i % 3 + 1) as u8)),
            );
        }
        assert_eq!(cells.keys().count(), hexes.len());
        assert_eq!(cells.values().count(), hexes.len());

        for hex in hexes {
            assert!(cells.remove(hex).is_some());
            assert!(!cells.contains_key(hex));
        }
        assert_eq!(cells.len(), 0);
    }

    #[test]
    fn generated_moves_match_checked_application_and_undo() {
        let mut compared = 0;
        for mask in 0..8 {
            let game_type = GameType { mosquito: mask & 1 != 0, ladybug: mask & 2 != 0, pillbug: mask & 4 != 0 };
            for seed in 1..=2_u64 {
                let mut board = Board::new(game_type);
                let mut rng = seed;
                for _ in 0..80 {
                    let moves = board.legal_moves();
                    if moves.is_empty() { break; }
                    for &mv in &moves {
                        let before = board.position_key();
                        let mut actual = board.clone();
                        let mut reference = board.clone();
                        let undo = actual.make_generated(mv);
                        let reference_undo = reference.make_unchecked(mv).unwrap();
                        assert_eq!(actual.position_key(), reference.position_key());
                        assert_eq!(actual.locations, reference.locations);
                        assert_eq!(actual.ply, reference.ply);
                        assert_eq!(actual.turns_taken, reference.turns_taken);
                        actual.undo_generated(undo);
                        reference.undo(reference_undo).unwrap();
                        assert_eq!(actual.position_key(), before);
                        assert_eq!(actual.position_key(), reference.position_key());
                        assert_eq!(actual.locations, reference.locations);
                        compared += 1;
                    }
                    rng ^= rng << 13; rng ^= rng >> 7; rng ^= rng << 17;
                    board.make_unchecked(moves[rng as usize % moves.len()]).unwrap();
                }
            }
        }
        assert!(compared > 1000);
    }

    #[test]
    fn singleton_destination_keeps_imported_grasshopper_source_stack() {
        let mut board = Board::new(GameType::mlp());
        let source = Hex::ORIGIN;
        let destination = Hex::new(2, 0);
        let queen = Piece::new(Color::White, Bug::Queen, 1);
        let hopper = Piece::new(Color::White, Bug::Grasshopper, 1);
        board.make_unchecked(HiveMove::Place { piece: queen, to: source }).unwrap();
        board.make_unchecked(HiveMove::Place { piece: Piece::new(Color::Black, Bug::Queen, 1), to: Hex::new(1, 0) }).unwrap();
        board.make_unchecked(HiveMove::Place { piece: hopper, to: Hex::new(-1, 0) }).unwrap();
        board.make_unchecked(HiveMove::Pass).unwrap();
        board.make_unchecked(HiveMove::Move { piece: hopper, from: Hex::new(-1, 0), to: source }).unwrap();
        board.make_unchecked(HiveMove::Pass).unwrap();
        let mv = HiveMove::Move { piece: hopper, from: source, to: destination };
        assert!(board.legal_moves().contains(&mv));
        let before = board.position_key();
        let undo = board.make_generated(mv);
        assert_eq!(board.top(source), Some(queen));
        assert_eq!(board.stack_height(source), 1);
        assert_eq!(board.top(destination), Some(hopper));
        board.undo_generated(undo);
        assert_eq!(board.position_key(), before);
        assert_eq!(board.stack_height(source), 2);
    }

    #[test]
    fn make_and_undo_placement_restores_position() {
        let mut board = Board::default();
        let before = board.position_key();
        let queen = Piece::new(Color::White, Bug::Queen, 1);
        let undo = board
            .make_unchecked(HiveMove::Place {
                piece: queen,
                to: Hex::ORIGIN,
            })
            .unwrap();

        assert_eq!(board.location(queen), Some(Hex::ORIGIN));
        assert!(!board.is_in_hand(queen));
        assert_eq!(board.side_to_move(), Color::Black);

        board.undo(undo).unwrap();
        assert_eq!(board.position_key(), before);
        assert_eq!(board.side_to_move(), Color::White);
        assert_eq!(board.ply(), 0);
    }

    #[test]
    fn make_and_undo_stack_move_restores_position() {
        let mut board = Board::default();
        let wq = Piece::new(Color::White, Bug::Queen, 1);
        let bq = Piece::new(Color::Black, Bug::Queen, 1);
        let wb = Piece::new(Color::White, Bug::Beetle, 1);

        board
            .make_unchecked(HiveMove::Place {
                piece: wq,
                to: Hex::ORIGIN,
            })
            .unwrap();
        board
            .make_unchecked(HiveMove::Place {
                piece: bq,
                to: Hex::new(1, 0),
            })
            .unwrap();
        board
            .make_unchecked(HiveMove::Place {
                piece: wb,
                to: Hex::new(-1, 0),
            })
            .unwrap();
        board.make_unchecked(HiveMove::Pass).unwrap();

        let before = board.position_key();
        let undo = board
            .make_unchecked(HiveMove::Move {
                piece: wb,
                from: Hex::new(-1, 0),
                to: Hex::new(1, 0),
            })
            .unwrap();

        assert_eq!(board.stack_height(Hex::new(1, 0)), 2);
        assert_eq!(board.top(Hex::new(1, 0)), Some(wb));
        board.undo(undo).unwrap();
        assert_eq!(board.position_key(), before);
        assert_eq!(board.location(wb), Some(Hex::new(-1, 0)));
    }
}
