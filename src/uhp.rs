use crate::position::Position;
use crate::{Board, Bug, Color, Direction, GameType, Hex, HiveMove, Piece, Undo};
use std::collections::BTreeSet;
use std::fmt;

pub const ENGINE_NAME: &str = "FoulBrood";
pub const ENGINE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GameState {
    NotStarted,
    InProgress,
    Draw,
    WhiteWins,
    BlackWins,
}

impl fmt::Display for GameState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            GameState::NotStarted => "NotStarted",
            GameState::InProgress => "InProgress",
            GameState::Draw => "Draw",
            GameState::WhiteWins => "WhiteWins",
            GameState::BlackWins => "BlackWins",
        };
        f.write_str(text)
    }
}

impl GameState {
    fn parse(text: &str) -> Result<Self, String> {
        match text {
            "NotStarted" => Ok(Self::NotStarted),
            "InProgress" => Ok(Self::InProgress),
            "Draw" => Ok(Self::Draw),
            "WhiteWins" => Ok(Self::WhiteWins),
            "BlackWins" => Ok(Self::BlackWins),
            _ => Err(format!("invalid GameStateString '{text}'")),
        }
    }
}

#[derive(Clone, Debug)]
pub struct UhpGame {
    board: Board,
    setup_root: Option<String>,
    positions: Vec<Position>,
    moves: Vec<HiveMove>,
    move_strings: Vec<String>,
    undos: Vec<Undo>,
}

impl UhpGame {
    pub fn new(game_type: GameType) -> Self {
        Self {
            positions: vec![Position::new(&Board::new(game_type))],
            board: Board::new(game_type),
            setup_root: None,
            moves: Vec::new(),
            move_strings: Vec::new(),
            undos: Vec::new(),
        }
    }

    /// FoulBrood analysis root: variant~side~turn~piece:q:r:level,...~piece:from_q:from_r.
    pub fn from_root(text: &str) -> Result<Self, String> {
        if !text.contains('~') { return Ok(Self::new(parse_game_type(text)?)); }
        let f: Vec<_> = text.split('~').collect();
        if f.len()!=5 { return Err("Invalid setup position.".into()); }
        let variant = parse_game_type(f[0])?;
        let side = match f[1] { "0"=>Color::White,"1"=>Color::Black,_=>return Err("Choose White or Black to move.".into()) };
        let turn = f[2].parse::<u8>().map_err(|_|"Invalid turn number.")?;
        let coordinate = |x:&str| x.parse::<i16>().map_err(|_|"Invalid setup coordinate.".to_string());
        let mut pieces = Vec::new();
        if !f[3].is_empty() { for entry in f[3].split(',') {
            let p:Vec<_> = entry.split(':').collect(); if p.len()!=4 { return Err("Invalid setup piece.".into()); }
            pieces.push((parse_piece(p[0])?,Hex::new(coordinate(p[1])?,coordinate(p[2])?),p[3].parse::<usize>().map_err(|_|"Invalid stack level.")?));
            if pieces.len()>28 { return Err("Too many pieces.".into()); }
        }}
        let last = if f[4].is_empty() {None} else {
            let p:Vec<_> = f[4].split(':').collect(); if p.len()!=3 { return Err("Invalid last moved piece.".into()); }
            Some((parse_piece(p[0])?,Hex::new(coordinate(p[1])?,coordinate(p[2])?)))
        };
        let board = Board::from_setup(variant,side,turn,&pieces,last)?;
        Ok(Self { positions:vec![Position::new(&board)],board,setup_root:Some(text.to_string()),moves:Vec::new(),move_strings:Vec::new(),undos:Vec::new() })
    }

    pub fn from_game_string(text: &str) -> Result<Self, String> {
        let parts: Vec<&str> = text.split(';').map(str::trim).collect();
        if parts.len() < 3 {
            return Err("GameString must contain game type, state, and turn".to_string());
        }

        let declared_state = GameState::parse(parts[1])?;
        let declared_turn = parts[2];
        let mut game = Self::from_root(parts[0])?;

        for move_text in &parts[3..] {
            if move_text.is_empty() {
                return Err("GameString contains an empty MoveString".to_string());
            }
            game.play(move_text)?;
        }

        if game.state() != declared_state {
            return Err(format!(
                "GameString state mismatch: declared {declared_state}, reconstructed {}",
                game.state()
            ));
        }
        if game.turn_string() != declared_turn {
            return Err(format!(
                "GameString turn mismatch: declared {declared_turn}, reconstructed {}",
                game.turn_string()
            ));
        }

        Ok(game)
    }

    pub fn board(&self) -> &Board {
        &self.board
    }

    pub fn history(&self) -> &[HiveMove] {
        &self.moves
    }

    pub fn state(&self) -> GameState {
        let white_surrounded = self.board.queen_surrounded(Color::White);
        let black_surrounded = self.board.queen_surrounded(Color::Black);
        match (white_surrounded, black_surrounded) {
            (true, true) => GameState::Draw,
            (true, false) => GameState::BlackWins,
            (false, true) => GameState::WhiteWins,
            (false, false) if self.positions.last().is_some_and(|current| self.positions.iter().filter(|p| current.same_repetition(p,&self.board)).take(3).count()==3) => GameState::Draw,
            (false, false) if self.board.ply() == 0 => GameState::NotStarted,
            (false, false) => GameState::InProgress,
        }
    }

    pub fn turn_string(&self) -> String {
        let side = self.board.side_to_move();
        let color = match side {
            Color::White => "White",
            Color::Black => "Black",
        };
        let turn = u16::from(self.board.turns_taken(side)) + 1;
        format!("{color}[{turn}]")
    }

    pub fn game_string(&self) -> String {
        let mut fields = vec![
            self.setup_root.clone().unwrap_or_else(||game_type_string(self.board.game_type())),
            self.state().to_string(),
            self.turn_string(),
        ];
        fields.extend(self.move_strings.iter().cloned());
        fields.join(";")
    }

    pub fn valid_move_strings(&self) -> Result<Vec<String>, String> {
        let mut strings = BTreeSet::new();
        if matches!(self.state(), GameState::Draw | GameState::WhiteWins | GameState::BlackWins) { return Ok(Vec::new()); }
        for mv in self.board.legal_moves() {
            strings.insert(move_to_uhp(&self.board, mv)?);
        }
        Ok(strings.into_iter().collect())
    }

    pub fn play(&mut self, move_text: &str) -> Result<(), String> {
        if matches!(self.state(), GameState::Draw | GameState::WhiteWins | GameState::BlackWins) {
            return Err("game is over; there are no legal moves".to_string());
        }
        let normalized = move_text.trim();
        if normalized.is_empty() {
            return Err("MoveString is empty".to_string());
        }

        let mv = resolve_move_string(&self.board, normalized)?;
        let undo = self
            .board
            .make_unchecked(mv)
            .map_err(|error| format!("failed to apply legal move: {error}"))?;
        self.moves.push(mv);
        self.move_strings.push(normalized.to_string());
        self.undos.push(undo);
        self.positions.push(self.positions.last().expect("initial position").after(&self.board, mv));
        Ok(())
    }

    pub fn undo(&mut self, count: usize) -> Result<(), String> {
        if count == 0 {
            return Err("MovesToUndo must be at least 1".to_string());
        }
        if count > self.undos.len() {
            return Err(format!(
                "cannot undo {count} move(s); history contains {}",
                self.undos.len()
            ));
        }

        for _ in 0..count {
            let undo = self.undos.pop().expect("length checked above");
            self.board
                .undo(undo)
                .map_err(|error| format!("undo failed: {error}"))?;
            self.positions.pop();
            self.moves.pop();
            self.move_strings.pop();
        }
        Ok(())
    }

    /// Search using the full played history, including the current position.
    pub fn search(&self, limit: crate::search::SearchLimit) -> crate::search::SearchResult {
        crate::search::search_with_history(&self.board, limit, &self.positions)
    }

    /// Publish fully completed iterations while retaining one search and its history.
    pub fn search_with_progress(&self, limit: crate::search::SearchLimit, progress: impl FnMut(&crate::search::SearchResult)) -> crate::search::SearchResult {
        crate::search::search_with_progress(&self.board, limit, &self.positions, progress)
    }

    pub fn bestmove(&self, limit: crate::search::SearchLimit) -> Result<String, String> {
        let result = self.search(limit);
        let mv = result.best_move
            .ok_or_else(|| "game is over; there are no legal moves".to_string())?;
        move_to_uhp(&self.board, mv)
    }

    pub fn perft(&self, depth: u8) -> u64 {
        let mut board = self.board.clone();
        board.perft(depth)
    }
}

impl Default for UhpGame {
    fn default() -> Self {
        // The UHP specification defines bare `newgame` as Base Hive.
        Self::new(GameType::base())
    }
}

#[derive(Clone, Debug)]
pub struct UhpEngine {
    game: UhpGame,
    report_scores: bool,
}

impl Default for UhpEngine {
    fn default() -> Self {
        Self {
            game: UhpGame::default(),
            report_scores: false,
        }
    }
}

impl UhpEngine {
    pub fn game(&self) -> &UhpGame {
        &self.game
    }

    pub fn info_lines() -> Vec<String> {
        vec![
            format!("id {ENGINE_NAME} v{ENGINE_VERSION}"),
            "Mosquito;Ladybug;Pillbug".to_string(),
        ]
    }

    /// Execute one UHP command. Returned lines do not include the mandatory
    /// trailing `ok`; the command-line front end appends it uniformly.
    pub fn execute(&mut self, input: &str) -> Vec<String> {
        let line = input.trim();
        if line.is_empty() {
            return vec!["err Empty command.".to_string()];
        }

        let command = line.split_whitespace().next().unwrap_or_default();
        let args = line[command.len()..].trim();

        match command {
            "info" => {
                if args.is_empty() {
                    Self::info_lines()
                } else {
                    vec!["err info takes no parameters.".to_string()]
                }
            }
            "newgame" => self.cmd_newgame(args),
            "play" => self.cmd_play(args),
            "pass" => {
                if args.is_empty() {
                    self.cmd_play("pass")
                } else {
                    vec!["err pass takes no parameters.".to_string()]
                }
            }
            "validmoves" => self.cmd_validmoves(args),
            "bestmove" => self.cmd_bestmove(args),
            "undo" => self.cmd_undo(args),
            "options" => self.cmd_options(args),
            // Non-standard developer command. It is deliberately outside the
            // advertised capability list, but makes cross-engine correctness
            // testing much easier while the engine is young.
            "perft" => self.cmd_perft(args),
            _ => vec![format!("err Invalid command '{command}'.")],
        }
    }

    fn cmd_newgame(&mut self, args: &str) -> Vec<String> {
        let result = if args.is_empty() {
            Ok(UhpGame::new(GameType::base()))
        } else if args.contains(';') {
            UhpGame::from_game_string(args)
        } else {
            parse_game_type(args).map(UhpGame::new)
        };

        match result {
            Ok(game) => {
                self.game = game;
                vec![self.game.game_string()]
            }
            Err(error) => vec![format!("err {error}")],
        }
    }

    fn cmd_play(&mut self, args: &str) -> Vec<String> {
        if args.is_empty() {
            return vec!["err play requires a MoveString.".to_string()];
        }
        match self.game.play(args) {
            Ok(()) => vec![self.game.game_string()],
            Err(error) => vec![format!("invalidmove {error}")],
        }
    }

    fn cmd_validmoves(&self, args: &str) -> Vec<String> {
        if !args.is_empty() {
            return vec!["err validmoves takes no parameters.".to_string()];
        }
        match self.game.valid_move_strings() {
            Ok(moves) => vec![moves.join(";")],
            Err(error) => vec![format!("err {error}")],
        }
    }

    fn cmd_bestmove(&self, args: &str) -> Vec<String> {
        let mut parts = args.split_whitespace();
        let mode = parts.next();
        let limit = parts.next();
        if mode.is_none() || limit.is_none() || parts.next().is_some() {
            return vec!["err bestmove requires 'time hh:mm:ss' or 'depth N'.".to_string()];
        }

        use crate::search::SearchLimit;
        let limit = match (mode.unwrap(), limit.unwrap()) {
            ("depth", depth) => depth.parse::<u8>()
                .ok().filter(|&d| d <= 64).map(SearchLimit::Depth)
                .ok_or_else(|| "bestmove depth requires an integer from 0 to 64".to_string()),
            ("time", time) => parse_time_limit(time).map(SearchLimit::Time),
            (other, _) => Err(format!("unknown bestmove mode '{other}'")),
        };
        let limit = match limit {
            Ok(limit) => limit,
            Err(error) => return vec![format!("err {error}")],
        };
        if self.report_scores {
            let publish = |result: &crate::search::SearchResult| {
                if let (Some(mv), Some(score)) = (result.best_move, result.score) {
                    if let Ok(text) = move_to_uhp(self.game.board(), mv) {
                        eprintln!("FoulBroodScore v1;depth={};score={};move={}", result.completed_depth, score, text);
                    }
                }
            };
            let result = self.game.search_with_progress(limit, publish);
            publish(&result);
            return match result.best_move.and_then(|mv| move_to_uhp(self.game.board(), mv).ok()) {
                Some(mv) => vec![mv],
                None => vec!["err game is over; there are no legal moves".to_string()],
            };
        }
        match self.game.bestmove(limit) {
            Ok(mv) => vec![mv],
            Err(error) => vec![format!("err {error}")],
        }
    }

    fn cmd_undo(&mut self, args: &str) -> Vec<String> {
        let count = if args.is_empty() {
            1
        } else {
            match args.parse::<usize>() {
                Ok(value) => value,
                Err(_) => return vec!["err undo requires a positive integer.".to_string()],
            }
        };

        match self.game.undo(count) {
            Ok(()) => vec![self.game.game_string()],
            Err(error) => vec![format!("err {error}")],
        }
    }

    fn cmd_options(&mut self, args: &str) -> Vec<String> {
        match args {
            "" | "get ReportFoulBroodScores" => vec![format!("ReportFoulBroodScores;bool;{};False", if self.report_scores { "True" } else { "False" })],
            "set ReportFoulBroodScores True" => { self.report_scores = true; Vec::new() },
            "set ReportFoulBroodScores False" => { self.report_scores = false; Vec::new() },
            _ => vec!["err Unknown option or value.".to_string()],
        }
    }

    fn cmd_perft(&self, args: &str) -> Vec<String> {
        let depth = match args.parse::<u8>() {
            Ok(value) => value,
            Err(_) => return vec!["err perft requires a depth from 0 to 255.".to_string()],
        };
        vec![self.game.perft(depth).to_string()]
    }
}

pub fn parse_game_type(text: &str) -> Result<GameType, String> {
    if text == "Base" {
        return Ok(GameType::base());
    }
    let Some(expansions) = text.strip_prefix("Base+") else {
        return Err(format!("invalid GameTypeString '{text}'"));
    };
    if expansions.is_empty() {
        return Err(format!("invalid GameTypeString '{text}'"));
    }

    let mut game_type = GameType::base();
    for flag in expansions.chars() {
        let slot = match flag {
            'M' => &mut game_type.mosquito,
            'L' => &mut game_type.ladybug,
            'P' => &mut game_type.pillbug,
            _ => return Err(format!("unknown expansion flag '{flag}'")),
        };
        if *slot {
            return Err(format!("duplicate expansion flag '{flag}'"));
        }
        *slot = true;
    }
    Ok(game_type)
}

pub fn game_type_string(game_type: GameType) -> String {
    let mut text = "Base".to_string();
    if game_type.mosquito || game_type.ladybug || game_type.pillbug {
        text.push('+');
        if game_type.mosquito {
            text.push('M');
        }
        if game_type.ladybug {
            text.push('L');
        }
        if game_type.pillbug {
            text.push('P');
        }
    }
    text
}

pub fn parse_piece(text: &str) -> Result<Piece, String> {
    let bytes = text.as_bytes();
    if bytes.len() < 2 {
        return Err(format!("invalid piece short name '{text}'"));
    }

    let color = match bytes[0] as char {
        'w' => Color::White,
        'b' => Color::Black,
        _ => return Err(format!("invalid piece color in '{text}'")),
    };
    let bug = match bytes[1] as char {
        'Q' => Bug::Queen,
        'S' => Bug::Spider,
        'B' => Bug::Beetle,
        'G' => Bug::Grasshopper,
        'A' => Bug::Ant,
        'M' => Bug::Mosquito,
        'L' => Bug::Ladybug,
        'P' => Bug::Pillbug,
        _ => return Err(format!("invalid bug type in '{text}'")),
    };

    let number_text = &text[2..];
    let number = if bug.copies() == 1 {
        if !number_text.is_empty() {
            return Err(format!("{bug:?} short name must not include a number"));
        }
        1
    } else {
        if number_text.is_empty() {
            return Err(format!("piece '{text}' requires a copy number"));
        }
        let number = number_text
            .parse::<u8>()
            .map_err(|_| format!("invalid copy number in '{text}'"))?;
        if !(1..=bug.copies()).contains(&number) {
            return Err(format!("copy number out of range in '{text}'"));
        }
        number
    };

    Ok(Piece::new(color, bug, number))
}

pub fn move_to_uhp(board: &Board, mv: HiveMove) -> Result<String, String> {
    match mv {
        HiveMove::Pass => Ok("pass".to_string()),
        HiveMove::Place { piece, to } if board.ply() == 0 && to == Hex::ORIGIN => {
            Ok(piece.to_string())
        }
        HiveMove::Place { piece, to } => relative_move_string(board, piece, None, to),
        HiveMove::Move { piece, from, to } => {
            if board.is_occupied(to) {
                let target = board
                    .top(to)
                    .ok_or_else(|| format!("occupied destination {to} has no top piece"))?;
                Ok(format!("{piece} {target}"))
            } else {
                relative_move_string(board, piece, Some(from), to)
            }
        }
        HiveMove::Pillbug {
            piece, from, to, ..
        } => relative_move_string(board, piece, Some(from), to),
    }
}

fn relative_move_string(
    board: &Board,
    piece: Piece,
    lifted_source: Option<Hex>,
    destination: Hex,
) -> Result<String, String> {
    let mut candidates = Vec::new();
    for neighbor in destination.neighbors() {
        if let Some(target) = top_after_lift(board, neighbor, lifted_source) {
            candidates.push((target.id(), target, neighbor));
        }
    }
    candidates.sort_unstable_by_key(|(id, _, hex)| (*id, *hex));

    let (_, target, target_hex) = candidates
        .into_iter()
        .next()
        .ok_or_else(|| format!("cannot encode destination {destination}: no adjacent reference piece"))?;
    let direction = target_hex
        .direction_to(destination)
        .ok_or_else(|| "reference piece is not adjacent to destination".to_string())?;
    let position = relative_position_string(target, direction);
    Ok(format!("{piece} {position}"))
}

fn top_after_lift(board: &Board, hex: Hex, lifted_source: Option<Hex>) -> Option<Piece> {
    if lifted_source != Some(hex) {
        return board.top(hex);
    }
    let stack = board.stack(hex)?;
    if stack.len() < 2 {
        None
    } else {
        stack.get(stack.len() - 2).copied()
    }
}

fn relative_position_string(target: Piece, direction: Direction) -> String {
    match direction {
        Direction::NE => format!("{target}/"),
        Direction::E => format!("{target}-"),
        Direction::SE => format!("{target}\\"),
        Direction::SW => format!("/{target}"),
        Direction::W => format!("-{target}"),
        Direction::NW => format!("\\{target}"),
    }
}

fn resolve_move_string(board: &Board, text: &str) -> Result<HiveMove, String> {
    if text == "pass" {
        return board
            .legal_moves()
            .into_iter()
            .find(|mv| *mv == HiveMove::Pass)
            .ok_or_else(|| "pass is legal only when no other legal move exists".to_string());
    }

    let fields: Vec<&str> = text.split_whitespace().collect();
    if fields.is_empty() || fields.len() > 2 {
        return Err(format!("invalid MoveString '{text}'"));
    }
    let piece = parse_piece(fields[0])?;

    let destination = if fields.len() == 1 {
        if board.ply() != 0 {
            return Err("a MoveString without a relative position is valid only on move 1".to_string());
        }
        Hex::ORIGIN
    } else {
        parse_relative_destination(board, fields[1])?
    };

    let mut candidates = Vec::new();
    for mv in board.legal_moves() {
        let matches = match mv {
            HiveMove::Place { piece: p, to } => p == piece && to == destination,
            HiveMove::Move { piece: p, to, .. } => p == piece && to == destination,
            HiveMove::Pillbug { piece: p, to, .. } => p == piece && to == destination,
            HiveMove::Pass => false,
        };
        if matches {
            candidates.push(mv);
        }
    }

    if candidates.is_empty() {
        return Err(format!("'{text}' is not legal in the current position"));
    }

    // The notation does not encode whether a friendly piece reached a square
    // under its own power or via a Pillbug. Those paths produce the same game
    // state; prefer the ordinary move when both representations exist.
    candidates.sort_unstable_by_key(|mv| match mv {
        HiveMove::Place { .. } => 0_u8,
        HiveMove::Move { .. } => 1,
        HiveMove::Pillbug { .. } => 2,
        HiveMove::Pass => 3,
    });
    Ok(candidates[0])
}

fn parse_relative_destination(board: &Board, text: &str) -> Result<Hex, String> {
    if text.is_empty() {
        return Err("relative position is empty".to_string());
    }

    let (target_text, direction) = if let Some(rest) = text.strip_prefix('/') {
        (rest, Some(Direction::SW))
    } else if let Some(rest) = text.strip_prefix('-') {
        (rest, Some(Direction::W))
    } else if let Some(rest) = text.strip_prefix('\\') {
        (rest, Some(Direction::NW))
    } else if let Some(rest) = text.strip_suffix('/') {
        (rest, Some(Direction::NE))
    } else if let Some(rest) = text.strip_suffix('-') {
        (rest, Some(Direction::E))
    } else if let Some(rest) = text.strip_suffix('\\') {
        (rest, Some(Direction::SE))
    } else {
        (text, None)
    };

    if target_text.is_empty() {
        return Err(format!("invalid relative position '{text}'"));
    }
    let target = parse_piece(target_text)?;
    let target_hex = board
        .location(target)
        .ok_or_else(|| format!("reference piece {target} is not on the board"))?;
    Ok(match direction {
        Some(direction) => target_hex.neighbor(direction),
        None => target_hex,
    })
}

fn parse_time_limit(text: &str) -> Result<std::time::Duration, String> {
    let parts: Vec<&str> = text.split(':').collect();
    if parts.len() != 3 {
        return Err("bestmove time must use hh:mm:ss".to_string());
    }
    let hours = parts[0]
        .parse::<u64>()
        .map_err(|_| "invalid hours in bestmove time".to_string())?;
    let minutes = parts[1]
        .parse::<u8>()
        .map_err(|_| "invalid minutes in bestmove time".to_string())?;
    let seconds = parts[2]
        .parse::<u8>()
        .map_err(|_| "invalid seconds in bestmove time".to_string())?;
    if minutes >= 60 || seconds >= 60 {
        return Err("minutes and seconds in bestmove time must be below 60".to_string());
    }
    let seconds = hours.checked_mul(3600)
        .and_then(|h| h.checked_add(u64::from(minutes) * 60 + u64::from(seconds)))
        .ok_or_else(|| "bestmove time is too large".to_string())?;
    let duration = std::time::Duration::from_secs(seconds);
    std::time::Instant::now().checked_add(duration)
        .ok_or_else(|| "bestmove time is too large".to_string())?;
    Ok(duration)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_type_round_trip_all_expansions() {
        for text in ["Base", "Base+M", "Base+L", "Base+P", "Base+ML", "Base+MP", "Base+LP", "Base+MLP"] {
            let game_type = parse_game_type(text).unwrap();
            assert_eq!(game_type_string(game_type), text);
        }
        // Parsing is permissive about flag order but serialization is canonical.
        assert_eq!(game_type_string(parse_game_type("Base+PLM").unwrap()), "Base+MLP");
    }

    #[test]
    fn piece_short_names_round_trip() {
        for color in Color::ALL {
            for piece in Piece::all_for(color, GameType::mlp()) {
                assert_eq!(parse_piece(&piece.to_string()).unwrap(), piece);
            }
        }
    }

    #[test]
    fn bare_newgame_is_base_and_queen_is_not_a_first_move() {
        let engine = UhpEngine::default();
        assert_eq!(engine.game().game_string(), "Base;NotStarted;White[1]");
        let moves = engine.game().valid_move_strings().unwrap();
        assert_eq!(moves.len(), 4);
        assert!(!moves.iter().any(|mv| mv == "wQ"));
        assert!(moves.iter().any(|mv| mv == "wS1"));
        assert!(moves.iter().any(|mv| mv == "wB1"));
        assert!(moves.iter().any(|mv| mv == "wG1"));
        assert!(moves.iter().any(|mv| mv == "wA1"));
    }

    #[test]
    fn mlp_opening_has_seven_non_queen_moves() {
        let game = UhpGame::new(GameType::mlp());
        let moves = game.valid_move_strings().unwrap();
        assert_eq!(moves.len(), 7);
        assert!(!moves.iter().any(|mv| mv == "wQ"));
        assert!(moves.iter().any(|mv| mv == "wM"));
        assert!(moves.iter().any(|mv| mv == "wL"));
        assert!(moves.iter().any(|mv| mv == "wP"));
    }

    #[test]
    fn uhp_spec_game_string_reconstructs() {
        let text = "Base;InProgress;White[3];wS1;bG1 -wS1;wA1 wS1/;bG2 /bG1";
        let game = UhpGame::from_game_string(text).unwrap();
        assert_eq!(game.game_string(), text);
        assert_eq!(game.board().ply(), 4);
    }

    #[test]
    fn play_and_undo_preserve_history_string() {
        let mut game = UhpGame::new(GameType::base());
        game.play("wS1").unwrap();
        game.play("bG1 -wS1").unwrap();
        assert_eq!(game.game_string(), "Base;InProgress;White[2];wS1;bG1 -wS1");
        game.undo(1).unwrap();
        assert_eq!(game.game_string(), "Base;InProgress;Black[1];wS1");
    }

    #[test]
    fn queen_first_is_rejected() {
        let mut game = UhpGame::new(GameType::base());
        assert!(game.play("wQ").is_err());
    }

    #[test]
    fn relative_direction_mapping_matches_uhp_spec() {
        let target = Piece::new(Color::White, Bug::Spider, 1);
        assert_eq!(relative_position_string(target, Direction::NE), "wS1/");
        assert_eq!(relative_position_string(target, Direction::E), "wS1-");
        assert_eq!(relative_position_string(target, Direction::SE), "wS1\\");
        assert_eq!(relative_position_string(target, Direction::SW), "/wS1");
        assert_eq!(relative_position_string(target, Direction::W), "-wS1");
        assert_eq!(relative_position_string(target, Direction::NW), "\\wS1");
    }

    #[test]
    fn mzinga_regression_ground_beetle_cannot_cross_empty_shared_flanks() {
        let position = "Base+MLP;InProgress;Black[15];wB1;bS1 -wB1;wA1 wB1\\;bG1 \\bS1;wB2 wA1\\;bQ -bS1;wQ wB2\\;bM \\bG1;wM wB1-;bQ -bG1;wM wQ/;bS2 \\bQ;wG1 wB1-;bA1 bM/;wL wM-;bA1 -wQ;wL wB2/;bL -bS2;wP wM/;bA1 -bL;wP wM-;bG2 bA1/;wA2 wM/;bQ /bS2;wA3 -wQ;bP -bA1;wA1 wG1-;bB1 -bS1;wA1 /bP";
        let mut game = UhpGame::from_game_string(position).unwrap();

        assert!(game.play("bB1 bQ\\").is_err());
    }

    #[test]
    fn mzinga_regression_fixed_table_does_not_lose_occupied_destination() {
        let position = r#"Base+MLP;InProgress;White[41];wP;bB1 wP\;wL wP/;bP bB1\;wS1 wL-;bM bP-;wQ -wL;bQ bB1-;wS1 \wQ;bA1 bQ/;wB1 \wS1;bS1 bQ-;wS2 wL/;bL bS1-;wB2 wS2-;bM bP\;wA1 -wQ;bG1 bS1\;wA1 /bM;bB2 bG1\;wM wS2/;wA1 -bB2;wG1 \wM;bM bL-;wA1 bS1/;bA1 wA1-;wG2 \wB1;bA1 wG1/;wA1 -wB1;bS2 bQ\;wA1 bS2\;bG2 bQ/;wA1 wG1-;bG2 bB2\;wG3 -wG2;bA2 \bA1;wA2 -wQ;bA3 bQ/;wA1 wB2-;bA3 wS2\;wA2 bQ/;bS2 bP\;wA3 \wG2;bA2 -bS2;wA3 /wP;bG3 bG2-;wA3 wQ/;bA1 \wG2;wL /bB1;bA2 wA1-;wA2 bB2-;bA3 bS1/;wA2 -wL;bA3 wB2\;wA2 bG2\;bS2 wL\;wA2 /wQ;bA3 wG2/;wA2 bG2\;bA3 bG3-;wG3 wB1/;bA2 wG3/;wA2 /bS2;bA2 wG1/;wA1 -bA1;bA3 \wL;wA2 bA1/;bA3 bQ\;wL /bS2;bA3 bM-;wA1 wG1-;bA3 -wS1;wA2 bG3/;bA1 -wQ;wG3 -bA1;bA2 /wG3;wA2 wA1-;bA1 wL-;wA2 bA2\;bM bQ\"#;
        let mut game = UhpGame::from_game_string(position).unwrap();

        // Mzinga correctly rejects this move because its destination is
        // already occupied. The v0.7.0 fixed table could lose that occupied
        // cell from its probe chain after prior remove/undo activity.
        assert!(game.play("wA1 /wG3").is_err());
    }

    #[test]
    fn initial_perft_through_uhp_game_matches_corrected_openings() {
        assert_eq!(UhpGame::new(GameType::base()).perft(1), 4);
        assert_eq!(UhpGame::new(GameType::base()).perft(2), 96);
        assert_eq!(UhpGame::new(GameType::mlp()).perft(1), 7);
        assert_eq!(UhpGame::new(GameType::mlp()).perft(2), 294);
    }
}
