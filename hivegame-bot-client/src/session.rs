use crate::{
    bot::{self, Turn},
    config::BotConfig,
    protocol::{self, Challenge, ChallengeAction, ClientRequest, Game, Incoming, User},
    token::{self, TokenError},
    turn_tracker::{TurnTracker, TurnTracking},
};
use futures_util::{SinkExt, StreamExt};
use std::{pin::pin, sync::Arc, time::Duration};
use tokio::{
    net::TcpStream,
    sync::{mpsc, Semaphore},
    time::{interval_at, sleep, timeout, Instant, MissedTickBehavior},
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{self, protocol::WebSocketConfig, Message},
    MaybeTlsStream,
    WebSocketStream,
};
use tracing::{debug, error, info, warn};

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
// The server sends a protocol ping about every second, so this much silence means the connection
// is dead.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(15);
// Pushes cover every move and challenge; this retries turns whose engine run failed and
// challenges whose accept was refused.
const RECONCILE_INTERVAL: Duration = Duration::from_secs(30);
const RECONNECT_DELAY_MIN: Duration = Duration::from_secs(1);
const RECONNECT_DELAY_MAX: Duration = Duration::from_secs(10);

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error(transparent)]
    Token(#[from] TokenError),
    #[error("websocket: {0}")]
    WebSocket(#[from] tungstenite::Error),
    #[error("could not encode request: {0}")]
    Encode(#[from] serde_json::Error),
    #[error("authentication refused: {0}")]
    AuthRefused(String),
    #[error("no authenticated connection within {CONNECT_TIMEOUT:?}")]
    ConnectTimeout,
    #[error("connection closed during authentication")]
    ClosedDuringAuth,
    #[error("nothing heard from the server for {SILENCE_TIMEOUT:?}")]
    Silent,
}

pub enum Outgoing {
    // Counts as played only once written, so the reconnect, which forgets played positions,
    // keeps tracking a move still waiting here.
    Move {
        position_key: u64,
        request: ClientRequest,
    },
    Resync,
    /// HotFrass patch: a request typed into the viewer's bot panel (a new challenge).
    Request(ClientRequest),
}

/// HotFrass patch: the viewer writes one JSON command per line to our stdin.
/// `{"cmd":"challenge","opponent":"Name"|null,"base":600,"increment":10,"rated":true}`
fn listen_for_commands(outbox: mpsc::UnboundedSender<Outgoing>, auto: Arc<AutoState>) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut line = String::new();
        loop {
            line.clear();
            match stdin.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let Ok(command) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            let cmd = command.get("cmd").and_then(|c| c.as_str()).unwrap_or("");
            if cmd == "accept" {
                // {"cmd":"accept","from":["Antsy"],"max_games":4,"min_base":600}
                let from: Vec<String> = command
                    .get("from")
                    .and_then(|f| f.as_array())
                    .map(|a| a.iter().filter_map(|n| n.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                let max_games = command.get("max_games").and_then(|m| m.as_u64()).unwrap_or(0) as usize;
                let min_base_secs = command.get("min_base").and_then(|m| m.as_i64()).unwrap_or(600);
                let anyone = command.get("anyone").and_then(|a| a.as_bool()).unwrap_or(false);
                let clock = match (
                    command.get("base").and_then(|b| b.as_i64()),
                    command.get("increment").and_then(|i| i.as_i64()),
                ) {
                    (Some(base), Some(increment)) => Some((base, increment)),
                    _ => None,
                };
                protocol::hb(serde_json::json!({"ev": "rules", "from": from, "max_games": max_games, "anyone": anyone}));
                let humans_only = command.get("humans").and_then(|h| h.as_bool()).unwrap_or(false);
                // "direct": accept challenges sent to us by name (only while no game is being played).
                let direct = command.get("direct").and_then(|d| d.as_bool()).unwrap_or(false);
                *auto.rules.lock().unwrap() = AutoRules { from, min_base_secs, max_games, anyone, clock, humans_only, direct };
                // A fresh allowance from now, and a new lobby snapshot to act on at once.
                auto.accepted.store(0, std::sync::atomic::Ordering::Relaxed);
                if outbox.send(Outgoing::Resync).is_err() {
                    return;
                }
                continue;
            }
            if cmd == "manual" {
                // {"cmd":"manual","on":true}: the person at the viewer makes the moves; the engine is not run.
                let on = command.get("on").and_then(|o| o.as_bool()).unwrap_or(false);
                auto.manual.store(on, std::sync::atomic::Ordering::Relaxed);
                protocol::hb(serde_json::json!({"ev": "manual", "on": on}));
                // Switching back to the engine in the middle of our turn: look at the games again.
                if outbox.send(Outgoing::Resync).is_err() {
                    return;
                }
                continue;
            }
            if cmd == "move" {
                // {"cmd":"move","id":"<game id>","turn":12,"move":"wA1 -bQ"}: a move made by hand on the viewer's board.
                let id = command.get("id").and_then(|i| i.as_str());
                let turn = command.get("turn").and_then(|t| t.as_u64());
                let notation = command.get("move").and_then(|m| m.as_str()).map(str::trim).filter(|m| !m.is_empty());
                if let (Some(id), Some(turn), Some(notation)) = (id, turn, notation) {
                    protocol::hb(serde_json::json!({"ev": "move", "id": id, "turn": turn, "move": notation, "by_hand": true}));
                    let request = ClientRequest::Game {
                        game_id: id.to_string(),
                        action: protocol::GameAction::PlayAt { turn: turn as usize, notation: notation.to_string() },
                    };
                    if outbox.send(Outgoing::Request(request)).is_err() {
                        return;
                    }
                }
                continue;
            }
            if cmd == "control" {
                // {"cmd":"control","id":"<game id>","what":"Resign","color":"White"}
                let id = command.get("id").and_then(|i| i.as_str());
                let what = command.get("what").and_then(|w| w.as_str()).filter(|w| {
                    ["Resign", "DrawOffer", "DrawAccept", "DrawReject", "Abort"].contains(w)
                });
                let color = command.get("color").and_then(|c| c.as_str()).filter(|c| *c == "White" || *c == "Black");
                if let (Some(id), Some(what), Some(color)) = (id, what, color) {
                    let mut control = serde_json::Map::new();
                    control.insert(what.to_string(), serde_json::Value::String(color.to_string()));
                    let request = ClientRequest::Game {
                        game_id: id.to_string(),
                        action: protocol::GameAction::Control(serde_json::Value::Object(control)),
                    };
                    if outbox.send(Outgoing::Request(request)).is_err() {
                        return;
                    }
                }
                continue;
            }
            if cmd == "resync" {
                if outbox.send(Outgoing::Resync).is_err() {
                    return;
                }
                continue;
            }
            if cmd == "withdraw" {
                // {"cmd":"withdraw","id":"<challenge id>"}: take back one of our own open challenges.
                if let Some(id) = command.get("id").and_then(|i| i.as_str()) {
                    let request = ClientRequest::Challenge(ChallengeAction::Delete(id.to_string()));
                    if outbox.send(Outgoing::Request(request)).is_err() {
                        return;
                    }
                    if outbox.send(Outgoing::Resync).is_err() {
                        return;
                    }
                }
                continue;
            }
            if cmd == "take" {
                // {"cmd":"take","id":"<challenge id>"}: accept one challenge picked in the viewer.
                if auto.busy() {
                    // One game at a time: nothing is accepted while a game is being played.
                    protocol::hb(serde_json::json!({"ev": "busy"}));
                    continue;
                }
                if let Some(id) = command.get("id").and_then(|i| i.as_str()) {
                    auto.active.lock().unwrap().insert(format!("pending-{id}"), Instant::now() - Duration::from_secs(1740));
                    protocol::hb(serde_json::json!({"ev": "accept", "id": id, "open": false, "from": ""}));
                    let request = ClientRequest::Challenge(ChallengeAction::Accept(id.to_string()));
                    if outbox.send(Outgoing::Request(request)).is_err() {
                        return;
                    }
                }
                continue;
            }
            if cmd != "challenge" {
                continue;
            }
            let opponent = command.get("opponent").and_then(|o| o.as_str()).filter(|o| !o.is_empty());
            let base = command.get("base").and_then(|b| b.as_i64()).unwrap_or(600).clamp(60, 10800);
            let increment = command.get("increment").and_then(|i| i.as_i64()).unwrap_or(10).clamp(0, 180);
            let rated = command.get("rated").and_then(|r| r.as_bool()).unwrap_or(true);
            // Our colour: White, Black, or Random (either).
            let color = match command.get("color").and_then(|c| c.as_str()) {
                Some("White") => "White",
                Some("Black") => "Black",
                _ => "Random",
            };
            // Rating range of who may take an open challenge (ignored for a direct one).
            let band = |name: &str| command.get(name).and_then(|b| b.as_i64()).filter(|_| opponent.is_none()).map(|b| b.clamp(0, 4000));
            let (band_lower, band_upper) = (band("min_rating"), band("max_rating"));
            let details = serde_json::json!({
                "rated": rated, "game_type": "MLP",
                "visibility": if opponent.is_some() { "Direct" } else { "Public" },
                "opponent": opponent, "color_choice": color, "time_mode": "RealTime",
                "time_base": base, "time_increment": increment, "band_upper": band_upper, "band_lower": band_lower,
            });
            protocol::hb(serde_json::json!({
                "ev": "challenge_sent", "opponent": opponent, "base": base, "increment": increment, "rated": rated, "color": color,
            }));
            let request = ClientRequest::Challenge(ChallengeAction::Create(details));
            if outbox.send(Outgoing::Request(request)).is_err() {
                return;
            }
        }
    });
}

pub struct Shared {
    pub http: reqwest::Client,
    pub base_url: String,
    pub websocket_url: String,
    pub engine_slots: Semaphore,
}

/// HotFrass patch: which of our games are running, and how many open challenges we took.
#[derive(Default)]
struct AutoState {
    active: std::sync::Mutex<std::collections::HashMap<String, Instant>>,
    accepted: std::sync::atomic::AtomicUsize,
    /// Whose open challenges to take; starts from the config and can be changed while running.
    rules: std::sync::Mutex<AutoRules>,
    /// The person at the viewer plays the moves; the engine stays idle.
    manual: std::sync::atomic::AtomicBool,
}

#[derive(Default, Clone)]
struct AutoRules {
    from: Vec<String>,
    min_base_secs: i64,
    max_games: usize,
    /// Take open challenges from any player, not only the listed names.
    anyone: bool,
    /// Only this exact clock (base seconds, increment seconds), when set.
    clock: Option<(i64, i64)>,
    /// Skip challenges from bot accounts.
    humans_only: bool,
    direct: bool,
}

impl AutoState {
    fn note(&self, game: &Game) {
        let mut active = self.active.lock().unwrap();
        if game.finished {
            active.remove(&game.game_id);
        } else {
            active.insert(game.game_id.clone(), Instant::now());
        }
    }

    fn busy(&self) -> bool {
        let mut active = self.active.lock().unwrap();
        // A game we have heard nothing about for 30 minutes is taken as over.
        active.retain(|_, seen| seen.elapsed() < Duration::from_secs(1800));
        !active.is_empty()
    }
}

struct Session {
    auto: Arc<AutoState>,
    bot: Arc<BotConfig>,
    shared: Arc<Shared>,
    me: User,
    outbox: mpsc::UnboundedSender<Outgoing>,
    turn_tracker: TurnTracker,
}

pub async fn run(bot: BotConfig, shared: Arc<Shared>) {
    let bot = Arc::new(bot);
    // Outlives each connection, so a move whose engine finishes during a reconnect
    // goes out on the next socket.
    let (outbox, mut queued) = mpsc::unbounded_channel();
    let turn_tracker = TurnTracker::new();
    let auto = Arc::new(AutoState::default());
    *auto.rules.lock().unwrap() = AutoRules {
        from: bot.accept_open_from.clone(),
        min_base_secs: bot.min_base_secs,
        max_games: bot.max_auto_games,
        anyone: false,
        clock: None,
        humans_only: false,
        direct: true, // as hive-hydra itself behaves, until the viewer sends its rules (it does so at start)
    };
    listen_for_commands(outbox.clone(), auto.clone());
    let mut reconnect_delay = RECONNECT_DELAY_MIN;
    loop {
        match connect(&bot, &shared).await {
            Ok((socket, me)) => {
                info!(bot = %bot.name, username = %me.username, "connected");
                protocol::hb(serde_json::json!({"ev": "connected", "user": me.username}));
                reconnect_delay = RECONNECT_DELAY_MIN;
                // A move written to a dying socket may never have arrived; if so the game is
                // still pending and must be played again.
                turn_tracker.forget_processed().await;
                let session = Session {
                    auto: auto.clone(),
                    bot: bot.clone(),
                    shared: shared.clone(),
                    me,
                    outbox: outbox.clone(),
                    turn_tracker: turn_tracker.clone(),
                };
                match session.serve(socket, &mut queued).await {
                    Ok(()) => info!(bot = %bot.name, "connection closed"),
                    Err(e) => {
                        warn!(bot = %bot.name, error = %e, "connection lost");
                        protocol::hb(serde_json::json!({"ev": "error", "msg": format!("connection lost: {e}")}));
                    }
                }
            }
            Err(e) => {
                error!(bot = %bot.name, error = %e, "connection failed");
                protocol::hb(serde_json::json!({"ev": "error", "msg": format!("{e}")}));
            }
        }
        sleep(reconnect_delay).await;
        reconnect_delay = (reconnect_delay * 2).min(RECONNECT_DELAY_MAX);
    }
}

async fn connect(bot: &BotConfig, shared: &Shared) -> Result<(Socket, User), SessionError> {
    info!(bot = %bot.name, email = %bot.email, "fetching token");
    let token = token::fetch(&shared.http, &shared.base_url, &bot.email, &bot.password).await?;
    timeout(
        CONNECT_TIMEOUT,
        authenticated_socket(&shared.websocket_url, token),
    )
    .await
    .map_err(|_| SessionError::ConnectTimeout)?
}

async fn authenticated_socket(url: &str, token: String) -> Result<(Socket, User), SessionError> {
    // A game list is a single frame and runs to megabytes for a bot with many games.
    let config = WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None);
    let (mut socket, _) = connect_async_with_config(url, Some(config), true).await?;
    send(&mut socket, &ClientRequest::Auth(token)).await?;
    let me = await_authentication(&mut socket).await?;
    Ok((socket, me))
}

async fn await_authentication(socket: &mut Socket) -> Result<User, SessionError> {
    while let Some(frame) = socket.next().await {
        let Message::Text(text) = frame? else {
            continue;
        };
        match protocol::parse(&text) {
            Ok(Incoming::Authenticated(me)) => return Ok(me),
            Ok(Incoming::Error(reason)) => return Err(SessionError::AuthRefused(reason)),
            _ => {}
        }
    }
    Err(SessionError::ClosedDuringAuth)
}

async fn send(socket: &mut Socket, request: &ClientRequest) -> Result<(), SessionError> {
    socket
        .send(Message::text(serde_json::to_string(request)?))
        .await?;
    Ok(())
}

impl Session {
    async fn serve(
        &self,
        mut socket: Socket,
        queued: &mut mpsc::UnboundedReceiver<Outgoing>,
    ) -> Result<(), SessionError> {
        // The server handles a socket's requests in order, so moves that finished while we were
        // disconnected go first rather than wait behind the snapshot query.
        while let Ok(outgoing) = queued.try_recv() {
            self.deliver(&mut socket, outgoing).await?;
        }
        send(&mut socket, &ClientRequest::Resync).await?;
        let mut reconcile = interval_at(Instant::now() + RECONCILE_INTERVAL, RECONCILE_INTERVAL);
        reconcile.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut silence = pin!(sleep(SILENCE_TIMEOUT));
        loop {
            tokio::select! {
                frame = socket.next() => {
                    silence.as_mut().reset(Instant::now() + SILENCE_TIMEOUT);
                    match frame {
                        None => return Ok(()),
                        Some(frame) => {
                            if let Message::Text(text) = frame? {
                                self.handle(&mut socket, &text).await?;
                            }
                        }
                    }
                }
                Some(outgoing) = queued.recv() => self.deliver(&mut socket, outgoing).await?,
                _ = reconcile.tick() => {
                    self.turn_tracker.cleanup().await;
                    send(&mut socket, &ClientRequest::Resync).await?;
                    send(&mut socket, &ClientRequest::GetOngoingGames).await?;
                }
                () = &mut silence => return Err(SessionError::Silent),
            }
        }
    }

    async fn deliver(&self, socket: &mut Socket, outgoing: Outgoing) -> Result<(), SessionError> {
        match outgoing {
            Outgoing::Move {
                position_key,
                request,
            } => {
                // Marked before the write: if it fails, the reconnect forgets the position and
                // the snapshot replays the turn.
                self.turn_tracker.processed(position_key).await;
                send(socket, &request).await
            }
            Outgoing::Resync => {
                send(socket, &ClientRequest::Resync).await?;
                send(socket, &ClientRequest::GetOngoingGames).await
            }
            Outgoing::Request(request) => send(socket, &request).await,
        }
    }

    async fn handle(&self, socket: &mut Socket, text: &str) -> Result<(), SessionError> {
        let bot = &self.bot.name;
        let incoming = match protocol::parse(text) {
            Ok(incoming) => incoming,
            Err(e) => {
                warn!(bot = %bot, error = %e, "unreadable server message");
                return Ok(());
            }
        };
        match incoming {
            Incoming::Games(games) => self.take_turns(games).await,
            Incoming::Ongoing(games) => {
                // A game we were tracking that the server no longer lists was aborted or ended unseen.
                let listed: std::collections::HashSet<&str> = games.iter().map(|g| g.game_id.as_str()).collect();
                let gone: Vec<String> = {
                    let mut active = self.auto.active.lock().unwrap();
                    let gone: Vec<String> = active
                        .keys()
                        .filter(|id| !id.starts_with("pending-") && !listed.contains(id.as_str()))
                        .cloned()
                        .collect();
                    for id in &gone {
                        active.remove(id);
                    }
                    gone
                };
                for id in gone {
                    protocol::hb(serde_json::json!({"ev": "gone", "id": id}));
                }
                self.take_turns(games).await;
            }
            Incoming::Challenges(challenges) => self.accept_challenges(socket, challenges).await?,
            Incoming::LobbySnapshot(snapshot) => {
                let lobby: Vec<serde_json::Value> = snapshot
                    .challenges
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "id": c.challenge_id,
                            "from": c.challenger.as_ref().map(|u| u.username.clone()).unwrap_or_default(),
                            "mine": c.challenger.as_ref().is_some_and(|u| u.uid == self.me.uid),
                            "to": c.opponent.as_ref().map(|u| u.username.clone()),
                            "rating": c.challenger_rating, "rated": c.rated, "mode": c.time_mode,
                            "bot": c.challenger.as_ref().is_some_and(|u| u.bot), "color": c.color_choice,
                            "base": c.time_base, "increment": c.time_increment,
                        })
                    })
                    .collect();
                let online: Vec<serde_json::Value> = snapshot
                    .online_users
                    .iter()
                    .filter(|u| u.uid != self.me.uid)
                    .map(|u| {
                        // Rating by speed (Bullet, Blitz, Rapid, Classic), rounded.
                        let ratings: serde_json::Map<String, serde_json::Value> = u
                            .ratings
                            .as_object()
                            .map(|m| {
                                m.iter()
                                    .filter_map(|(speed, r)| {
                                        let rating = r.get("rating")?.as_f64()?;
                                        Some((speed.clone(), serde_json::json!(rating.round() as i64)))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        serde_json::json!({"name": u.username, "bot": u.bot, "ratings": ratings})
                    })
                    .collect();
                protocol::hb(serde_json::json!({"ev": "lobby", "challenges": lobby, "online": online}));
                self.take_turns(snapshot.urgent_games).await;
                self.accept_challenges(socket, snapshot.challenges).await?;
            }
            Incoming::ResyncRetry { retry_after_ms } => {
                self.resync_later(Duration::from_millis(retry_after_ms))
            }
            Incoming::Error(reason) => {
                warn!(bot = %bot, reason = %reason, "server error");
                protocol::hb(serde_json::json!({"ev": "note", "msg": format!("hivegame.com: {reason}")}));
            }
            Incoming::Refused(refusal) => {
                warn!(bot = %bot, refusal = %refusal, "request refused");
                // A move or control sent by hand that the site would not take: tell the viewer why.
                if let Some(game) = refusal.get("Game") {
                    let reason = game.get("reason").and_then(|r| r.as_str()).unwrap_or("request refused");
                    protocol::hb(serde_json::json!({
                        "ev": "refused", "id": game.get("game_id").and_then(|g| g.as_str()).unwrap_or(""), "msg": reason,
                    }));
                }
            }
            Incoming::Authenticated(_) => {}
            Incoming::Other(tag) => debug!(bot = %bot, tag = %tag, "ignored server message"),
        }
        Ok(())
    }

    async fn take_turns(&self, games: Vec<Game>) {
        for game in games {
            self.auto.note(&game);
            if game.finished {
                // Idle again: look at the lobby for the next open challenge.
                self.resync_later(Duration::from_secs(4));
            }
            protocol::hb(serde_json::json!({
                "ev": "game", "id": game.game_id, "turn": game.turn, "finished": game.finished,
                "status": game.game_status, "white": game.player_name(true), "black": game.player_name(false),
                "our_turn": game.is_turn_of(&self.me.uid),
                "white_left": game.seconds_left(true), "black_left": game.seconds_left(false),
                "increment": game.time_increment, "timed": game.time_mode.as_deref() == Some("RealTime"),
                "base": game.time_base, "speed": game.speed, "rated": game.rated,
                "white_card": game.player_card(true), "black_card": game.player_card(false),
                // The full move list goes along once the game is over, so the viewer can keep a record.
                "history": if game.finished { Some(&game.history) } else { None },
            }));
            if !game.is_turn_of(&self.me.uid) {
                continue;
            }
            if self.auto.manual.load(std::sync::atomic::Ordering::Relaxed) {
                // Played by hand from the viewer: nothing to compute here.
                continue;
            }
            let position_key = game.position_key();
            if self.turn_tracker.tracked(position_key).await {
                continue;
            }
            self.turn_tracker.processing(position_key).await;
            debug!(bot = %self.bot.name, game_id = %game.game_id, "our turn");
            tokio::spawn(bot::play_turn(
                Turn {
                    game,
                    position_key,
                    bot: self.bot.clone(),
                    outbox: self.outbox.clone(),
                },
                self.shared.clone(),
                self.turn_tracker.clone(),
            ));
        }
    }

    async fn accept_challenges(
        &self,
        socket: &mut Socket,
        challenges: Vec<Challenge>,
    ) -> Result<(), SessionError> {
        for challenge in challenges {
            let addressed_to_us = challenge
                .opponent
                .as_ref()
                .is_some_and(|opponent| opponent.uid == self.me.uid);
            if !addressed_to_us && !self.wants_open(&challenge) {
                continue;
            }
            if addressed_to_us {
                // A challenge sent to us by name: only with the "accept all direct challenges" rule on,
                // and never while a game is being played. Otherwise it waits in the lobby for the user.
                let direct = self.auto.rules.lock().unwrap().direct;
                // Only timed games of 20+20 or shorter are taken automatically; anything longer waits for the user.
                let short_enough = challenge.time_mode.as_deref() == Some("RealTime")
                    && challenge.time_base.is_some_and(|base| base <= 1200)
                    && challenge.time_increment.unwrap_or(0) <= 20;
                if !direct || !short_enough || self.auto.busy() {
                    continue;
                }
            } else {
                self.auto.accepted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            // Counts as running until the server tells us about the game (so two are never accepted at once).
            self.auto
                .active
                .lock()
                .unwrap()
                .insert(format!("pending-{}", challenge.challenge_id), Instant::now() - Duration::from_secs(1740));
            info!(bot = %self.bot.name, challenge_id = %challenge.challenge_id, "accepting challenge");
            protocol::hb(serde_json::json!({
                "ev": "accept", "id": challenge.challenge_id, "open": !addressed_to_us,
                "from": challenge.challenger.as_ref().map(|c| c.username.clone()).unwrap_or_default(),
            }));
            let accept = ClientRequest::Challenge(ChallengeAction::Accept(challenge.challenge_id));
            send(socket, &accept).await?;
        }
        Ok(())
    }

    /// An open real-time challenge from a listed opponent, while we are idle and under the cap.
    fn wants_open(&self, challenge: &Challenge) -> bool {
        let Some(challenger) = challenge.challenger.as_ref() else {
            return false;
        };
        let rules = self.auto.rules.lock().unwrap().clone();
        challenge.opponent.is_none()
            && challenger.uid != self.me.uid
            && (rules.anyone || rules.from.iter().any(|name| name.eq_ignore_ascii_case(&challenger.username)))
            && !(rules.humans_only && challenger.bot)
            && challenge.time_mode.as_deref() == Some("RealTime")
            && match rules.clock {
                Some((base, increment)) => {
                    challenge.time_base == Some(base) && challenge.time_increment.unwrap_or(0) == increment
                }
                None => challenge.time_base.unwrap_or(0) >= rules.min_base_secs.max(1),
            }
            && self.auto.accepted.load(std::sync::atomic::Ordering::Relaxed) < rules.max_games
            && !self.auto.busy()
    }

    fn resync_later(&self, delay: Duration) {
        let outbox = self.outbox.clone();
        tokio::spawn(async move {
            sleep(delay).await;
            let _ = outbox.send(Outgoing::Resync);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use tempfile::TempDir;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;
    use wiremock::{
        matchers::{method, path},
        Mock,
        MockServer,
        ResponseTemplate,
    };

    const ME: &str = "00000000-0000-0000-0000-000000000001";
    const THEM: &str = "00000000-0000-0000-0000-000000000002";
    const PATIENCE: Duration = Duration::from_secs(10);
    const ENGINE: &str =
        "cat > /dev/null\nprintf 'id fake\\nok\\nBase+MLP;InProgress;Black[1];wS1\\nok\\nbG1 -wS1\\nok\\n'\n";

    struct Hivegame {
        _http: MockServer,
        listener: TcpListener,
        _engine_dir: TempDir,
        session: tokio::task::JoinHandle<()>,
    }

    struct Connection {
        socket: WebSocketStream<TcpStream>,
    }

    impl Hivegame {
        async fn start() -> Self {
            Self::with_engine(ENGINE).await
        }

        async fn with_engine(script: &str) -> Self {
            let http = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path("/api/v1/auth/token"))
                .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                    "success": true,
                    "data": {"token": "tok"}
                })))
                .mount(&http)
                .await;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let engine_dir = TempDir::new().unwrap();
            let engine = engine_dir.path().join("engine.sh");
            fs::write(&engine, script).unwrap();
            let bot = BotConfig {
                name: "test-bot".to_string(),
                ai_command: format!("sh {}", engine.display()),
                bestmove_command_args: "depth 1".to_string(),
                email: "bot@example.com".to_string(),
                password: "hivegame".to_string(),
                accept_open_from: Vec::new(),
                min_base_secs: 0,
                max_auto_games: 0,
            };
            let shared = Arc::new(Shared {
                http: reqwest::Client::new(),
                base_url: http.uri(),
                websocket_url: format!("ws://{}/ws/?format=json", listener.local_addr().unwrap()),
                engine_slots: Semaphore::new(1),
            });
            let session = tokio::spawn(run(bot, shared));
            Self {
                _http: http,
                listener,
                _engine_dir: engine_dir,
                session,
            }
        }

        async fn accept(&self) -> Connection {
            let (tcp, _) = timeout(PATIENCE, self.listener.accept())
                .await
                .expect("hydra never connected")
                .unwrap();
            Connection {
                socket: accept_async(tcp).await.unwrap(),
            }
        }

        async fn authenticated(&self) -> Connection {
            let mut connection = self.accept().await;
            assert_eq!(connection.next_frame().await, json!({"Auth": "tok"}));
            connection
                .push(json!({"Ok": {"Authenticated": user(ME)}}))
                .await;
            assert_eq!(connection.next_frame().await, json!("Resync"));
            connection
        }
    }

    impl Drop for Hivegame {
        fn drop(&mut self) {
            self.session.abort();
        }
    }

    impl Connection {
        async fn push(&mut self, message: Value) {
            self.socket
                .send(Message::text(message.to_string()))
                .await
                .unwrap();
        }

        async fn next_frame(&mut self) -> Value {
            loop {
                let frame = timeout(PATIENCE, self.socket.next())
                    .await
                    .expect("hydra went quiet")
                    .expect("hydra hung up")
                    .unwrap();
                if let Message::Text(text) = frame {
                    return serde_json::from_str(&text).unwrap();
                }
            }
        }
    }

    fn user(uid: &str) -> Value {
        json!({"username": "someone", "uid": uid})
    }

    fn game(game_id: &str, current_player_id: &str) -> Value {
        json!({
            "game_id": game_id, "current_player_id": current_player_id, "finished": false,
            "game_type": "MLP", "history": [["wS1", ""]], "turn": 1,
            "game_start": "Moves", "game_status": "InProgress"
        })
    }

    fn our_move() -> Value {
        json!({"Game": {"game_id": "ours", "action": {"PlayAt": {"turn": 1, "notation": "bG1 -wS1"}}}})
    }

    fn reaction(game_action: Value, game: Value) -> Value {
        json!({"Ok": {"Game": {"Reaction": {
            "game_action": game_action, "game_id": game["game_id"], "game": game,
            "user_id": THEM, "username": "them"
        }}}})
    }

    #[tokio::test]
    async fn leaves_pings_unanswered() {
        let hivegame = Hivegame::start().await;
        let mut connection = hivegame.accept().await;

        assert_eq!(connection.next_frame().await, json!({"Auth": "tok"}));
        connection
            .push(
                json!({"Ok": {"UserStatus": {"status": "Online", "user": null, "username": "x"}}}),
            )
            .await;
        connection
            .push(json!({"Ok": {"Ping": {"nonce": 1, "value": 0.0}}}))
            .await;
        connection
            .push(json!({"Ok": {"Authenticated": user(ME)}}))
            .await;
        assert_eq!(connection.next_frame().await, json!("Resync"));
        connection
            .push(json!({"Ok": {"Ping": {"nonce": 2, "value": 0.0}}}))
            .await;
        connection
            .push(json!({"Ok": {"Challenge": {"Direct": {"challenge_id": "ours", "opponent": user(ME), "time_mode": "RealTime", "time_base": 600, "time_increment": 10}}}}))
            .await;
        assert_eq!(
            connection.next_frame().await,
            json!({"Challenge": {"Accept": "ours"}})
        );
    }

    #[tokio::test]
    async fn plays_its_turns() {
        let hivegame = Hivegame::start().await;
        let mut connection = hivegame.authenticated().await;

        connection
            .push(json!({"Ok": {"Game": {"Urgent": [game("theirs", THEM)]}}}))
            .await;
        connection
            .push(reaction(json!("Join"), game("ours", ME)))
            .await;

        assert_eq!(connection.next_frame().await, our_move());
    }

    #[tokio::test]
    async fn waits_for_a_ready_game_to_start() {
        let hivegame = Hivegame::start().await;
        let mut connection = hivegame.authenticated().await;
        let mut released = game("ours", ME);
        released["game_start"] = json!("Ready");
        released["game_status"] = json!("NotStarted");

        connection
            .push(reaction(
                json!({"New": {"pairing_label": null}}),
                released.clone(),
            ))
            .await;
        assert!(
            timeout(Duration::from_millis(500), connection.socket.next())
                .await
                .is_err(),
            "hydra moved before the game started"
        );

        let mut started = released;
        started["game_status"] = json!("InProgress");
        connection.push(reaction(json!("Started"), started)).await;
        assert_eq!(connection.next_frame().await, our_move());
    }

    #[tokio::test]
    async fn accepts_only_challenges_addressed_to_it() {
        let hivegame = Hivegame::start().await;
        let mut connection = hivegame.authenticated().await;

        connection
            .push(json!({"Ok": {"Challenge": {"Created": {"challenge_id": "open", "opponent": null}}}}))
            .await;
        connection
            .push(json!({"Ok": {"Challenge": {"Direct": {"challenge_id": "other", "opponent": user(THEM)}}}}))
            .await;
        connection
            .push(json!({"Ok": {"Challenge": {"Direct": {"challenge_id": "ours", "opponent": user(ME), "time_mode": "RealTime", "time_base": 600, "time_increment": 10}}}}))
            .await;

        assert_eq!(
            connection.next_frame().await,
            json!({"Challenge": {"Accept": "ours"}})
        );
    }

    #[tokio::test]
    async fn reconnects_after_a_refused_auth() {
        let hivegame = Hivegame::start().await;
        let mut refused = hivegame.accept().await;
        assert_eq!(refused.next_frame().await, json!({"Auth": "tok"}));
        refused.push(json!({"Ok": {"Error": "Auth failed"}})).await;

        hivegame.authenticated().await;
    }

    #[tokio::test]
    async fn replays_pending_turns_after_a_reconnect() {
        let hivegame = Hivegame::start().await;
        let mut first = hivegame.authenticated().await;
        first
            .push(json!({"Ok": {"Game": {"Urgent": [game("ours", ME)]}}}))
            .await;
        assert_eq!(first.next_frame().await, our_move());
        drop(first);

        let mut second = hivegame.authenticated().await;
        second
            .push(json!({"Ok": {"Game": {"Urgent": [game("ours", ME)]}}}))
            .await;
        assert_eq!(second.next_frame().await, our_move());
    }

    #[tokio::test]
    async fn sends_a_move_finished_while_disconnected_first_and_once() {
        // Slower than noticing the hang-up, faster than the reconnect delay.
        let hivegame = Hivegame::with_engine(&format!("sleep 0.3\n{ENGINE}")).await;
        let mut first = hivegame.authenticated().await;
        first
            .push(json!({"Ok": {"Game": {"Urgent": [game("ours", ME)]}}}))
            .await;
        drop(first);

        let mut second = hivegame.accept().await;
        assert_eq!(second.next_frame().await, json!({"Auth": "tok"}));
        second
            .push(json!({"Ok": {"Authenticated": user(ME)}}))
            .await;
        assert_eq!(second.next_frame().await, our_move());
        assert_eq!(second.next_frame().await, json!("Resync"));

        // Sent before the server saw the move.
        second
            .push(json!({"Ok": {"Game": {"Urgent": [game("ours", ME)]}}}))
            .await;
        assert!(
            timeout(Duration::from_secs(1), second.socket.next())
                .await
                .is_err(),
            "hydra played the same turn twice"
        );
    }
}
