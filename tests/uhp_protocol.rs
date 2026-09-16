use foulbrood::UhpEngine;

#[test]
fn uhp_spec_opening_transcript_works() {
    let mut engine = UhpEngine::default();

    assert_eq!(
        engine.execute("newgame"),
        vec!["Base;NotStarted;White[1]".to_string()]
    );
    assert_eq!(
        engine.execute("validmoves"),
        vec!["wA1;wB1;wG1;wS1".to_string()]
    );
    assert_eq!(
        engine.execute("play wS1"),
        vec!["Base;InProgress;Black[1];wS1".to_string()]
    );
    assert_eq!(
        engine.execute("undo"),
        vec!["Base;NotStarted;White[1]".to_string()]
    );
}

#[test]
fn uhp_can_load_the_protocol_example_game_string() {
    let mut engine = UhpEngine::default();
    let game = "Base;InProgress;White[3];wS1;bG1 -wS1;wA1 wS1/;bG2 /bG1";
    assert_eq!(engine.execute(&format!("newgame {game}")), vec![game.to_string()]);
}

#[test]
fn illegal_queen_opening_is_reported_as_invalidmove() {
    let mut engine = UhpEngine::default();
    let response = engine.execute("play wQ");
    assert_eq!(response.len(), 1);
    assert!(response[0].starts_with("invalidmove "));
}

#[test]
fn expansion_capabilities_and_mlp_opening_are_exposed() {
    let mut engine = UhpEngine::default();
    assert_eq!(
        UhpEngine::info_lines(),
        vec![
            format!("id FoulBrood v{}", env!("CARGO_PKG_VERSION")),
            "Mosquito;Ladybug;Pillbug".to_string(),
        ]
    );
    assert_eq!(
        engine.execute("newgame Base+MLP"),
        vec!["Base+MLP;NotStarted;White[1]".to_string()]
    );
    assert_eq!(
        engine.execute("validmoves"),
        vec!["wA1;wB1;wG1;wL;wM;wP;wS1".to_string()]
    );
}

#[test]
fn developer_perft_command_has_correct_opening_counts() {
    let mut engine = UhpEngine::default();
    assert_eq!(engine.execute("perft 1"), vec!["4".to_string()]);
    assert_eq!(engine.execute("perft 2"), vec!["96".to_string()]);

    engine.execute("newgame Base+MLP");
    assert_eq!(engine.execute("perft 1"), vec!["7".to_string()]);
    assert_eq!(engine.execute("perft 2"), vec!["294".to_string()]);
}

#[test]
fn parameterless_commands_reject_extra_text() {
    let mut engine = UhpEngine::default();
    assert!(engine.execute("info junk")[0].starts_with("err "));
    assert!(engine.execute("pass junk")[0].starts_with("err "));
    assert!(engine.execute("validmoves junk")[0].starts_with("err "));
}

#[test]
fn search_protocol_limits_legality_and_history() {
    let mut engine = UhpEngine::default();
    engine.execute("play wS1");
    engine.execute("play bG1 -wS1");
    let before = engine.game().game_string();
    for cmd in ["bestmove depth 0", "bestmove depth 2", "bestmove time 00:00:00"] {
        let response = engine.execute(cmd);
        assert_eq!(response.len(), 1);
        assert!(engine.game().valid_move_strings().unwrap().contains(&response[0]));
        assert_eq!(engine.game().game_string(), before);
        assert_eq!(engine.game().history().len(), 2);
    }
    for cmd in ["bestmove depth 65", "bestmove depth -1", "bestmove depth nope",
                "bestmove time 00:60:00", "bestmove time 00:00:60",
                "bestmove time 18446744073709551615:00:00", "bestmove time 1",
                "bestmove depth 2 extra"] {
        assert!(engine.execute(cmd)[0].starts_with("err "), "{cmd}");
        assert_eq!(engine.game().game_string(), before);
    }
    engine.execute("undo 2");
    assert_eq!(engine.game().board().ply(), 0);
}

#[test]
fn score_reporting_is_explicit_and_preserves_bestmove() {
    let mut plain = foulbrood::UhpEngine::default();
    let mut reporting = plain.clone();
    assert!(reporting.execute("options set ReportFoulBroodScores True").is_empty());
    for game in ["Base", "Base;InProgress;Black[1];wS1"] {
        assert_eq!(plain.execute(&format!("newgame {game}")), reporting.execute(&format!("newgame {game}")));
        assert_eq!(plain.execute("bestmove depth 2"), reporting.execute("bestmove depth 2"));
    }
    assert!(reporting.execute("options set ReportFoulBroodScores False").is_empty());
    assert!(reporting.execute("options set ReportFoulBroodScores maybe")[0].starts_with("err "));
}
