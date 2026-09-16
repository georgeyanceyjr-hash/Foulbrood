//! FoulBrood: a correctness-first Hive engine core.
//!
//! Milestone 1 implements:
//! - axial hex coordinates
//! - full Base / M / L / P inventory
//! - stacked board representation
//! - compact piece locations + in-hand bitset
//! - make/undo for placement, movement, and pass
//! - deterministic position keys
//! - complete legal move generation for Base + M/L/P
//! - UHP parsing, serialization, history, undo, and command-line protocol

mod board;
mod coord;
mod fast_hash;
mod mv;
mod piece;
mod placement;
mod movement;
pub mod uhp;
pub mod search;

pub use board::{Board, MoveError, Undo, MAX_PIECES};
pub use coord::{Direction, Hex};
pub use mv::HiveMove;
pub use piece::{Bug, Color, GameType, Piece};
pub use uhp::{game_type_string, move_to_uhp, parse_game_type, parse_piece, GameState, UhpEngine, UhpGame};

mod position;
