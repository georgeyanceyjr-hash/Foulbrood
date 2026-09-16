use foulbrood::UhpGame;
use std::hint::black_box;
use std::time::{Duration, Instant};

const MIDGAME_81: &str = r#"Base+MLP;InProgress;White[41];wP;bB1 wP\;wL wP/;bP bB1\;wS1 wL-;bM bP-;wQ -wL;bQ bB1-;wS1 \wQ;bA1 bQ/;wB1 \wS1;bS1 bQ-;wS2 wL/;bL bS1-;wB2 wS2-;bM bP\;wA1 -wQ;bG1 bS1\;wA1 /bM;bB2 bG1\;wM wS2/;wA1 -bB2;wG1 \wM;bM bL-;wA1 bS1/;bA1 wA1-;wG2 \wB1;bA1 wG1/;wA1 -wB1;bS2 bQ\;wA1 bS2\;bG2 bQ/;wA1 wG1-;bG2 bB2\;wG3 -wG2;bA2 \bA1;wA2 -wQ;bA3 bQ/;wA1 wB2-;bA3 wS2\;wA2 bQ/;bS2 bP\;wA3 \wG2;bA2 -bS2;wA3 /wP;bG3 bG2-;wA3 wQ/;bA1 \wG2;wL /bB1;bA2 wA1-;wA2 bB2-;bA3 bS1/;wA2 -wL;bA3 wB2\;wA2 bG2\;bS2 wL\;wA2 /wQ;bA3 wG2/;wA2 bG2\;bA3 bG3-;wG3 wB1/;bA2 wG3/;wA2 /bS2;bA2 wG1/;wA1 -bA1;bA3 \wL;wA2 bA1/;bA3 bQ\;wL /bS2;bA3 bM-;wA1 wG1-;bA3 -wS1;wA2 bG3/;bA1 -wQ;wG3 -bA1;bA2 /wG3;wA2 wA1-;bA1 wL-;wA2 bA2\;bM bQ\"#;
const EXPECTED: u64 = 97_224_155;

fn main() {
    let game = UhpGame::from_game_string(MIDGAME_81).expect("midgame-81 GameString must load");
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut runs = 0u64;
    let mut checksum = 0u64;

    while Instant::now() < deadline {
        let nodes = black_box(game.perft(4));
        assert_eq!(nodes, EXPECTED, "midgame-81 perft changed");
        checksum ^= nodes.wrapping_add(runs);
        runs += 1;
    }

    eprintln!("profile workload complete: {runs} runs, checksum={checksum}");
}
