//! `nativetools` — the CLI the Python side drives.
//!
//! ```text
//! nativetools export <dir>
//! nativetools seed <world.json> <vault path>
//! nativetools copy <vault path> <new vault path>
//! nativetools session <vault path> --today <YYYY-MM-DD[THH:MM]> [--me <name>]
//!                     [--no-directory] [--no-preground] [--no-normalize] [--no-compose] [--tools sig|compact|full]
//! ```
//!
//! `--tools` picks the tools block's spelling (`sig`, the default:
//! one-line signatures; `compact`, `tools.json`; `full`, `tools.full.json`).
//!
//! `session` reads one JSON request per line on stdin and answers one JSON
//! line on stdout: `{"op":"prompt"}`, `{"op":"user","text":…}`,
//! `{"op":"call","tool":…,"args":{…}[,"think":<think text>]}`,
//! `{"op":"compile","slots":{…}}` (the slots of a v3 trace, compiled to the call the runtime will
//! execute; `compile.rs`),
//! `{"op":"call_text","text":<raw model message>}` (the think block in front
//! of the call is the trace the guard of `trace.rs` reads),
//! `{"op":"parse","text":<raw model message>}` and
//! `{"op":"peek_repeat","text":<raw model message>}` (would this call repeat
//! the previous one: `{"repeat": bool, "strikes": repeats answered so far}`).

use std::io::{BufRead as _, Write as _};
use std::path::Path;
use std::process::ExitCode;

use centraid_nativetools::prompt::ToolsMode;
use centraid_nativetools::{Flags, Session, dates, export, parse, seed};
use serde_json::{Value, json};

fn usage() -> ExitCode {
    eprintln!(
        "usage:\n  nativetools export <dir>\n  nativetools seed <world.json> <vault path>\n  nativetools copy <vault> <new vault>\n  \
         nativetools session <vault path> --today <YYYY-MM-DD[THH:MM]> [--me <name>] \
         [--no-directory] [--no-preground] [--no-normalize] [--no-compose] [--tools sig|compact|full]"
    );
    ExitCode::from(2)
}

fn fail(message: &str) -> ExitCode {
    eprintln!("nativetools: {message}");
    ExitCode::FAILURE
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("export") if args.len() == 2 => match export::export(Path::new(&args[1])) {
            Ok(files) => {
                println!("{}", json!({"exported": files, "dir": args[1]}));
                ExitCode::SUCCESS
            }
            Err(error) => fail(&error),
        },
        Some("seed") if args.len() == 3 => {
            let world = match std::fs::read_to_string(&args[1])
                .map_err(|error| error.to_string())
                .and_then(|text| {
                    serde_json::from_str::<Value>(&text).map_err(|error| error.to_string())
                }) {
                Ok(world) => world,
                Err(error) => return fail(&format!("reading {}: {error}", args[1])),
            };
            match seed::seed_report(&world, Path::new(&args[2])) {
                Ok((keys, dropped)) => {
                    println!(
                        "{}",
                        json!({"vault": args[2], "keys": keys, "dropped": dropped})
                    );
                    ExitCode::SUCCESS
                }
                Err(error) => fail(&error),
            }
        }
        Some("copy") if args.len() == 3 => {
            match centraid_nativetools::vaultio::copy_vault(
                Path::new(&args[1]),
                Path::new(&args[2]),
            ) {
                Ok(()) => {
                    println!("{}", json!({"copied": args[1], "to": args[2]}));
                    ExitCode::SUCCESS
                }
                Err(error) => fail(&error),
            }
        }
        Some("session") if args.len() >= 2 => session(&args[1], &args[2..]),
        _ => usage(),
    }
}

fn session(path: &str, rest: &[String]) -> ExitCode {
    let mut today = None;
    let mut me = String::new();
    let mut flags = Flags::default();
    let mut iter = rest.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--today" => today = iter.next().cloned(),
            "--me" => me = iter.next().cloned().unwrap_or_default(),
            "--no-directory" => flags.directory = false,
            "--no-preground" => flags.preground = false,
            "--no-normalize" => flags.normalize = false,
            "--no-compose" => flags.compose = false,
            "--tools" => match iter.next().and_then(|mode| ToolsMode::parse(mode)) {
                Some(mode) => flags.tools = mode,
                None => return fail("--tools takes sig, compact or full"),
            },
            _ => return usage(),
        }
    }
    let Some(today) = today else {
        return fail("--today is required: the clock is injected, never read");
    };
    let now = match dates::parse_now(&today) {
        Ok(now) => now,
        Err(error) => return fail(&error),
    };
    let mut session = match Session::open(Path::new(path), now, &me, flags) {
        Ok(session) => session,
        Err(error) => return fail(&error),
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => answer(&mut session, &request),
            Err(error) => json!({"error": format!("not JSON: {error}")}),
        };
        if writeln!(stdout, "{response}")
            .and_then(|()| stdout.flush())
            .is_err()
        {
            break;
        }
    }
    ExitCode::SUCCESS
}

fn answer(session: &mut Session, request: &Value) -> Value {
    let text = request
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match request.get("op").and_then(Value::as_str) {
        Some("prompt") => session.prompt(),
        Some("user") => session.user(text),
        Some("call") => {
            let tool = request
                .get("tool")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
            // the optional think block the call was written under (its slot trace is enforced)
            session.call_traced(tool, &args, request.get("think").and_then(Value::as_str))
        }
        // the slots of a v3 trace, compiled to the call the runtime will execute (`compile.rs`)
        Some("compile") => session.compile(request.get("slots").unwrap_or(&Value::Null)),
        Some("call_text") => session.call_text(text),
        Some("peek_repeat") => match parse::parse_call(text) {
            Ok(call) => {
                let tool = call["tool"].as_str().unwrap_or_default();
                let strikes = session.peek_repeat(tool, &call["args"]);
                json!({"repeat": strikes.is_some(), "strikes": strikes.unwrap_or(0)})
            }
            Err(_) => json!({"repeat": false, "strikes": 0}),
        },
        Some("parse") => match parse::parse_call(text) {
            Ok(call) => call,
            Err(error) => json!({"error": error}),
        },
        other => json!({"error": format!(
            "unknown op {other:?}; ops: prompt, user, call, compile, call_text, peek_repeat, parse"
        )}),
    }
}
