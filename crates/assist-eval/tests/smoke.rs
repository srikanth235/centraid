//! THE WHOLE RIG WITH NO MODEL: a tiny world is seeded into a real vault, sessions replay through the phone's
//! prompt renderer and the real runtime, and a stub stands in for the weights. What these tests hold is the plumbing
//! (seed, copy, session, effect, judge, report); how often a 0.8B model picks the right call is the fine-tune's
//! measurement (see the README).

use std::sync::Mutex;

use centraid_assist_eval::report;
use centraid_assist_eval::run::{DeclineStepper, Runner, SessionResult, StepOut, Stepper};
use centraid_assist_eval::source::MemorySource;
use serde_json::{Value, json};

fn world() -> Value {
    json!({
        "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "smoke",
        "people": [{"key": "neha", "name": "Neha Rao"}, {"key": "ravi", "name": "Ravi Menon"}],
        "tasks": [{"key": "cabin", "name": "Book the cabin", "due": "2026-06-19T09:00", "status": "open"}]
    })
}

fn session(id: &str, turns: Vec<Value>) -> centraid_assist_eval::gold::Session {
    serde_json::from_value(json!({
        "id": id, "world": "W", "today": "2026-03-12T18:20", "me": "Sam Park", "turns": turns
    }))
    .expect("session")
}

fn source(sessions: Vec<centraid_assist_eval::gold::Session>) -> MemorySource {
    MemorySource {
        label: "smoke".to_owned(),
        sessions,
        worlds: [("W".to_owned(), world())].into_iter().collect(),
    }
}

fn declines() -> Value {
    json!({"user": "write me a poem", "gold": [{"type": "decline", "reasons": ["out_of_scope"]}], "ref": [{"tool": "decline", "args": {"reason": "out_of_scope"}}]})
}

fn who_is_neha() -> Value {
    json!({"user": "who is neha", "gold": [{"type": "rows", "rows": ["neha"]}],
           "ref": [{"tool": "answer", "args": {"kind": "person", "name": "neha"}}]})
}

fn call(tool: &str, params: &[(&str, &str)]) -> String {
    let mut text = format!("<think>\nintent: go\n</think>\n\n<tool_call>\n<function={tool}>\n");
    for (name, value) in params {
        text += &format!("<parameter={name}>\n{value}\n</parameter>\n");
    }
    text + "</function>\n</tool_call>"
}

/// Says what it was scripted to say, one message per step, then the last one again.
struct Script(Mutex<Vec<String>>);

impl Stepper for Script {
    fn step(&self, _prompt: &str, _dates: Option<&str>) -> Result<StepOut, String> {
        let mut said = self.0.lock().expect("lock");
        let text = if said.len() > 1 {
            said.remove(0)
        } else {
            said[0].clone()
        };
        Ok(StepOut {
            text,
            think_cut: false,
        })
    }
}

fn run(source: &MemorySource, stepper: &dyn Stepper) -> Vec<SessionResult> {
    let mut runner = Runner::new(source, stepper).expect("runner");
    source
        .sessions
        .iter()
        .map(|s| runner.run_session(s).expect("session runs"))
        .collect()
}

#[test]
fn a_model_that_declines_everything_passes_the_declines_and_fails_the_reads() {
    let source = source(vec![
        session("S1", vec![declines()]),
        session("S2", vec![who_is_neha()]),
    ]);
    let results = run(&source, &DeclineStepper);
    assert!(results[0].pass(), "{:?}", results[0].turns[0].problems);
    assert_eq!(results[0].turns[0].ending, "decline");
    assert!(!results[1].pass());
    assert_eq!(
        results[1].turns[0].problems,
        vec!["ended in decline, want rows".to_owned()]
    );
    assert!(!results[1].turns[0].tool_ok);
    assert_eq!(results[1].turns[0].apps, vec!["people".to_owned()]);
}

#[test]
fn a_scripted_read_is_scored_by_its_effect_and_its_arguments() {
    let answer = call("answer", &[("kind", "person"), ("name", "Neha")]);
    let source = source(vec![session("S", vec![who_is_neha()])]);
    let results = run(&source, &Script(Mutex::new(vec![answer])));
    let turn = &results[0].turns[0];
    assert!(turn.pass, "{:?} ended {}", turn.problems, turn.ending);
    assert!(turn.tool_ok);
    assert_eq!(turn.constraints, 1);
    assert_eq!(turn.args["rows"], "right");
    assert_eq!(turn.args["date"], "absent");
    assert_eq!(turn.calls.len(), 1);

    // the same effect from the wrong person is a failed turn and a wrong `rows` argument
    let wrong = call("answer", &[("kind", "person"), ("name", "Ravi")]);
    let results = run(&source, &Script(Mutex::new(vec![wrong])));
    let turn = &results[0].turns[0];
    assert!(!turn.pass && turn.tool_ok);
    assert_eq!(turn.args["rows"], "wrong");
}

#[test]
fn a_write_lands_in_the_vault_and_a_later_turn_sees_it() {
    let complete = json!({"user": "tick off the cabin", "gold": [{"type": "diff", "diff": {"rows": [
        {"key": "cabin", "change": "updated", "fields": {"status": "completed", "completed": {"any": true}}}], "links": []}}],
        "ref": [{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "Book the cabin"}}]});
    let again = json!({"user": "which tasks are open", "gold": [{"type": "rows", "rows": []}],
        "ref": [{"tool": "answer", "args": {"kind": "task", "where": "status = open"}}]});
    let source = source(vec![session("S", vec![complete, again])]);
    let script = Script(Mutex::new(vec![
        call(
            "act",
            &[
                ("verb", "complete"),
                ("kind", "task"),
                ("name", "Book the cabin"),
            ],
        ),
        call("answer", &[("kind", "task"), ("where", "status = open")]),
    ]));
    let results = run(&source, &script);
    let turns = &results[0].turns;
    assert!(
        turns[0].pass,
        "{:?} ended {}",
        turns[0].problems, turns[0].ending
    );
    assert!(
        turns[1].pass,
        "{:?} ended {}",
        turns[1].problems, turns[1].ending
    );
    assert_eq!(turns[1].constraints, 1);
}

#[test]
fn a_failing_engine_stops_the_session_and_the_rest_is_not_run() {
    struct Broken;
    impl Stepper for Broken {
        fn step(&self, _: &str, _: Option<&str>) -> Result<StepOut, String> {
            Err("the model failed".to_owned())
        }
    }
    let source = source(vec![session("S", vec![declines(), declines()])]);
    let results = run(&source, &Broken);
    assert_eq!(results[0].error.as_deref(), Some("the model failed"));
    assert!(results[0].turns.iter().all(|t| !t.pass && !t.run));
    assert_eq!(
        results[0].turns[0].problems,
        vec!["engine failed: the model failed".to_owned()]
    );
}

#[test]
fn the_report_counts_sessions_turns_apps_and_constraints_and_survives_json() {
    let source = source(vec![
        session("S1", vec![declines(), who_is_neha()]),
        session("S2", vec![who_is_neha()]),
    ]);
    let results = run(&source, &DeclineStepper);
    let report = report::build("stub", "smoke", &results);
    assert_eq!(report.overall.sessions, 2);
    assert_eq!(
        (report.overall.session_pass.k, report.overall.session_pass.n),
        (0, 2)
    );
    assert_eq!((report.all.turn_pass.k, report.all.turn_pass.n), (1, 3));
    // S1's second turn fails after S1's first passed: both are clean; S2's only turn is its first failure
    assert_eq!(
        (report.all.clean_turn_pass.k, report.all.clean_turn_pass.n),
        (1, 3)
    );
    assert_eq!(
        (report.all.tool_accuracy.k, report.all.tool_accuracy.n),
        (1, 3)
    );
    let one = report.all.by_constraints["1"];
    assert_eq!((one.turns, one.failed), (2, 2));
    assert_eq!(report.all.by_constraints["0"].turns, 1);
    assert_eq!(report.all.by_constraints["0-1"].turns, 3);
    assert_eq!(report.by_app["people"].slice.turns, 2);
    assert_eq!(report.failed.len(), 2);
    assert_eq!(report.failed[0].id, "S1");
    assert_eq!(report.failed[0].turn, 2);

    let json: Value = serde_json::to_value(&report).expect("json");
    for key in [
        "overall",
        "turn_pass",
        "tool_accuracy",
        "arguments",
        "by_constraints",
        "by_app",
        "failed",
    ] {
        assert!(json.get(key).is_some(), "report has {key}");
    }
    assert!(json["arguments"]["amount"]["scored"].is_number());

    // a run file read back scores the same
    let again: Vec<SessionResult> = results
        .iter()
        .map(|r| serde_json::from_str(&serde_json::to_string(r).expect("ser")).expect("de"))
        .collect();
    assert_eq!(
        serde_json::to_value(report::build("stub", "smoke", &again)).expect("json"),
        json
    );

    let text = report::text(&report);
    assert!(text.contains("Session pass:     0/2 = 0.0%"), "{text}");
    assert!(text.contains("people"), "{text}");
}
