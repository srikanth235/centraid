//! THE REPLAY PRECONDITION WITH NO MODEL: a set whose reference calls reproduce its gold may score a model; one that
//! does not is refused with the sessions named. No weights, no network, no clocks.

use centraid_assist::native::prompt::ToolsMode;
use centraid_assist_eval::gold::Session;
use centraid_assist_eval::replay;
use centraid_assist_eval::source::MemorySource;
use serde_json::{Value, json};

fn world() -> Value {
    json!({
        "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "replay",
        "people": [{"key": "neha", "name": "Neha Rao"}, {"key": "ravi", "name": "Ravi Menon"}]
    })
}

fn session(id: &str, gold_row: &str) -> Session {
    serde_json::from_value(json!({
        "id": id, "world": "W", "today": "2026-03-12T18:20", "me": "Sam Park",
        "turns": [
            {"user": "write me a poem", "gold": [{"type": "decline", "reasons": ["out_of_scope"]}],
             "ref": [{"tool": "decline", "args": {"reason": "out_of_scope"}}]},
            // the same text again, answered differently: occurrence by occurrence
            {"user": "who is neha", "gold": [{"type": "rows", "rows": [gold_row]}],
             "ref": [{"tool": "find", "args": {"kind": "person", "name": "Neha"}},
                     {"tool": "answer", "args": {"rows": "@1"}}]},
            {"user": "write me a poem", "gold": [{"type": "decline", "reasons": ["out_of_scope"]}],
             "ref": [{"tool": "decline", "args": {"reason": "out_of_scope"}}]}
        ]
    }))
    .expect("session")
}

fn source(sessions: Vec<Session>) -> MemorySource {
    MemorySource {
        label: "replay".to_owned(),
        sessions,
        worlds: [("W".to_owned(), world())].into_iter().collect(),
    }
}

#[test]
fn a_set_whose_reference_calls_reproduce_the_gold_replays() {
    let source = source(vec![session("A", "neha"), session("B", "neha")]);
    let report = replay::require(&source, &source.sessions, ToolsMode::Sig).expect("replays");
    assert_eq!((report.sessions, report.turns), (2, 6));
}

#[test]
fn the_replay_runs_under_every_tools_block() {
    let source = source(vec![session("A", "neha")]);
    for tools in [ToolsMode::Sig, ToolsMode::S2] {
        replay::require(&source, &source.sessions, tools)
            .unwrap_or_else(|e| panic!("{tools:?}: {e}"));
    }
}

#[test]
fn a_session_whose_gold_the_reference_does_not_reach_is_listed_and_refused() {
    // B's gold wants Ravi but its reference finds Neha
    let source = source(vec![session("A", "neha"), session("B", "ravi")]);
    let error = replay::require(&source, &source.sessions, ToolsMode::Sig)
        .expect_err("refused")
        .to_string();
    assert!(error.contains("do not replay"), "{error}");
    assert!(error.contains("B turn 2"), "{error}");
    assert!(!error.contains("A turn"), "{error}");
    assert!(error.contains("1 of 2 sessions"), "{error}");
}

#[test]
fn a_session_the_data_cannot_seed_is_listed_not_fatal() {
    let mut orphan = session("C", "neha");
    orphan.world = "missing".to_owned();
    let source = source(vec![session("A", "neha"), orphan]);
    let report = replay::replay(&source, &source.sessions, ToolsMode::Sig).expect("runs");
    assert!(!report.replays());
    assert_eq!(report.unrunnable.len(), 1);
    assert!(report.describe(5).contains("C could not run"));
}
