//! The pending write: park, confirm, dismiss, stale, one per session, undo (#1088, R-1088-2,
//! R-1088-6, R-1088-10).
//!
//! A session in `Writes::Park` plans a turn's writes against a patched world and ends the turn
//! with ONE pending write (`effect.pending`). Nothing reaches the vault until `confirm`, which runs
//! the steps through the door, in order, and reads the after-write observation back from the
//! vault. These tests drive that on the fixture world.

mod common;

use centraid_nativetools::park::{Confirmed, Writes};
use centraid_nativetools::vaultio::{Handle, SetClock};
use centraid_nativetools::{Flags, Session};
use common::{World, call, journal, number, seeded};
use serde_json::{Value, json};

fn park(world: &World) -> Session {
    world.session_with(
        common::TODAY,
        Flags {
            writes: Writes::Park,
            ..Flags::default()
        },
    )
}

fn pending_id(response: &Value) -> String {
    response["effect"]["pending"]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("the turn ended without a pending write: {response}"))
        .to_owned()
}

fn text(response: &Value) -> String {
    response["text"].as_str().expect("a text").to_owned()
}

/// How many times a command has been answered `executed` in the vault's journal.
fn executed(world: &World, command: &str) -> usize {
    journal(world)
        .get(&(command.to_owned(), "executed".to_owned()))
        .copied()
        .unwrap_or(0)
}

/// Another writer: a command the vault takes while a card waits.
fn elsewhere(world: &World, command: &str, input: Value) {
    let handle = Handle::open(world.path(), SetClock::at(1_900_000_000_000), "elsewhere")
        .expect("the vault opens");
    handle
        .must(command, input)
        .expect("the other writer's command runs");
}

/// A turn that completes the fixture's `cabin` task: the card it ends in, and the text it showed.
fn complete_cabin(session: &mut Session) -> (Value, String) {
    let row = number(session, "task", "cabin");
    let response = call(session, "act", json!({"verb": "complete", "rows": row}));
    let shown = text(&response);
    (response, shown)
}

#[test]
fn a_turn_that_writes_ends_in_one_pending_write() {
    let world = seeded();
    let before = journal(&world);
    let mut session = park(&world);
    let (response, shown) = complete_cabin(&mut session);
    assert_eq!(response["ends_turn"], json!(true));
    let pending = &response["effect"]["pending"];
    assert_eq!(pending["verbs"], json!(["complete"]));
    assert_eq!(pending["preview"], json!([shown]));
    assert_eq!(
        pending["steps"][0]["command"],
        json!("schedule.set_task_status")
    );
    assert_eq!(pending["destructive"], json!(false));
    assert_eq!(
        session.pending().map(|p| p.id.clone()),
        Some(pending_id(&response))
    );
    assert_eq!(journal(&world), before, "a parked write reaches no table");
}

#[test]
fn a_write_that_is_not_the_last_call_waits_for_the_turn_to_end() {
    let world = seeded();
    let mut session = park(&world);
    let row = number(&mut session, "task", "cabin");
    let first = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": row, "more": true}),
    );
    assert_eq!(first["ends_turn"], json!(false));
    assert!(first["effect"].get("pending").is_none(), "{first}");
    let last = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "cabin"}),
    );
    pending_id(&last);
}

#[test]
fn confirm_runs_the_steps_and_shows_what_the_vault_did() {
    // single-write turns of several verbs: the real after-write text is the parked text
    let cases: &[(&str, Value)] = &[
        ("task", json!({"verb": "complete"})),
        (
            "event",
            json!({"verb": "reschedule", "args": {"to": {"unit": "day", "rel": 1}}}),
        ),
        ("person", json!({"verb": "star"})),
        ("document", json!({"verb": "delete"})),
        (
            "note",
            json!({"verb": "edit", "args": {"body+": "and salt"}}),
        ),
    ];
    let subjects = [
        ("task", "cabin"),
        ("event", "Dentist"),
        ("person", "Benedikt"),
        ("document", "Lease"),
        ("note", "Dal"),
    ];
    for ((kind, args), (_, name)) in cases.iter().zip(subjects) {
        let world = seeded();
        let before = journal(&world);
        let mut session = park(&world);
        let row = number(&mut session, kind, name);
        let mut act = args.clone();
        act["rows"] = json!(row);
        let response = call(&mut session, "act", act);
        let shown = text(&response);
        let id = pending_id(&response);
        let Confirmed::Done {
            text: real,
            steps,
            diff,
        } = session.confirm(&id)
        else {
            panic!("{kind} {name}: {shown}");
        };
        assert_eq!(
            real, shown,
            "{kind} {name}: the real observation is the parked one"
        );
        assert_eq!(steps, 1);
        assert!(
            !diff["rows"].as_array().expect("rows").is_empty(),
            "{kind}: the real diff"
        );
        assert_ne!(
            journal(&world),
            before,
            "{kind} {name}: the vault was written"
        );
        assert!(session.pending().is_none());
    }
}

#[test]
fn a_chain_confirms_call_by_call_to_the_text_each_call_showed() {
    let world = seeded();
    let (added, ticked) = (
        executed(&world, "schedule.add_task"),
        executed(&world, "schedule.set_task_status"),
    );
    let mut session = park(&world);
    session.user("add a task to renew the passport and tick it off");
    let made = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: Renew passport", "more": true}),
    );
    let n = format!("#{}", made["effect"]["created"][0]["n"]);
    let done = call(&mut session, "act", json!({"verb": "complete", "rows": n}));
    let id = pending_id(&done);
    let parked = format!("{}\n{}", text(&made), text(&done));
    assert_eq!(
        executed(&world, "schedule.add_task"),
        added,
        "nothing ran while parked"
    );
    let Confirmed::Done {
        text: real, steps, ..
    } = session.confirm(&id)
    else {
        panic!("the chain did not confirm");
    };
    assert_eq!(steps, 2);
    assert_eq!(
        real, parked,
        "the vault's after-write texts are the parked ones"
    );
    assert_eq!(executed(&world, "schedule.add_task"), added + 1);
    assert_eq!(executed(&world, "schedule.set_task_status"), ticked + 1);
}

#[test]
fn dismiss_leaves_the_vault_and_the_session_as_they_were() {
    let world = seeded();
    let before = journal(&world);
    let mut session = park(&world);
    let (response, _) = complete_cabin(&mut session);
    let id = pending_id(&response);
    assert!(session.dismiss(&id));
    assert!(session.pending().is_none());
    assert!(!session.dismiss(&id), "a card is dismissed once");
    assert_eq!(
        session.confirm(&id),
        Confirmed::Unknown,
        "a dismissed card cannot be confirmed"
    );
    assert_eq!(journal(&world), before);
    // the session reads the vault again: the task is open, and there is nothing to undo
    session.user("undo that");
    let undo = call(&mut session, "act", json!({"verb": "undo"}));
    assert!(
        text(&undo).starts_with("error: nothing to undo"),
        "{}",
        text(&undo)
    );
    session.user("what is open");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    assert!(text(&found).contains("status open"), "{}", text(&found));
}

#[test]
fn a_row_changed_since_planning_makes_the_confirm_stale() {
    let world = seeded();
    let ticked = executed(&world, "schedule.set_task_status");
    let mut session = park(&world);
    let (response, _) = complete_cabin(&mut session);
    let id = pending_id(&response);
    elsewhere(
        &world,
        "schedule.edit_task",
        json!({"task_id": world.id("cabin"), "title": "cabin, rebooked"}),
    );
    let Confirmed::Stale { rows } = session.confirm(&id) else {
        panic!("a changed row must make the card stale");
    };
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert!(rows[0].starts_with("task "), "{rows:?}");
    assert_eq!(
        executed(&world, "schedule.set_task_status"),
        ticked,
        "a stale card writes nothing"
    );
    assert!(session.pending().is_none(), "and is not offered again");
}

#[test]
fn a_new_message_dismisses_the_pending_write() {
    let world = seeded();
    let before = journal(&world);
    let ticked = executed(&world, "schedule.set_task_status");
    let mut session = park(&world);
    let (first, _) = complete_cabin(&mut session);
    let id = pending_id(&first);
    session.user("never mind, what is due this week");
    assert!(session.pending().is_none(), "one pending write per session");
    assert_eq!(session.confirm(&id), Confirmed::Unknown);
    assert_eq!(journal(&world), before);
    // a second card replaces the first for good
    let (second, _) = complete_cabin(&mut session);
    let second_id = pending_id(&second);
    assert_ne!(second_id, id);
    assert!(matches!(
        session.confirm(&second_id),
        Confirmed::Done { .. }
    ));
    assert_eq!(executed(&world, "schedule.set_task_status"), ticked + 1);
}

#[test]
fn a_confirm_sent_twice_writes_once() {
    let world = seeded();
    let mut session = park(&world);
    let (response, _) = complete_cabin(&mut session);
    let id = pending_id(&response);
    let first = session.confirm(&id);
    assert!(matches!(first, Confirmed::Done { .. }));
    let count = journal(&world);
    assert_eq!(session.confirm(&id), first, "the same answer");
    assert_eq!(journal(&world), count, "and no second write");
}

#[test]
fn a_step_the_vault_refuses_is_typed_and_names_what_landed() {
    let world = seeded();
    let mut session = park(&world);
    session.user("book coffee with Ray");
    let response = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "event", "args": {"name": "Coffee", "date": {"unit": "week", "rel": 1, "weekday": 1, "time": "14:00"}}}),
    );
    let id = pending_id(&response);
    let step = &session.pending().expect("pending").steps[0];
    // someone else takes the hour while the card waits: no row it addresses has changed
    elsewhere(
        &world,
        "schedule.propose_event",
        json!({
            "summary": "Meeting", "dtstart": step.input["dtstart"], "dtend": step.input["dtend"],
            "calendar_id": step.input["calendar_id"],
        }),
    );
    match session.confirm(&id) {
        Confirmed::Refused {
            step,
            predicate,
            landed,
            ..
        } => {
            assert_eq!(step, 0);
            assert_eq!(predicate, "no_busy_conflict");
            assert_eq!(landed, 0);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn undo_parks_too_and_takes_back_a_confirmed_batch() {
    let world = seeded();
    let (deletes, restores) = (
        executed(&world, "schedule.delete_task"),
        executed(&world, "schedule.restore_task"),
    );
    let mut session = park(&world);
    let row = number(&mut session, "task", "cabin");
    let deleted = call(&mut session, "act", json!({"verb": "delete", "rows": row}));
    let id = pending_id(&deleted);
    assert_eq!(deleted["effect"]["pending"]["destructive"], json!(true));
    assert!(matches!(session.confirm(&id), Confirmed::Done { .. }));
    assert_eq!(executed(&world, "schedule.delete_task"), deletes + 1);
    // the next message takes it back: the undo is a card of its own
    session.user("undo that");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert!(text(&undone).starts_with("undone:"), "{}", text(&undone));
    assert_eq!(undone["effect"]["pending"]["verbs"], json!(["undo"]));
    assert_eq!(
        executed(&world, "schedule.restore_task"),
        restores,
        "the undo waits for its tap"
    );
    let id = pending_id(&undone);
    assert!(matches!(session.confirm(&id), Confirmed::Done { .. }));
    assert_eq!(executed(&world, "schedule.restore_task"), restores + 1);
}

#[test]
fn an_id_only_the_vault_can_name_is_replaced_in_the_later_steps() {
    // `people.add_debt` takes no id: the patch makes one up for the card, and a later step of the
    // same turn names it. The vault's own id takes its place when the first step has run.
    let world = seeded();
    let mut session = park(&world);
    let neha = number(&mut session, "person", "Neha Rao");
    let made = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "debt", "args": {"name": "taxi", "person": neha, "amount": 18.5, "direction": "owes_me"}, "more": true}),
    );
    let debt = format!("#{}", made["effect"]["created"][0]["n"]);
    let parked_id = made["effect"]["created"][0]["id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let settled = call(
        &mut session,
        "act",
        json!({"verb": "settle_debt", "rows": debt}),
    );
    let id = pending_id(&settled);
    let Confirmed::Done { text: real, .. } = session.confirm(&id) else {
        panic!("the chain did not confirm");
    };
    assert_eq!(real, format!("{}\n{}", text(&made), text(&settled)));
    // the vault holds one debt called taxi, settled, under an id of its own
    let mut fresh = world.session();
    fresh.user("");
    let found = call(&mut fresh, "find", json!({"kind": "debt", "name": "taxi"}));
    let rows = found["effect"]["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{}", found["text"]);
    assert_ne!(rows[0]["id"].as_str(), Some(parked_id.as_str()));
    assert!(text(&found).contains("status settled"), "{}", text(&found));
}
