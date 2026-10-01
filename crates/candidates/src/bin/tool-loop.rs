//! # `tool-loop` — the composable-tools candidate, served and scored
//!
//! ```text
//! tool-loop serve --world suite|holdout|spec:<world.json> [--search ranked]
//!     JSON lines on stdin/stdout, one session at a time:
//!       {"op":"open"}                      -> {"today": "Monday 2026-06-15"}
//!       {"op":"turn","request":"…"}        -> {"ok": true}
//!       {"op":"call","line":"search \"x\""} -> {"obs": "…", "end": null | "<plan>"}
//!       {"op":"end_turn"}                  -> {"end": "<plan>"}   (the caller's limit)
//!     `open` again deals a FRESH copy of the world.
//!
//! tool-loop score --corpus suite [--sessions ids.json] [--turns out.jsonl]
//!                 [--steps N] [--budget CHARS] [--search ranked]
//!                 --agent <program> [args…]
//!     `--search ranked` answers `search "x"` with the ranker
//!     ([`centraid_candidates::rank`]): hits plus their numbered inline links.
//!     Off by default: `search "x"` is `show (things called x)`.
//!     The official scoring loop (`centraid_evalsuite::run`), with each turn
//!     played by <program> over stdin/stdout:
//!       -> {"op":"session","id":"s01","today":"today: Monday 2026-06-15"}
//!       -> {"op":"turn","request":"…"}
//!       <- {"call":"…"}                     (repeated)
//!       -> {"obs":"…","end":bool}
//!       -> {"op":"turn_end","plan":"…"}     after the turn closes
//!     `end` is true on the step that closes the turn, WHATEVER closed it: an
//!     `answer`, a write, `done`, or the loop's own limits — the agent loops
//!     until it reads it. A turn is bounded by a BUDGET of characters read and
//!     written (`--budget`, calls plus observations), a hard `--steps` cap, and
//!     one guard: a call identical to the one before it is not run, and the
//!     turn closes (a model repeating itself has stopped making progress).
//! ```
//!
//! A training world (`spec:`) is an EMPTY founded vault
//! ([`WorldTemplate::empty`]) filled by a list of writes, each either a raw
//! command `{"cmd": "people.add_person", "body": {…}, "as": "ana"}` or a
//! canonical line `{"canon": "locker.add_item{…}"}`. A string `"$ana.party_id"`
//! anywhere in a later body is replaced by that field of the earlier result.
//! A third form, `{"field": ["core.content_item", "$ph1.asset_id", "place_id"],
//! "as": "pl1"}`, READS one column through the field door as `{"value": …}` —
//! for ids no command returns, such as the place a photograph's coordinates
//! minted, which `media.name_place` then names.

use std::cell::RefCell;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, ExitCode, Stdio};
use std::rc::Rc;

use centraid_candidates::tools::{ToolSession, today_line};
use centraid_evalsuite::{
    Candidate, CandidateRuntime, Context, Plan, Report, Session, WorldTemplate,
};
use serde_json::{Value, json};

fn plan_text(plan: &Plan) -> String {
    match plan {
        Plan::Ids(ids) => format!("ids {}", ids.len()),
        Plan::Wrote => "wrote".to_owned(),
        Plan::Value(value) => format!("value {value}"),
        Plan::Declined { reason } => format!("declined {reason}"),
    }
}

// -- worlds --------------------------------------------------------------

fn world(spec: &str) -> Result<WorldTemplate, String> {
    match spec {
        "suite" => WorldTemplate::build(),
        "holdout" => WorldTemplate::build_scenario(centraid_evalworld::Scenario::Second),
        other => {
            let path = other
                .strip_prefix("spec:")
                .ok_or_else(|| format!("--world {other:?}: suite, holdout or spec:<file>"))?;
            training_world(path)
        }
    }
}

fn training_world(path: &str) -> Result<WorldTemplate, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("{path}: {error}"))?;
    let spec: Value = serde_json::from_str(&text).map_err(|error| format!("{path}: {error}"))?;
    let now_ms = spec["now_ms"]
        .as_i64()
        .ok_or_else(|| format!("{path}: now_ms is required"))?;
    let seed = spec["seed"].as_str().unwrap_or("centraid-trainworld/1");
    let empty = WorldTemplate::empty(now_ms, seed)?;
    let dealt = empty.deal_with_ids(&format!("{seed}/rows"))?;
    {
        let mut ctx = Context::new(&dealt);
        let mut tools = ToolSession::default();
        let mut named: serde_json::Map<String, Value> = serde_json::Map::new();
        let calendar_id = ctx.calendar_id()?.unwrap_or_default();
        named.insert(
            "me".into(),
            json!({ "party_id": ctx.me(), "calendar_id": calendar_id }),
        );
        let writes = spec["writes"].as_array().cloned().unwrap_or_default();
        for (at, write) in writes.iter().enumerate() {
            // THE WRITE'S OWN INSTANT, when it names one: the clock is put
            // there for this write alone and brought back after, so an
            // activity lands last week and a task is ticked off on Thursday
            // while every read still sees the world's `now`.
            if let Some(when) = write["at"].as_str() {
                dealt
                    .set_clock(when)
                    .map_err(|error| format!("{path}: write {at}: {error}"))?;
            }
            let result = seed_one(write, at, path, &mut ctx, &mut tools, &named);
            dealt.reset_clock();
            let result = result?;
            // WHO IS IN THE FRAME: one proposed region per person, staged on
            // the photograph and confirmed through the member's own
            // `media.answer_face_proposal` — what joins the photo to them.
            for (slot, face) in write["faces"].as_array().into_iter().flatten().enumerate() {
                let party = substitute(face, &named);
                let party = party
                    .as_str()
                    .filter(|party| !party.starts_with('$'))
                    .ok_or_else(|| format!("{path}: write {at}: face {face} names no party"))?;
                let asset = result["asset_id"].as_str().ok_or_else(|| {
                    format!("{path}: write {at}: faces on a write with no asset_id")
                })?;
                let region = dealt.stage_face_proposal(asset, slot)?;
                let body = json!({ "region_id": region, "answer": "confirm", "party_id": party });
                ctx.write("media.answer_face_proposal", body.clone())
                    .map_err(|error| {
                        format!("{path}: write {at} media.answer_face_proposal {body}: {error}")
                    })?;
                ctx.end_turn("seed", &Plan::Wrote);
            }
            if let Some(name) = write["as"].as_str() {
                named.insert(name.to_owned(), result);
            }
        }
    }
    dealt.freeze()
}

/// One write of a training world's spec, run; its result, for `"as"`.
fn seed_one(
    write: &Value,
    at: usize,
    path: &str,
    ctx: &mut Context<'_>,
    tools: &mut ToolSession,
    named: &serde_json::Map<String, Value>,
) -> Result<Value, String> {
    Ok(if let Some(line) = write["canon"].as_str() {
        let line = substitute(&Value::String(line.to_owned()), named);
        tools.begin_turn();
        let step = tools.call(line.as_str().unwrap_or_default(), ctx);
        if step.end != Some(Plan::Wrote) {
            return Err(format!("{path}: write {at} ({line}): {}", step.obs));
        }
        ctx.end_turn("seed", &Plan::Wrote);
        Value::Null
    } else if let Some(door) = write["field"].as_array() {
        // A READ, not a write: `{"field": [entity, id, column]}` names
        // one column of one row through the field door, as
        // `{"value": …}` — for ids no command hands back (the place a
        // photograph's coordinates minted, say).
        let parts: Vec<String> = door
            .iter()
            .map(|part| {
                substitute(part, named)
                    .as_str()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect();
        let [entity, id, column] = parts.as_slice() else {
            return Err(format!(
                "{path}: write {at}: field takes [entity, id, column]"
            ));
        };
        let found = ctx
            .field(entity, id, column)
            .map_err(|error| format!("{path}: write {at} field {parts:?}: {error}"))?
            .ok_or_else(|| format!("{path}: write {at} field {parts:?}: no value"))?;
        json!({ "value": found })
    } else {
        let command = write["cmd"]
            .as_str()
            .ok_or_else(|| format!("{path}: write {at} has neither cmd nor canon"))?;
        let body = substitute(&write["body"], named);
        let result = ctx
            .write(command, body.clone())
            .map_err(|error| format!("{path}: write {at} {command} {body}: {error}"))?;
        ctx.end_turn("seed", &Plan::Wrote);
        result
    })
}

/// `"$name.a.b"` → that path of an earlier result; anything else unchanged.
fn substitute(value: &Value, named: &serde_json::Map<String, Value>) -> Value {
    match value {
        Value::String(text) if text.starts_with('$') => {
            let mut parts = text[1..].split('.');
            let mut at = parts.next().and_then(|name| named.get(name));
            for part in parts {
                at = at.and_then(|found| found.get(part));
            }
            at.cloned().unwrap_or_else(|| value.clone())
        }
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute(v, named)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), substitute(v, named)))
                .collect(),
        ),
        other => other.clone(),
    }
}

// -- serve ---------------------------------------------------------------

fn serve(template: &WorldTemplate, ranked: bool) -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut out = std::io::stdout();
    let mut reply = |value: Value| {
        let _ = writeln!(out, "{value}");
        let _ = out.flush();
    };
    // Wait for the first `open`.
    loop {
        let Some(Ok(line)) = lines.next() else {
            return Ok(());
        };
        let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        match msg["op"].as_str() {
            Some("open") => break,
            Some("quit") => return Ok(()),
            _ => reply(json!({"error": "open a session first"})),
        }
    }
    'sessions: loop {
        let dealt = template.deal()?;
        let mut ctx = Context::new(&dealt);
        let mut tools = ToolSession::default();
        tools.set_ranked(ranked);
        let mut request = String::new();
        let mut in_turn = false;
        reply(json!({ "today": today_line(ctx.today()) }));
        loop {
            let Some(Ok(line)) = lines.next() else {
                return Ok(());
            };
            let msg: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            match msg["op"].as_str() {
                Some("open") => continue 'sessions,
                Some("quit") => return Ok(()),
                Some("turn") => {
                    if in_turn {
                        let plan = tools.finish();
                        ctx.end_turn(&request, &plan);
                    }
                    request = msg["request"].as_str().unwrap_or_default().to_owned();
                    tools.begin_turn();
                    tools.note_request(&request);
                    in_turn = true;
                    reply(json!({"ok": true}));
                }
                Some("call") if in_turn => {
                    let step = tools.call(msg["line"].as_str().unwrap_or_default(), &mut ctx);
                    let end = step.end.as_ref().map(plan_text);
                    if let Some(plan) = &step.end {
                        ctx.end_turn(&request, plan);
                        in_turn = false;
                    }
                    reply(json!({"obs": step.obs, "end": end}));
                }
                Some("peek") => {
                    // For a data GENERATOR, never a model: the rows of a
                    // read-only call as JSON, from a scratch session so no
                    // `#n` is numbered and `them` does not move.
                    reply(peek(msg["line"].as_str().unwrap_or_default(), &mut ctx));
                }
                Some("end_turn") if in_turn => {
                    let plan = tools.finish();
                    ctx.end_turn(&request, &plan);
                    in_turn = false;
                    reply(json!({"end": plan_text(&plan)}));
                }
                _ => reply(json!({"error": "expected turn, call, end_turn, open or quit"})),
            }
        }
    }
}

fn peek(line: &str, ctx: &mut Context<'_>) -> Value {
    let tree = match centraid_candidates::canon::parse_for_execution(line, ctx.today()) {
        Ok(tree) => tree,
        Err(complaint) => return json!({"error": complaint}),
    };
    if !matches!(
        tree,
        centraid_candidates::canon::Turn::Show(_) | centraid_candidates::canon::Turn::Value(_)
    ) {
        return json!({"error": "peek takes a show or a value"});
    }
    let mut state = centraid_candidates::exec::State::default();
    match centraid_candidates::exec::execute(&tree, &mut state, ctx) {
        Plan::Ids(_) => {
            let rows: Vec<Value> = state
                .answers
                .last()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|row| {
                    json!({"id": row.id, "entity": row.entity, "app": row.app,
                           "label": row.label, "date": row.date, "live": row.live,
                           "extra": row.extra})
                })
                .collect();
            json!({ "rows": rows })
        }
        Plan::Value(value) => json!({ "value": value }),
        other => json!({ "error": plan_text(&other) }),
    }
}

// -- score ---------------------------------------------------------------

struct Agent {
    _child: Child,
    to: ChildStdin,
    from: BufReader<ChildStdout>,
}

impl Agent {
    fn send(&mut self, value: &Value) {
        let _ = writeln!(self.to, "{value}");
        let _ = self.to.flush();
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        match self.from.read_line(&mut line) {
            Ok(n) if n > 0 => serde_json::from_str(&line).unwrap_or(Value::Null),
            _ => Value::Null,
        }
    }
}

/// How far one turn may run.
#[derive(Clone, Copy)]
struct Limits {
    /// Hard cap on calls.
    steps: usize,
    /// Characters of calls plus observations; a context budget, not a count.
    budget: usize,
}

struct LoopRuntime {
    agent: Rc<RefCell<Agent>>,
    limits: Limits,
    ranked: bool,
    name: String,
}

struct LoopSession {
    agent: Rc<RefCell<Agent>>,
    limits: Limits,
    tools: ToolSession,
    started: bool,
    id: String,
}

impl CandidateRuntime for LoopRuntime {
    fn name(&self) -> &str {
        &self.name
    }

    fn session(&self, session: &Session) -> Box<dyn Candidate> {
        let mut tools = ToolSession::default();
        tools.set_ranked(self.ranked);
        Box::new(LoopSession {
            agent: Rc::clone(&self.agent),
            limits: self.limits,
            tools,
            started: false,
            id: session.id.clone(),
        })
    }
}

impl Candidate for LoopSession {
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan {
        let mut agent = self.agent.borrow_mut();
        if !self.started {
            agent.send(&json!({"op": "session", "id": self.id, "today": today_line(ctx.today())}));
            self.started = true;
        }
        agent.send(&json!({"op": "turn", "request": request}));
        self.tools.begin_turn();
        self.tools.note_request(request);
        let mut plan = None;
        let mut spent = 0usize;
        let mut previous: Option<String> = None;
        for at in 0..self.limits.steps {
            let msg = agent.recv();
            let Some(line) = msg["call"].as_str() else {
                // The agent sent no call at all (its `--invalid fail` mode):
                // a failed turn, never retried. An INVALID line is sent as
                // text and comes back from the runtime as an `error: …`.
                plan = Some(Plan::Declined {
                    reason: "unhandled: the agent emitted no call".to_owned(),
                });
                break;
            };
            if previous.as_deref() == Some(line.trim()) {
                agent.send(&json!({"obs": "stopped: the same call twice", "end": true}));
                break;
            }
            let step = self.tools.call(line, ctx);
            spent += line.len() + step.obs.len();
            let closing =
                step.end.is_some() || at + 1 == self.limits.steps || spent >= self.limits.budget;
            agent.send(&json!({"obs": step.obs, "end": closing}));
            if let Some(found) = step.end {
                plan = Some(found);
                break;
            }
            if closing {
                break;
            }
            previous = Some(line.trim().to_owned());
        }
        let plan = plan.unwrap_or_else(|| self.tools.finish());
        agent.send(&json!({"op": "turn_end", "plan": plan_text(&plan)}));
        plan
    }
}

fn score(args: &[String]) -> Result<(), String> {
    let mut corpus = "suite".to_owned();
    let mut sessions: Option<String> = None;
    let mut turns_out: Option<String> = None;
    let mut limits = Limits {
        steps: 12,
        budget: 12_000,
    };
    let mut ranked = false;
    let mut agent_cmd: Vec<String> = Vec::new();
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "--corpus" => {
                at += 1;
                corpus.clone_from(&args[at]);
            }
            "--sessions" => {
                at += 1;
                sessions = Some(args[at].clone());
            }
            "--turns" => {
                at += 1;
                turns_out = Some(args[at].clone());
            }
            "--steps" => {
                at += 1;
                limits.steps = args[at].parse().map_err(|_| "--steps N")?;
            }
            "--budget" => {
                at += 1;
                limits.budget = args[at].parse().map_err(|_| "--budget CHARS")?;
            }
            "--search" => {
                at += 1;
                ranked = search_mode(args.get(at).map(String::as_str))?;
            }
            "--agent" => {
                agent_cmd = args[at + 1..].to_vec();
                break;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
        at += 1;
    }
    if agent_cmd.is_empty() {
        return Err("--agent <program> [args…] is required, last".to_owned());
    }
    let path = centraid_candidates::corpus_path(&corpus);
    let mut suite = centraid_evalsuite::Suite::read(&path)?;
    let template = if corpus == "holdout" {
        WorldTemplate::build_scenario(centraid_evalworld::Scenario::Second)?
    } else {
        WorldTemplate::build()?
    };
    suite.resolve(&template.inventory)?;
    if let Some(file) = &sessions {
        let text = std::fs::read_to_string(file).map_err(|error| format!("{file}: {error}"))?;
        let wanted: Vec<String> =
            serde_json::from_str(&text).map_err(|error| format!("{file}: {error}"))?;
        suite
            .sessions
            .retain(|session| wanted.contains(&session.id));
    }
    let mut child = Command::new(&agent_cmd[0])
        .args(&agent_cmd[1..])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|error| format!("the agent does not start: {error}"))?;
    let to = child.stdin.take().ok_or("no agent stdin")?;
    let from = BufReader::new(child.stdout.take().ok_or("no agent stdout")?);
    let runtime = LoopRuntime {
        agent: Rc::new(RefCell::new(Agent {
            _child: child,
            to,
            from,
        })),
        limits,
        ranked,
        name: format!("tool-loop ({})", agent_cmd.join(" ")),
    };
    let report = centraid_evalsuite::run(&suite, &template, &runtime)?;
    runtime.agent.borrow_mut().send(&json!({"op": "quit"}));
    print_report(&corpus, &report);
    if let Some(path) = &turns_out {
        let mut lines = String::new();
        for session in &report.sessions {
            for (at, turn) in session.turns.iter().enumerate() {
                lines.push_str(
                    &json!({
                        "corpus": corpus, "session": session.id,
                        "category": session.category, "turn": at,
                        "passed": turn.passed, "tier": tier(turn),
                        "complaint": turn.complaint,
                    })
                    .to_string(),
                );
                lines.push('\n');
            }
        }
        std::fs::write(path, lines).map_err(|error| format!("{path}: {error}"))?;
    }
    Ok(())
}

#[expect(clippy::cast_precision_loss, reason = "a rate over tens of sessions")]
fn rate(passed: usize, total: usize) -> f64 {
    if total == 0 {
        return 0.0;
    }
    passed as f64 * 100.0 / total as f64
}

/// A turn's outcome in three tiers: right, asked (a clarify the case did
/// not want, with nothing moved) or wrong. Strict scoring counts only the
/// first; a candidate that hands a question back instead of guessing is
/// "safe", and the product wants that distinguished from a wrong write.
fn tier(turn: &centraid_evalsuite::TurnResult) -> &'static str {
    if turn.passed {
        "right"
    } else if matches!(&turn.plan, Plan::Declined { reason } if reason == "clarify")
        && turn.changes.is_empty()
    {
        "asked"
    } else {
        "wrong"
    }
}

fn print_report(corpus: &str, report: &Report) {
    let (passed, total) = report.strict_sessions();
    println!("\n================ corpus: {corpus} ================");
    println!("candidate: {}", report.candidate);
    println!(
        "\nSESSIONS PASSED (strict, the headline): {passed}/{total}  {:.1}%",
        rate(passed, total)
    );
    println!(
        "GRADED SESSION SCORE (F1 per rows turn):  {:.1}%",
        report.graded_score() * 100.0
    );
    let turns: usize = report.sessions.iter().map(|s| s.turns.len()).sum();
    let turns_passed: usize = report
        .sessions
        .iter()
        .flat_map(|s| &s.turns)
        .filter(|turn| turn.passed)
        .count();
    println!(
        "TURNS PASSED (diagnostic, never a score): {turns_passed}/{turns}  {:.1}%",
        rate(turns_passed, turns)
    );
    let safe_sessions = report
        .sessions
        .iter()
        .filter(|s| s.turns.iter().all(|t| tier(t) != "wrong"))
        .count();
    let all_turns: Vec<_> = report.sessions.iter().flat_map(|s| &s.turns).collect();
    let asked = all_turns.iter().filter(|t| tier(t) == "asked").count();
    let wrong = all_turns.iter().filter(|t| tier(t) == "wrong").count();
    println!(
        "SESSIONS SAFE (right or asked, never wrong): {safe_sessions}/{total}  {:.1}%",
        rate(safe_sessions, total)
    );
    println!(
        "TURNS asked {asked} ({:.1}%) · wrong {wrong} ({:.1}%)",
        rate(asked, turns),
        rate(wrong, turns)
    );
}

/// `--search plain|ranked`.
fn search_mode(mode: Option<&str>) -> Result<bool, String> {
    match mode {
        Some("ranked") => Ok(true),
        Some("plain") => Ok(false),
        _ => Err("--search plain|ranked".to_owned()),
    }
}

/// `serve [--world SPEC] [--search ranked]`.
fn serve_args(args: &[String]) -> Result<(String, bool), String> {
    let mut spec = "suite".to_owned();
    let mut ranked = false;
    let mut at = 0;
    while at < args.len() {
        match args[at].as_str() {
            "--world" => {
                at += 1;
                spec = args.get(at).cloned().ok_or("--world SPEC")?;
            }
            "--search" => {
                at += 1;
                ranked = search_mode(args.get(at).map(String::as_str))?;
            }
            other => return Err(format!("unknown argument {other:?}")),
        }
        at += 1;
    }
    Ok((spec, ranked))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let outcome = match args.first().map(String::as_str) {
        Some("serve") => serve_args(&args[1..])
            .and_then(|(spec, ranked)| world(&spec).and_then(|template| serve(&template, ranked))),
        Some("score") => score(&args[1..]),
        _ => Err("tool-loop serve --world … | tool-loop score … --agent …".to_owned()),
    };
    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(complaint) => {
            eprintln!("{complaint}");
            ExitCode::FAILURE
        }
    }
}
