//! The trace guard (`src/trace.rs`): a call that contradicts its own v2 trace is refused as an
//! error observation, and a call without a v2 trace is untouched.

mod common;

use std::io::Write as _;
use std::process::{Command, Stdio};

use centraid_nativetools::Session;
use common::{seeded, seeded_with};
use serde_json::{Value, json};

fn traced(session: &mut Session, tool: &str, args: Value, think: &str) -> Value {
    session.call_traced(tool, &args, Some(think))
}

fn text(response: &Value) -> &str {
    response["text"].as_str().expect("a text")
}

fn refused(response: &Value) -> bool {
    text(response).contains("contradicts the call")
        && response["effect"]["trace_guard"] == json!(true)
        && response["ends_turn"] == json!(false)
}

/// `#n` of each row a find returned, and its `@k`.
fn found(response: &Value) -> (Vec<String>, String) {
    let rows = response["effect"]["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    (
        rows,
        response["effect"]["result"]
            .as_str()
            .expect("a result handle")
            .to_owned(),
    )
}

fn many_tasks(count: usize) -> Value {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    let tasks = world["tasks"].as_array_mut().unwrap();
    for i in 0..count {
        tasks.push(json!({"key": format!("bulk{i}"), "name": format!("Bulk chore {i}"), "due": "2026-11-01"}));
    }
    world
}

#[test]
fn intent_write_with_an_answer_call_is_refused() {
    let world = seeded();
    let mut session = world.session();
    session.user("what tasks are open");
    let args = json!({"kind": "task", "limit": 2});
    let response = traced(
        &mut session,
        "answer",
        args.clone(),
        "intent: write \"what\"",
    );
    assert!(refused(&response), "{response}");
    assert!(text(&response).contains("intent is write, the call is an answer"));
    // refused like a repeat, but not counted as the last call: the same call under a
    // trace that matches it goes through instead of being answered `repeated call`
    let response = traced(&mut session, "answer", args, "intent: read \"what\"");
    assert!(text(&response).starts_with("answered:"), "{response}");
}

#[test]
fn a_write_under_any_other_intent_is_refused_and_changes_nothing() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let (rows, _) = found(&common::call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    ));
    let act = json!({"verb": "complete", "rows": rows[0]});
    for intent in ["read", "count", "ask", "decline"] {
        let response = traced(
            &mut session,
            "act",
            act.clone(),
            &format!("intent: {intent} \"x\""),
        );
        assert!(refused(&response), "{intent}: {response}");
        assert!(response["effect"]["diff"].is_null(), "{response}");
    }
    let response = traced(
        &mut session,
        "act",
        act,
        "intent: write \"finish\"\nverb: complete\nscope: one",
    );
    assert_eq!(
        response["effect"]["diff"]["rows"][0]["change"], "updated",
        "{response}"
    );
}

#[test]
fn scope_one_with_a_several_row_write_is_refused() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let cabin = found(&common::call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    ))
    .0;
    let reed = found(&common::call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "reed"}),
    ))
    .0;
    let two = format!("{}, {}", cabin[0], reed[0]);
    let act = json!({"verb": "complete", "rows": two});
    let response = traced(
        &mut session,
        "act",
        act.clone(),
        "intent: write\nverb: complete\nscope: one",
    );
    assert!(refused(&response), "{response}");
    assert!(
        text(&response).contains("scope is one, the write names 2 rows"),
        "{response}"
    );
    assert!(response["effect"]["diff"].is_null());
    // the same two rows under scope some
    let response = traced(
        &mut session,
        "act",
        act,
        "intent: write\nverb: complete\nscope: some \"both\"",
    );
    assert_eq!(
        response["effect"]["diff"]["rows"].as_array().unwrap().len(),
        2,
        "{response}"
    );
    // one row under scope one, and a selector write (no rows named), are fine
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let (rows, _) = found(&common::call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "reed"}),
    ));
    let response = traced(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": rows[0]}),
        "intent: write\nverb: complete\nscope: one",
    );
    assert_eq!(
        response["effect"]["diff"]["rows"].as_array().unwrap().len(),
        1,
        "{response}"
    );
}

#[test]
fn refer_with_rows_other_than_the_referent_is_refused() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let (tasks, list) = found(&common::call(&mut session, "find", json!({"kind": "task"})));
    let (events, events_list) = found(&common::call(
        &mut session,
        "find",
        json!({"kind": "event"}),
    ));
    let cabin = found(&common::call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    ))
    .0;
    assert!(tasks.contains(&cabin[0]));
    session.user("do that");
    let one = json!({"verb": "complete", "rows": cabin[0]});
    // both = every row of the referent: one row of the result is a strict subset
    let think =
        format!("intent: write \"do\"\nverb: complete\nscope: one\nrefer: both \"both\" -> {list}");
    let response = traced(&mut session, "act", one.clone(), &think);
    assert!(refused(&response), "{response}");
    assert!(text(&response).contains("refer points at"), "{response}");
    // rows outside the referent
    let think =
        format!("intent: write\nverb: complete\nscope: one\nrefer: that \"that\" -> {events_list}");
    let response = traced(&mut session, "act", one.clone(), &think);
    assert!(refused(&response), "{response}");
    let think = format!(
        "intent: write\nverb: complete\nscope: one\nrefer: it \"it\" -> {}",
        events[0]
    );
    let response = traced(&mut session, "act", one.clone(), &think);
    assert!(refused(&response), "{response}");
    // a follow-up read: within names another result than the referent
    let think = format!("intent: read\nrefer: that \"those\" -> {events_list}");
    let response = traced(&mut session, "answer", json!({"within": list}), &think);
    assert!(refused(&response), "{response}");
    // the referent itself, a row of it, or a row handle, are fine
    let think =
        format!("intent: write\nverb: complete\nscope: one\nrefer: nth \"first\" -> {list}");
    let response = traced(&mut session, "act", one, &think);
    assert_eq!(
        response["effect"]["diff"]["rows"][0]["change"], "updated",
        "{response}"
    );
    session.user("which of them");
    let think = format!("intent: read\nrefer: both \"them\" -> {list}");
    let response = traced(&mut session, "answer", json!({"within": list}), &think);
    assert!(text(&response).starts_with("answered:"), "{response}");
    session.user("and that one");
    let think = format!("intent: read\nrefer: it \"it\" -> {}", events[0]);
    let response = traced(&mut session, "answer", json!({"rows": events[0]}), &think);
    assert!(text(&response).starts_with("answered:"), "{response}");
}

#[test]
fn a_call_without_a_v2_trace_is_untouched() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is there");
    // the old single-line think never matches, whatever it says
    let old = [
        "saw: none · intent: write complete · plan: answer",
        "intent: write star · kind: photo · plan: answer",
        "intent: write complete",
        "",
    ];
    for (i, think) in old.iter().enumerate() {
        let response = session.call_traced(
            "find",
            &json!({"kind": "task", "limit": i + 1}),
            Some(think),
        );
        assert!(text(&response).starts_with('@'), "{think}: {response}");
    }
    // the old line in front of the two calls the guard watches: a write and an answer
    session.user("do it");
    let response = session.call_traced("answer", &json!({"kind": "event"}), Some(old[0]));
    assert!(text(&response).starts_with("answered:"), "{response}");
    session.user("and");
    let response = session.call_traced("answer", &json!({"kind": "event"}), None);
    assert!(text(&response).starts_with("answered:"), "{response}");
    session.user("and");
    // a v2 trace with no slot the call contradicts
    let response = traced(
        &mut session,
        "answer",
        json!({"kind": "person"}),
        "intent: read \"what\"\nscope: one\nrefer: it -> nowhere",
    );
    assert!(text(&response).starts_with("answered:"), "{response}");
}

#[test]
fn the_bulk_write_guard_reads_the_scope_when_there_is_a_trace() {
    let act = |session: &mut Session, list: &str, think: Option<&str>| {
        session.call_traced("act", &json!({"verb": "complete", "rows": list}), think)
    };
    let bulk = |message: &str, think: Option<&str>| {
        let world = seeded_with(&many_tasks(14));
        let mut session = world.session();
        session.user("");
        let (rows, list) = found(&common::call(&mut session, "find", json!({"kind": "task"})));
        assert!(
            rows.len() > 12,
            "more rows than a write may take without all"
        );
        session.user(message);
        act(&mut session, &list, think)
    };
    // no trace: the words of the message decide, as before
    let response = bulk("finish the chores", None);
    assert!(
        text(&response).contains("the message does not say all or every"),
        "{response}"
    );
    let response = bulk("finish all the chores", None);
    assert!(
        response["effect"]["diff"]["rows"].as_array().unwrap().len() > 12,
        "{response}"
    );
    // a trace: its scope decides, the words do not
    let response = bulk(
        "finish the chores",
        Some("intent: write\nverb: complete\nscope: all \"the chores\""),
    );
    assert!(
        response["effect"]["diff"]["rows"].as_array().unwrap().len() > 12,
        "{response}"
    );
    let response = bulk(
        "finish all the chores",
        Some("intent: write\nverb: complete\nscope: some"),
    );
    assert!(
        text(&response).contains("the trace says scope some, not all"),
        "{response}"
    );
    assert!(response["effect"]["diff"].is_null());
    // a trace with no scope line falls back to the words
    let response = bulk("finish the chores", Some("intent: write\nverb: complete"));
    assert!(
        text(&response).contains("the message does not say all or every"),
        "{response}"
    );
    let response = bulk("finish every chore", Some("intent: write\nverb: complete"));
    assert!(
        response["effect"]["diff"]["rows"].as_array().unwrap().len() > 12,
        "{response}"
    );
}

#[test]
fn the_cli_reads_the_trace_from_the_message_and_from_a_think_field() {
    let dir = tempfile::tempdir().unwrap();
    let world = dir.path().join("world.json");
    std::fs::write(&world, common::FIXTURE).unwrap();
    let vault = dir.path().join("vault.db");
    let bin = env!("CARGO_BIN_EXE_nativetools");
    let seeded = Command::new(bin)
        .arg("seed")
        .arg(&world)
        .arg(&vault)
        .output()
        .unwrap();
    assert!(seeded.status.success());
    let call = |think: &str| {
        format!(
            "<think>\n{think}\n</think>\n\n<tool_call>\n<function=act>\n<parameter=verb>\ncomplete\n</parameter>\n<parameter=kind>\ntask\n</parameter>\n<parameter=name>\ncabin\n</parameter>\n</function>\n</tool_call>"
        )
    };
    let requests = [
        json!({"op": "user", "text": "is the cabin booked?"}),
        json!({"op": "call_text", "text": call("intent: read \"is\"")}),
        json!({"op": "call", "tool": "act", "args": {"verb": "complete", "kind": "task", "name": "cabin"}, "think": "intent: decline"}),
        json!({"op": "call_text", "text": call("saw: #9 Book the cabin · intent: write complete · plan: act")}),
    ];
    let mut child = Command::new(bin)
        .arg("session")
        .arg(&vault)
        .args(["--today", "2026-09-27", "--me", "Sam Park"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let stdin = child.stdin.as_mut().unwrap();
        for request in &requests {
            writeln!(stdin, "{request}").unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(refused(&lines[1]), "{}", lines[1]);
    assert!(refused(&lines[2]), "{}", lines[2]);
    // the old line does not match: the write goes through
    assert_eq!(lines[3]["ends_turn"], true, "{}", lines[3]);
    assert_eq!(lines[3]["effect"]["diff"]["rows"][0]["change"], "updated");
}
