//! Phase 5 of #1044: conventions as code, the error table, and the compile step.
//!
//! - container readouts select the active rows, and the habit defaults (`next`, `last one`,
//!   `biggest`, the status words) fill only a slot the call leaves out (`ground.rs`);
//! - `errors.json` lists every error family the sources hold, each with an example call that
//!   produces it on the fixture world (`export.rs`);
//! - `compile` turns the slots of a v3 trace into the call the runtime executes (`compile.rs`).

mod common;

use std::io::Write as _;
use std::process::{Command, Stdio};

use centraid_nativetools::export::{self, ExampleCall};
use centraid_nativetools::ground::{ACTIVE_NOTE, Defaults};
use centraid_nativetools::{Flags, Session, parse, trace};
use common::{World, call, ids, number, seeded, seeded_with};
use serde_json::{Value, json};

const BIN: &str = env!("CARGO_BIN_EXE_nativetools");

/// The fixture plus a Home list with every status, and a parent task with every status below it.
/// Home: `cabin` (open), `sink` (in progress), `plants` (open), `chore_done` (completed), `idea`
/// (cancelled). Report: `outline` (open), `part_done` (completed), `part_off` (cancelled).
fn home_world() -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    let tasks = world["tasks"].as_array_mut().unwrap();
    tasks.push(json!({"key": "sink", "name": "Wipe the sink", "status": "in_progress", "list": "home", "effort": 15}));
    tasks.push(json!({"key": "plants", "name": "Water the plants", "list": "home", "effort": 10}));
    tasks.push(
        json!({"key": "chore_done", "name": "Done chore", "status": "completed", "list": "home"}),
    );
    tasks.push(json!({"key": "idea", "name": "Old idea", "status": "cancelled", "list": "home"}));
    tasks.push(json!({"key": "part_done", "name": "Report part done", "status": "completed", "parent": "report"}));
    tasks.push(json!({"key": "part_off", "name": "Report part off", "status": "cancelled", "parent": "report"}));
    seeded_with(&world)
}

fn sorted(world: &World, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = keys.iter().map(|key| world.id(key)).collect();
    out.sort();
    out
}

fn rows_of(response: &Value) -> Vec<String> {
    let mut out = ids(&response["effect"]["rows"]);
    if out.is_empty() {
        out = ids(&response["effect"]["answer"]["rows"]);
    }
    out.sort();
    out
}

fn said(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

/// A session over `world` where the model's message is `message`; the handle of `kind name`.
fn ask(world: &World, kind: &str, name: &str, message: &str) -> (Session, String) {
    let mut session = world.session();
    let handle = number(&mut session, kind, name);
    session.user(message);
    (session, handle)
}

// ---------------------------------------------------------------------------------------------
// 1. container readouts

#[test]
fn a_readout_of_a_list_selects_the_active_rows_and_says_so() {
    let world = home_world();
    let (mut session, home) = ask(&world, "list", "Home", "what's on the home list");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "linked_to": home}),
    );
    assert_eq!(
        rows_of(&reply),
        sorted(&world, &["cabin", "sink", "plants"]),
        "{reply}"
    );
    assert!(said(&reply).contains(ACTIVE_NOTE), "{reply}");
    assert_eq!(
        ACTIVE_NOTE,
        "(active rows; add status = completed or all for the rest)"
    );
    // a find reads the same rows
    session.user("what's on the home list");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "linked_to": home}),
    );
    assert_eq!(
        rows_of(&found),
        sorted(&world, &["cabin", "sink", "plants"])
    );
}

#[test]
fn an_explicit_status_condition_is_honoured_as_written() {
    let world = home_world();
    let (mut session, home) = ask(&world, "list", "Home", "what's on the home list");
    for (clause, keys) in [
        ("status = completed", vec!["chore_done"]),
        ("status = cancelled", vec!["idea"]),
        ("status = open", vec!["cabin", "sink", "plants"]),
        (
            "status in (\"completed\", \"cancelled\")",
            vec!["chore_done", "idea"],
        ),
    ] {
        session.user("what's on the home list");
        let reply = call(
            &mut session,
            "answer",
            json!({"kind": "task", "linked_to": home, "where": clause}),
        );
        assert_eq!(rows_of(&reply), sorted(&world, &keys), "{clause}: {reply}");
        assert!(!said(&reply).contains(ACTIVE_NOTE), "{clause}: {reply}");
    }
}

#[test]
fn all_everything_or_done_in_the_message_takes_every_row() {
    let world = home_world();
    let every = sorted(&world, &["cabin", "sink", "plants", "chore_done", "idea"]);
    for message in [
        "show me all of the home list",
        "everything on the home list",
        "what's done on the home list",
    ] {
        let (mut session, home) = ask(&world, "list", "Home", message);
        let reply = call(
            &mut session,
            "answer",
            json!({"kind": "task", "linked_to": home}),
        );
        assert_eq!(rows_of(&reply), every, "{message}: {reply}");
        assert!(!said(&reply).contains(ACTIVE_NOTE), "{message}: {reply}");
    }
}

#[test]
fn counts_and_sums_over_a_container_take_the_active_rows() {
    let world = home_world();
    let (mut session, home) = ask(&world, "list", "Home", "how many are on the home list");
    let count = call(
        &mut session,
        "answer",
        json!({"kind": "task", "linked_to": home, "op": "count"}),
    );
    assert_eq!(
        count["effect"]["value"]["values"][0]["amount"],
        json!(3),
        "{count}"
    );
    assert!(said(&count).contains(ACTIVE_NOTE), "{count}");
    session.user("how long is the home list");
    let sum = call(
        &mut session,
        "compute",
        json!({"kind": "task", "linked_to": home, "op": "sum", "field": "effort"}),
    );
    assert!(said(&sum).contains("55"), "{sum}");
    assert!(said(&sum).contains(ACTIVE_NOTE), "{sum}");
    // "all": every row, 5 of them
    session.user("how many tasks are there in all on the home list");
    let all = call(
        &mut session,
        "answer",
        json!({"kind": "task", "linked_to": home, "op": "count"}),
    );
    assert_eq!(
        all["effect"]["value"]["values"][0]["amount"],
        json!(5),
        "{all}"
    );
}

#[test]
fn a_parent_task_is_a_container_and_a_person_is_not() {
    let world = home_world();
    let (mut session, report) = ask(
        &world,
        "task",
        "Write report",
        "what are the parts of the report",
    );
    let parts = call(
        &mut session,
        "answer",
        json!({"kind": "task", "linked_to": report}),
    );
    assert_eq!(rows_of(&parts), sorted(&world, &["outline"]), "{parts}");
    assert!(said(&parts).contains(ACTIVE_NOTE), "{parts}");
    // a person is not a container: the call is read as written
    let mut session = world.session();
    let benedikt = number(&mut session, "person", "Benedikt");
    session.user("what do i owe benedikt");
    let linked = call(
        &mut session,
        "answer",
        json!({"kind": "task", "linked_to": benedikt}),
    );
    assert_eq!(rows_of(&linked), sorted(&world, &["reed"]), "{linked}");
    assert!(!said(&linked).contains(ACTIVE_NOTE), "{linked}");
}

#[test]
fn the_container_default_can_be_switched_off() {
    let world = home_world();
    let flags = Flags {
        defaults: Defaults {
            active: false,
            ..Defaults::default()
        },
        ..Flags::default()
    };
    let mut session = world.session_with(common::TODAY, flags);
    let home = number(&mut session, "list", "Home");
    session.user("what's on the home list");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "linked_to": home}),
    );
    assert_eq!(rows_of(&reply).len(), 5, "{reply}");
}

// ---------------------------------------------------------------------------------------------
// 2. habit defaults

fn events_with_a_past() -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    let events = world["events"].as_array_mut().unwrap();
    for (key, start) in [
        ("old1", "2026-09-10T09:00"),
        ("old2", "2026-09-20T09:00"),
        ("fut", "2026-10-04T09:00"),
    ] {
        events.push(json!({"key": key, "name": "Standup", "start": start}));
    }
    seeded_with(&world)
}

fn answer_in_turn(world: &World, message: &str, args: Value) -> Value {
    let mut session = world.session();
    session.user(message);
    call(&mut session, "answer", args)
}

#[test]
fn next_is_the_nearest_upcoming_one_when_the_call_states_no_order_or_limit() {
    let world = events_with_a_past();
    let reply = answer_in_turn(
        &world,
        "when's the next standup",
        json!({"kind": "event", "name": "Standup"}),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["fut"]), "{reply}");
    assert!(said(&reply).contains("next:"), "{reply}");
    // the model's own order or limit stands
    let own = answer_in_turn(
        &world,
        "when's the next standup",
        json!({"kind": "event", "name": "Standup", "order": "date asc", "limit": 2,
               "when": {"from": {"unit": "day", "rel": 0}}}),
    );
    assert_eq!(
        own["effect"]["answer"]["rows"].as_array().unwrap().len(),
        1,
        "{own}"
    );
    let own = answer_in_turn(
        &world,
        "when's the next standup",
        json!({"kind": "event", "name": "Standup", "limit": 2}),
    );
    assert_eq!(rows_of(&own).len(), 2, "{own}");
    assert!(!said(&own).contains("next:"), "{own}");
    // "next" in front of a date unit, a weekday or a count is not "the nearest one"
    for message in [
        "what's on next week",
        "standups next friday",
        "the next 3 standups",
        "the next three standups",
        "what is on this week or next",
        "the friday after next",
    ] {
        let reply = answer_in_turn(&world, message, json!({"kind": "event", "name": "Standup"}));
        assert_eq!(rows_of(&reply).len(), 3, "{message}: {reply}");
        assert!(!said(&reply).contains("next:"), "{message}: {reply}");
    }
    // off by the switch
    let flags = Flags {
        defaults: Defaults {
            next: false,
            ..Defaults::default()
        },
        ..Flags::default()
    };
    let mut session = world.session_with(common::TODAY, flags);
    session.user("when's the next standup");
    let off = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Standup"}),
    );
    assert_eq!(rows_of(&off).len(), 3, "{off}");
}

#[test]
fn the_last_one_is_the_latest_past_one() {
    let world = events_with_a_past();
    let reply = answer_in_turn(
        &world,
        "when was the last one",
        json!({"kind": "event", "name": "Standup"}),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["old2"]), "{reply}");
    // the model wrote the order and the limit, and an open span from today on: that is the
    // mistake, and it is read up to today
    let reply = answer_in_turn(
        &world,
        "when was the last one",
        json!({"kind": "event", "name": "Standup", "order": "date desc", "limit": 1,
               "when": {"from": {"unit": "day", "rel": 0}}}),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["old2"]), "{reply}");
    // a span of its own stays
    let reply = answer_in_turn(
        &world,
        "when was the last one",
        json!({"kind": "event", "name": "Standup", "order": "date desc", "limit": 1,
               "when": {"to": {"date": "2026-09-15"}}}),
    );
    assert_eq!(rows_of(&reply), sorted(&world, &["old1"]), "{reply}");
}

#[test]
fn biggest_with_a_number_field_is_a_value() {
    // off by default (the train references read "biggest" as rows); on when the switch is set
    let world = seeded();
    let args = json!({"kind": "debt", "order": "amount desc", "limit": 1});
    let off = answer_in_turn(&world, "which is the biggest", args.clone());
    assert!(off["effect"]["value"].is_null(), "{off}");
    let on = || Flags {
        defaults: Defaults {
            biggest: true,
            ..Defaults::default()
        },
        ..Flags::default()
    };
    let mut session = world.session_with(common::TODAY, on());
    session.user("which is the biggest");
    let reply = call(&mut session, "answer", args.clone());
    assert_eq!(reply["effect"]["value"]["op"], "max", "{reply}");
    assert!(said(&reply).contains("25.50"), "{reply}");
    // "most" is not named even with the switch on
    let mut session = world.session_with(common::TODAY, on());
    session.user("which is the most");
    let reply = call(&mut session, "answer", args);
    assert!(reply["effect"]["value"].is_null(), "{reply}");
}

#[test]
fn the_status_words_of_a_readout_are_status_open() {
    let world = home_world();
    // a readout of what is left: the completed task is out
    let reply = answer_in_turn(&world, "what is left to do", json!({"kind": "task"}));
    let rows = rows_of(&reply);
    assert!(!rows.contains(&world.id("report")), "{reply}");
    assert!(rows.contains(&world.id("pay")), "{reply}");
    assert!(said(&reply).contains("status:"), "{reply}");
    // an explicit status condition stands
    let reply = answer_in_turn(
        &world,
        "what is left to do",
        json!({"kind": "task", "where": "status = completed"}),
    );
    assert!(rows_of(&reply).contains(&world.id("report")), "{reply}");
    // "all" and a status word of its own are honoured
    let reply = answer_in_turn(&world, "all that is left and done", json!({"kind": "task"}));
    assert!(rows_of(&reply).contains(&world.id("report")), "{reply}");
    // a find is also how a write looks a row up ("open them again"): left as written
    let mut session = world.session();
    session.user("open them again");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Write report"}),
    );
    assert_eq!(rows_of(&found), sorted(&world, &["report"]), "{found}");
    // a count
    let mut session = world.session();
    session.user("how many are still open");
    let count = call(
        &mut session,
        "answer",
        json!({"kind": "task", "op": "count"}),
    );
    let open = rows_of(&call(
        &mut world.session(),
        "find",
        json!({"kind": "task", "where": "status = open"}),
    ))
    .len();
    assert_eq!(
        count["effect"]["value"]["values"][0]["amount"],
        json!(open),
        "{count}"
    );
}

// ---------------------------------------------------------------------------------------------
// 3. the error table

/// Run an example on a fresh fixture world; the text of its last call.
fn run_example(calls: &[ExampleCall]) -> String {
    let world = seeded();
    // the table documents what each family says when it is said: the asks and declines the
    // runtime composes (`Flags::compose`) are not said to the model, so they run uncomposed
    let mut session = world.session_uncomposed();
    let mut last = String::new();
    for (index, example) in calls.iter().enumerate() {
        if index == 0 || example.user.is_some() {
            session.user(example.user.as_deref().unwrap_or(""));
        }
        let response = if example.tool == "call_text" {
            let text = example.args["text"].as_str().expect("the raw message");
            match parse::parse_call(text) {
                Ok(parsed) => {
                    let tool = parsed["tool"].as_str().unwrap_or_default().to_owned();
                    session.call_traced(&tool, &parsed["args"], trace::think_of(text))
                }
                Err(message) => session.call_unreadable(&message),
            }
        } else {
            session.call_traced(&example.tool, &example.args, example.think.as_deref())
        };
        last = said(&response).to_owned();
    }
    last
}

#[test]
fn every_error_family_has_an_example_that_produces_it_or_says_why_not() {
    let families = export::error_families();
    assert!(families.len() >= 130, "{} families", families.len());
    let mut with_example = 0;
    for family in &families {
        match &family.example {
            Some(calls) => {
                let text = run_example(calls);
                assert!(
                    family.matches(&text),
                    "{}: {}\n  example answered: {text}",
                    family.id,
                    family.template
                );
                with_example += 1;
            }
            None => assert!(
                family.why_none.len() > 20 && !family.why_none.starts_with("no example written"),
                "{} has neither an example nor a reason: {}",
                family.id,
                family.template
            ),
        }
    }
    assert!(with_example >= 125, "{with_example} examples");
}

#[test]
fn the_families_the_data_is_built_from_are_all_there() {
    let families = export::error_families();
    let has = |id: &str| families.iter().any(|family| family.id == id);
    for id in [
        // schema
        "session.tool_has_no_parameter_key_tool",
        "whr.x_have_no_field_field_x",
        "session.no_kind_part_kinds_x",
        "act.no_verb_verb_text_verbs_x",
        // cardinality
        "values.balance_needs_one_x_the_selection",
        "values.balance_is_for_one_x_the",
        "act.act_needs_rows_n_or_a",
        // applicability
        "act.x_does_not_apply_to_x",
        "act.nothing_to_undo",
        "act.name_state",
        // vault refusals
        "act.x_name_said",
        "act.restore_name_it_is_in_the",
        // the trace guard and the repeat policy
        "trace.the_trace_contradicts_the_call_why",
        "session.repeated_call_again_do_not_send",
        "session.repeated_call_you_already_made_this",
        "session.repeated_call_at_step_x_step",
    ] {
        assert!(has(id), "no family {id}");
    }
    let kinds: std::collections::BTreeSet<&str> =
        families.iter().map(|family| family.family).collect();
    for kind in [
        "schema",
        "cardinality",
        "applicability",
        "vault",
        "trace",
        "repeat",
    ] {
        assert!(kinds.contains(kind), "no {kind} family");
    }
    // ids are unique and stable in form
    let mut seen = std::collections::BTreeSet::new();
    for family in &families {
        assert!(seen.insert(family.id.clone()), "{} twice", family.id);
        assert!(family.template.contains(": "), "{}", family.template);
    }
}

#[test]
fn export_writes_errors_json() {
    let dir = tempfile::tempdir().unwrap();
    export::export(dir.path()).unwrap();
    let text = std::fs::read_to_string(dir.path().join("errors.json")).unwrap();
    let table: Value = serde_json::from_str(&text).unwrap();
    let families = table["families"].as_array().unwrap();
    assert_eq!(families.len(), export::error_families().len());
    for family in families {
        for key in [
            "id",
            "family",
            "template",
            "tool",
            "argument",
            "example",
            "why_no_example",
        ] {
            assert!(family.get(key).is_some(), "{key} in {family}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// 4. the compile step

/// Compare two calls: the tool, and the arguments with a JSON text read as JSON.
fn normal(call: &Value) -> Value {
    let mut args = call["args"].as_object().cloned().unwrap_or_default();
    for value in args.values_mut() {
        if let Value::String(text) = value
            && text.starts_with('{')
            && let Ok(parsed) = serde_json::from_str::<Value>(text)
        {
            *value = parsed;
        }
    }
    json!({"tool": call["tool"], "args": Value::Object(args)})
}

/// Compile `slots` in a session that has seen `message`; the reference call must be what the
/// slots state, and running either on a fresh world must read the same.
fn compiles_to(setup: impl Fn(&mut Session) -> (String, Value, Value)) {
    let world = seeded();
    let mut session = world.session();
    let (message, slots, expected) = setup(&mut session);
    session.user(&message);
    let compiled = session.compile(&slots);
    assert!(compiled.get("refused").is_none(), "{slots}: {compiled}");
    assert_eq!(
        normal(&compiled["stated"]),
        normal(&expected),
        "stated: {slots}\n{compiled}"
    );
    // the call the runtime executes is the stated one after its grounding: the same effect
    let other = seeded();
    let mut reference = other.session();
    let (_, _, _) = setup(&mut reference);
    reference.user(&message);
    let by_reference = reference.call(expected["tool"].as_str().unwrap(), &expected["args"]);
    let executed = &compiled["call"];
    let by_compile = session.call(executed["tool"].as_str().unwrap(), &executed["args"]);
    assert_eq!(
        by_compile["text"], by_reference["text"],
        "{slots}: compiled {executed}"
    );
}

#[test]
fn ten_slot_sets_compile_to_the_calls_the_reference_run_makes() {
    // 1. a read with a date
    compiles_to(|_| {
        (
            "what's on next week".into(),
            json!({"intent": "read", "kind": "event", "when": {"unit": "week", "rel": 1}}),
            json!({"tool": "answer", "args": {"kind": "event", "when": {"unit": "week", "rel": 1}}}),
        )
    });
    // 2. a count with a typed where
    compiles_to(|_| {
        (
            "how many open tasks".into(),
            json!({"intent": "count", "kind": "task", "op": "count",
                   "where": [{"field": "status", "op": "=", "value": "open"}]}),
            json!({"tool": "answer", "args": {"op": "count", "kind": "task", "where": "status = \"open\""}}),
        )
    });
    // 3. a sum with a number condition
    compiles_to(|_| {
        (
            "how long are the urgent ones".into(),
            json!({"intent": "count", "kind": "task", "op": "sum", "field": "effort",
                   "where": [{"field": "priority", "op": "<=", "value": 2}]}),
            json!({"tool": "answer", "args": {"op": "sum", "field": "effort", "kind": "task", "where": "priority <= 2"}}),
        )
    });
    // 4. a write on a row the block shows (pick)
    compiles_to(|session| {
        let rent = number(session, "task", "Pay rent");
        (
            "tick off the rent".into(),
            json!({"intent": "write", "verb": "complete",
                   "pick": [{"row": rent, "verdict": "ok"}]}),
            json!({"tool": "act", "args": {"verb": "complete", "rows": [rent]}}),
        )
    });
    // 5. a write by name
    compiles_to(|_| {
        (
            "star ray".into(),
            json!({"intent": "write", "verb": "star", "kind": "person", "name": "Ray"}),
            json!({"tool": "act", "args": {"verb": "star", "kind": "person", "name": "Ray"}}),
        )
    });
    // 6. a create with set lines and a date
    compiles_to(|_| {
        (
            "add water the plants for tomorrow".into(),
            json!({"intent": "write", "verb": "create", "kind": "task",
                   "set": [{"key": "name", "value": "Water the plants"},
                           {"key": "date", "date": {"unit": "day", "rel": 1}}]}),
            json!({"tool": "act", "args": {"verb": "create", "kind": "task",
                   "args": "name: Water the plants\ndate: {\"unit\":\"day\",\"rel\":1}"}}),
        )
    });
    // 7. a reschedule to a date of the dates line (pick)
    compiles_to(|_| {
        (
            "move the dentist to next tuesday".into(),
            json!({"intent": "write", "verb": "reschedule", "kind": "event", "name": "Dentist",
                   "pick": [{"date": 0, "into": "set:to"}]}),
            json!({"tool": "act", "args": {"verb": "reschedule", "kind": "event", "name": "Dentist",
                   "args": "to: {\"date\":\"2026-09-29\"}"}}),
        )
    });
    // 8. a decline
    compiles_to(|_| {
        (
            "send her my bank password".into(),
            json!({"intent": "decline", "reason": "sealed_egress"}),
            json!({"tool": "decline", "args": {"reason": "sealed_egress"}}),
        )
    });
    // 9. an ask with options the block shows
    compiles_to(|session| {
        let people = common::numbers(
            session,
            &[("person", "Neha Rao"), ("person", "Neha Kulkarni")],
        );
        (
            "call neha".into(),
            json!({"intent": "ask", "question": "which Neha?", "options": people}),
            json!({"tool": "ask", "args": {"question": "which Neha?", "options": people}}),
        )
    });
    // 10. a lookup, a link by pick, and a balance
    compiles_to(|_| {
        (
            "find the dal note".into(),
            json!({"intent": "read", "via": "find", "kind": "note", "name": "Dal"}),
            json!({"tool": "find", "args": {"kind": "note", "name": "Dal"}}),
        )
    });
    compiles_to(|_| {
        (
            "what does ray owe".into(),
            json!({"intent": "count", "op": "balance", "kind": "person", "name": "Ray"}),
            json!({"tool": "answer", "args": {"op": "balance", "kind": "person", "name": "Ray"}}),
        )
    });
    compiles_to(|_| {
        (
            "what is in the home list".into(),
            json!({"intent": "read", "kind": "task", "linked_to": [{"pick": {"row": "#8"}}],
                   "where": [{"field": "effort", "op": "<=", "value": 60}]}),
            json!({"tool": "answer", "args": {"kind": "task", "linked_to": ["#8"], "where": "effort <= 60"}}),
        )
    });
}

#[test]
fn the_conventions_apply_to_a_compiled_call() {
    let world = home_world();
    let mut session = world.session();
    session.user("");
    let home = number(&mut session, "list", "Home");
    session.user("what's on the home list");
    let compiled = session.compile(&json!({"intent": "read", "kind": "task", "linked_to": [home]}));
    let args = &compiled["call"]["args"];
    assert_eq!(
        args["where"], "status != completed and status != cancelled",
        "{compiled}"
    );
    assert!(
        compiled["notes"].to_string().contains(ACTIVE_NOTE),
        "{compiled}"
    );
    // the stated call is the model's, without them
    assert!(
        compiled["stated"]["args"].get("where").is_none(),
        "{compiled}"
    );
    // and it runs as the same rows
    let ran = session.call("answer", args);
    assert_eq!(
        rows_of(&ran),
        sorted(&world, &["cabin", "sink", "plants"]),
        "{ran}"
    );
}

fn refused(world: &World, setup_message: &str, slots: Value) -> Value {
    let mut session = world.session();
    session.user(setup_message);
    session.compile(&slots)["refused"].clone()
}

#[test]
fn a_slot_that_does_not_compile_is_refused_with_its_name() {
    let world = seeded();
    // a pick outside the block
    let why = refused(
        &world,
        "tick off the rent",
        json!({"intent": "write", "verb": "complete", "pick": [{"row": "#999", "verdict": "ok"}]}),
    );
    assert_eq!(why["slot"], "pick[0]", "{why}");
    // the second entry is the one named
    let why = refused(
        &world,
        "tick off the rent",
        json!({"intent": "write", "verb": "complete",
               "pick": [{"row": "#8", "verdict": "no"}, {"row": "#40", "verdict": "ok"}]}),
    );
    assert_eq!(why["slot"], "pick[1]", "{why}");
    assert!(
        why["why"].as_str().unwrap().contains("not in the block"),
        "{why}"
    );
    // a handle slot
    let why = refused(
        &world,
        "",
        json!({"intent": "read", "kind": "task", "linked_to": ["#8", "#77"]}),
    );
    assert_eq!(why["slot"], "linked_to[1]", "{why}");
    // a result that was never issued
    let why = refused(
        &world,
        "",
        json!({"intent": "read", "kind": "task", "within": "@4"}),
    );
    assert_eq!(why["slot"], "within", "{why}");
    // where is typed, never text
    let why = refused(
        &world,
        "",
        json!({"intent": "read", "kind": "task", "where": "status = open"}),
    );
    assert_eq!(why["slot"], "where", "{why}");
    // a field the kind does not have
    let why = refused(
        &world,
        "",
        json!({"intent": "read", "kind": "task",
               "where": [{"field": "status", "op": "=", "value": "open"}, {"field": "colour", "op": "=", "value": "red"}]}),
    );
    assert_eq!(why["slot"], "where[1]", "{why}");
    // a dates-line entry that is not there, and one with two readings
    let why = refused(
        &world,
        "move the dentist to next tuesday",
        json!({"intent": "write", "verb": "reschedule", "kind": "event", "name": "Dentist",
               "pick": [{"date": 3, "into": "set:to"}]}),
    );
    assert_eq!(why["slot"], "pick[0]", "{why}");
    let why = refused(
        &world,
        "what was on the third of may",
        json!({"intent": "read", "kind": "event", "when": {"pick": {"date": 0}}}),
    );
    assert_eq!(why["slot"], "when", "{why}");
    assert!(
        why["why"].as_str().unwrap().contains("two readings"),
        "{why}"
    );
    // a focus row that is not on the focus line
    let why = refused(
        &world,
        "",
        json!({"intent": "write", "verb": "complete", "pick": [{"focus": 0}]}),
    );
    assert_eq!(why["slot"], "pick[0]", "{why}");
    // the closed words
    for (slots, slot) in [
        (json!({"intent": "tell"}), "intent"),
        (json!({"intent": "write"}), "verb"),
        (json!({"intent": "write", "verb": "frobnicate"}), "verb"),
        (json!({"intent": "read", "via": "search2"}), "via"),
        (json!({"intent": "read", "bogus": 1}), "bogus"),
        (
            json!({"intent": "read", "kind": "task", "limit": 0}),
            "limit",
        ),
        (
            json!({"intent": "read", "kind": "task", "when": {"foo": 1}}),
            "when",
        ),
        (json!({"kind": "task"}), "intent"),
    ] {
        let why = refused(&world, "", slots.clone());
        assert_eq!(why["slot"], slot, "{slots}: {why}");
    }
}

#[test]
fn a_pick_resolves_to_the_row_id_and_the_resolved_date() {
    let world = seeded();
    let mut session = world.session();
    let rent = number(&mut session, "task", "Pay rent");
    session.user("move the rent to next tuesday");
    let compiled = session.compile(&json!({
        "intent": "write", "verb": "reschedule",
        "pick": [{"row": rent, "verdict": "ok"}, {"date": 0, "into": "set:to"}]
    }));
    assert!(compiled.get("refused").is_none(), "{compiled}");
    let picks = compiled["resolved"]["picks"].as_array().unwrap();
    assert_eq!(picks[0]["id"], world.id("pay"), "{compiled}");
    assert_eq!(picks[0]["handle"], json!(rent));
    let dates = compiled["resolved"]["dates"].as_array().unwrap();
    assert_eq!(
        dates[0]["expr"],
        json!({"date": "2026-09-29"}),
        "{compiled}"
    );
    assert_eq!(compiled["stated"]["args"]["rows"], json!([rent]));
    // an explicit handle slot beside a pick keeps rows out of the call
    let rent2 = rent.clone();
    session.user("move the rent");
    let compiled = session.compile(&json!({
        "intent": "write", "verb": "complete", "within": "@1",
        "pick": [{"row": rent2, "verdict": "ok"}]
    }));
    assert!(
        compiled["stated"]["args"].get("rows").is_none(),
        "{compiled}"
    );
}

// ---------------------------------------------------------------------------------------------
// the protocol

#[test]
fn the_compile_op_answers_on_the_session_protocol() {
    let dir = tempfile::tempdir().unwrap();
    let world = dir.path().join("world.json");
    std::fs::write(&world, common::FIXTURE).unwrap();
    let vault = dir.path().join("vault.db");
    assert!(
        Command::new(BIN)
            .arg("seed")
            .arg(&world)
            .arg(&vault)
            .status()
            .unwrap()
            .success()
    );
    let mut child = Command::new(BIN)
        .arg("session")
        .arg(&vault)
        .args(["--today", "2026-09-27"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let requests = [
        json!({"op": "user", "text": "how many open tasks"}),
        json!({"op": "compile", "slots": {"intent": "count", "kind": "task", "op": "count",
               "where": [{"field": "status", "op": "=", "value": "open"}]}}),
        json!({"op": "compile", "slots": {"intent": "count", "kind": "task", "op": "count",
               "pick": [{"row": "#99"}]}}),
    ];
    let mut stdin = child.stdin.take().unwrap();
    for request in &requests {
        writeln!(stdin, "{request}").unwrap();
    }
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    let lines: Vec<Value> = String::from_utf8(out.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let compiled = &lines[1];
    assert_eq!(compiled["call"]["tool"], "answer", "{compiled}");
    assert_eq!(
        compiled["call"]["args"]["where"], "status = \"open\"",
        "{compiled}"
    );
    assert_eq!(compiled["call"]["args"]["op"], "count");
    assert!(compiled["notes"].is_array() && compiled["resolved"].is_object());
    assert_eq!(lines[2]["refused"]["slot"], "pick[0]", "{}", lines[2]);
}
