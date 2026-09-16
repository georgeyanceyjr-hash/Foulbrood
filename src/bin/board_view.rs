//! Local UI adapter. All legality, history, draws and undo remain in UhpGame.
use foulbrood::{Color, GameState, HiveMove, Piece, UhpGame, move_to_uhp};

fn quoted(s: &str) -> String {
    let mut out=String::from("\"");
    for c in s.chars() { match c {
        '"'=>out.push_str("\\\""), '\\'=>out.push_str("\\\\"),
        '\n'=>out.push_str("\\n"), '\r'=>out.push_str("\\r"), '\t'=>out.push_str("\\t"),
        c if c.is_control()=>out.push_str(&format!("\\u{:04x}",c as u32)),
        c=>out.push(c),
    }}
    out.push('"'); out
}
fn run(args:&[String])->Result<String,String> {
    let command=args.get(1).ok_or("missing command")?;
    let text=args.get(2).ok_or("missing position")?;
    let mut game=if text.contains(';') {UhpGame::from_game_string(text)?}
        else {UhpGame::from_root(text)?};
    if command=="trace" {
        let mut replay=UhpGame::from_root(text.split(';').next().unwrap())?;
        let mut frames=vec![snapshot(&replay)?];
        for mv in text.split(';').skip(3) { replay.play(mv)?; frames.push(snapshot(&replay)?); }
        return Ok(format!("[{}]",frames.join(",")));
    }
    match command.as_str() {
        "snapshot"=>(),
        "play"=>game.play(args.get(3).ok_or("missing move")?)?,
        "undo"=>game.undo(1)?,
        _=>return Err("unknown command".into()),
    }
    snapshot(&game)
}
fn snapshot(game:&UhpGame)->Result<String,String> {
    let board=game.board(); let mut pieces=Vec::new();let mut reserve=Vec::new();
    for color in Color::ALL { for piece in Piece::all_for(color,board.game_type()) {
        if board.is_in_hand(piece) {reserve.push(quoted(&piece.to_string()));}
        else if let Some(hex)=board.location(piece) {
            let level=board.stack(hex).unwrap().iter().position(|p|*p==piece).unwrap();
            pieces.push(format!("{{\"id\":{},\"q\":{},\"r\":{},\"level\":{}}}",quoted(&piece.to_string()),hex.q,hex.r,level));
        }
    }}
    let mut legal=Vec::new();
    if matches!(game.state(),GameState::NotStarted|GameState::InProgress) {
        for mv in board.legal_moves() {
            let notation=move_to_uhp(board,mv)?;
            let (piece,to,actor)=match mv {
                HiveMove::Place{piece,to}|HiveMove::Move{piece,to,..}=>(Some(piece),Some(to),None),
                HiveMove::Pillbug{piece,to,actor,..}=>(Some(piece),Some(to),Some(actor)),
                HiveMove::Pass=>(None,None,None),
            };
            legal.push(format!("{{\"move\":{},\"piece\":{},\"to\":{},\"actor\":{}}}",quoted(&notation),
                piece.map_or("null".into(),|p|quoted(&p.to_string())),
                to.map_or("null".into(),|h|format!("[{},{}]",h.q,h.r)),
                actor.map_or("null".into(),|p|quoted(&p.to_string()))));
        }
    }
    Ok(format!("{{\"game\":{},\"state\":{},\"side\":{},\"pieces\":[{}],\"reserve\":[{}],\"legal\":[{}],\"ply\":{},\"last_move\":{}}}",
        quoted(&game.game_string()),quoted(&game.state().to_string()),board.side_to_move().index(),pieces.join(","),reserve.join(","),legal.join(","),game.history().len(),last_move(game.history().last().copied().or_else(||board.last_move()))))
}
fn last_move(mv:Option<HiveMove>)->String {
    let (piece,from,to,actor)=match mv {
        Some(HiveMove::Place{piece,to})=>(piece,None,to,None),
        Some(HiveMove::Move{piece,from,to})=>(piece,Some(from),to,None),
        Some(HiveMove::Pillbug{piece,from,to,actor})=>(piece,Some(from),to,Some(actor)),
        None|Some(HiveMove::Pass)=>return "null".into(),
    };
    format!("{{\"piece\":{},\"from\":{},\"to\":[{},{}],\"actor\":{}}}",
        quoted(&piece.to_string()),from.map_or("null".into(),|h|format!("[{},{}]",h.q,h.r)),to.q,to.r,
        actor.map_or("null".into(),|p|quoted(&p.to_string())))
}
fn main() {
    match run(&std::env::args().collect::<Vec<_>>()) {
        Ok(json)=>println!("{json}"),
        Err(err)=>{eprintln!("{err}");std::process::exit(1);}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn last_moved_piece_is_relocated_piece_not_pillbug_actor() {
        let actor=foulbrood::parse_piece("wP").unwrap();
        let piece=foulbrood::parse_piece("bQ").unwrap();
        let from=foulbrood::Hex::new(1,0);let to=foulbrood::Hex::new(0,1);
        let text=last_move(Some(HiveMove::Pillbug{actor,piece,from,to}));
        assert!(text.contains("\"piece\":\"bQ\""));
        assert!(text.contains("\"actor\":\"wP\""));
        assert!(text.contains("\"from\":[1,0]"));
        assert_eq!(last_move(Some(HiveMove::Pass)),"null");
        assert_eq!(last_move(None),"null");
        assert!(last_move(Some(HiveMove::Place{piece,to})).contains("\"from\":null"));
    }
    #[test]
    fn quoting_preserves_notation_and_rejects_illegal_moves() {
        assert_eq!(quoted("wA1 \\bQ"),"\"wA1 \\\\bQ\"");
        assert!(run(&["view","play","Base","wQ"].map(String::from)).is_err());
        let result=run(&["view","play","Base","wS1"].map(String::from)).unwrap();
        assert!(result.contains("\"side\":1"));
        assert!(result.contains("\"q\":0,\"r\":0"));
    }
}
