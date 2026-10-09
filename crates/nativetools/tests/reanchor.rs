//! FAIL-SOFT (SPEC §5): a step that was rejected or came back empty restates
//! the rows the model can still use, so the next step re-anchors on them; a
//! step cap or a loop ends the turn as an `ask` that says what is unclear.

mod common;

use common::{call, seeded, text};
use serde_json::json;

const HANDLES: &str = "rows you can still use: ";

#[test]
fn an_empty_find_restates_the_rows_the_turn_has_shown() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("what's due next week?");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"unit": "week", "rel": 1}}),
    );
    assert!(
        !shown.contains(HANDLES),
        "a result that found rows says nothing more: {shown}"
    );
    let empty = text(&mut session, "find", json!({"kind": "task", "name": "zzz"}));
    assert!(empty.starts_with("0 tasks called \"zzz\"."), "{empty}");
    let last = empty.lines().last().unwrap();
    assert_eq!(
        last,
        format!("{HANDLES}#9 task \"Pay rent\", #10 task \"Book the cabin\""),
        "{empty}"
    );
}

#[test]
fn an_error_restates_them_too_and_a_turn_ending_call_does_not() {
    let world = seeded();
    let mut session = world.session();
    session.user("push the cabin to friday");
    let _ = text(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    // A bad verb is not a lost anchor.
    let bad = text(
        &mut session,
        "act",
        json!({"verb": "reschedulee", "rows": "#9"}),
    );
    assert!(
        bad.starts_with("error: no verb") && !bad.contains(HANDLES),
        "{bad}"
    );
    // A refusal that names the row to use says what to use next already.
    let named = text(
        &mut session,
        "act",
        json!({"verb": "cancel", "kind": "event", "rows": "#9"}),
    );
    assert!(
        named.starts_with("error:") && !named.contains(HANDLES),
        "{named}"
    );
    // A handle that was never shown gets the rows that can be used.
    let never = text(&mut session, "open", json!({"row": "#99"}));
    assert!(never.contains(&format!("\n{HANDLES}#9 task")), "{never}");
    let done = call(&mut session, "ask", json!({"question": "which friday?"}));
    assert_eq!(done["ends_turn"], true);
    assert!(!done["text"].as_str().unwrap().contains(HANDLES));
}

#[test]
fn nothing_is_restated_when_no_row_is_addressable_yet() {
    let world = seeded();
    let mut session = world.session();
    session.user("do the thing");
    let bad = text(
        &mut session,
        "act",
        json!({"verb": "reschedulee", "kind": "task", "name": "cabin"}),
    );
    assert!(!bad.contains(HANDLES), "{bad}");
}

#[test]
fn the_restatement_is_capped_and_short() {
    let world = seeded();
    let mut session = world.session();
    session.user("everything");
    for kind in ["person", "task", "event", "note"] {
        let _ = text(&mut session, "find", json!({"kind": kind}));
    }
    let bad = text(&mut session, "open", json!({"row": "#99"}));
    let line = bad.lines().last().unwrap();
    assert!(line.starts_with(HANDLES), "{bad}");
    assert!(line.matches('#').count() <= 6, "{line}");
    assert!(line.chars().count() <= 400, "{line}");
}

#[test]
fn rows_from_the_previous_turn_are_restated_after_this_turns() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("what's due next week?");
    let _ = text(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"unit": "week", "rel": 1}}),
    );
    session.user("and then?");
    let empty = text(&mut session, "find", json!({"kind": "task", "name": "zzz"}));
    assert!(
        empty.contains(&format!(
            "\n{HANDLES}#9 task \"Pay rent\", #10 task \"Book the cabin\""
        )),
        "{empty}"
    );
}

fn find_n(session: &mut centraid_nativetools::Session, limit: u32) -> serde_json::Value {
    call(session, "find", json!({"kind": "task", "limit": limit}))
}

#[test]
fn the_step_cap_ends_in_an_ask_that_says_what_is_unclear() {
    let world = seeded();
    let mut session = world.session();
    session.user("do the cabin thing");
    for limit in 1..=5 {
        assert_eq!(find_n(&mut session, limit)["ends_turn"], false);
    }
    let sixth = find_n(&mut session, 6);
    assert_eq!(sixth["ends_turn"], true);
    let effect = &sixth["effect"];
    assert_eq!(effect["tool"], "ask", "{sixth}");
    assert!(
        effect.get("cap").is_none() && effect.get("loop").is_none(),
        "{sixth}"
    );
    assert_eq!(effect["failsoft"], "cap");
    let question = effect["ask"]["question"].as_str().unwrap();
    assert!(
        question.starts_with("I could not settle this in 6 steps"),
        "{question}"
    );
    // The rows the turn saw are the options.
    let options = effect["ask"]["options"].as_array().unwrap();
    assert!(!options.is_empty() && options.len() <= 12, "{sixth}");
    let text = sixth["text"].as_str().unwrap();
    assert!(
        text.contains("asked: \"I could not settle this in 6 steps"),
        "{text}"
    );
}

#[test]
fn a_loop_ends_in_an_ask_naming_the_failing_call() {
    let world = seeded();
    let mut session = world.session();
    session.user("push the cabin to friday");
    let args = json!({"kind": "task", "name": "cabin"});
    let first = call(&mut session, "find", args.clone());
    assert!(first["text"].as_str().unwrap().starts_with("@1"), "{first}");
    let hint = call(&mut session, "find", args.clone());
    assert_eq!(hint["effect"]["repeat"], 1);
    let nudge = call(&mut session, "find", args.clone());
    assert_eq!(nudge["effect"]["repeat"], 2);
    let end = call(&mut session, "find", args);
    assert_eq!(end["ends_turn"], true);
    assert_eq!(end["effect"]["tool"], "ask", "{end}");
    assert_eq!(end["effect"]["failsoft"], "loop");
    assert!(end["effect"].get("loop").is_none(), "{end}");
    let question = end["effect"]["ask"]["question"].as_str().unwrap();
    assert!(
        question.starts_with("I could not settle this"),
        "the turn says it could not settle: {question}"
    );
}

#[test]
fn a_write_that_matched_nothing_sent_again_declines_not_found() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("push the cabin to friday");
    let args = json!({"verb": "reschedule", "kind": "task", "name": "nothing like it"});
    let first = call(&mut session, "act", args.clone());
    assert!(
        first["text"]
            .as_str()
            .unwrap()
            .starts_with("0 tasks called"),
        "{first}"
    );
    // a refusal like any other: the same call sent again ends the turn at once
    let end = call(&mut session, "act", args);
    assert_eq!(end["ends_turn"], true, "{end}");
    assert_eq!(end["effect"]["tool"], "decline", "{end}");
    assert_eq!(end["effect"]["decline"]["reason"], "not_found");
    assert_eq!(
        end["effect"]["failsoft"],
        json!({"family": "write_no_match", "action": "decline:not_found"})
    );
}

#[test]
fn a_cap_or_loop_after_a_write_keeps_the_write_and_stays_a_cap() {
    // An ask after a landed write would read as "nothing was done".
    let world = seeded();
    let mut session = world.session();
    session.user("complete the cabin");
    let cabin = common::find_in_turn(&mut session, "task", "cabin");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": cabin, "more": true}),
    );
    assert!(
        done["text"].as_str().unwrap().starts_with("completed:"),
        "{done}"
    );
    for limit in 1..=3 {
        let _ = find_n(&mut session, limit);
    }
    let last = find_n(&mut session, 4);
    assert_eq!(last["ends_turn"], true);
    assert_eq!(last["effect"]["cap"], true, "{last}");
    assert!(last["effect"].get("ask").is_none(), "{last}");
}
