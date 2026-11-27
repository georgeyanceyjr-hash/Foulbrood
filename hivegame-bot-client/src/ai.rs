use std::process::Stdio;
use tokio::{
    io::AsyncWriteExt,
    process::{Child, Command},
};
use tracing::info;

#[derive(Debug)]
pub enum AiError {
    Process(std::io::Error),
    Parse(ParseError),
    Output(std::string::FromUtf8Error),
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AiError::Process(e) => write!(f, "Process error: {e}"),
            AiError::Parse(e) => write!(f, "Parse error: {e}"),
            AiError::Output(e) => write!(f, "Output encoding error: {e}"),
        }
    }
}

impl std::error::Error for AiError {}

impl From<std::io::Error> for AiError {
    fn from(error: std::io::Error) -> Self {
        AiError::Process(error)
    }
}

impl From<ParseError> for AiError {
    fn from(error: ParseError) -> Self {
        AiError::Parse(error)
    }
}

impl From<std::string::FromUtf8Error> for AiError {
    fn from(error: std::string::FromUtf8Error) -> Self {
        AiError::Output(error)
    }
}

#[derive(Debug)]
pub enum ParseError {
    NoOutput,
    MissingBestMove(String),
    BestMoveError(String),
    MissingOk(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::NoOutput => write!(f, "No output received from AI"),
            ParseError::MissingBestMove(msg) => write!(f, "No bestmove found in output: {msg}"),
            ParseError::BestMoveError(msg) => {
                write!(f, "bestmove command error in output: {msg}")
            }
            ParseError::MissingOk(msg) => write!(f, "Missing 'ok' confirmation in output: {msg}"),
        }
    }
}

impl std::error::Error for ParseError {}

#[allow(dead_code)]
pub fn spawn_process(command: &str, name: &str) -> std::io::Result<Child> {
    spawn_process_env(command, name, &[])
}

/// As spawn_process, with extra environment variables for the engine (engines that do not know them ignore them).
pub fn spawn_process_env(command: &str, name: &str, env: &[(String, String)]) -> std::io::Result<Child> {
    info!("Starting AI '{}' for '{}'...", command, name);

    // The viewer passes the engine's own file path (spaces allowed): run it from its folder, like the viewer does.
    let whole = std::path::Path::new(command.trim());
    if whole.is_file() {
        let mut cmd = Command::new(whole);
        cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        if let Some(dir) = whole.parent().filter(|d| !d.as_os_str().is_empty()) {
            cmd.current_dir(dir);
        }
        return cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn();
    }
    let command_parts: Vec<&str> = command.split_whitespace().collect();

    if command_parts.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("Error: Empty AI command for {name}, command {command}"),
        ));
    }

    let program = command_parts[0];
    let args = &command_parts[1..];

    Command::new(program)
        .args(args)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
}

pub fn parse_ai_output(output: &str) -> Result<String, ParseError> {
    if output.is_empty() {
        return Err(ParseError::NoOutput);
    }

    let lines: Vec<&str> = output
        .lines()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();

    let first_ok_pos = lines
        .iter()
        .position(|&line| line == "ok")
        .ok_or(ParseError::MissingOk(output.to_string()))?;
    let remaining_lines = &lines[first_ok_pos + 1..];
    let second_ok_pos = remaining_lines
        .iter()
        .position(|&line| line == "ok")
        .ok_or(ParseError::MissingOk(output.to_string()))?;

    let remaining_lines = &remaining_lines[second_ok_pos + 1..];
    let bestmove_pos = remaining_lines
        .iter()
        .position(|&line| line != "ok")
        .ok_or(ParseError::MissingBestMove(output.to_string()))?;

    let bestmove = remaining_lines[bestmove_pos];
    if bestmove.starts_with("err ") {
        return Err(ParseError::BestMoveError(output.to_string()));
    }

    if !remaining_lines[bestmove_pos + 1..].contains(&"ok") {
        return Err(ParseError::MissingOk(output.to_string()));
    }

    Ok(bestmove.to_string())
}

/// HotFrass patch: "FoulBroodScore v2;kind=iteration;depth=9;score=120;move=wA1 -bQ" from the
/// engine's stderr, as (depth, score, move). Engines that do not report this are simply silent.
pub fn parse_progress(line: &str) -> Option<(u32, i64, String)> {
    let rest = line.trim().strip_prefix("FoulBroodScore v2;")?;
    let (mut depth, mut score, mut mv, mut iteration) = (None, None, None, false);
    for field in rest.split(';') {
        match field.split_once('=') {
            Some(("kind", kind)) => iteration = kind == "iteration",
            Some(("depth", d)) => depth = d.parse().ok(),
            Some(("score", sc)) => score = sc.parse().ok(),
            Some(("move", m)) => mv = Some(m.to_string()),
            _ => {}
        }
    }
    if !iteration {
        return None;
    }
    Some((depth?, score?, mv?))
}

pub async fn run_commands(
    mut child: Child,
    game_string: &str,
    bestmove_args: &str,
    on_progress: impl Fn(u32, i64, String) + Send + 'static,
) -> Result<String, AiError> {
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            use tokio::io::AsyncBufReadExt;
            let mut lines = tokio::io::BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some((depth, score, mv)) = parse_progress(&line) {
                    on_progress(depth, score, mv);
                }
            }
        });
    }
    let mut stdin = child.stdin.take().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Failed to open stdin")
    })?;
    let commands = format!("newgame {game_string}\nbestmove {bestmove_args}\n");
    stdin.write_all(commands.as_bytes()).await?;
    // The engine only exits once its stdin is closed.
    drop(stdin);

    let output = child.wait_with_output().await?;
    let stdout = String::from_utf8(output.stdout)?;

    Ok(parse_ai_output(&stdout)?)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[tokio::test]
    async fn engine_path_with_spaces_runs_from_its_folder() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("my engines");
        std::fs::create_dir(&folder).unwrap();
        let engine = folder.join("my engine");
        std::fs::write(&engine, "#!/bin/sh\npwd\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&engine, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = super::spawn_process(engine.to_str().unwrap(), "t").unwrap();
        child.stdin.take().unwrap().shutdown().await.unwrap();
        let mut out = String::new();
        child.stdout.take().unwrap().read_to_string(&mut out).await.unwrap();
        assert_eq!(std::path::Path::new(out.trim()).canonicalize().unwrap(), folder.canonicalize().unwrap());
    }

    use super::*;

    #[test]
    fn parses_engine_progress() {
        assert_eq!(
            parse_progress("FoulBroodScore v2;kind=iteration;depth=9;score=-120;move=wA1 -bQ"),
            Some((9, -120, "wA1 -bQ".to_string()))
        );
        assert_eq!(parse_progress("FoulBroodScore v2;kind=final;status=complete;depth=9;score=1;move=wP;evalmove=wP"), None);
        assert_eq!(parse_progress("info depth 9 score 5"), None);
    }

    #[test]
    fn test_valid_output() {
        let output = r#"
            id nokamute cargo-1.0.0
            Mosquito;Ladybug;Pillbug
            ok
            Base;InProgress;White[3];wS1
            ok
            bG1 -wS1
            ok
        "#;
        assert_eq!(parse_ai_output(output).unwrap(), "bG1 -wS1");
    }

    #[test]
    fn test_empty_output() {
        let output = "";
        assert!(matches!(parse_ai_output(output), Err(ParseError::NoOutput)));
    }

    #[test]
    fn test_missing_ok() {
        let output = r#"
            id nokamute cargo-1.0.0
            Mosquito;Ladybug;Pillbug
            ok
            Base;InProgress;White[3];wS1
            bG1 -wS1
        "#;
        assert!(matches!(
            parse_ai_output(output),
            Err(ParseError::MissingOk(_))
        ));
    }

    #[test]
    fn test_missing_bestmove() {
        let output = r#"
            id nokamute cargo-1.0.0
            Mosquito;Ladybug;Pillbug
            ok
            Base;InProgress;White[3];wS1
            ok
            ok
        "#;
        assert!(matches!(
            parse_ai_output(output),
            Err(ParseError::MissingBestMove(_))
        ));
    }

    #[test]
    fn test_bestmove_error() {
        let output = r#"
            id nokamute cargo-1.0.0
            Mosquito;Ladybug;Pillbug
            ok
            Base;InProgress;White[3];wS1
            ok
            err UnrecognizedCommand("time 00:00:0E")
        "#;
        assert!(matches!(
            parse_ai_output(output),
            Err(ParseError::BestMoveError(_))
        ));
    }
}
