use foulbrood::{Color, GameState, UhpGame, search::SearchLimit};
use std::collections::HashMap;
fn descriptor(g: &UhpGame) -> String {
    let b=g.board();let mut views=Vec::new();
    for mirror in [false,true] {for rotation in 0..6 {
        let transform=|h:foulbrood::Hex| {
            let(mut q,mut r)=(i32::from(h.q),i32::from(h.r));
            for _ in 0..rotation {(q,r)=(-r,q+r);}
            if mirror {q=-q-r;}(q,r)
        };
        let mut cells=Vec::new();
        for h in b.occupied_hexes() {let(q,r)=transform(h);for(z,p) in b.stack(h).unwrap().iter().enumerate() {
            cells.push((q,r,z,p.color,p.bug));
        }}
        let shift=(cells.iter().map(|x|x.0).min().unwrap_or(0),cells.iter().map(|x|x.1).min().unwrap_or(0));
        for x in &mut cells {x.0-=shift.0;x.1-=shift.1;}cells.sort();
        // An independent full legal-outcome description captures effective stun
        // without reusing the production fingerprint or last-piece comparison.
        let mut actions=Vec::new();
        for mv in b.legal_moves() {
            let (kind,piece,source,dest)=match mv {
                foulbrood::HiveMove::Place{piece,to}=>(0,piece,None,to),
                foulbrood::HiveMove::Move{piece,from,to}|foulbrood::HiveMove::Pillbug{piece,from,to,..}=>(1,piece,Some(from),to),
                foulbrood::HiveMove::Pass=>{actions.push((2,Color::White,foulbrood::Bug::Queen,0,0,0,0,0));continue;}
            };
            let(q,r)=transform(dest);let(sq,sr,level)=source.map_or((0,0,0),|h| {
                let(x,y)=transform(h);(x-shift.0,y-shift.1,b.stack_height(h))
            });
            actions.push((kind,piece.color,piece.bug,sq,sr,level,q-shift.0,r-shift.1));
        }
        actions.sort();actions.dedup();
        let phases=Color::ALL.map(|c|if b.queen_is_placed(c){0}else{b.turns_taken(c).min(3)});
        views.push(format!("{:?}|{:?}|{:?}|{:?}|{:?}",cells,actions,b.game_type(),b.side_to_move(),phases));
    }}
    views.into_iter().min().unwrap()
}

#[test]
fn recorded_cycles_draw_on_third_occurrence_and_undo_reopens() {
    for text in include_str!("threefold_games.txt").lines() {
        let fields:Vec<_>=text.split(';').collect();
        let kind=foulbrood::parse_game_type(fields[0]).unwrap();
        let mut game=UhpGame::new(kind);let mut counts=HashMap::new();counts.insert(descriptor(&game),1);
        let mut drawn=false;
        for &mv in &fields[3..] {
            let before=game.game_string();game.play(mv).unwrap();
            let count=counts.entry(descriptor(&game)).or_insert(0);*count+=1;
            assert_eq!(game.state()==GameState::Draw,*count==3);
            if *count==3 {
                drawn=true;
                assert!(game.valid_move_strings().unwrap().is_empty());
                let result=game.search(SearchLimit::Depth(2));assert_eq!(result.score,Some(0));assert!(result.best_move.is_none());
                let final_text=game.game_string();
                assert_eq!(UhpGame::from_game_string(&final_text).unwrap().game_string(),final_text);
                assert!(game.play("pass").is_err());assert_eq!(game.game_string(),final_text);
                game.undo(1).unwrap();assert_eq!(game.game_string(),before);
                assert_eq!(game.state(),GameState::InProgress);
                assert!(!game.valid_move_strings().unwrap().is_empty());
                game.play(mv).unwrap();assert_eq!(game.game_string(),final_text);
                break;
            }
        }
        assert!(drawn);
    }
}

#[test]
fn archived_missed_draws_end_at_the_independently_diagnosed_ply() {
    for line in include_str!("archive_repetition.txt").lines() {
        let mut fields=line.split('|');let id=fields.next().unwrap();
        let expected:usize=fields.next().unwrap().parse().unwrap();
        let mut game=UhpGame::new(foulbrood::GameType::mlp());
        for (index,mv) in fields.next().unwrap().split(';').enumerate() {
            game.play(mv).unwrap_or_else(|e|panic!("{id} ply {}: {e}",index+1));
            if index+1==expected {
                assert_eq!(game.state(),GameState::Draw,"{id}");
                let result=game.search(SearchLimit::Depth(1));assert_eq!(result.score,Some(0));assert!(result.best_move.is_none());
                game.undo(1).unwrap();assert_eq!(game.state(),GameState::InProgress,"{id}");
                game.play(mv).unwrap();assert_eq!(game.state(),GameState::Draw,"{id}");break;
            }
            assert_eq!(game.state(),GameState::InProgress,"{id} ply {}",index+1);
        }
    }
}
