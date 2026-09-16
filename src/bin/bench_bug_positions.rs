//! Whole legal-move generation on bug-focused positions; no per-bug timing claim.
use foulbrood::{Bug, HiveMove, UhpGame};
use std::hint::black_box;
use std::io::{self, BufRead};
use std::time::{Duration, Instant};

fn coverage(game: &UhpGame) -> [usize; 22] {
    let mut counts = [0; 22];
    for mv in game.board().legal_moves() {
        counts[0] += 1;
        match mv {
            HiveMove::Place { .. } => counts[1] += 1,
            HiveMove::Move { piece, from, .. } => {
                counts[2 + piece.bug as usize] += 1;
                if piece.bug == Bug::Beetle || piece.bug == Bug::Mosquito {
                    let offset = if piece.bug == Bug::Beetle { 18 } else { 20 };
                    counts[offset + usize::from(game.board().stack_height(from) > 1)] += 1;
                }
            }
            HiveMove::Pillbug { actor, .. } => counts[10 + actor.bug as usize] += 1,
            HiveMove::Pass => {}
        }
    }
    counts
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let inspect = args.get(1).is_some_and(|s| s == "--inspect");
    let seconds: f64 = args.get(2).map(|s| s.parse().expect("seconds")).unwrap_or(0.2);
    let runs: usize = args.get(3).map(|s| s.parse().expect("runs")).unwrap_or(5);
    assert!(seconds.is_finite() && seconds > 0.0 && runs > 0);
    for line in io::stdin().lock().lines() {
        let position = line.expect("read position");
        let game = UhpGame::from_game_string(&position).expect("valid GameString");
        let counts = coverage(&game);
        if inspect {
            println!("{:?}", counts);
            continue;
        }
        let expected = game.board().legal_moves();
        // Parsing and verification are outside the timed region. Allocation is
        // included: this measures the public legal_moves API, not perft's reused
        // buffers or any individual movement routine.
        for _ in 0..1024 { black_box(game.board().legal_moves()); }
        let mut samples = Vec::new();
        for _ in 0..runs {
            let start = Instant::now();
            let mut iterations = 0_u64;
            loop {
                for _ in 0..256 {
                    black_box(black_box(game.board()).legal_moves());
                }
                iterations += 256;
                if start.elapsed() >= Duration::from_secs_f64(seconds) { break; }
            }
            samples.push(start.elapsed().as_secs_f64() * 1e9 / iterations as f64);
        }
        assert_eq!(game.board().legal_moves(), expected, "move generation changed state");
        let mut descriptions: Vec<String> = expected.iter().map(ToString::to_string).collect();
        descriptions.sort();
        println!("{{\"coverage\":{:?},\"perft3\":{},\"moves\":{:?},\"ns_per_generation\":{:?}}}", counts, game.perft(3), descriptions, samples);
    }
}
