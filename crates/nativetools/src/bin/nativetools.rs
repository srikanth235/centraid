//! `nativetools` — the CLI the Python side drives.
//!
//! ```text
//! nativetools export <dir>
//! nativetools seed <world.json> <vault path>
//! nativetools copy <vault path> <new vault path>
//! nativetools session <vault path> --today <YYYY-MM-DD[THH:MM]> [--me <name>]
//!                     [--no-directory] [--no-preground] [--no-normalize] [--no-compose] [--tools sig|compact|full]
//!                     [--writes run|park|shadow] [--auto-confirm]
//! nativetools think
//! ```
//!
//! `--writes` picks what a write does: `run` (the default: the vault runs it), `park` (a patched copy of
//! the world takes it and nothing reaches the vault: `authored/park_oracle.py` holds its texts to
//! `run`'s), or `shadow` (the vault runs it AND the patch follows; where they part, a step's
//! `effect.drift` says so). With `--writes park --auto-confirm` the binary taps the card itself: when a
//! response ends a turn with a pending write it confirms it and adds the outcome as `effect.confirmed`,
//! so the next turn plans against the vault as a run would have left it.
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
//!
//! `think` is the stateless compiler of `think.rs`, with no vault behind it: one JSON request per line on stdin, one JSON
//! answer on stdout. `{"op":"compile","think":…,"dates":<the prompt's dates line or null>,"mode":"v3.1"|"v4"}` answers
//! `{"call":{"tool":…,"args":{…}}}` (the arguments in the order a call writes them) or
//! `{"refused":{"class":…,"message":…}}`; `{"op":"v4","think":…,"dates":…[,"context":{"message":…,"focus":<the `focus:`
//! line without its lead or null>,"rows":{"<n>":{"name":…,"line":…}}}]}` answers `{"think":<the v4 text>}` or
//! `{"skip":{"reason":…,"detail":…}}`.

use std::io::{BufRead as _, Write as _};
use std::path::Path;
use std::process::ExitCode;

use centraid_nativetools::park::Writes;
use centraid_nativetools::prompt::ToolsMode;
use centraid_nativetools::think::{Call, Context, RowText, TraceMode};
use centraid_nativetools::{Flags, Session, dates, export, parse, seed, think};
use serde_json::{Value, json};

fn usage() -> ExitCode {
    eprintln!(
        "usage:\n  nativetools export <dir>\n  nativetools seed <world.json> <vault path>\n  nativetools copy <vault> <new vault>\n  \
         nativetools session <vault path> --today <YYYY-MM-DD[THH:MM]> [--me <name>] \
         [--no-directory] [--no-preground] [--no-normalize] [--no-compose] [--tools sig|compact|full] \
         [--writes run|park|shadow] [--auto-confirm]\n  \
         nativetools think"
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
        Some("think") if args.len() == 1 => think(),
        _ => usage(),
    }
}

fn session(path: &str, rest: &[String]) -> ExitCode {
    let mut today = None;
    let mut me = String::new();
    let mut flags = Flags::default();
    let mut auto_confirm = false;
    let mut iter = rest.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--today" => today = iter.next().cloned(),
            "--me" => me = iter.next().cloned().unwrap_or_default(),
            "--no-directory" => flags.directory = false,
            "--no-preground" => flags.preground = false,
            "--no-normalize" => flags.normalize = false,
            "--no-compose" => flags.compose = false,
            "--auto-confirm" => auto_confirm = true,
            "--writes" => match iter.next().and_then(|mode| Writes::parse(mode)) {
                Some(mode) => flags.writes = mode,
                None => return fail("--writes takes run, park or shadow"),
            },
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
    let mut session =
        match centraid_nativetools::vaultio::open_session(Path::new(path), now, &me, flags) {
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
            Ok(request) => {
                let mut response = answer(&mut session, &request);
                if auto_confirm
                    && let Some(id) = session.pending().map(|pending| pending.id.clone())
                {
                    response["effect"]["confirmed"] = session.confirm(&id).to_json();
                }
                // `--writes shadow`: where the patched world parted from the vault at this step
                let drift = session.take_drift();
                if !drift.is_empty() {
                    response["effect"]["drift"] = json!(drift);
                }
                response
            }
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

/// `think`: the stateless compiler, one JSON request per line.
fn think() -> ExitCode {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => think_answer(&request),
            Err(error) => format!("{}", json!({"error": format!("not JSON: {error}")})),
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

/// A call as JSON text, its arguments in the order a call writes them (a JSON map here would sort them).
fn call_json(call: &Call) -> String {
    let args: Vec<String> = call
        .args
        .iter()
        .map(|(key, value)| format!("{}:{}", json!(key), json!(value)))
        .collect();
    format!(
        "{{\"tool\":{},\"args\":{{{}}}}}",
        json!(call.tool),
        args.join(",")
    )
}

fn think_context(context: &Value) -> Context {
    let mut out = Context {
        message: context["message"].as_str().unwrap_or_default().to_owned(),
        focus: context["focus"].as_str().map(str::to_owned),
        ..Context::default()
    };
    if let Some(rows) = context["rows"].as_object() {
        for (number, row) in rows {
            out.rows.insert(
                number.clone(),
                RowText {
                    name: row["name"].as_str().unwrap_or_default().to_owned(),
                    line: row["line"].as_str().unwrap_or_default().to_owned(),
                },
            );
        }
    }
    out
}

fn think_answer(request: &Value) -> String {
    let Some(text) = request.get("think").and_then(Value::as_str) else {
        return json!({"error": "a request has a `think` text"}).to_string();
    };
    let dates = request.get("dates").and_then(Value::as_str);
    match request.get("op").and_then(Value::as_str) {
        Some("compile") => {
            let Some(mode) = request
                .get("mode")
                .and_then(Value::as_str)
                .and_then(TraceMode::parse)
            else {
                return json!({"error": "`mode` is \"v3.1\" or \"v4\""}).to_string();
            };
            match think::compile_think(text, dates, mode) {
                Ok(call) => format!("{{\"call\":{}}}", call_json(&call)),
                Err(refusal) => {
                    json!({"refused": {"class": refusal.class, "message": refusal.message}})
                        .to_string()
                }
            }
        }
        Some("v4") => {
            let context = request.get("context").filter(|value| value.is_object());
            let context = context.map(think_context);
            match think::v4_think(text, dates, context.as_ref()) {
                Ok(rewritten) => json!({"think": rewritten}).to_string(),
                Err(skip) => {
                    json!({"skip": {"reason": skip.reason, "detail": skip.detail}}).to_string()
                }
            }
        }
        other => json!({"error": format!("unknown op {other:?}; ops: compile, v4")}).to_string(),
    }
}
