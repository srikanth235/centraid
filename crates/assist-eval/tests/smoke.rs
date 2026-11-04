//! THE WHOLE RIG WITH NO MODEL: a tiny world is seeded into a real vault, sessions replay through the phone's
//! prompt renderer and the real runtime, and a stub stands in for the weights. What these tests hold is the plumbing
//! (seed, copy, session, effect, judge, report); how often a 0.8B model picks the right call is the fine-tune's
//! measurement (see the README).

use std::sync::Mutex;

use centraid_assist::native::prompt::ToolsMode;
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
    fn step(
        &self,
        _prompt: &str,
        _dates: Option<&str>,
        _tools: ToolsMode,
    ) -> Result<StepOut, String> {
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

/// Runs under S2's tools block, the prompt the frozen sets were written for.
fn run(source: &MemorySource, stepper: &dyn Stepper) -> Vec<SessionResult> {
    run_with(source, stepper, ToolsMode::S2)
}

fn run_with(source: &MemorySource, stepper: &dyn Stepper, tools: ToolsMode) -> Vec<SessionResult> {
    let mut runner = Runner::new(source, stepper)
        .expect("runner")
        .with_tools(tools);
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
    let find = call("find", &[("kind", "person"), ("name", "Neha")]);
    let answer = call("answer", &[("rows", "@1")]);
    let source = source(vec![session("S", vec![who_is_neha()])]);
    let results = run(&source, &Script(Mutex::new(vec![find, answer.clone()])));
    let turn = &results[0].turns[0];
    assert!(turn.pass, "{:?} ended {}", turn.problems, turn.ending);
    assert!(turn.tool_ok);
    assert_eq!(turn.constraints, 1);
    assert_eq!(turn.args["rows"], "right");
    assert_eq!(turn.args["date"], "absent");
    assert_eq!(turn.calls.len(), 2);

    // the same effect from the wrong person is a failed turn and a wrong `rows` argument
    let wrong = call("find", &[("kind", "person"), ("name", "Ravi")]);
    let results = run(&source, &Script(Mutex::new(vec![wrong, answer])));
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
        fn step(&self, _: &str, _: Option<&str>, _: ToolsMode) -> Result<StepOut, String> {
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
    let report = report::build("stub", "smoke", &results, &[], results.len());
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
        serde_json::to_value(report::build("stub", "smoke", &again, &[], again.len()))
            .expect("json"),
        json
    );

    let text = report::text(&report);
    assert!(text.contains("Session pass:     0/2 = 0.0%"), "{text}");
    assert!(text.contains("people"), "{text}");
}

#[test]
fn a_look_then_answer_that_passes_gets_its_arguments_right() {
    let source = source(vec![session("S", vec![who_is_neha()])]);
    let script = Script(Mutex::new(vec![
        call("find", &[("kind", "person"), ("name", "Neha")]),
        call("answer", &[("rows", "@1")]),
    ]));
    let turn = &run_with(&source, &script, ToolsMode::Sig)[0].turns[0];
    assert!(turn.pass, "{:?} ended {}", turn.problems, turn.ending);
    assert_eq!(turn.calls.len(), 2);
    assert_eq!(
        turn.args["rows"], "right",
        "the effect passed, so the argument was right"
    );
    assert!(turn.tool_ok);
}

#[test]
fn the_new_contract_finds_then_does_by_handle_and_names_the_right_tool() {
    let complete = json!({"user": "tick off the cabin", "gold": [{"type": "diff", "diff": {"rows": [
        {"key": "cabin", "change": "updated", "fields": {"status": "completed", "completed": {"any": true}}}], "links": []}}],
        "ref": [{"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "Book the cabin"}}]});
    let source = source(vec![session("S", vec![complete])]);
    let script = Script(Mutex::new(vec![
        call("find", &[("kind", "task"), ("name", "Book the cabin")]),
        call("do", &[("verb", "complete"), ("rows", "@1")]),
    ]));
    let turn = &run_with(&source, &script, ToolsMode::Sig)[0].turns[0];
    assert!(turn.pass, "{:?} ended {}", turn.problems, turn.ending);
    assert!(turn.tool_name_ok && turn.tool_ok);
    assert_eq!(turn.args["rows"], "right");
    // the wrong verb is a failed turn, a wrong tool name, and the right tool by effect-class (it still wrote)
    let script = Script(Mutex::new(vec![
        call("find", &[("kind", "task"), ("name", "Book the cabin")]),
        call("do", &[("verb", "cancel"), ("rows", "@1")]),
    ]));
    let turn = &run(&source, &script)[0].turns[0];
    assert!(!turn.pass && !turn.tool_name_ok && turn.tool_ok);
    assert_eq!(turn.args["rows"], "wrong", "another verb is another act");
}

/// Remembers the first prompt it was shown.
struct Seen(Mutex<Option<String>>);

impl Stepper for Seen {
    fn step(
        &self,
        prompt: &str,
        _dates: Option<&str>,
        tools: ToolsMode,
    ) -> Result<StepOut, String> {
        self.0
            .lock()
            .expect("lock")
            .get_or_insert_with(|| prompt.to_owned());
        DeclineStepper.step(prompt, None, tools)
    }
}

#[test]
fn the_tools_block_the_model_reads_is_the_one_the_run_names() {
    let source = source(vec![session("S", vec![declines()])]);
    let shown = |tools: ToolsMode| {
        let seen = Seen(Mutex::new(None));
        let mut runner = Runner::new(&source, &seen)
            .expect("runner")
            .with_tools(tools);
        runner.run_session(&source.sessions[0]).expect("session");
        seen.0.lock().expect("lock").take().expect("a prompt")
    };
    let (s2, new) = (shown(ToolsMode::S2), shown(ToolsMode::Sig));
    assert_ne!(s2, new);
    assert!(s2.contains("act("), "S2 learned act");
    assert!(!new.contains("act("), "the eight tools have no act");
}

#[test]
fn a_count_is_compute_then_answer_value_and_ends_in_a_value() {
    let count = json!({"user": "how many tasks", "gold": [{"type": "value", "values": [{"amount": 1, "unit": null}]}],
        "ref": [{"tool": "answer", "args": {"kind": "task", "op": "count"}}]});
    let source = source(vec![session("S", vec![count])]);
    for tools in [ToolsMode::Sig, ToolsMode::S2] {
        let script = Script(Mutex::new(vec![
            call("compute", &[("op", "count"), ("kind", "task")]),
            call("answer", &[("value", "@1")]),
        ]));
        let mut runner = Runner::new(&source, &script)
            .expect("runner")
            .with_tools(tools);
        let result = runner.run_session(&source.sessions[0]).expect("session");
        let turn = &result.turns[0];
        assert!(
            turn.pass,
            "{tools:?}: {:?} ended {}",
            turn.problems, turn.ending
        );
        assert_eq!(turn.ending, "value", "{tools:?}");
        assert!(turn.tool_name_ok, "{tools:?}");
    }
}

/// Remembers the tools mode the runner passed with each step.
struct Tools(Mutex<Vec<ToolsMode>>);

impl Stepper for Tools {
    fn step(
        &self,
        prompt: &str,
        _dates: Option<&str>,
        tools: ToolsMode,
    ) -> Result<StepOut, String> {
        self.0.lock().expect("lock").push(tools);
        DeclineStepper.step(prompt, None, tools)
    }
}

#[test]
fn a_default_runner_shows_the_eight_tools_and_a_chosen_mode_reaches_the_step() {
    let source = source(vec![session("S", vec![declines()])]);
    let seen = Seen(Mutex::new(None));
    Runner::new(&source, &seen)
        .expect("runner")
        .run_session(&source.sessions[0])
        .expect("session");
    let prompt = seen.0.lock().expect("lock").clone().expect("prompt");
    assert!(
        !prompt.contains("act("),
        "the default block is the eight tools'"
    );
    let tools = Tools(Mutex::new(Vec::new()));
    Runner::new(&source, &tools)
        .expect("runner")
        .run_session(&source.sessions[0])
        .expect("session");
    Runner::new(&source, &tools)
        .expect("runner")
        .with_tools(ToolsMode::S2)
        .run_session(&source.sessions[0])
        .expect("session");
    assert_eq!(
        *tools.0.lock().expect("lock"),
        vec![ToolsMode::Sig, ToolsMode::S2]
    );
}
