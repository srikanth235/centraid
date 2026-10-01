//! Runtime-only repairs that need the person's message: the row in focus for
//! an ambiguous by-name act, and dates the model got wrong.

mod common;

use common::{seeded, text};
use serde_json::json;

#[test]
fn an_ambiguous_name_resolves_to_the_one_row_in_focus() {
    let world = seeded();
    let mut session = world.session();
    session.user("who is neha kulkarni");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha Kulkarni"}),
    );
    assert!(shown.contains("Neha Kulkarni"), "{shown}");
    session.user("star neha");
    let acted = text(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Neha"}),
    );
    assert!(acted.starts_with("starred: #"), "{acted}");
    assert!(acted.contains("Neha Kulkarni"), "{acted}");
    assert!(acted.contains("note: 2 rows fit"), "{acted}");
}

#[test]
fn a_row_in_a_long_list_is_not_the_one_in_focus() {
    // A row that only met the condition of a long answer is not what the
    // person is talking about (Session::focus): five or more rows do not
    // settle which Neha "star neha" means.
    let world = seeded();
    let mut session = world.session();
    session.user("who have i seen lately");
    let shown = text(&mut session, "find", json!({"kind": "person"}));
    assert!(shown.contains("Neha Kulkarni"), "{shown}");
    assert!(shown.contains("5 people"), "{shown}");
    session.user("star neha");
    let acted = text(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Neha"}),
    );
    assert!(acted.starts_with("ambiguous:"), "{acted}");
}

#[test]
fn without_a_unique_focus_the_name_stays_ambiguous() {
    let world = seeded();
    let mut session = world.session();
    session.user("star neha");
    let acted = text(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Neha"}),
    );
    assert!(acted.starts_with("ambiguous:"), "{acted}");
}

#[test]
fn a_date_the_message_states_overrides_a_contradicting_when() {
    let world = seeded();
    let mut session = world.session_with("2026-09-23T09:00", centraid_nativetools::Flags::default());
    session.user("what's on tomorrow");
    let wrong = text(
        &mut session,
        "find",
        json!({"kind": "event", "when": {"unit": "day", "rel": 3}}),
    );
    assert!(wrong.contains("Thu 2026-09-24"), "{wrong}");
    assert!(wrong.contains("date: \"tomorrow\""), "{wrong}");
}
