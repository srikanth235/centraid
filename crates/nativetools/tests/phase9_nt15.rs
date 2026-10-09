//! nt15 (#1044, owner ruling 2026-10-06): the runtime batch R1 to R5 and N1b.
//!
//! R1 names the repair in the four errors that left the model sending the same call again
//! (a note count on a task, `within: #1, #2`, a `linked_to` with a row that is no link, a reveal
//! of a field the item does not hold); R1s makes "asked for X, revealed Y" impossible within a
//! turn; R2 shows a short body whole and adds the append form `body+:`; R3 widens what the
//! grounding lists (an ordinal day, two days of one month, near spellings, a fair menu, a joined
//! name, a bare hour after "to"); R4 asks about a part-of-name row only for a majority of the
//! name's words; R5 leaves a trashed row named earlier out of "who else is in the trash";
//! N1b narrows nt14's N1 to one day and to rows ahead.
//!
//! Each best-effort repair is off under `--no-normalize` (the replay of an author's bad steps,
//! which stay the errors they were); R1s and the display and error texts are not.

mod common;

use centraid_nativetools::{Flags, Session};
use common::{World, call, find_in_turn, ids, numbers, seeded_with};
use serde_json::{Value, json};

fn text(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

fn world_with(edit: impl FnOnce(&mut Value)) -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    edit(&mut world);
    seeded_with(&world)
}

fn push(world: &mut Value, section: &str, row: Value) {
    world[section].as_array_mut().expect("a section").push(row);
}

fn flagged(world: &World, flags: Flags) -> Session {
    world.session_with(common::TODAY, flags)
}

/// A session with the best-effort repairs off.
fn replay(world: &World) -> Session {
    flagged(
        world,
        Flags {
            normalize: false,
            ..Flags::default()
        },
    )
}

/// A session without the asks the runtime composes: the legacy replies.
fn uncomposed(world: &World) -> Session {
    flagged(
        world,
        Flags {
            compose: false,
            ..Flags::default()
        },
    )
}

/// The `dates:` line of a message, or `None`.
fn dates(session: &mut Session, message: &str) -> Option<String> {
    session.user(message)["dates"].as_str().map(str::to_owned)
}

fn vault_line(session: &mut Session, message: &str) -> String {
    session.user(message)["preground"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn rows_of(response: &Value) -> Vec<String> {
    response["effect"]["rows"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|row| row["id"].as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// R1a: a task's or an event's notes are its description

fn described() -> World {
    world_with(|world| {
        world["tasks"][0]["description"] = json!("ask about the parking");
        world["events"][1]["description"] = json!("bring the x-rays");
    })
}

#[test]
fn nt15_r1a_a_note_count_on_a_task_is_a_condition_on_its_description() {
    let world = described();
    let mut session = world.session();
    session.user("tasks with no notes");
    let none = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "note count = 0"}),
    );
    assert!(!text(&none).contains("error:"), "{none}");
    assert!(
        text(&none).contains(
            "note: read note count = 0 as description is empty (a task's notes are its description)"
        ),
        "{none}"
    );
    assert!(!rows_of(&none).contains(&world.id("cabin")), "{none}");
    assert!(rows_of(&none).contains(&world.id("pay")), "{none}");
    let some = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "notes count > 0"}),
    );
    assert_eq!(rows_of(&some), vec![world.id("cabin")], "{some}");
    assert!(text(&some).contains("as description is set"), "{some}");
    // the other condition of the where stays
    let both = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "note count >= 1 and status = open"}),
    );
    assert_eq!(rows_of(&both), vec![world.id("cabin")], "{both}");
}

#[test]
fn nt15_r1a_an_event_the_same() {
    let world = described();
    let mut session = world.session();
    session.user("events with notes");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "event", "where": "note count != 0"}),
    );
    assert!(
        text(&reply).contains("an event's notes are its description"),
        "{reply}"
    );
    assert_eq!(
        reply["effect"]["answer"]["rows"][0]["id"],
        world.id("dentist"),
        "{reply}"
    );
}

#[test]
fn nt15_r1a_a_count_that_is_neither_empty_nor_set_stays_the_error_that_names_the_repair() {
    let world = described();
    let mut session = world.session();
    session.user("tasks with two notes");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "note count = 2"}),
    );
    assert!(
        text(&reply).starts_with("error: tasks are not linked to notes."),
        "{reply}"
    );
    assert!(
        text(&reply).contains(
            "A task's notes are its description: where description is empty (or is set, or contains"
        ),
        "{reply}"
    );
}

#[test]
fn nt15_r1a_off_under_no_normalize_the_error_names_the_repair() {
    let world = described();
    let mut session = replay(&world);
    session.user("tasks with no notes");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "note count = 0"}),
    );
    assert!(text(&reply).starts_with("error:"), "{reply}");
    assert!(
        text(&reply).contains("A task's notes are its description: where description is empty"),
        "{reply}"
    );
    assert!(!text(&reply).contains("note: read"), "{reply}");
}

#[test]
fn nt15_r1a_a_link_to_notes_from_a_task_or_an_event_names_the_repair() {
    let world = described();
    let mut session = world.session();
    session.user("notes of the cabin task");
    let dal = common::find_in_turn(&mut session, "note", "Dal");
    // a call that names a note row has no use of the sentence about notes in general
    let tasks = call(
        &mut session,
        "find",
        json!({"kind": "task", "linked_to": dal}),
    );
    assert!(
        text(&tasks).starts_with("tasks are not linked to notes."),
        "{tasks}"
    );
    assert!(!text(&tasks).contains("are its description"), "{tasks}");
    let cabin = common::find_in_turn(&mut session, "task", "Book the cabin");
    let notes = call(
        &mut session,
        "find",
        json!({"kind": "note", "linked_to": cabin}),
    );
    assert!(
        text(&notes).contains("A task's notes are its description, not linked rows"),
        "{notes}"
    );
}

// ---------------------------------------------------------------------------------------------
// R1b: `within: #43, #44` is a list of rows

#[test]
fn nt15_r1b_a_list_of_rows_in_within_is_rows() {
    let world = seeded_with_fixture();
    let mut session = world.session();
    session.user("the first two tasks");
    let found = numbers(
        &mut session,
        &[("task", "Book the cabin"), ("task", "Pay rent")],
    );
    let list = format!("{}, {}", found[0], found[1]);
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "within": list}),
    );
    assert!(!text(&reply).contains("error:"), "{reply}");
    assert!(
        text(&reply).contains(&format!(
            "note: within takes a result (@n); used rows: {list}"
        )),
        "{reply}"
    );
    let mut got = ids(&reply["effect"]["answer"]["rows"]);
    got.sort();
    let mut want = vec![world.id("cabin"), world.id("pay")];
    want.sort();
    assert_eq!(got, want, "{reply}");
    // a count over the same rows
    session.user("how many of those");
    let count = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "within": list}),
    );
    assert!(!text(&count).contains("error:"), "{count}");
}

fn seeded_with_fixture() -> World {
    common::seeded()
}

#[test]
fn nt15_r1b_the_error_names_the_repair_when_it_is_not_normalised() {
    let world = common::seeded();
    // off under --no-normalize
    let mut session = replay(&world);
    session.user("the first two tasks");
    let found = numbers(
        &mut session,
        &[("task", "Book the cabin"), ("task", "Pay rent")],
    );
    let list = format!("{}, {}", found[0], found[1]);
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "within": list}),
    );
    assert!(
        text(&reply).starts_with(&format!(
            "error: \"{list}\" is not a result; results are @n."
        )),
        "{reply}"
    );
    assert!(
        text(&reply).contains(&format!("use rows: {list}.")),
        "{reply}"
    );
    // a `where` beside it is not normalised either: rows and a selector are not combined
    let mut session = world.session();
    session.user("the first two tasks");
    let found = numbers(
        &mut session,
        &[("task", "Book the cabin"), ("task", "Pay rent")],
    );
    let list = format!("{}, {}", found[0], found[1]);
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "within": list, "where": "status = open"}),
    );
    assert!(
        text(&reply).contains(&format!("use rows: {list}.")),
        "{reply}"
    );
    // a find has no rows: its error names the answer
    session.user("the first two tasks");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "task", "within": list}),
    );
    assert!(
        text(&reply).contains(&format!("answer rows: {list}.")),
        "{reply}"
    );
    // a row that was never shown is not rewritten
    session.user("the first two tasks");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "within": "#900, #901"}),
    );
    assert!(text(&reply).contains("use rows: #900, #901"), "{reply}");
    assert!(!text(&reply).contains("note: within"), "{reply}");
    // a text that is no list of rows has no such sentence
    session.user("the first two tasks");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "within": "foo"}),
    );
    assert!(!text(&reply).contains("use rows"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// R1c: which rows of a `linked_to` are links for the kind

/// photos link to albums and people; the fixture's photo `Beach day` has Neha Rao in it.
fn mixed_links(session: &mut Session) -> (String, String, String) {
    session.user("photos of neha and the dentist");
    let ids = numbers(
        session,
        &[
            ("person", "Neha Rao"),
            ("event", "Dentist"),
            ("task", "Pay rent"),
        ],
    );
    (ids[0].clone(), ids[1].clone(), ids[2].clone())
}

#[test]
fn nt15_r1c_a_linked_to_keeps_the_rows_that_are_links_for_the_kind() {
    let world = common::seeded();
    let mut session = world.session();
    let (neha, dentist, rent) = mixed_links(&mut session);
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "photo", "linked_to": format!("{neha}, {dentist}, {rent}")}),
    );
    assert!(!text(&reply).contains("not linked"), "{reply}");
    assert_eq!(rows_of(&reply), vec![world.id("beach")], "{reply}");
    assert!(
        text(&reply).contains(&format!(
            "note: used linked_to {neha}; ignored {dentist} event, {rent} task (photos link to"
        )),
        "{reply}"
    );
}

#[test]
fn nt15_r1c_with_no_valid_row_the_reply_names_which_are_not_links() {
    let world = common::seeded();
    let mut session = world.session();
    let (_, dentist, rent) = mixed_links(&mut session);
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "photo", "linked_to": format!("{dentist}, {rent}")}),
    );
    assert!(
        text(&reply).starts_with("photos are not linked to events."),
        "{reply}"
    );
    assert!(
        text(&reply).contains(&format!(
            "{dentist} event and {rent} task are not valid links for photos."
        )),
        "{reply}"
    );
}

#[test]
fn nt15_r1c_not_normalised_the_reply_says_which_rows_are_valid_and_which_are_not() {
    let world = common::seeded();
    let mut session = replay(&world);
    let (neha, dentist, rent) = mixed_links(&mut session);
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "photo", "linked_to": format!("{dentist}, {neha}, {rent}")}),
    );
    assert!(
        text(&reply).contains(&format!(
            "{neha} person is a valid link for photos; {dentist} event and {rent} task are not."
        )),
        "{reply}"
    );
    assert!(!text(&reply).contains("note: used linked_to"), "{reply}");
    // one row named: the reply is what it was
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "photo", "linked_to": dentist}),
    );
    assert!(!text(&reply).contains("valid link"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// R1d: a reveal of an unknown field lists what THIS row holds

fn with_mail() -> World {
    world_with(|world| {
        push(
            world,
            "locker",
            json!({"key": "mail", "name": "Mail login", "type": "login", "username": "sam", "password": "pw-mail", "code": "123456"}),
        );
        push(
            world,
            "locker",
            json!({"key": "visa", "name": "Visa card", "type": "card", "card_number": "4111111111111111", "cvv": "737"}),
        );
    })
}

#[test]
fn nt15_r1d_an_unknown_field_lists_the_fields_the_row_holds() {
    let world = with_mail();
    let mut session = world.session();
    session.user("show the pin of the mail login");
    let mail = find_in_turn(&mut session, "locker_item", "Mail login");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": mail, "args": "field: pin"}),
    );
    assert!(
        text(&reply).starts_with("error: reveal takes field:"),
        "{reply}"
    );
    assert!(
        text(&reply).contains("this login holds: password, code."),
        "{reply}"
    );
    assert!(
        !text(&reply).contains("card_number") && !text(&reply).contains("cvv"),
        "{reply}"
    );
    session.user("and the pin of the wifi");
    let wifi = find_in_turn(&mut session, "locker_item", "Home wifi");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": wifi, "args": "field: pin"}),
    );
    assert!(
        text(&reply).contains("this wifi holds: password."),
        "{reply}"
    );
    session.user("and the pin of the visa");
    let visa = find_in_turn(&mut session, "locker_item", "Visa card");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": visa, "args": "field: pin"}),
    );
    assert!(
        text(&reply).contains("this card holds: card_number, cvv."),
        "{reply}"
    );
}

// ---------------------------------------------------------------------------------------------
// R1s: a different secret is never revealed after a refusal, unless the message names it

fn reveal(session: &mut Session, item: &str, field: &str) -> Value {
    call(
        session,
        "act",
        json!({"verb": "reveal", "kind": "locker item", "name": item, "args": format!("field: {field}")}),
    )
}

#[test]
fn nt15_r1s_after_a_refusal_another_secret_is_not_revealed_and_the_turn_ends_in_an_ask() {
    let world = with_mail();
    let mut session = world.session();
    session.user("what is the pin of the mail login");
    let refused = reveal(&mut session, "Mail login", "pin");
    assert!(
        text(&refused).starts_with("error: reveal takes field:"),
        "{refused}"
    );
    let second = reveal(&mut session, "Mail login", "password");
    assert!(!text(&second).contains("pw-mail"), "{second}");
    assert!(!text(&second).contains("123456"), "{second}");
    assert_eq!(second["ends_turn"], true, "{second}");
    assert_eq!(
        second["effect"]["ask"]["question"], "Which one do you want: password or code?",
        "{second}"
    );
    assert!(
        text(&second).contains("pin was asked for first"),
        "{second}"
    );
    assert_eq!(
        second["effect"]["compose"]["family"], "reveal_other_field",
        "{second}"
    );
    assert_eq!(
        second["effect"]["ask"]["options"][0]["id"],
        world.id("mail"),
        "{second}"
    );
    // nothing was revealed and nothing was written
    assert!(second["effect"].get("revealed").is_none(), "{second}");
}

#[test]
fn nt15_r1s_the_secret_a_message_names_is_not_held_back() {
    let world = with_mail();
    // the password was asked for too: it is revealed after the refusal for the pin
    let mut session = world.session();
    session.user("what are the pin and the password of the mail login");
    let refused = reveal(&mut session, "Mail login", "pin");
    assert!(text(&refused).starts_with("error:"), "{refused}");
    let second = reveal(&mut session, "Mail login", "password");
    assert!(text(&second).contains("password: pw-mail"), "{second}");
    // an N4 synonym of a secret the message names reaches it the same way
    let mut session = world.session();
    session.user("the pin and the 2fa of the mail login");
    reveal(&mut session, "Mail login", "pin");
    let second = reveal(&mut session, "Mail login", "code");
    assert!(text(&second).contains("code: 123456"), "{second}");
    let mut session = world.session();
    session.user("the pin and the pw of the mail login");
    reveal(&mut session, "Mail login", "pin");
    let second = reveal(&mut session, "Mail login", "password");
    assert!(text(&second).contains("password: pw-mail"), "{second}");
}

#[test]
fn nt15_r1s_a_reveal_by_a_name_or_a_synonym_with_no_refusal_works() {
    let world = with_mail();
    let mut session = world.session();
    session.user("what is the 2fa of the mail login");
    let reply = reveal(&mut session, "Mail login", "2fa");
    assert!(
        text(&reply).contains("note: read field 2fa as code"),
        "{reply}"
    );
    assert!(text(&reply).contains("code: 123456"), "{reply}");
    session.user("and the pw");
    let reply = reveal(&mut session, "Mail login", "pw");
    assert!(text(&reply).contains("password: pw-mail"), "{reply}");
}

#[test]
fn nt15_r1s_asked_for_the_code_of_a_wifi_the_password_is_not_revealed() {
    // the wifi keeps a password and no code: `2fa` is read as `code` (N4), which it lacks; the
    // password is a secret nobody asked for
    let world = common::seeded();
    let mut session = world.session();
    session.user("what is the 2fa of the home wifi");
    let refused = reveal(&mut session, "Home wifi", "2fa");
    assert!(
        text(&refused).contains("Home wifi\" has no code. It holds: password."),
        "{refused}"
    );
    // the error does not offer the call for the password
    assert!(!text(&refused).contains("Send"), "{refused}");
    let second = reveal(&mut session, "Home wifi", "password");
    assert!(!text(&second).contains("hunter2"), "{second}");
    assert_eq!(second["ends_turn"], true, "{second}");
    assert_eq!(
        second["effect"]["ask"]["question"], "Do you want the password?",
        "{second}"
    );
    // the next turn, asked for by name: it is revealed
    session.user("the password then");
    let third = reveal(&mut session, "Home wifi", "password");
    assert!(text(&third).contains("password: hunter2"), "{third}");
}

#[test]
fn nt15_r1s_the_hint_to_send_the_held_secret_is_for_a_message_that_names_it() {
    let world = common::seeded();
    let mut session = world.session();
    session.user("what is the cvv or the password of the home wifi");
    let refused = reveal(&mut session, "Home wifi", "cvv");
    assert!(
        text(&refused).contains("Send act verb: reveal"),
        "{refused}"
    );
    let mut session = world.session();
    session.user("what is the cvv of the home wifi");
    let refused = reveal(&mut session, "Home wifi", "cvv");
    assert!(text(&refused).contains("It holds: password."), "{refused}");
    assert!(!text(&refused).contains("Send"), "{refused}");
}

#[test]
fn nt15_r1s_without_the_composed_asks_it_is_an_error_naming_the_field_asked_first() {
    let world = with_mail();
    let mut session = uncomposed(&world);
    session.user("what is the pin of the mail login");
    reveal(&mut session, "Mail login", "pin");
    let second = reveal(&mut session, "Mail login", "password");
    assert!(
        text(&second).starts_with("error: pin was asked for first,"),
        "{second}"
    );
    assert!(!text(&second).contains("pw-mail"), "{second}");
    assert_eq!(second["ends_turn"], false, "{second}");
}

#[test]
fn nt15_r1s_a_repeat_of_the_field_refused_and_another_item_are_not_held_back() {
    let world = with_mail();
    let mut session = world.session();
    session.user("what is the pin of the mail login and the wifi");
    reveal(&mut session, "Mail login", "pin");
    // another item: the refusal was about the mail login
    let wifi = reveal(&mut session, "Home wifi", "password");
    assert!(text(&wifi).contains("password: hunter2"), "{wifi}");
}

#[test]
fn nt15_r1s_holds_under_no_normalize_too() {
    // it is a safety rule, not a repair: the replay keeps it
    let world = with_mail();
    let mut session = replay(&world);
    session.user("what is the pin of the mail login");
    reveal(&mut session, "Mail login", "pin");
    let second = reveal(&mut session, "Mail login", "password");
    assert!(!text(&second).contains("pw-mail"), "{second}");
}

// ---------------------------------------------------------------------------------------------
// R2a: short bodies and descriptions are shown whole

fn long_text(length: usize) -> String {
    let mut out = String::new();
    while out.chars().count() < length {
        out.push_str("lentils ");
    }
    out.chars().take(length).collect()
}

#[test]
fn nt15_r2a_a_body_or_description_of_200_characters_or_fewer_is_shown_whole() {
    let exact = long_text(200);
    let over = long_text(201);
    let world = world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "exact", "name": "Exact note", "body": exact, "created": "2026-09-11T08:00"}),
        );
        push(
            world,
            "notes",
            json!({"key": "over", "name": "Over note", "body": over, "created": "2026-09-12T08:00"}),
        );
        world["tasks"][0]["description"] =
            json!("ask about the parking, the key and the deposit before the weekend");
        world["events"][0]["description"] = json!(
            "bring the x-rays and the insurance card and a list of questions for the dentist"
        );
    });
    let mut session = world.session();
    session.user("my notes");
    let found = call(&mut session, "find", json!({"kind": "note"}));
    assert!(
        text(&found).contains(&format!("body \"{exact}\"")),
        "{found}"
    );
    let cut: String = over.chars().take(60).collect();
    assert!(
        text(&found).contains(&format!("body \"{cut}…\"")),
        "{found}"
    );
    assert!(!text(&found).contains(&over), "{found}");
    session.user("the cabin task");
    let tasks = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Book the cabin"}),
    );
    assert!(
        text(&tasks).contains(
            "description \"ask about the parking, the key and the deposit before the weekend\""
        ),
        "{tasks}"
    );
    session.user("the tabla class");
    let events = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Tabla"}),
    );
    assert!(
        text(&events).contains("description \"bring the x-rays and the insurance card and a list of questions for the dentist\""),
        "{events}"
    );
    // an open row shows them too
    session.user("open the cabin task");
    let cabin = find_in_turn_task(&mut session);
    let open = call(&mut session, "open", json!({"row": cabin}));
    assert!(
        text(&open).contains(
            "description \"ask about the parking, the key and the deposit before the weekend\""
        ),
        "{open}"
    );
}

fn find_in_turn_task(session: &mut Session) -> String {
    find_in_turn(session, "task", "Book the cabin")
}

#[test]
fn nt15_r2a_any_other_text_keeps_the_short_cut() {
    let role = long_text(100);
    let world = world_with(|world| {
        world["people"][0]["role"] = json!(role);
    });
    let mut session = world.session();
    session.user("neha");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha Rao"}),
    );
    let cut: String = role.chars().take(60).collect();
    assert!(
        text(&found).contains(&format!("role \"{cut}…\"")),
        "{found}"
    );
}

#[test]
fn nt15_r2a_a_restore_shows_the_body_it_brings_back() {
    let world = world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "gone", "name": "Old shopping", "body": "milk, eggs", "created": "2026-09-11T08:00", "trashed": "2026-09-25T09:00"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "gone_task", "name": "Old chore", "description": "wipe the shelves", "trashed": "2026-09-25T09:00"}),
        );
    });
    let mut session = world.session();
    session.user("bring back the old shopping note");
    let note = common::trashed_number(&mut session, "note", "Old shopping");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": note}),
    );
    assert!(
        text(&reply).contains("back from the trash · body \"milk, eggs\""),
        "{reply}"
    );
    session.user("and the old chore");
    let task = common::trashed_number(&mut session, "task", "Old chore");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": task}),
    );
    assert!(
        text(&reply).contains("back from the trash · description \"wipe the shelves\""),
        "{reply}"
    );
}

// ---------------------------------------------------------------------------------------------
// R2b: the append form

fn appendable() -> World {
    world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "shop", "name": "Shopping", "body": "milk, eggs, bread", "created": "2026-09-20T08:00"}),
        );
        push(
            world,
            "notes",
            json!({"key": "pack", "name": "Packing", "body": "- socks\n- hat", "created": "2026-09-21T08:00"}),
        );
        push(
            world,
            "notes",
            json!({"key": "lines", "name": "Chores", "body": "sweep\nmop", "created": "2026-09-22T08:00"}),
        );
        push(
            world,
            "notes",
            json!({"key": "prose", "name": "Plan", "body": "Call the plumber on Friday.", "created": "2026-09-23T08:00"}),
        );
        push(
            world,
            "notes",
            json!({"key": "semi", "name": "Parts", "body": "washer; o-ring", "created": "2026-09-24T08:00"}),
        );
        push(
            world,
            "notes",
            json!({"key": "blank", "name": "Blank", "created": "2026-09-24T09:00"}),
        );
        world["tasks"][0]["description"] = json!("ask about the parking");
    })
}

fn edit_note(session: &mut Session, name: &str, args: &str) -> Value {
    call(
        session,
        "act",
        json!({"verb": "edit", "kind": "note", "name": name, "args": args}),
    )
}

#[test]
fn nt15_r2b_body_plus_adds_to_the_text_with_the_separator_the_text_uses() {
    let world = appendable();
    let mut session = world.session();
    session.user("add oat milk to the shopping note");
    let reply = edit_note(&mut session, "Shopping", "body+: oat milk");
    assert!(!text(&reply).contains("error:"), "{reply}");
    // the reply shows the new text whole
    assert!(
        text(&reply).contains("body \"milk, eggs, bread\" → \"milk, eggs, bread, oat milk\""),
        "{reply}"
    );
    // lines: a new line, and the bullet the lines carry
    session.user("add a scarf to packing");
    let reply = edit_note(&mut session, "Packing", "body+: scarf");
    assert!(
        text(&reply).contains("→ \"- socks\n- hat\n- scarf\""),
        "{reply}"
    );
    session.user("add dust to chores");
    let reply = edit_note(&mut session, "Chores", "body+: dust");
    assert!(text(&reply).contains("→ \"sweep\nmop\ndust\""), "{reply}");
    // prose that ends a sentence: a space; semicolons keep theirs
    session.user("add a line to the plan");
    let reply = edit_note(&mut session, "Plan", "body+: Then pay him.");
    assert!(
        text(&reply).contains("→ \"Call the plumber on Friday. Then pay him.\""),
        "{reply}"
    );
    session.user("add a gasket to parts");
    let reply = edit_note(&mut session, "Parts", "body+: gasket");
    assert!(
        text(&reply).contains("→ \"washer; o-ring; gasket\""),
        "{reply}"
    );
}

#[test]
fn nt15_r2b_the_join_is_a_rule_of_the_text() {
    use centraid_nativetools::act::appended;
    assert_eq!(appended("", "first"), "first");
    assert_eq!(appended("  ", "first"), "first");
    assert_eq!(appended("milk, eggs,", "bread"), "milk, eggs, bread");
    assert_eq!(appended("sweep\nmop\n", "dust"), "sweep\nmop\ndust");
    assert_eq!(appended("* a\n* b", "c"), "* a\n* b\n* c");
    assert_eq!(appended("* a\n* b", "* c"), "* a\n* b\n* c");
    assert_eq!(appended("Done. Next", "more"), "Done. Next, more");
    assert_eq!(appended("Done.", "More."), "Done. More.");
    assert_eq!(appended("a; b", "c"), "a; b; c");
    assert_eq!(appended("a, b; c", "d"), "a, b; c, d");
}

#[test]
fn nt15_r2b_a_description_of_a_task_and_what_the_vault_holds_after() {
    let world = appendable();
    let mut session = world.session();
    session.user("add to the cabin task that the code is 1234");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Book the cabin", "args": "description+: the code is 1234"}),
    );
    assert!(
        text(&reply).contains(
            "description \"ask about the parking\" → \"ask about the parking, the code is 1234\""
        ),
        "{reply}"
    );
    // it is one write, which undo reverts
    session.user("undo that");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert!(!text(&undone).contains("error:"), "{undone}");
    assert!(
        text(&undone).contains(
            "description \"ask about the parking, the code is 1234\" → \"ask about the parking\""
        ),
        "{undone}"
    );
    // and a read shows the text whole
    session.user("what is on the cabin task");
    let read = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Book the cabin"}),
    );
    assert!(
        text(&read).contains("description \"ask about the parking\""),
        "{read}"
    );
}

#[test]
fn nt15_r2b_another_word_for_the_text_is_read_and_a_replace_is_still_a_replace() {
    let world = appendable();
    let mut session = world.session();
    session.user("add parking to the cabin task");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Book the cabin", "args": "notes+: and parking"}),
    );
    assert!(
        text(&reply).contains("note: read notes+ as description+"),
        "{reply}"
    );
    assert!(
        text(&reply).contains("→ \"ask about the parking, and parking\""),
        "{reply}"
    );
    // the plain edit of a body is no refusal: it replaces
    session.user("change the shopping note");
    let reply = edit_note(&mut session, "Shopping", "body: tea");
    assert!(text(&reply).contains("→ \"tea\""), "{reply}");
    // off under --no-normalize the alias is the error it was
    let mut session = replay(&world);
    session.user("add parking to the cabin task");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Book the cabin", "args": "notes+: parking"}),
    );
    assert!(
        text(&reply).starts_with("error: only a body or a description takes +:"),
        "{reply}"
    );
}

#[test]
fn nt15_r2b_other_fields_and_empty_text_are_refused() {
    let world = appendable();
    let mut session = world.session();
    session.user("add to the name");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Pay rent", "args": "name+: now"}),
    );
    assert!(
        text(&reply).starts_with("error: only a body or a description takes +:"),
        "{reply}"
    );
    let reply = edit_note(&mut session, "Shopping", "body: tea\nbody+: milk");
    assert!(
        text(&reply).starts_with("error: body and body+ in one edit"),
        "{reply}"
    );
    let reply = edit_note(&mut session, "Shopping", "body+: ");
    assert!(
        text(&reply).starts_with("error: body+ needs the text to add."),
        "{reply}"
    );
}

#[test]
fn nt15_r2b_the_append_is_one_line_of_the_prompt() {
    let world = common::seeded();
    let mut session = world.session();
    let prompt = centraid_nativetools::prompt::prompt(&mut session);
    let rendered = prompt["rendered"].as_str().expect("a prompt");
    let lines: Vec<&str> = rendered
        .lines()
        .filter(|line| line.contains("body+"))
        .collect();
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert!(lines[0].contains("act(verb"), "{lines:?}");
}

// ---------------------------------------------------------------------------------------------
// R3a, R3b, R3e: the `dates:` line

#[test]
fn nt15_r3a_a_bare_ordinal_day_lists_its_readings() {
    let world = common::seeded();
    let mut session = world.session();
    for message in [
        "remind me on the 2nd about rent",
        "is the 2nd free",
        "on the 2nd works",
        "on the 2nd for lunch",
        "the 2nd",
    ] {
        assert_eq!(
            dates(&mut session, message).as_deref(),
            Some("dates: the 2nd = 2026-09-02 (past) / 2026-10-02 (upcoming)"),
            "{message}"
        );
    }
    // the 26th, as before
    assert_eq!(
        dates(&mut session, "on the 26th about rent").as_deref(),
        Some("dates: the 26th = 2026-09-26 (past) / 2026-10-26 (upcoming)")
    );
}

#[test]
fn nt15_r3a_a_position_is_still_no_date() {
    let world = common::seeded();
    let mut session = world.session();
    for message in [
        "on the second one",
        "the 3rd meeting",
        "on the 3rd meeting",
        "the second one",
        "the fifth of those",
        "on the third task",
        "about the 2nd thing",
    ] {
        assert_eq!(dates(&mut session, message), None, "{message}");
    }
}

#[test]
fn nt15_r3b_two_days_of_one_month_are_one_span() {
    let world = common::seeded();
    let mut session = world.session();
    let span = Some(
        "dates: the 21st and 22nd of august = 2026-08-21..2026-08-22 (past) / 2027-08-21..2027-08-22 (upcoming)",
    );
    assert_eq!(
        dates(&mut session, "photos from the 21st and 22nd of august").as_deref(),
        span
    );
    assert_eq!(
        dates(&mut session, "from the 3rd to the 9th of june").as_deref(),
        Some(
            "dates: the 3rd to the 9th of june = 2026-06-03..2026-06-09 (past) / 2027-06-03..2027-06-09 (upcoming)"
        )
    );
    assert_eq!(
        dates(&mut session, "21-22 august").as_deref(),
        Some(
            "dates: 21-22 august = 2026-08-21..2026-08-22 (past) / 2027-08-21..2027-08-22 (upcoming)"
        )
    );
    // a year said is that span alone
    assert_eq!(
        dates(&mut session, "the 21st and 22nd of august 2025").as_deref(),
        Some("dates: the 21st and 22nd of august 2025 = 2025-08-21..2025-08-22")
    );
}

#[test]
fn nt15_r3b_days_that_are_not_next_to_each_other_stay_two_days_in_the_month_named() {
    let world = common::seeded();
    let mut session = world.session();
    // the days between are not meant; the first day is read in the month the second names
    assert_eq!(
        dates(&mut session, "the 5th and the 20th of august").as_deref(),
        Some(
            "dates: the 5th = 2026-08-05 (past) / 2027-08-05 (upcoming) · the 20th of august = 2026-08-20 (past) / 2027-08-20 (upcoming)"
        )
    );
    assert_eq!(
        dates(&mut session, "the 5th or 6th of august").as_deref(),
        Some(
            "dates: the 5th = 2026-08-05 (past) / 2027-08-05 (upcoming) · 6th of august = 2026-08-06 (past) / 2027-08-06 (upcoming)"
        )
    );
}

#[test]
fn nt15_r3e_a_bare_hour_after_to_is_listed_with_both_readings() {
    let world = common::seeded();
    let mut session = world.session();
    assert_eq!(
        dates(&mut session, "move it to one").as_deref(),
        Some("dates: to one = 13:00 (pm) / 01:00 (am)")
    );
    // as the digit does
    assert_eq!(
        dates(&mut session, "move it to 1").as_deref(),
        Some("dates: to 1 = 13:00 (pm) / 01:00 (am)")
    );
    assert_eq!(
        dates(&mut session, "move it to nine").as_deref(),
        Some("dates: to nine = 09:00 (am) / 21:00 (pm)")
    );
    // a number word after "to" that is no time
    for message in [
        "give it to one of them",
        "assign it to one person",
        "what is due to one",
    ] {
        assert_eq!(dates(&mut session, message), None, "{message}");
    }
}

// ---------------------------------------------------------------------------------------------
// R3c, R3d, R3e: what the vault line lists

fn menu_world() -> World {
    world_with(|world| {
        push(
            world,
            "lists",
            json!({"key": "reno", "name": "Kitchen renovation"}),
        );
        for (index, name) in [
            "Work",
            "Work lunch",
            "Work trip",
            "Work notes",
            "Work permit",
            "Work shoes",
            "Work call",
            "Work party",
            "Work review",
        ]
        .iter()
        .enumerate()
        {
            push(
                world,
                "tasks",
                json!({"key": format!("wk{index}"), "name": name, "due": format!("2026-10-{:02}", 10 + index)}),
            );
        }
        push(
            world,
            "albums",
            json!({"key": "brasil", "name": "Brasil 2019"}),
        );
        push(world, "albums", json!({"key": "word", "name": "Word"}));
        push(world, "albums", json!({"key": "prasil", "name": "Prasil"}));
        push(
            world,
            "events",
            json!({"key": "night", "name": "Chess club night", "start": "2026-10-22T19:00"}),
        );
        push(
            world,
            "locker",
            json!({"key": "lg", "name": "Bank login", "type": "login", "username": "sam", "password": "x"}),
        );
        push(world, "people", json!({"key": "weijie", "name": "Wei Jie"}));
        push(
            world,
            "events",
            json!({"key": "recitals", "name": "Recitals night", "start": "2026-10-20T19:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "recital_one", "name": "Recital", "start": "2026-10-21T19:00"}),
        );
    })
}

fn vault_rows(line: &str) -> usize {
    line.trim_start_matches("vault: ").split(" · ").count()
}

#[test]
fn nt15_r3d_a_rare_word_keeps_a_slot_when_a_common_word_fills_the_cap() {
    let world = menu_world();
    let mut session = world.session();
    let line = vault_line(&mut session, "put the work stuff in the reno list");
    assert!(line.contains("list \"Kitchen renovation\""), "{line}");
    assert!(line.contains("task \"Work\""), "{line}");
    assert!(vault_rows(&line) <= 8, "{line}");
    // the word that reaches nothing is not served, and the common word still fills its slots
    let line = vault_line(&mut session, "show work");
    assert!(!line.contains("Kitchen renovation"), "{line}");
    assert_eq!(vault_rows(&line), 8, "{line}");
}

#[test]
fn nt15_r3c_a_near_spelling_brings_the_row_in_at_a_lower_tier() {
    let world = menu_world();
    let mut session = world.session();
    // brazil is one edit from Brasil, and no row has a word it starts
    let line = vault_line(&mut session, "photos from brazil");
    assert!(line.contains("album \"Brasil 2019\""), "{line}");
    // two letters swapped is one edit too
    let line = vault_line(&mut session, "photos from brasli");
    assert!(line.contains("album \"Brasil 2019\""), "{line}");
    let line = vault_line(&mut session, "photos from brazli");
    assert!(!line.contains("Brasil"), "{line}");
    let line = vault_line(&mut session, "photos from brasill");
    assert!(line.contains("album \"Brasil 2019\""), "{line}");
    // the row a word reaches exactly comes first, a near spelling after it
    let line = vault_line(&mut session, "brazil work");
    assert!(
        line.find("Work").expect("a row") < line.find("Brasil 2019").expect("a row"),
        "{line}"
    );
    // a word that reaches a row as it is said has no near spellings: the recitals are the
    // night, and `Recital` is the plain singular of the word
    let line = vault_line(&mut session, "when are the recitals");
    assert!(line.contains("event \"Recitals night\""), "{line}");
    assert!(!line.contains("event \"Recital\""), "{line}");
    // a word of four or five letters is no near spelling (`work` is not `Word`)
    let line = vault_line(&mut session, "show work");
    assert!(!line.contains("album \"Word\""), "{line}");
    let line = vault_line(&mut session, "is that right");
    assert!(!line.contains("Chess club night"), "{line}");
    // the first letter is not the one that slips (`krasil` is one edit from both, and neither)
    let line = vault_line(&mut session, "photos from krasil");
    assert!(
        !line.contains("Brasil") && !line.contains("Prasil"),
        "{line}"
    );
    // a kind of the vault is a category, not a name
    let line = vault_line(&mut session, "which logins are there");
    assert!(!line.contains("login"), "{line}");
    // two edits away is none either
    let line = vault_line(&mut session, "photos from brazzzil");
    assert!(!line.contains("Brasil"), "{line}");
}

#[test]
fn nt15_r3e_a_joined_name_reaches_a_spaced_one() {
    let world = menu_world();
    let mut session = world.session();
    let line = vault_line(&mut session, "what is weijie's number");
    assert!(line.contains("person \"Wei Jie\""), "{line}");
    // one edit from the joined name
    let line = vault_line(&mut session, "what is weijia's number");
    assert!(line.contains("person \"Wei Jie\""), "{line}");
    let line = vault_line(&mut session, "what is weston's number");
    assert!(!line.contains("Wei Jie"), "{line}");
}

// ---------------------------------------------------------------------------------------------
// R4: a part-of-name write needs more than half of the name's words

fn renewals() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "car", "name": "Renew car insurance", "due": "2026-10-20"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "card", "name": "Renew library card", "due": "2026-10-22"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "photos", "name": "Passport photos", "due": "2026-10-25"}),
        );
    })
}

fn complete(name: &str) -> Value {
    json!({"verb": "complete", "kind": "task", "name": name})
}

#[test]
fn nt15_r4_a_write_that_shares_one_of_two_words_is_a_decline_not_a_which_one() {
    let world = renewals();
    let mut session = world.session();
    session.user("renew the passport");
    let reply = call(&mut session, "act", complete("renew passport"));
    assert_eq!(reply["effect"]["tool"], "decline", "{reply}");
    assert_eq!(reply["effect"]["decline"]["reason"], "not_found", "{reply}");
    assert!(common::diff_rows(&reply).is_empty(), "{reply}");
    // the article is no content word
    let mut session = world.session();
    session.user("renew the passport");
    let reply = call(&mut session, "act", complete("renew the passport"));
    assert_eq!(reply["effect"]["tool"], "decline", "{reply}");
}

#[test]
fn nt15_r4_more_than_half_of_the_words_is_still_asked_about() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "pass_renew", "name": "Renew passport online", "due": "2026-10-20"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "pass_book", "name": "Passport renewal booking", "due": "2026-10-21"}),
        );
    });
    // two of the three words of the name: more than half
    let mut session = world.session();
    session.user("renew the passport online today");
    let reply = call(&mut session, "act", complete("renew passport online today"));
    assert_ne!(reply["effect"]["tool"], "decline", "{reply}");
    assert!(
        !reply["effect"]["ambiguous"].is_null() || reply["effect"]["tool"] == "ask",
        "{reply}"
    );
}

#[test]
fn nt15_r4_a_read_keeps_half_and_a_replay_keeps_the_ask() {
    let world = renewals();
    let mut session = world.session();
    session.user("renew passport");
    let read = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "renew passport"}),
    );
    assert!(text(&read).contains("near spellings: #"), "{read}");
    assert!(text(&read).contains("Renew car insurance"), "{read}");
    // `--no-normalize`: the ask over the rows that share a word, as before
    let mut session = replay(&world);
    session.user("renew passport");
    let reply = call(&mut session, "act", complete("renew passport"));
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
}

// ---------------------------------------------------------------------------------------------
// R5: "who else is in the trash" leaves out the trashed row named earlier

fn trash_world() -> World {
    world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "ravi", "name": "Ravi Menon", "trashed": "2026-09-24T09:00"}),
        );
        push(
            world,
            "people",
            json!({"key": "priya", "name": "Priya Nair", "trashed": "2026-09-25T09:00"}),
        );
    })
}

#[test]
fn nt15_r5_a_trashed_person_named_earlier_is_left_out_of_who_else_is_in_the_trash() {
    let world = trash_world();
    let mut session = world.session();
    // the trash is listed once, so its rows are numbered; the turn after names one and shows none
    session.user("what is in the trash");
    call(
        &mut session,
        "find",
        json!({"kind": "person", "trashed": true}),
    );
    session.user("is ravi menon in the trash");
    call(
        &mut session,
        "ask",
        json!({"question": "Do you want him back?"}),
    );
    session.user("who else is in the trash");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "person", "trashed": true}),
    );
    assert!(text(&reply).contains("(excluding #"), "{reply}");
    // Old Contact and Priya Nair are trashed too; Ravi Menon was named
    let mut got = rows_of(&reply);
    got.sort();
    let mut want = vec![world.id("old"), world.id("priya")];
    want.sort();
    assert_eq!(got, want, "{reply}");
}

#[test]
fn nt15_r5_a_trashed_row_the_message_does_not_name_is_not_left_out() {
    let world = trash_world();
    let mut session = world.session();
    session.user("what is in the trash");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "person", "trashed": true}),
    );
    assert!(!text(&reply).contains("excluding"), "{reply}");
    let mut got = rows_of(&reply);
    got.sort();
    let mut want = vec![world.id("old"), world.id("ravi"), world.id("priya")];
    want.sort();
    assert_eq!(got, want, "{reply}");
}

#[test]
fn nt15_r5_the_last_trash_listing_is_what_else_leaves_out() {
    let world = trash_world();
    let mut session = world.session();
    session.user("is ravi menon in the trash");
    let first = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Ravi Menon", "trashed": true}),
    );
    assert_eq!(rows_of(&first), vec![world.id("ravi")], "{first}");
    session.user("who else is in the trash");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "person", "trashed": true}),
    );
    let mut got = rows_of(&reply);
    got.sort();
    let mut want = vec![world.id("old"), world.id("priya")];
    want.sort();
    assert_eq!(got, want, "{reply}");
}

// ---------------------------------------------------------------------------------------------
// N1b: nt14's N1, narrowed to one day and to rows ahead

fn swim() -> World {
    world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "swim_old", "name": "Swim lesson", "start": "2024-03-04T17:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "swim_past", "name": "Swim lesson", "start": "2026-08-04T17:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "vet_old", "name": "Vet visit", "start": "2026-05-04T10:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "vet_far", "name": "Vet visit", "start": "2026-12-14T10:00"}),
        );
    })
}

fn day(unit_rel: i64) -> Value {
    json!({"unit": "day", "rel": unit_rel})
}

#[test]
fn nt15_n1b_one_day_that_reaches_nothing_falls_back_to_the_rows_ahead() {
    let world = swim();
    let mut session = world.session();
    session.user("is the vet visit still on tuesday");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Vet visit", "when": day(2)}),
    );
    // only the visit ahead is offered: the one in May is past
    assert_eq!(rows_of(&reply), vec![world.id("vet_far")], "{reply}");
    assert!(
        text(&reply).contains("note: none Tue 2026-09-29; Vet visit is on Mon 2026-12-14"),
        "{reply}"
    );
    assert!(!text(&reply).contains("2026-05-04"), "{reply}");
}

#[test]
fn nt15_n1b_a_range_that_reaches_nothing_is_empty() {
    let world = swim();
    let mut session = world.session();
    session.user("any vet visits next week");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Vet visit", "when": {"unit": "week", "rel": 1}}),
    );
    assert!(rows_of(&reply).is_empty(), "{reply}");
    assert!(!text(&reply).contains("note: none"), "{reply}");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "event", "name": "Vet visit", "when": {"unit": "week", "rel": 1}}),
    );
    assert!(!text(&reply).contains("2026-12-14"), "{reply}");
}

#[test]
fn nt15_n1b_an_open_window_and_only_past_rows_are_empty() {
    let world = swim();
    let mut session = world.session();
    // "when's the next swim lesson": from today on, and the only lessons are past
    session.user("when's the next swim lesson");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Swim lesson", "when": {"from": day(0)}, "order": "date asc", "limit": 1}),
    );
    assert!(rows_of(&reply).is_empty(), "{reply}");
    assert!(!text(&reply).contains("2024"), "{reply}");
    // one day, but every row of the name is past
    session.user("is swim lesson on friday");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Swim lesson", "when": day(5)}),
    );
    assert!(rows_of(&reply).is_empty(), "{reply}");
    assert!(!text(&reply).contains("note: none"), "{reply}");
}

#[test]
fn nt15_n1b_a_day_with_a_time_is_one_day_and_off_under_no_normalize() {
    let world = swim();
    let mut session = world.session();
    session.user("is the vet visit on tuesday at 10");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Vet visit", "when": {"date": "2026-09-29", "time": "10:00"}}),
    );
    assert_eq!(rows_of(&reply), vec![world.id("vet_far")], "{reply}");
    let mut session = replay(&world);
    session.user("is the vet visit still on tuesday");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Vet visit", "when": day(2)}),
    );
    assert!(rows_of(&reply).is_empty(), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// fixes after the val replay: kind nouns in R4, a guess in R1s, the held names in R1d

#[test]
fn nt15_r4_a_kind_noun_is_no_content_word_of_the_name() {
    let world = world_with(|world| {
        for (key, name) in [("acl", "ACL ticket"), ("concert", "Concert ticket")] {
            push(
                world,
                "debts",
                json!({"key": key, "person": "ray", "direction": "i_owe", "amount": 30, "name": name, "date": "2026-08-01"}),
            );
        }
    });
    let mut session = world.session();
    session.user("settle the ticket IOU");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "settle_debt", "kind": "debt", "name": "ticket IOU"}),
    );
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    let mut got = ids(&reply["effect"]["ask"]["options"]);
    got.sort();
    let mut want = vec![world.id("acl"), world.id("concert")];
    want.sort();
    assert_eq!(got, want, "{reply}");
    // the other words of a name still count
    let world = renewals();
    let mut session = world.session();
    session.user("tick off the passport task");
    let reply = call(&mut session, "act", complete("renew passport task"));
    assert_eq!(reply["effect"]["tool"], "decline", "{reply}");
}

fn with_alarm() -> World {
    world_with(|world| {
        push(
            world,
            "locker",
            json!({"key": "alarm", "name": "Alarm code", "type": "note", "notes": "4721"}),
        );
        push(
            world,
            "locker",
            json!({"key": "mail", "name": "Mail login", "type": "login", "username": "sam", "password": "pw-mail", "code": "123456"}),
        );
    })
}

#[test]
fn nt15_r1s_a_guess_the_message_never_named_is_repaired_to_what_the_item_holds() {
    let world = with_alarm();
    let mut session = world.session();
    session.user("and the alarm code");
    let guess = reveal(&mut session, "Alarm code", "password");
    // the error says what the item holds with the names reveal takes, and offers the call
    assert!(text(&guess).contains("It holds: content."), "{guess}");
    assert!(text(&guess).contains("Send act verb: reveal"), "{guess}");
    let repaired = reveal(&mut session, "Alarm code", "content");
    assert!(text(&repaired).contains("4721"), "{repaired}");
    // notes is the same field
    session.user("and the alarm code again");
    reveal(&mut session, "Alarm code", "password");
    let repaired = reveal(&mut session, "Alarm code", "notes");
    assert!(text(&repaired).contains("4721"), "{repaired}");
}

#[test]
fn nt15_r1s_a_field_the_message_named_still_holds_the_others_back() {
    let world = with_alarm();
    // the person asked for the 2fa: the refusal is theirs, and the password is not revealed
    let mut session = world.session();
    session.user("my 2fa code for the alarm");
    let refused = reveal(&mut session, "Alarm code", "2fa");
    assert!(text(&refused).starts_with("error:"), "{refused}");
    assert!(!text(&refused).contains("Send"), "{refused}");
    let second = reveal(&mut session, "Alarm code", "content");
    assert!(!text(&second).contains("4721"), "{second}");
    assert_eq!(second["ends_turn"], true, "{second}");
    // an unknown field the message said (`pin`) holds as well
    let mut session = world.session();
    session.user("what is the pin of the mail login");
    reveal(&mut session, "Mail login", "pin");
    let second = reveal(&mut session, "Mail login", "password");
    assert!(!text(&second).contains("pw-mail"), "{second}");
    // and the list of an unknown field uses the names reveal takes
    session.user("the alarm pin");
    let unknown = reveal(&mut session, "Alarm code", "pin");
    assert!(
        text(&unknown).contains("this note holds: content."),
        "{unknown}"
    );
}
