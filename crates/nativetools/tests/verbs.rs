//! Every `act` verb through the real typed commands: the effect, the
//! already-so answer, undo, and the call-only ambiguity check (SPEC §3.3, §4.2).
//!
//! Earlier turns compact (SPEC §6.4), so each block finds the rows it writes
//! in the same turn — or references them again before the next one.

mod common;

use common::{call, diff_rows, ids, number, numbers, seeded, text, trashed_number};
use serde_json::{Value, json};

fn field_change(response: &Value, field: &str) -> Value {
    diff_rows(response)
        .iter()
        .find_map(|row| row["fields"].get(field).cloned())
        .unwrap_or_default()
}

fn link_change(response: &Value) -> Vec<String> {
    response["effect"]["diff"]["links"]
        .as_array()
        .map(|links| {
            links
                .iter()
                .map(|link| link["change"].as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn complete_then_reopen_and_already_so() {
    let world = seeded();
    let mut session = world.session();
    let cabin = number(&mut session, "task", "cabin");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": cabin}),
    );
    assert_eq!(done["ends_turn"], true);
    assert_eq!(field_change(&done, "status"), json!(["open", "completed"]));
    // The act referenced the row, so it survives compaction into turn 2.
    session.user("");
    let again = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": cabin}),
    );
    assert!(
        again["text"].as_str().unwrap().starts_with("already: "),
        "{}",
        again["text"]
    );
    assert!(
        diff_rows(&again).is_empty(),
        "an already-so write changes nothing"
    );
    assert_eq!(again["effect"]["already"][0]["id"], world.id("cabin"));
    session.user("");
    let open = call(
        &mut session,
        "act",
        json!({"verb": "reopen", "rows": cabin}),
    );
    assert_eq!(field_change(&open, "status"), json!(["completed", "open"]));
    session.user("");
    let noop = call(
        &mut session,
        "act",
        json!({"verb": "reopen", "rows": cabin}),
    );
    assert!(noop["text"].as_str().unwrap().contains("is open"));
}

#[test]
fn an_impossible_write_is_a_schema_error_naming_the_kinds() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    let found = numbers(&mut session, &[("event", "dentist"), ("person", "Ray")]);
    let refused = text(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": found[0]}),
    );
    assert_eq!(
        refused,
        "error: complete does not apply to events. complete applies to: task."
    );
    let refused = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": found[1], "args": {"to": {"unit": "day", "rel": 1}}}),
    );
    assert!(
        refused.starts_with("error: reschedule does not apply to people."),
        "{refused}"
    );
}

#[test]
fn a_selector_that_fits_two_rows_is_ambiguous_and_does_nothing() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    // `log` applies to both Nehas (a `star` would apply only to the one not
    // yet starred, SPEC §14).
    session.user("log a call with Neha");
    let response = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    let text = response["text"].as_str().unwrap();
    assert!(text.starts_with("ambiguous: \"Neha\" fits #"), "{text}");
    assert!(text.ends_with("; nothing was done."), "{text}");
    assert_eq!(
        response["ends_turn"], false,
        "the model still has to ask or narrow"
    );
    assert_eq!(ids(&response["effect"]["ambiguous"]).len(), 2);
    assert!(response["effect"].get("diff").is_none());
    // Naming the rows by number is the bulk write, and it applies to both.
    let listed: Vec<String> = response["effect"]["ambiguous"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    let both = call(
        &mut session,
        "act",
        json!({"verb": "log", "rows": listed.join(", "), "args": "kind: call"}),
    );
    assert!(
        both["text"].as_str().unwrap().starts_with("logged"),
        "{}",
        both["text"]
    );
}

#[test]
fn delete_restore_and_the_trash_answers() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    let reed = number(&mut session, "task", "reed");
    let deleted = call(&mut session, "act", json!({"verb": "delete", "rows": reed}));
    assert_eq!(
        diff_rows(&deleted)[0]["change"],
        "trashed",
        "{}",
        deleted["text"]
    );
    session.user("");
    let again = text(&mut session, "act", json!({"verb": "delete", "rows": reed}));
    assert!(again.contains("is in the trash"), "{again}");
    session.user("");
    let blocked = text(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": reed}),
    );
    assert!(
        blocked.contains("is in the trash; restore it first"),
        "{blocked}"
    );
    let restored = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": reed}),
    );
    assert_eq!(diff_rows(&restored)[0]["change"], "restored");
    session.user("");
    let live = text(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": reed}),
    );
    assert!(live.contains("is not in the trash"), "{live}");
    let library = trashed_number(&mut session, "task", "library");
    let back = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": library}),
    );
    assert_eq!(diff_rows(&back)[0]["id"], world.id("library"));
}

#[test]
fn star_and_unstar_on_every_starrable_kind() {
    let world = seeded();
    let mut session = world.session();
    for (kind, name, starred) in [
        ("person", "Benedikt", false),
        ("document", "Lease", false),
        ("photo", "Hike", false),
        ("locker item", "Bank", false),
        ("document", "W2", true),
        ("photo", "Beach", true),
        ("locker item", "wifi", true),
    ] {
        let row = number(&mut session, kind, name);
        let verb = if starred { "unstar" } else { "star" };
        let response = call(&mut session, "act", json!({"verb": verb, "rows": row}));
        assert_eq!(
            field_change(&response, "starred"),
            json!([starred, !starred]),
            "{kind} {name}: {}",
            response["text"]
        );
        session.user("");
        let again = text(&mut session, "act", json!({"verb": verb, "rows": row}));
        assert!(again.starts_with("already: "), "{kind} {name}: {again}");
    }
}

#[test]
fn add_to_and_remove_from_every_container() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    for (kind, name, container_kind, container) in [
        ("person", "Benedikt", "group", "Tahoe"),
        ("photo", "Hike", "album", "Wedding"),
        ("note", "Diary", "notebook", "Ideas"),
        ("document", "Lease", "folder", "Taxes"),
        ("task", "Pay rent", "list", "Home"),
    ] {
        let found = numbers(&mut session, &[(kind, name), (container_kind, container)]);
        let (row, target) = (&found[0], &found[1]);
        let added = call(
            &mut session,
            "act",
            json!({"verb": "add_to", "rows": row, "args": format!("to: {target}")}),
        );
        assert!(
            link_change(&added).contains(&"added".to_owned()),
            "{kind} into {container_kind}: {}",
            added["text"]
        );
        session.user("");
        let again = text(
            &mut session,
            "act",
            json!({"verb": "add_to", "rows": row, "args": format!("to: {target}")}),
        );
        assert!(again.contains("is already in"), "{again}");
        session.user("");
        let removed = call(
            &mut session,
            "act",
            json!({"verb": "remove_from", "rows": row, "args": format!("from: {target}")}),
        );
        assert!(
            link_change(&removed).contains(&"removed".to_owned()),
            "{}",
            removed["text"]
        );
        session.user("");
        let not_in = text(
            &mut session,
            "act",
            json!({"verb": "remove_from", "rows": row, "args": format!("from: {target}")}),
        );
        assert!(not_in.contains("is not in"), "{not_in}");
    }
    let found = numbers(&mut session, &[("photo", "Hike"), ("folder", "Taxes")]);
    let wrong = text(
        &mut session,
        "act",
        json!({"verb": "add_to", "rows": found[0], "args": format!("to: {}", found[1])}),
    );
    assert!(
        wrong.starts_with("error: a photo goes into a album"),
        "{wrong}"
    );
}

#[test]
fn reschedule_reads_the_row_anchor_and_keeps_the_time() {
    let world = seeded();
    let mut session = world.session();
    let dentist = number(&mut session, "event", "Dentist");
    let earlier = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": dentist, "args": {"to": {"unit": "hour", "rel": -1, "anchor": "row"}}}),
    );
    assert_eq!(
        field_change(&earlier, "date"),
        json!(["2026-10-02T09:00:00", "2026-10-02T08:00:00"]),
        "{}",
        earlier["text"]
    );
    session.user("");
    // The duration (45 minutes) rides along.
    let open = text(&mut session, "open", json!({"row": dentist}));
    assert!(open.contains("duration 45 min"), "{open}");
    let cabin = number(&mut session, "task", "cabin");
    let friday = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": cabin, "args": "to: {\"unit\":\"week\",\"rel\":2,\"weekday\":5}"}),
    );
    assert_eq!(
        field_change(&friday, "date"),
        json!(["2026-10-02T09:00:00", "2026-10-09T09:00:00"]),
        "a day keeps the row's time: {}",
        friday["text"]
    );
    session.user("");
    let same = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": cabin, "args": {"to": {"unit": "week", "rel": 2, "weekday": 5}}}),
    );
    assert!(same.starts_with("already: "), "{same}");
    session.user("");
    let range = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": cabin, "args": {"to": {"unit": "week", "rel": 1}}}),
    );
    assert!(range.contains("is a range"), "{range}");
    let bad = text(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": cabin, "args": {"to": {"unit": "day", "rel": 1, "weekday": 3}}}),
    );
    assert!(
        bad.starts_with("error: could not read the date expression"),
        "{bad}"
    );
    assert!(
        bad.contains("next monday at 2"),
        "the grammar's examples are quoted"
    );
}

#[test]
fn create_writes_every_creatable_kind_and_echoes_its_number() {
    let world = seeded();
    let mut session = world.session();
    let neha = number(&mut session, "person", "Neha Rao");
    for args in [
        json!({"kind": "debt", "name": "taxi", "person": neha, "amount": 18.5, "direction": "owes_me"}),
        json!({"kind": "task", "name": "Call plumber", "date": {"unit": "day", "rel": 1}, "effort": 15}),
        json!({"kind": "event", "name": "Coffee", "date": {"unit": "week", "rel": 1, "weekday": 1, "time": "14:00"}}),
        json!({"kind": "person", "name": "Ada Lovelace", "role": "friend"}),
        json!({"kind": "note", "name": "Packing list", "body": "socks"}),
        json!({"kind": "document", "name": "Receipt", "text": "paid"}),
        json!({"kind": "album", "name": "Autumn"}),
        json!({"kind": "notebook", "name": "Travel"}),
        json!({"kind": "folder", "name": "Medical"}),
        json!({"kind": "list", "name": "Errands"}),
        json!({"kind": "group", "name": "Book club"}),
        json!({"kind": "locker item", "name": "Gym", "type": "membership"}),
    ] {
        let mut args = args;
        let kind = args.as_object_mut().unwrap().remove("kind").unwrap();
        let response = call(
            &mut session,
            "act",
            json!({"verb": "create", "kind": kind, "args": args}),
        );
        let created = diff_rows(&response);
        assert_eq!(created.len(), 1, "{args}: {}", response["text"]);
        assert_eq!(created[0]["change"], "created");
        assert_eq!(created[0]["fields"]["name"][1], args["name"]);
        assert!(
            response["text"].as_str().unwrap().starts_with("created: #"),
            "{}",
            response["text"]
        );
        session.user("");
    }
    // A created container reads back as its own kind, not as a notebook.
    let album = call(
        &mut session,
        "find",
        json!({"kind": "album", "name": "Autumn"}),
    );
    assert_eq!(album["effect"]["rows"].as_array().unwrap().len(), 1);
    let coffee = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Coffee"}),
    );
    assert!(
        coffee["text"]
            .as_str()
            .unwrap()
            .contains("Mon 2026-09-28 14:00 (tomorrow)")
    );
    let balance = call(
        &mut session,
        "answer",
        json!({"op": "balance", "kind": "person", "name": "Neha Rao"}),
    );
    assert!(
        balance["text"].as_str().unwrap().contains("= 144.00 USD"),
        "{}",
        balance["text"]
    );
}

#[test]
fn edit_changes_fields_through_their_commands() {
    let world = seeded();
    let mut session = world.session();
    let cabin = number(&mut session, "task", "cabin");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": "name: Book the lake cabin\neffort: 45\nstatus: in_progress"}),
    );
    assert_eq!(
        field_change(&edited, "name"),
        json!(["Book the cabin", "Book the lake cabin"])
    );
    assert_eq!(field_change(&edited, "effort"), json!([30, 45]));
    assert_eq!(
        field_change(&edited, "status"),
        json!(["open", "in_progress"])
    );
    session.user("");
    let date = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": {"date": {"unit": "day", "rel": 1}}}),
    );
    assert!(date.contains("reschedule"), "{date}");
    session.user("");
    let unknown = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": {"flavour": "x"}}),
    );
    assert!(
        unknown.starts_with("error: tasks have no field \"flavour\". task editable fields:"),
        "{unknown}"
    );
    let bad_enum = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": {"status": "finished"}}),
    );
    assert!(
        bad_enum.contains("open, in_progress, completed, cancelled"),
        "{bad_enum}"
    );
    let same = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": {"effort": 45}}),
    );
    assert!(same.starts_with("already: "), "{same}");
    let person = number(&mut session, "person", "Ray");
    let role = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": person, "args": {"role": "climber", "cadence": 21}}),
    );
    assert_eq!(field_change(&role, "role"), json!([null, "climber"]));
    assert_eq!(field_change(&role, "cadence"), json!([null, 21]));
}

#[test]
fn cancel_log_settle_debt_settle_up_and_reveal() {
    let world = seeded();
    let mut session = world.session();
    let found = numbers(
        &mut session,
        &[("event", "Dentist"), ("event", "Launch party")],
    );
    let already = text(
        &mut session,
        "act",
        json!({"verb": "cancel", "rows": found[1]}),
    );
    assert!(already.starts_with("already: "), "{already}");
    let cancelled = call(
        &mut session,
        "act",
        json!({"verb": "cancel", "rows": found[0]}),
    );
    assert_eq!(
        field_change(&cancelled, "status"),
        json!(["tentative", "cancelled"])
    );

    let ray = number(&mut session, "person", "Ray");
    let bad = text(
        &mut session,
        "act",
        json!({"verb": "log", "rows": ray, "args": "kind: letter"}),
    );
    assert_eq!(
        bad,
        "error: log takes kind: call · message · visit · coffee."
    );
    let logged = call(
        &mut session,
        "act",
        json!({"verb": "log", "rows": ray, "args": "kind: coffee"}),
    );
    assert_eq!(field_change(&logged, "date")[1], "2026-09-27T09:00:00");

    let found = numbers(
        &mut session,
        &[("debt", "lunch"), ("debt", "concert tickets")],
    );
    let again = text(
        &mut session,
        "act",
        json!({"verb": "settle_debt", "rows": found[0]}),
    );
    assert!(
        again.starts_with("already: ") && again.contains("is settled"),
        "{again}"
    );
    let settled = call(
        &mut session,
        "act",
        json!({"verb": "settle_debt", "rows": found[1]}),
    );
    assert_eq!(field_change(&settled, "status"), json!(["open", "settled"]));

    // I paid the 300 cabin split three ways (Ray owes 100); Ray paid 60 of
    // groceries split with me (I owe 30): Ray owes me 70 in Tahoe.
    session.user("");
    let before = text(
        &mut session,
        "answer",
        json!({"op": "balance", "kind": "person", "name": "Ray"}),
    );
    assert!(before.contains("= 70.00 USD"), "{before}");
    let found = numbers(&mut session, &[("person", "Ray"), ("group", "Tahoe")]);
    let up = call(
        &mut session,
        "act",
        json!({"verb": "settle_up", "rows": found[0], "args": format!("group: {}", found[1])}),
    );
    assert!(
        up["text"]
            .as_str()
            .unwrap()
            .contains("settlement: 70.00 USD paid to you"),
        "{}",
        up["text"]
    );
    session.user("");
    let even = text(
        &mut session,
        "act",
        json!({"verb": "settle_up", "rows": found[0], "args": format!("group: {}", found[1])}),
    );
    assert!(
        even.starts_with("already: ") && even.contains("settled up"),
        "{even}"
    );

    let wifi = number(&mut session, "locker item", "wifi");
    let nothing = text(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": wifi, "args": "field: cvv"}),
    );
    assert!(
        nothing.contains("has no cvv. It holds: password."),
        "{nothing}"
    );
    let revealed = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": wifi, "args": "field: password"}),
    );
    assert!(
        revealed["text"]
            .as_str()
            .unwrap()
            .ends_with("password: hunter2"),
        "{}",
        revealed["text"]
    );
    assert!(
        diff_rows(&revealed).is_empty(),
        "a reveal writes only its receipt"
    );
}

#[test]
fn undo_reverts_the_whole_previous_turn_once() {
    let world = seeded();
    let mut session = world.session();
    let found = numbers(&mut session, &[("task", "cabin"), ("task", "Pay rent")]);
    call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": found[0], "more": true}),
    );
    call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": found[1], "more": "true"}),
    );
    call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": {"name": "Celebrate"}}),
    );
    session.user("undo that");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    let rows = diff_rows(&undone);
    assert_eq!(rows.len(), 3, "{}", undone["text"]);
    assert_eq!(
        rows.iter()
            .filter(|row| row["fields"]["status"] == json!(["completed", "open"]))
            .count(),
        2
    );
    assert!(rows.iter().any(|row| row["change"] == "trashed"));
    session.user("undo again");
    let twice = text(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(twice, "error: nothing to undo");
}

#[test]
fn undo_with_nothing_before_it_is_an_error() {
    let world = seeded();
    let mut session = world.session();
    session.user("undo");
    assert_eq!(
        text(&mut session, "act", json!({"verb": "undo"})),
        "error: nothing to undo"
    );
    session.user("look");
    call(&mut session, "find", json!({"kind": "task"}));
    session.user("undo");
    assert_eq!(
        text(&mut session, "act", json!({"verb": "undo"})),
        "error: nothing to undo"
    );
}

#[test]
fn more_keeps_the_turn_open_and_act_then_answer_works() {
    let world = seeded();
    let mut session = world.session();
    let cabin = number(&mut session, "task", "cabin");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": cabin, "more": true}),
    );
    assert_eq!(done["ends_turn"], false);
    let left = call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "status = open"}),
    );
    assert_eq!(left["ends_turn"], true);
    let answered = ids(&left["effect"]["answer"]["rows"]);
    assert!(!answered.is_empty());
    assert!(!answered.contains(&world.id("cabin")));
}

#[test]
fn a_suffixed_amount_creates_a_debt() {
    let world = seeded();
    let mut session = world.session();
    let neha = number(&mut session, "person", "Neha Rao");
    session.user("neha owes me 2.5k for the course");
    let response = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "debt", "args": {
            "name": "course", "person": neha, "amount": "2.5k", "direction": "owes_me"}}),
    );
    let made = response["text"].as_str().unwrap();
    assert!(made.starts_with("created: #"), "{made}");
    assert!(made.contains("2500"), "{made}");
}
