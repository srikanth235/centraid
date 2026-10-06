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
    session.user("log a call with neha");
    let acted = text(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    assert!(
        acted.starts_with("logged: #") || acted.contains("Neha Kulkarni"),
        "{acted}"
    );
    assert!(acted.contains("Neha Kulkarni"), "{acted}");
    assert!(acted.contains("note: 2 rows fit"), "{acted}");
}

#[test]
fn a_row_in_a_long_list_is_not_the_one_in_focus() {
    // A row that only met the condition of a long answer is not what the
    // person is talking about (Session::focus): five or more rows do not
    // settle which Neha "star neha" means.
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("who have i seen lately");
    let shown = text(&mut session, "find", json!({"kind": "person"}));
    assert!(shown.contains("Neha Kulkarni"), "{shown}");
    assert!(shown.contains("5 people"), "{shown}");
    session.user("add neha to the list");
    let acted = text(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "person", "name": "Neha", "args": "to: #1"}),
    );
    assert!(acted.starts_with("ambiguous:"), "{acted}");
}

#[test]
fn without_a_unique_focus_the_name_stays_ambiguous() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("add neha to the list");
    let acted = text(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "person", "name": "Neha", "args": "to: #1"}),
    );
    assert!(acted.starts_with("ambiguous:"), "{acted}");
}

#[test]
fn a_date_the_message_states_overrides_a_contradicting_when() {
    let world = seeded();
    let mut session =
        world.session_with("2026-09-23T09:00", centraid_nativetools::Flags::default());
    session.user("what's on tomorrow");
    let wrong = text(
        &mut session,
        "find",
        json!({"kind": "event", "when": {"unit": "day", "rel": 3}}),
    );
    assert!(wrong.contains("Thu 2026-09-24"), "{wrong}");
    assert!(wrong.contains("date: \"tomorrow\""), "{wrong}");
}

/// The fixture plus two unstarred Pedros and two "Sato" tasks.
fn pedros() -> common::World {
    let mut world: serde_json::Value = serde_json::from_str(common::FIXTURE).unwrap();
    let people = world["people"].as_array_mut().unwrap();
    for (key, name) in [("pedro_a", "Pedro Almeida"), ("pedro_c", "Pedro Costa")] {
        people.push(json!({"key": key, "name": name, "role": "friend"}));
    }
    common::seeded_with(&world)
}

fn star_by_pick(world: &common::World, message: &str, name: &str) -> (serde_json::Value, String) {
    let mut session = world.session();
    session.user(message);
    let n = common::find_in_turn(&mut session, "person", name);
    let response = common::call(&mut session, "act", json!({"verb": "star", "rows": n}));
    (response, n)
}

#[test]
fn a_pick_the_words_leave_ambiguous_asks_with_the_candidates() {
    // "star pedro" fits two people; the model picked one by number. The
    // runtime does not act: it ends the turn asking, with both as options.
    let world = pedros();
    let (response, _) = star_by_pick(&world, "star pedro", "Pedro Almeida");
    let text = response["text"].as_str().unwrap();
    assert!(
        text.starts_with("asked: \"which one of the 2 did you mean?\""),
        "{text}"
    );
    assert!(
        text.contains("Pedro Almeida") && text.contains("Pedro Costa"),
        "{text}"
    );
    assert!(text.contains("nothing was done"), "{text}");
    assert_eq!(response["ends_turn"], true);
    assert_eq!(response["effect"]["composed"], true);
    let options = response["effect"]["ask"]["options"].as_array().unwrap();
    assert_eq!(options.len(), 2, "{response}");
    assert!(response["effect"].get("diff").is_none(), "{response}");
}

#[test]
fn a_pick_the_words_settle_acts() {
    // The full name, the surname alone, the person says which.
    for (message, name) in [
        ("star pedro costa", "Pedro Costa"),
        ("star costa", "Pedro Costa"),
        ("star pedro almeida", "Pedro Almeida"),
        // The person says which: the second, the other, a date, a state.
        ("star pedro, the second one", "Pedro Costa"),
        ("star the other pedro", "Pedro Costa"),
        // Words that match no name word at all do not make a reference.
        ("star him", "Pedro Costa"),
    ] {
        let world = pedros();
        let (response, _) = star_by_pick(&world, message, name);
        let text = response["text"].as_str().unwrap();
        assert!(text.starts_with("starred: #"), "{message}: {text}");
    }
}

#[test]
fn a_pick_is_not_ambiguous_when_the_verb_changes_only_one_of_them() {
    // Pedro Costa is already starred: "star pedro" can only mean Almeida.
    let world = pedros();
    let mut session = world.session();
    session.user("star pedro costa");
    let costa = common::find_in_turn(&mut session, "person", "Pedro Costa");
    let first = text(&mut session, "act", json!({"verb": "star", "rows": costa}));
    assert!(first.starts_with("starred:"), "{first}");
    session.user("star pedro");
    let almeida = common::find_in_turn(&mut session, "person", "Pedro Almeida");
    let second = text(
        &mut session,
        "act",
        json!({"verb": "star", "rows": almeida}),
    );
    assert!(second.starts_with("starred: #"), "{second}");
}

#[test]
fn a_pick_in_focus_is_not_ambiguous() {
    // The last answer was the one Pedro Costa: "star pedro" is him.
    let world = pedros();
    let mut session = world.session();
    session.user("who is pedro costa");
    let shown = text(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Pedro Costa"}),
    );
    assert!(shown.contains("Pedro Costa"), "{shown}");
    session.user("star pedro");
    let costa = common::find_in_turn(&mut session, "person", "Pedro Costa");
    let done = text(&mut session, "act", json!({"verb": "star", "rows": costa}));
    assert!(done.starts_with("starred: #"), "{done}");
}
