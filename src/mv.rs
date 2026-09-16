use crate::{Hex, Piece};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum HiveMove {
    Place { piece: Piece, to: Hex },
    Move { piece: Piece, from: Hex, to: Hex },
    /// Pillbug special ability, including a Mosquito mimicking it.
    /// `actor` does not physically move; `piece` does.
    Pillbug {
        actor: Piece,
        piece: Piece,
        from: Hex,
        to: Hex,
    },
    Pass,
}

impl HiveMove {
    /// The piece physically moved by this turn, if any.
    pub const fn physical_piece(self) -> Option<Piece> {
        match self {
            HiveMove::Move { piece, .. } | HiveMove::Pillbug { piece, .. } => Some(piece),
            HiveMove::Place { .. } | HiveMove::Pass => None,
        }
    }

    pub const fn actor(self) -> Option<Piece> {
        match self {
            HiveMove::Place { piece, .. } | HiveMove::Move { piece, .. } => Some(piece),
            HiveMove::Pillbug { actor, .. } => Some(actor),
            HiveMove::Pass => None,
        }
    }
}

impl fmt::Display for HiveMove {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HiveMove::Place { piece, to } => write!(f, "place {piece} @ {to}"),
            HiveMove::Move { piece, from, to } => write!(f, "move {piece} {from} -> {to}"),
            HiveMove::Pillbug {
                actor,
                piece,
                from,
                to,
            } => write!(f, "pillbug {actor}: {piece} {from} -> {to}"),
            HiveMove::Pass => write!(f, "pass"),
        }
    }
}
