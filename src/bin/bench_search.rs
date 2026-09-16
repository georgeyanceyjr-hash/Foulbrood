//! Search measurement helper; does not change the UHP response format.
use foulbrood::{search::SearchLimit, move_to_uhp, UhpGame};
use std::time::Duration;
use std::io::{self, Write};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(args.len() == 3 || (args.len() == 4 && args[3] == "--progress"), "usage: bench_search GAMESTRING MILLISECONDS_OR_depth:N [--progress]");
    let game = UhpGame::from_game_string(&args[1]).expect("valid GameString");
    let limit = if args[2] == "infinite" { SearchLimit::Depth(64) } else if let Some(depth) = args[2].strip_prefix("depth:") {
        SearchLimit::Depth(depth.parse().expect("depth"))
    } else {
        SearchLimit::Time(Duration::from_millis(args[2].parse().expect("milliseconds")))
    };
    let publish = |result: &foulbrood::search::SearchResult| {
        let mv = result.best_move.map(|m| move_to_uhp(game.board(), m).unwrap()).unwrap_or_default();
        println!("{}\t{}\t{}\t{:.6}\t{}", result.completed_depth, result.nodes,
            result.score.map(|s| s.to_string()).unwrap_or_default(), result.elapsed.as_secs_f64(), mv);
        io::stdout().flush().expect("write progress");
    };
    let result = if args[2] == "infinite" || args.len() == 4 { game.search_with_progress(limit, publish) } else { game.search(limit) };
    publish(&result);
}
