use foulbrood::UhpEngine;
use std::io::{self, BufRead, Write};

fn emit(lines: &[String], stdout: &mut impl Write) -> io::Result<()> {
    for line in lines {
        writeln!(stdout, "{line}")?;
    }
    writeln!(stdout, "ok")?;
    stdout.flush()
}

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut engine = UhpEngine::default();

    // UHP requires engines to identify themselves immediately on startup.
    emit(&UhpEngine::info_lines(), &mut stdout)?;

    for line in stdin.lock().lines() {
        let line = line?;
        let trimmed = line.trim();
        if matches!(trimmed, "quit" | "exit") {
            break;
        }
        let response = engine.execute(trimmed);
        emit(&response, &mut stdout)?;
    }
    Ok(())
}
