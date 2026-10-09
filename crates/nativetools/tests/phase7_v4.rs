//! Phase 7 of #1044, slice M4: the v4 slot trace (`CONTRACT_V3.md` §8) in the compile step.
//!
//! A v4 trace is `"trace": "v4"` among the slots. The model writes fewer of them and `compile` infers the rest
//! and says so (`inferred`): the `kind` a verb fixes, the `scope` and the `refer` a v3.1 trace had to state. A v3.1
//! trace (no `trace` slot) compiles as before.

mod common;

use centraid_nativetools::Session;
use centraid_nativetools::compile::{PICK_REASONS, SINGLE_ROW_VERBS};
use centraid_nativetools::meta::{Kind, VERBS};
use centraid_nativetools::think::{self, TraceMode};
use common::{number, seeded};
use serde_json::{Value, json};

/// A session that has seen `message`.
fn session_for(message: &str) -> Session {
    let world = seeded();
    let mut session = world.session();
    session.user(message);
    session
}

fn stated(compiled: &Value) -> Value {
    assert!(compiled.get("refused").is_none(), "{compiled}");
    compiled["stated"].clone()
}

fn inferred(compiled: &Value) -> Vec<String> {
    compiled["inferred"]
        .as_array()
        .unwrap_or_else(|| panic!("a v4 reply has `inferred`: {compiled}"))
        .iter()
        .map(|item| item.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn a_v4_pick_is_one_row_with_its_reason_and_states_the_rows() {
    let world = seeded();
    let mut session = world.session();
    let rent = number(&mut session, "task", "Pay rent");
    session.user("tick off the rent");
    let v31 = session.compile(&json!({
        "intent": "write", "verb": "complete",
        "pick": [{"row": rent, "verdict": "ok"}]
    }));
    let v4 = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "complete",
        "pick": [{"row": rent, "verdict": "ok", "reason": "name"}]
    }));
    assert_eq!(stated(&v4), stated(&v31), "{v4}");
    assert_eq!(stated(&v4)["args"]["rows"], json!([rent]));
    assert_eq!(inferred(&v4), ["scope: one"], "{v4}");
    assert!(
        v31.get("inferred").is_none(),
        "a v3.1 reply has no `inferred`: {v31}"
    );
}

#[test]
fn a_v4_pick_states_the_rows_beside_another_handle_slot_a_v3_pick_does_not() {
    let world = seeded();
    let mut session = world.session();
    let rent = number(&mut session, "task", "Pay rent");
    session.user("tick off the rent");
    let slots = |trace: Option<&str>| {
        let mut slots = json!({
            "intent": "write", "verb": "complete", "within": "@1",
            "pick": [{"row": rent, "verdict": "ok"}]
        });
        if let Some(trace) = trace {
            slots["trace"] = json!(trace);
        }
        slots
    };
    let v31 = session.compile(&slots(None));
    assert!(stated(&v31)["args"].get("rows").is_none(), "{v31}");
    let v4 = session.compile(&slots(Some("v4")));
    assert_eq!(stated(&v4)["args"]["rows"], json!([rent]), "{v4}");
    assert_eq!(stated(&v4)["args"]["within"], json!("@1"), "{v4}");
}

#[test]
fn an_act_that_names_a_row_and_no_kind_takes_the_kind_of_its_verb() {
    let session = &mut session_for("tick off pay rent");
    let slots = json!({"trace": "v4", "intent": "write", "verb": "complete", "name": "Pay rent"});
    let v4 = session.compile(&slots);
    assert_eq!(
        stated(&v4),
        json!({"tool": "act", "args": {"verb": "complete", "kind": "task", "name": "Pay rent"}}),
        "{v4}"
    );
    assert_eq!(
        inferred(&v4),
        ["kind: task", "scope: all"],
        "a selector stands for all but under a single-row verb: {v4}"
    );
    // a verb that fits several kinds infers none, a kind that is said stays, a v3.1 trace infers none
    for (slots, kind) in [
        (
            json!({"trace": "v4", "intent": "write", "verb": "delete", "name": "Pay rent"}),
            None,
        ),
        (
            json!({"trace": "v4", "intent": "write", "verb": "complete", "kind": "task", "name": "Pay rent"}),
            Some("task"),
        ),
        (
            json!({"intent": "write", "verb": "complete", "name": "Pay rent"}),
            None,
        ),
    ] {
        let compiled = session.compile(&slots);
        assert_eq!(
            stated(&compiled)["args"]
                .get("kind")
                .and_then(Value::as_str),
            kind,
            "{slots}: {compiled}"
        );
    }
    // another handle slot (here `within`, which carries its own kind) leaves the kind alone
    let world = seeded();
    let mut session = world.session();
    number(&mut session, "task", "Pay rent");
    session.user("tick off pay rent");
    let within = session.compile(&json!({"trace": "v4", "intent": "write", "verb": "complete", "name": "Pay rent", "within": "@1"}));
    assert!(stated(&within)["args"].get("kind").is_none(), "{within}");
    // a read is not an act: the `name` of a lookup keeps no kind of its own
    let read = session.compile(&json!({"trace": "v4", "intent": "read", "name": "Pay rent"}));
    assert!(stated(&read)["args"].get("kind").is_none(), "{read}");
}

#[test]
fn a_where_that_needs_the_kind_reads_the_inferred_one() {
    let session = &mut session_for("complete the open one called pay rent");
    let compiled = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "complete", "name": "Pay rent",
        "where": [{"field": "status", "op": "=", "value": "open"}]
    }));
    assert_eq!(
        stated(&compiled)["args"]["where"],
        json!("status = \"open\""),
        "{compiled}"
    );
}

#[test]
fn scope_and_refer_are_inferred_from_the_rows_and_the_reason() {
    let world = seeded();
    let mut session = world.session();
    let rent = number(&mut session, "task", "Pay rent");
    session.user("and delete it");
    let focus = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "delete",
        "pick": [{"row": rent, "verdict": "ok", "reason": "focus"}]
    }));
    assert_eq!(
        inferred(&focus),
        ["scope: one", format!("refer: it -> {rent}").as_str()],
        "{focus}"
    );
    // a pick of a row the message names is no refer
    let named = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "delete",
        "pick": [{"row": rent, "verdict": "ok", "reason": "name"}]
    }));
    assert_eq!(inferred(&named), ["scope: one"], "{named}");
    // a result handle is a refer, and several rows are `all` (`@1` is the one row `number` found)
    session.call("find", &json!({"kind": "task"}));
    let result =
        session.compile(&json!({"trace": "v4", "intent": "write", "verb": "delete", "rows": "@2"}));
    let got = inferred(&result);
    assert_eq!(got[0], "scope: all", "{result}");
    assert_eq!(got[1], "refer: that -> @2", "{result}");
    // a create names no existing row: neither is inferred; a read has no scope
    let create = session.compile(&json!({
        "trace": "v4", "intent": "write", "verb": "create", "kind": "task",
        "set": [{"key": "name", "value": "Water the plants"}]
    }));
    assert!(inferred(&create).is_empty(), "{create}");
    let read = session.compile(&json!({"trace": "v4", "intent": "read", "kind": "task"}));
    assert!(inferred(&read).is_empty(), "{read}");
    // a selector under a verb that acts on one row is one
    let log =
        session.compile(&json!({"trace": "v4", "intent": "write", "verb": "log", "name": "Ray"}));
    assert_eq!(inferred(&log), ["kind: person", "scope: one"], "{log}");
}

#[test]
fn a_v4_trace_that_does_not_compile_is_refused_with_its_slot() {
    let world = seeded();
    let mut session = world.session();
    let rent = number(&mut session, "task", "Pay rent");
    session.user("tick off the rent");
    for (slots, slot) in [
        // both a pick and a rows slot name the rows
        (
            json!({"trace": "v4", "intent": "write", "verb": "complete", "rows": rent,
                   "pick": [{"row": rent, "verdict": "ok", "reason": "name"}]}),
            "pick",
        ),
        // a reason is one of the closed words
        (
            json!({"trace": "v4", "intent": "write", "verb": "complete",
                   "pick": [{"row": rent, "verdict": "ok", "reason": "position"}]}),
            "pick[0]",
        ),
        // a pick outside the block is refused as in v3.1
        (
            json!({"trace": "v4", "intent": "write", "verb": "complete",
                   "pick": [{"row": "#999", "verdict": "ok", "reason": "name"}]}),
            "pick[0]",
        ),
        (json!({"trace": "v5", "intent": "read"}), "trace"),
    ] {
        let compiled = session.compile(&slots);
        assert_eq!(compiled["refused"]["slot"], slot, "{slots}: {compiled}");
    }
}

#[test]
fn the_closed_words_and_the_kind_of_a_verb_are_the_runtimes() {
    // the one kind a verb applies to is exactly the verbs of the table with one kind: a v4 think that names a row by `name`
    // alone takes it (`think.rs`, `compile.rs` `kind_a_verb_fixes`)
    let mut taken: Vec<(String, String)> = Vec::new();
    for spec in VERBS {
        let think = format!("intent: write\nverb: {}\nname: x", spec.name);
        let Ok(call) = think::compile_think(&think, None, TraceMode::V4) else {
            panic!("{think} compiles");
        };
        if let Some((_, kind)) = call.args.iter().find(|(key, _)| key == "kind") {
            taken.push((spec.name.to_owned(), kind.clone()));
        }
    }
    let mut table: Vec<(String, String)> = VERBS
        .iter()
        .filter_map(|spec| match spec.commands {
            [(kind, _)] => Some((spec.name.to_owned(), kind.name().to_owned())),
            _ => None,
        })
        .collect();
    taken.sort();
    table.sort();
    assert_eq!(taken, table);
    assert!(!taken.is_empty());
    for (_, kind) in &taken {
        assert!(Kind::parse(kind).is_some(), "{kind}");
    }
    // the reasons of a pick: the runtime's list is the one a v4 think may write, and no other word is
    assert_eq!(
        PICK_REASONS,
        ["name", "kind", "date", "focus", "created", "asked", "nick"]
    );
    for reason in PICK_REASONS {
        let think = format!("intent: write\nverb: star\npick: #5 ({reason})");
        assert!(
            think::compile_think(&think, None, TraceMode::V4).is_ok(),
            "{think}"
        );
    }
    let think = "intent: write\nverb: star\npick: #5 (position)";
    assert!(think::compile_think(think, None, TraceMode::V4).is_err());
    // the verbs a selector stands for one row under
    assert_eq!(
        SINGLE_ROW_VERBS,
        [
            "edit",
            "reschedule",
            "log",
            "reveal",
            "settle_up",
            "settle_debt"
        ]
    );
}
