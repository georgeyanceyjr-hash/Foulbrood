use std::fmt;

/// Axial coordinates for a pointy/flat orientation-independent hex grid.
/// Only adjacency matters to the engine.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Hex {
    pub q: i16,
    pub r: i16,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(u8)]
pub enum Direction {
    E = 0,
    NE = 1,
    NW = 2,
    W = 3,
    SW = 4,
    SE = 5,
}

impl Direction {
    pub const ALL: [Direction; 6] = [
        Direction::E,
        Direction::NE,
        Direction::NW,
        Direction::W,
        Direction::SW,
        Direction::SE,
    ];

    pub const fn delta(self) -> (i16, i16) {
        match self {
            Direction::E => (1, 0),
            Direction::NE => (1, -1),
            Direction::NW => (0, -1),
            Direction::W => (-1, 0),
            Direction::SW => (-1, 1),
            Direction::SE => (0, 1),
        }
    }

    pub const fn opposite(self) -> Direction {
        match self {
            Direction::E => Direction::W,
            Direction::NE => Direction::SW,
            Direction::NW => Direction::SE,
            Direction::W => Direction::E,
            Direction::SW => Direction::NE,
            Direction::SE => Direction::NW,
        }
    }
}

impl Hex {
    pub const ORIGIN: Hex = Hex { q: 0, r: 0 };

    pub const fn new(q: i16, r: i16) -> Self {
        Self { q, r }
    }

    pub const fn neighbor(self, direction: Direction) -> Self {
        let (dq, dr) = direction.delta();
        Self {
            q: self.q + dq,
            r: self.r + dr,
        }
    }

    pub fn neighbors(self) -> [Hex; 6] {
        Direction::ALL.map(|direction| self.neighbor(direction))
    }

    #[inline(always)]
    pub fn direction_to(self, other: Hex) -> Option<Direction> {
        match (other.q - self.q, other.r - self.r) {
            (1, 0) => Some(Direction::E),
            (1, -1) => Some(Direction::NE),
            (0, -1) => Some(Direction::NW),
            (-1, 0) => Some(Direction::W),
            (-1, 1) => Some(Direction::SW),
            (0, 1) => Some(Direction::SE),
            _ => None,
        }
    }

    /// The two hexes touching the shared edge between two adjacent hexes.
    /// Hot-path implementation: derive them directly from the axial delta
    /// instead of scanning all six directions.
    #[inline(always)]
    pub fn gate_flanks(self, other: Hex) -> Option<(Hex, Hex)> {
        let (a, b) = match (other.q - self.q, other.r - self.r) {
            (1, 0) => (Direction::NE, Direction::SE),
            (1, -1) => (Direction::NW, Direction::E),
            (0, -1) => (Direction::W, Direction::NE),
            (-1, 0) => (Direction::SW, Direction::NW),
            (-1, 1) => (Direction::SE, Direction::W),
            (0, 1) => (Direction::E, Direction::SW),
            _ => return None,
        };
        Some((self.neighbor(a), self.neighbor(b)))
    }

    pub fn distance(self, other: Hex) -> u16 {
        let dq = i32::from(self.q) - i32::from(other.q);
        let dr = i32::from(self.r) - i32::from(other.r);
        let ds = -dq - dr;
        ((dq.abs() + dr.abs() + ds.abs()) / 2) as u16
    }
}

impl fmt::Display for Hex {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "({}, {})", self.q, self.r)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn origin_has_six_unique_neighbors() {
        let neighbors = Hex::ORIGIN.neighbors();
        let unique: HashSet<_> = neighbors.into_iter().collect();
        assert_eq!(unique.len(), 6);
        assert!(unique.iter().all(|hex| Hex::ORIGIN.distance(*hex) == 1));
    }

    #[test]
    fn opposite_direction_round_trip() {
        for direction in Direction::ALL {
            let there = Hex::ORIGIN.neighbor(direction);
            let back = there.neighbor(direction.opposite());
            assert_eq!(back, Hex::ORIGIN);
        }
    }

    #[test]
    fn gate_flanks_are_shared_neighbors() {
        let a = Hex::ORIGIN;
        let b = Hex::new(1, 0);
        let (left, right) = a.gate_flanks(b).unwrap();
        assert_eq!(HashSet::from([left, right]), HashSet::from([Hex::new(1, -1), Hex::new(0, 1)]));
    }
}
