//! The owner's rulings of #1044 (SPEC §14): "since X" runs to today (R1), a
//! bare ordinal or month-day is its next occurrence (R3, the unit tests of
//! `ground.rs` hold the table), and a verb filters its candidates by
//! applicability before ambiguity is judged (R4).

mod common;

use common::{call, seeded_with, text};
use serde_json::{Value, json};

/// The fixture plus rows the rulings need.
fn fixture() -> common::World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    let tasks = world["tasks"].as_array_mut().unwrap();
    tasks.push(json!({"key": "pay_tax", "name": "Pay tax"}));
    tasks.push(json!({"key": "mend_sail", "name": "Mend sail", "status": "cancelled"}));
    tasks.push(
        json!({"key": "mend_roof", "name": "Mend roof", "status": "completed",
        "completed": "2026-09-01T10:00"}),
    );
    let documents = world["documents"].as_array_mut().unwrap();
    documents.push(json!({"key": "w2_old", "name": "W2 2024", "text": "wages"}));
    let debts = world["debts"].as_array_mut().unwrap();
    debts.push(
        json!({"key": "lunch2", "person": "ray", "direction": "i_owe", "amount": 9,
        "name": "lunch", "date": "2026-09-01"}),
    );
    let people = world["people"].as_array_mut().unwrap();
    for (key, name) in [("pedro_a", "Pedro Almeida"), ("pedro_c", "Pedro Costa")] {
        people.push(json!({"key": key, "name": name, "role": "friend"}));
    }
    seeded_with(&world)
}

// ---- R1: "since X" over an aggregate is closed at today -------------------

#[test]
fn since_runs_up_to_today_in_a_count() {
    let world = fixture();
    for when in [
        json!({"from": {"date": "2026-09-01"}}),
        json!({"from": {"date": "2026-09-01"}, "to": null}),
        json!({"from": {"date": "2026-09-01"}, "to": {"date": "9999-12-31"}}),
    ] {
        let mut session = world.session();
        session.user("how many tasks have i got since the first of september");
        let shown = text(
            &mut session,
            "answer",
            json!({"kind": "task", "op": "count", "when": when}),
        );
        assert!(shown.contains("when: 2026-09-01..2026-09-27"), "{shown}");
        assert!(shown.contains("date: \"since"), "{shown}");
    }
}

#[test]
fn since_leaves_an_end_the_message_or_the_call_states() {
    let world = fixture();
    // The model's own end stands.
    let mut session = world.session();
    session.user("tasks since the first of september");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"from": {"date": "2026-09-01"}, "to": {"date": "2026-10-03"}}}),
    );
    assert!(shown.contains("when: 2026-09-01..2026-10-03"), "{shown}");
    assert!(shown.contains("Book the cabin"), "{shown}");
    // An end bound in the words is not today.
    let mut session = world.session();
    session.user("tasks since the first of september up to the fifth of october");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"from": {"date": "2026-09-01"}}}),
    );
    assert!(!shown.contains("date: \"since"), "{shown}");
    // A "since" that is not a date.
    let mut session = world.session();
    session.user("what's open, since the report is done");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"from": {"date": "2026-09-01"}}}),
    );
    assert!(!shown.contains("date: \"since"), "{shown}");
    // Without "since" an open end is the model's.
    let mut session = world.session();
    session.user("tasks from the first of september onwards");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"from": {"date": "2026-09-01"}}}),
    );
    assert!(shown.contains("when: 2026-09-01.."), "{shown}");
}

#[test]
fn since_closes_a_sum_and_a_breakdown_but_not_a_selector_or_a_listing() {
    let world = fixture();
    let mut session = world.session();
    session.user("how many tasks since the first of september");
    let counted = text(
        &mut session,
        "answer",
        json!({"kind": "task", "op": "count", "when": {"from": {"date": "2026-09-01"}}}),
    );
    assert!(counted.contains("2026-09-01..2026-09-27"), "{counted}");
    // A listing keeps its open end, as an answer without an op and an act's
    // selector are listings.
    for (tool, args) in [
        (
            "answer",
            json!({"kind": "task", "when": {"from": {"date": "2026-09-01"}}}),
        ),
        (
            "find",
            json!({"kind": "task", "when": {"from": {"date": "2026-09-01"}}}),
        ),
    ] {
        let mut session = world.session();
        session.user("what tasks since the first of september");
        let listed = text(&mut session, tool, args);
        assert!(listed.contains("when: 2026-09-01.."), "{listed}");
        assert!(!listed.contains("2026-09-27"), "{listed}");
    }
}

// ---- R4: applicability before ambiguity ---------------------------------

#[test]
fn complete_by_name_takes_the_one_open_candidate() {
    // "Mend reed" is open, "Mend sail" cancelled and "Mend roof" completed.
    let world = fixture();
    let mut session = world.session_uncomposed();
    session.user("tick off mend");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Mend"}),
    );
    assert!(done.starts_with("completed: #"), "{done}");
    assert!(done.contains("Mend reed for Benedikt"), "{done}");
    // Two open candidates stay ambiguous.
    let mut session = world.session_uncomposed();
    session.user("tick off pay");
    let again = text(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Pay"}),
    );
    assert!(again.starts_with("ambiguous:"), "{again}");
}

#[test]
fn star_and_unstar_by_name_take_the_candidate_they_can_change() {
    let world = fixture();
    // W2 2025 is starred, W2 2024 is not.
    let mut session = world.session();
    session.user("star w2");
    let starred = text(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "document", "name": "W2"}),
    );
    assert!(
        starred.starts_with("starred: #") && starred.contains("W2 2024"),
        "{starred}"
    );
    // The star above is in the vault: a fresh world for the unstar.
    let world = fixture();
    let mut session = world.session();
    session.user("unstar w2");
    let unstarred = text(
        &mut session,
        "act",
        json!({"verb": "unstar", "kind": "document", "name": "W2"}),
    );
    assert!(
        unstarred.starts_with("unstarred: #") && unstarred.contains("W2 2025"),
        "{unstarred}"
    );
}

#[test]
fn a_row_in_focus_does_not_beat_applicability() {
    // Pedro Costa was starred last turn, so he is in focus; "star pedro" is
    // still Almeida, the only one a star changes.
    let world = fixture();
    let mut session = world.session();
    session.user("star pedro costa");
    let costa = common::find_in_turn(&mut session, "person", "Pedro Costa");
    let first = text(&mut session, "act", json!({"verb": "star", "rows": costa}));
    assert!(first.starts_with("starred:"), "{first}");
    session.user("star pedro");
    let second = text(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Pedro"}),
    );
    assert!(
        second.starts_with("starred: #") && second.contains("Pedro Almeida"),
        "{second}"
    );
}

#[test]
fn settle_and_delete_by_name_take_the_open_and_the_live_row() {
    let world = fixture();
    // Two debts called "lunch": one settled, one open.
    let mut session = world.session();
    session.user("settle the lunch");
    let settled = text(
        &mut session,
        "act",
        json!({"verb": "settle_debt", "kind": "debt", "name": "lunch"}),
    );
    assert!(settled.starts_with("settled: #"), "{settled}");
    // A trashed row is not a candidate for delete.
    let mut session = world.session();
    session.user("delete the library books");
    let shown = text(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "task", "name": "Library"}),
    );
    assert!(!shown.starts_with("ambiguous:"), "{shown}");
}

#[test]
fn a_pick_of_the_row_the_verb_cannot_change_goes_to_the_one_it_can() {
    // The model picked the completed "Mend roof" by number for "tick off
    // mend"; the only open Mend is the reed.
    let world = fixture();
    let mut session = world.session();
    session.user("tick off mend");
    let roof = common::find_in_turn(&mut session, "task", "Mend roof");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": roof}),
    );
    let shown = done["text"].as_str().unwrap();
    assert!(shown.contains("Mend reed for Benedikt"), "{shown}");
    assert!(!shown.contains("Mend roof"), "{shown}");
}
