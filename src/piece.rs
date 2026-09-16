use std::fmt;

pub const PIECES_PER_COLOR: usize = 14;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
pub enum Color {
    White = 0,
    Black = 1,
}

impl Color {
    pub const ALL: [Color; 2] = [Color::White, Color::Black];

    pub const fn index(self) -> usize {
        self as usize
    }

    pub const fn other(self) -> Color {
        match self {
            Color::White => Color::Black,
            Color::Black => Color::White,
        }
    }

    pub const fn prefix(self) -> char {
        match self {
            Color::White => 'w',
            Color::Black => 'b',
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
pub enum Bug {
    Queen = 0,
    Spider = 1,
    Beetle = 2,
    Grasshopper = 3,
    Ant = 4,
    Mosquito = 5,
    Ladybug = 6,
    Pillbug = 7,
}

impl Bug {
    /// Stable move-generation order. Keeping this deterministic is useful for
    /// tests now and move ordering later.
    pub const ALL: [Bug; 8] = [
        Bug::Queen,
        Bug::Spider,
        Bug::Beetle,
        Bug::Grasshopper,
        Bug::Ant,
        Bug::Mosquito,
        Bug::Ladybug,
        Bug::Pillbug,
    ];

    pub const fn letter(self) -> char {
        match self {
            Bug::Queen => 'Q',
            Bug::Spider => 'S',
            Bug::Beetle => 'B',
            Bug::Grasshopper => 'G',
            Bug::Ant => 'A',
            Bug::Mosquito => 'M',
            Bug::Ladybug => 'L',
            Bug::Pillbug => 'P',
        }
    }

    pub const fn copies(self) -> u8 {
        match self {
            Bug::Queen | Bug::Mosquito | Bug::Ladybug | Bug::Pillbug => 1,
            Bug::Spider | Bug::Beetle => 2,
            Bug::Grasshopper | Bug::Ant => 3,
        }
    }

    const fn color_slot_start(self) -> u8 {
        match self {
            Bug::Queen => 0,
            Bug::Spider => 1,
            Bug::Beetle => 3,
            Bug::Grasshopper => 5,
            Bug::Ant => 8,
            Bug::Mosquito => 11,
            Bug::Ladybug => 12,
            Bug::Pillbug => 13,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct GameType {
    pub mosquito: bool,
    pub ladybug: bool,
    pub pillbug: bool,
}

impl GameType {
    pub const fn base() -> Self {
        Self {
            mosquito: false,
            ladybug: false,
            pillbug: false,
        }
    }

    pub const fn mlp() -> Self {
        Self {
            mosquito: true,
            ladybug: true,
            pillbug: true,
        }
    }

    pub const fn includes(self, bug: Bug) -> bool {
        match bug {
            Bug::Mosquito => self.mosquito,
            Bug::Ladybug => self.ladybug,
            Bug::Pillbug => self.pillbug,
            _ => true,
        }
    }
}

impl Default for GameType {
    fn default() -> Self {
        Self::mlp()
    }
}

/// A physical Hive piece.
///
/// `number` is 1-based. For bugs with a single copy it is always 1.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Piece {
    pub color: Color,
    pub bug: Bug,
    pub number: u8,
}

impl Piece {
    pub const fn new(color: Color, bug: Bug, number: u8) -> Self {
        Self { color, bug, number }
    }

    /// Stable ID in 0..28. This lets us use a u32 as an in-hand bitset.
    pub const fn id(self) -> usize {
        let color_offset = self.color as usize * PIECES_PER_COLOR;
        color_offset + self.bug.color_slot_start() as usize + (self.number as usize - 1)
    }

    pub fn all_for(color: Color, game_type: GameType) -> Vec<Piece> {
        let mut pieces = Vec::with_capacity(PIECES_PER_COLOR);
        for bug in Bug::ALL {
            if !game_type.includes(bug) {
                continue;
            }
            for number in 1..=bug.copies() {
                pieces.push(Piece::new(color, bug, number));
            }
        }
        pieces
    }
}

impl fmt::Display for Piece {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let color = self.color.prefix();
        let bug = self.bug.letter();
        if self.bug.copies() == 1 {
            write!(f, "{color}{bug}")
        } else {
            write!(f, "{color}{bug}{}", self.number)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn inventory_counts_are_correct() {
        assert_eq!(Piece::all_for(Color::White, GameType::base()).len(), 11);
        assert_eq!(Piece::all_for(Color::White, GameType::mlp()).len(), 14);
    }

    #[test]
    fn full_inventory_ids_are_unique() {
        let mut ids = HashSet::new();
        for color in Color::ALL {
            for piece in Piece::all_for(color, GameType::mlp()) {
                assert!(ids.insert(piece.id()), "duplicate id for {piece}");
            }
        }
        assert_eq!(ids.len(), 28);
        assert_eq!(ids.iter().copied().max(), Some(27));
    }
}
