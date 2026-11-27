use crate::{
    ai,
    config::BotConfig,
    protocol::{ClientRequest, Game, GameAction},
    session::{Outgoing, Shared},
    turn_tracker::{TurnTracker, TurnTracking},
};
use std::sync::Arc;
use tokio::sync::{mpsc, Semaphore};
use tracing::{debug, error, info};

pub struct Turn {
    pub game: Game,
    pub position_key: u64,
    pub bot: Arc<BotConfig>,
    pub outbox: mpsc::UnboundedSender<Outgoing>,
}

/// Set while the person at the viewer plays the moves by hand.
pub static MANUAL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub async fn play_turn(turn: Turn, shared: Arc<Shared>, turn_tracker: TurnTracker) {
    let Some(bestmove) = think(&turn, &shared.engine_slots).await else {
        turn_tracker.processed(turn.position_key).await;
        return;
    };
    // Switched to playing by hand while the engine was thinking: the person's move counts, not the engine's.
    if MANUAL.load(std::sync::atomic::Ordering::Relaxed) {
        turn_tracker.processed(turn.position_key).await;
        return;
    }
    info!(bot = %turn.bot.name, game_id = %turn.game.game_id, bestmove = %bestmove, "playing move");
    crate::protocol::hb(serde_json::json!({
        "ev": "move", "id": turn.game.game_id, "turn": turn.game.turn, "move": bestmove,
    }));
    let play = Outgoing::Move {
        position_key: turn.position_key,
        request: ClientRequest::Game {
            game_id: turn.game.game_id.clone(),
            action: GameAction::PlayAt {
                turn: turn.game.turn,
                notation: bestmove,
            },
        },
    };
    // The session loop holds the receiver for the life of the process.
    let _ = turn.outbox.send(play);
}

async fn think(turn: &Turn, engine_slots: &Semaphore) -> Option<String> {
    let bot = &turn.bot.name;
    let game_id = &turn.game.game_id;
    let _permit = match engine_slots.acquire().await {
        Ok(permit) => permit,
        Err(e) => {
            error!(bot = %bot, game_id = %game_id, error = %e, "engine slots closed");
            return None;
        }
    };
    let game_string = turn.game.uhp_game_string();
    debug!(bot = %bot, game_id = %game_id, game_string = %game_string, "thinking");
    let child = match ai::spawn_process(&turn.bot.ai_command, bot) {
        Ok(child) => child,
        Err(e) => {
            error!(bot = %bot, game_id = %game_id, error = %e, "failed to spawn AI process");
            return None;
        }
    };
    // HotFrass patch: with a configured "time hh:mm:ss", treat it as a ceiling and budget from the clock.
    let configured = turn.bot.bestmove_command_args.trim();
    let args = configured
        .strip_prefix("time ")
        .and_then(|t| {
            let p: Vec<u64> = t.trim().split(':').filter_map(|x| x.parse().ok()).collect();
            (p.len() == 3).then(|| p[0] * 3600 + p[1] * 60 + p[2])
        })
        .and_then(|max_secs| turn.game.bestmove_time_args(max_secs))
        .unwrap_or_else(|| configured.to_string());
    info!(bot = %bot, game_id = %game_id, args = %args, "thinking");
    crate::protocol::hb(serde_json::json!({
        "ev": "think", "id": turn.game.game_id, "turn": turn.game.turn, "args": args,
    }));
    let (progress_id, progress_turn) = (turn.game.game_id.clone(), turn.game.turn);
    let on_progress = move |depth: u32, score: i64, mv: String| {
        crate::protocol::hb(serde_json::json!({
            "ev": "info", "id": progress_id, "turn": progress_turn, "depth": depth, "score": score, "move": mv,
        }));
    };
    match ai::run_commands(child, &game_string, &args, on_progress).await {
        Ok(bestmove) => Some(bestmove),
        Err(e) => {
            error!(bot = %bot, game_id = %game_id, error = %e, "AI failed to produce a move");
            crate::protocol::hb(serde_json::json!({"ev": "error", "msg": format!("engine failed: {e}")}));
            None
        }
    }
}
