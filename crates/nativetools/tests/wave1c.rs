//! The pick-ambiguity rule and the applicability filter, held to what a person
//! means (SPEC §3.3 (b)/(c), §14.1): the answer to an ask picks one of the ask's
//! options, a call's own narrowing is not a guess, rows acted on stay in focus,
//! and a verb's candidates are the rows it can change in the state they are in.
//! The fixtures follow the authored sessions of #1044 that the first version of
//! the rule got wrong.

mod common;

use common::{call, seeded_with, text};
use serde_json::{Value, json};

const HOUR_LATER: &str = r#"to: {"unit":"hour","rel":1,"anchor":"row"}"#;

fn world_with(edit: impl FnOnce(&mut Value)) -> common::World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).unwrap();
    edit(&mut world);
    seeded_with(&world)
}

fn push(world: &mut Value, section: &str, row: Value) {
    world[section].as_array_mut().unwrap().push(row);
}

/// `#n` of the row a response's `ambiguous` block lists with this name.
fn listed(response: &Value, name: &str) -> String {
    let text = response["text"].as_str().unwrap();
    let at = text.find(&format!("\"{name}\"")).unwrap_or_else(|| {
        panic!("{name} is not listed: {text}");
    });
    let before = &text[..at];
    let hash = before.rfind('#').expect("a #n before the name");
    let digits: String = before[hash + 1..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    format!("#{digits}")
}

fn number_in(shown: &str) -> String {
    let hash = shown.find('#').expect("a #n");
    let digits: String = shown[hash + 1..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    format!("#{digits}")
}

// ---- A: the answer to an ask picks one of its options --------------------

#[test]
fn the_answer_to_an_ask_picks_one_of_the_options() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "hen_class", "name": "Hen do cocktail class", "start": "2026-10-10T18:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "hen_dinner", "name": "Hen do dinner", "start": "2026-10-10T20:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "mum_dinner", "name": "Mum's birthday dinner", "start": "2026-10-11T19:00"}),
        );
    });
    let mut session = world.session_uncomposed();
    session.user("push the hen do back an hour");
    let first = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Hen do", "args": HOUR_LATER}),
    );
    assert!(
        first["text"].as_str().unwrap().starts_with("ambiguous:"),
        "{first}"
    );
    let class = listed(&first, "Hen do cocktail class");
    let dinner = listed(&first, "Hen do dinner");
    call(
        &mut session,
        "ask",
        json!({"question": "the cocktail class or the dinner?", "options": format!("{class}, {dinner}")}),
    );
    // "dinner" fits the hen do dinner and Mum's birthday dinner; the person
    // is answering the ask, so it is the dinner among the options.
    session.user("dinner");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": dinner, "args": HOUR_LATER}),
    );
    assert!(done.starts_with("rescheduled: #"), "{done}");
    assert!(done.contains("Hen do dinner"), "{done}");
}

#[test]
fn an_answer_that_fits_two_options_still_asks() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "a", "name": "Hen do cocktail class", "start": "2026-10-10T18:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "b", "name": "Hen do dinner", "start": "2026-10-10T20:00"}),
        );
    });
    let mut session = world.session_uncomposed();
    session.user("push the hen do back an hour");
    let first = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Hen do", "args": HOUR_LATER}),
    );
    let class = listed(&first, "Hen do cocktail class");
    let dinner = listed(&first, "Hen do dinner");
    call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": format!("{class}, {dinner}")}),
    );
    session.user("the hen do");
    let asked = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": dinner, "args": HOUR_LATER}),
    );
    assert!(asked.starts_with("ambiguous:"), "{asked}");
}

#[test]
fn a_plural_weekday_names_the_row() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "sat", "name": "Dress fitting with Zainab", "start": "2026-10-03T14:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "wed", "name": "Dress fitting with Zainab", "start": "2026-10-14T14:00"}),
        );
    });
    let mut session = world.session_uncomposed();
    session.user("move the dress fitting with zainab to 3pm");
    let first = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Dress fitting with Zainab",
               "args": r#"to: {"unit":"day","rel":0,"anchor":"row","time":"15:00"}"#}),
    );
    assert!(
        first["text"].as_str().unwrap().starts_with("ambiguous:"),
        "{first}"
    );
    let rows: Vec<String> = first["effect"]["ambiguous"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    call(
        &mut session,
        "ask",
        json!({"question": "saturday's fitting or the other?", "options": rows.join(", ")}),
    );
    session.user("dress fitting with zainab, saturdays");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": rows[0],
               "args": r#"to: {"unit":"day","rel":0,"anchor":"row","time":"15:00"}"#}),
    );
    assert!(done.starts_with("rescheduled: #"), "{done}");
}

#[test]
fn a_message_that_names_nothing_borrows_nothing_from_the_one_before() {
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "pedro_a", "name": "Pedro Almeida", "role": "uncle"}),
        );
        push(
            world,
            "people",
            json!({"key": "pedro_c", "name": "Pedro Costa", "role": "driver"}),
        );
    });
    let mut session = world.session();
    session.user("star pedro");
    let first = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Pedro"}),
    );
    let costa = format!(
        "#{}",
        first["effect"]["ambiguous"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == world.id("pedro_c"))
            .unwrap()["n"]
    );
    session.user("the driver");
    // Not asked: "the driver" names no word of "Pedro Costa", so the earlier
    // "pedro" does not make it a naming message.
    let done = text(&mut session, "act", json!({"verb": "star", "rows": costa}));
    assert!(done.starts_with("starred: #"), "{done}");
}

// ---- H: rows acted on stay in focus ---------------------------------------

#[test]
fn a_row_acted_on_last_turn_is_the_one_in_focus() {
    let world = world_with(|world| {
        for (key, start) in [
            ("p1", "2026-09-24T18:30"),
            ("p2", "2026-10-01T18:30"),
            ("p3", "2026-10-08T18:30"),
        ] {
            push(
                world,
                "events",
                json!({"key": key, "name": "Pottery class", "start": start}),
            );
        }
    });
    let mut session = world.session();
    session.user("push thursday's pottery back an hour");
    let moved = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Pottery class",
               "when": {"date": "2026-10-01"}, "args": HOUR_LATER}),
    );
    assert!(moved.starts_with("rescheduled: #"), "{moved}");
    let row = number_in(&moved);
    session.user("make the pottery description wheel throwing");
    let edited = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": row, "args": "description: wheel throwing"}),
    );
    assert!(edited.starts_with("edited: #"), "{edited}");
}

// ---- B: the call's own narrowing is not a guess ----------------------------

#[test]
fn a_selector_the_call_narrowed_is_not_a_pick() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "bins_a", "name": "Put the bins out", "due": "2026-10-06T19:00"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "bins_b", "name": "Put the bins out", "due": "2026-10-13T19:00"}),
        );
    });
    let mut session = world.session();
    session.user("and move the bins to wednesday");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "task", "name": "bins",
               "when": {"date": "2026-10-13"},
               "args": "to: {\"unit\":\"week\",\"rel\":2,\"weekday\":3}"}),
    );
    assert!(done.starts_with("rescheduled: #"), "{done}");
}

// ---- E: the message states the picked row's whole name ---------------------

#[test]
fn the_whole_name_in_the_message_is_the_row() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "tb", "name": "TB test", "start": "2026-09-29T10:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "tb_reading", "name": "TB test reading", "start": "2026-10-02T10:00"}),
        );
    });
    let mut session = world.session_uncomposed();
    session.user("put the tb test back to wednesday at 10");
    let first = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "tb test",
               "args": r#"to: {"unit":"week","rel":1,"weekday":3,"time":"10:00"}"#}),
    );
    // nt12 R6: `tb test` is tier 1 for `TB test` and tier 3 for `TB test reading`: a lookalike
    // name is the ask over both, never a write on the one that is exact
    let said = first["text"].as_str().unwrap_or_default().to_owned();
    assert!(said.starts_with("ambiguous:"), "{said}");
    assert!(
        said.contains("TB test") && said.contains("TB test reading"),
        "{said}"
    );
}

// ---- F: the matcher stems --------------------------------------------------

#[test]
fn tire_and_tires_rotation_and_rotated_are_one_word() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "tires", "name": "Get truck tires rotated", "due": "2026-10-03T10:00"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "reg", "name": "Renew truck registration", "due": "2026-10-05T10:00"}),
        );
    });
    let mut session = world.session();
    session.user("put the truck tire rotation on the house list");
    let home = common::find_in_turn(&mut session, "list", "Home");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "task", "name": "tires rotated",
               "args": format!("to: {home}")}),
    );
    assert!(done.starts_with("added: #"), "{done}");
}

// ---- G: the row is named in the previous user message ----------------------

#[test]
fn the_previous_message_names_the_row() {
    let world = world_with(|world| {
        push(
            world,
            "locker",
            json!({"key": "hdfc", "name": "HDFC debit card", "type": "card"}),
        );
        push(
            world,
            "locker",
            json!({"key": "sbi", "name": "SBI credit card", "type": "card"}),
        );
        push(
            world,
            "locker",
            json!({"key": "pan", "name": "PAN card", "type": "card"}),
        );
    });
    let mut session = world.session();
    session.user("email my hdfc card number to karthik");
    call(&mut session, "decline", json!({"reason": "sealed_egress"}));
    session.user("fine, star the card then");
    let hdfc = common::find_in_turn(&mut session, "locker item", "HDFC debit card");
    let done = text(&mut session, "act", json!({"verb": "star", "rows": hdfc}));
    assert!(done.starts_with("starred: #"), "{done}");
}

// ---- I: a long read of which one candidate is a row ------------------------

#[test]
fn the_one_candidate_a_long_read_showed_is_the_pick() {
    let world = world_with(|world| {
        let events = world["events"].as_array_mut().unwrap();
        events.clear();
        for (key, name, start) in [
            ("roof", "Roofing inspection", "2026-09-28T11:00"),
            ("femi", "Dentist for Femi", "2026-09-29T09:00"),
            ("car", "Car service", "2026-09-29T13:00"),
            ("bank_visit", "Bank visit", "2026-09-30T10:00"),
            ("pharm", "Pharmacy pickup", "2026-10-01T16:00"),
            ("kemi", "Dentist for Kemi", "2026-10-06T09:00"),
        ] {
            events.push(json!({"key": key, "name": name, "start": start}));
        }
    });
    let mut session = world.session();
    session.user("what's on this week");
    let shown = call(
        &mut session,
        "find",
        json!({"kind": "event", "when": {"from": {"date": "2026-09-27"}, "to": {"date": "2026-10-04"}}}),
    );
    let rows = shown["effect"]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 5, "{shown}");
    let femi = format!("#{}", rows[1]["n"]);
    session.user("move the dentist to 10");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": femi,
               "args": r#"to: {"unit":"day","rel":0,"anchor":"row","time":"10:00"}"#}),
    );
    assert!(done.starts_with("rescheduled: #"), "{done}");
    assert!(done.contains("Dentist for Femi"), "{done}");
}

// ---- R4: applicability by state -------------------------------------------

#[test]
fn a_pick_of_the_event_that_is_not_over_is_the_one_meant() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "g1", "name": "Viktor's basketball game", "start": "2026-09-12T11:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "g2", "name": "Viktor's basketball game", "start": "2026-10-03T11:00"}),
        );
    });
    let to_noon = r#"to: {"unit":"day","rel":0,"anchor":"row","time":"12:00"}"#;
    let mut session = world.session_uncomposed();
    session.user("and move the game to noon");
    // By name nothing is chosen: two games fit, as before.
    let first = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "game", "args": to_noon}),
    );
    assert!(
        first["text"].as_str().unwrap().starts_with("ambiguous:"),
        "{first}"
    );
    let number_of = |key: &str| -> String {
        let row = first["effect"]["ambiguous"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["id"] == world.id(key))
            .unwrap();
        format!("#{}", row["n"])
    };
    let (past, ahead) = (number_of("g1"), number_of("g2"));
    // The other pick, the game that is over, asks (the turn then ends).
    let mut second = world.session_uncomposed();
    second.user("and move the game to noon");
    call(
        &mut second,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "game", "args": to_noon}),
    );
    let asked = call(
        &mut second,
        "act",
        json!({"verb": "reschedule", "rows": past, "args": to_noon}),
    );
    assert!(
        asked["text"].as_str().unwrap().starts_with("ambiguous:"),
        "{asked}"
    );
    let done = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": ahead, "args": to_noon}),
    );
    assert!(done.starts_with("rescheduled: #"), "{done}");
    assert!(done.contains("2026-10-03"), "{done}");
}

#[test]
fn cancel_takes_the_event_that_is_not_cancelled() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "s1", "name": "Swim class", "start": "2026-10-03T09:00", "cancelled": true}),
        );
        push(
            world,
            "events",
            json!({"key": "s2", "name": "Swim class", "start": "2026-10-10T09:00"}),
        );
    });
    let mut session = world.session();
    session.user("cancel the swim class");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "cancel", "kind": "event", "name": "Swim class"}),
    );
    assert!(done.starts_with("cancelled: #"), "{done}");
    assert!(done.contains("status tentative → cancelled"), "{done}");
    assert!(
        done.contains("only that one is a row cancel can change"),
        "{done}"
    );
}

#[test]
fn add_to_takes_the_row_that_is_not_a_member() {
    let world = world_with(|world| {
        push(
            world,
            "photos",
            json!({"key": "beach2", "name": "Beach day", "taken": "2026-07-02T10:00"}),
        );
    });
    let mut session = world.session();
    session.user("put the beach day photo in summer");
    let summer = common::find_in_turn(&mut session, "album", "Summer");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "photo", "name": "Beach day",
               "args": format!("to: {summer}")}),
    );
    assert!(done.starts_with("added: #"), "{done}");
}

#[test]
fn pinning_takes_the_note_that_is_not_pinned() {
    let world = world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "tips1", "name": "Packing tips", "body": "socks", "pinned": true}),
        );
        push(
            world,
            "notes",
            json!({"key": "tips2", "name": "Packing tips", "body": "shoes"}),
        );
    });
    let mut session = world.session();
    session.user("pin the packing tips");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "note", "name": "Packing tips", "args": "pinned: true"}),
    );
    assert!(done.starts_with("edited: #"), "{done}");
    assert!(done.contains("pinned"), "{done}");
}

// ---- K: a malformed clock is not repaired ----------------------------------

#[test]
fn a_malformed_clock_is_an_error_not_a_different_time() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "echo", "name": "Echo test", "start": "2026-10-06T08:30"}),
        );
    });
    let mut session = world.session();
    session.user("move the echo test to tomorrow at 9");
    let shown = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Echo test",
               "args": r#"to: {"unit":"day","rel":1,"time":"9"}"#}),
    );
    assert!(shown.starts_with("error:"), "{shown}");
    assert!(shown.contains("HH:MM"), "{shown}");
}

// ---- R1 revised: since closes only an aggregate ------------------------------

#[test]
fn since_leaves_a_row_listing_open_ended() {
    let world = common::seeded();
    let mut session = world.session();
    session.user("what tasks have i got since the first of september");
    let shown = text(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"from": {"date": "2026-09-01"}}}),
    );
    assert!(shown.contains("when: 2026-09-01.."), "{shown}");
    assert!(!shown.contains("date: \"since"), "{shown}");
    assert!(shown.contains("Book the cabin"), "{shown}");
}

// ---- R4 exception: a reschedule to where a row already is ------------------

#[test]
fn a_reschedule_to_the_time_a_row_is_already_at_still_asks() {
    // "move the playtest to friday" with one playtest already on that Friday:
    // an already-so row is a legitimate target (the person may be
    // re-confirming it), so it is not filtered and the name stays ambiguous.
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "pt1", "name": "Playtest night", "start": "2026-10-02T18:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "pt2", "name": "Playtest night", "start": "2026-10-09T18:00"}),
        );
    });
    let mut session = world.session_uncomposed();
    session.user("move playtest night to friday");
    let shown = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Playtest night",
               "args": r#"to: {"unit":"week","rel":1,"weekday":5,"time":"18:00"}"#}),
    );
    assert!(shown.starts_with("ambiguous:"), "{shown}");
}

#[test]
fn a_task_reschedule_to_its_own_date_still_asks() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "f1", "name": "Fix the phone", "due": "2026-09-29"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "f2", "name": "Fix the laptop", "due": "2026-10-02"}),
        );
    });
    let mut session = world.session_uncomposed();
    session.user("push the fix task to friday");
    let shown = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "task", "name": "Fix",
               "args": r#"to: {"unit":"week","rel":1,"weekday":5}"#}),
    );
    assert!(shown.starts_with("ambiguous:"), "{shown}");
}
