//! nt14 (#1044, owner ruling 2026-10-06): a group's balance asked with no person named is the
//! user's own position in that group, as if `linked_to` named the user, with
//! `note: your balance (no person named)`. A person named (by the call or the message) is
//! unchanged; a group the user is not in stays the error. The default is a resolution, so it is
//! off under `--no-normalize` like nt12/nt13's (the replay of an author's bad steps).

mod common;

use centraid_nativetools::Flags;
use centraid_nativetools::vaultio::{Handle, SetClock};
use common::{World, call, find_in_turn, seeded_with};
use serde_json::{Value, json};

const NOTE: &str = "note: your balance (no person named)";

fn text(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

/// The fixture plus a group the user is not in.
fn world() -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    world["groups"].as_array_mut().expect("groups").push(
        json!({"key": "club", "name": "Book Club", "members": ["ray", "benedikt"], "created": "2026-03-01T09:00"}),
    );
    seeded_with(&world)
}

fn replay(world: &World) -> centraid_nativetools::Session {
    world.session_with(
        common::TODAY,
        Flags {
            normalize: false,
            ..Flags::default()
        },
    )
}

/// A turn that leaves Ray in focus, then the user's own question about the group.
fn with_ray_in_focus(session: &mut centraid_nativetools::Session, message: &str) {
    session.user("find ray");
    call(
        session,
        "find",
        json!({"kind": "person", "name": "Ray Ochoa"}),
    );
    session.user(message);
}

fn group_balance() -> Value {
    json!({"op": "balance", "kind": "group", "name": "Tahoe Trip"})
}

#[test]
fn nt14_a_group_balance_with_no_person_is_the_users_with_a_note() {
    let world = world();
    let mut session = world.session();
    session.user("where am i in the tahoe trip");
    let reply = call(&mut session, "compute", group_balance());
    assert!(!text(&reply).contains("error:"), "{reply}");
    assert!(text(&reply).contains(NOTE), "{reply}");
    assert!(text(&reply).contains("Sam Park"), "{reply}");
    let me = common::number(&mut session, "person", "Sam Park");
    session.user("and the tahoe trip balance");
    let named = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip", "linked_to": me}),
    );
    assert_eq!(
        reply["effect"]["value"]["values"],
        named["effect"]["value"]["values"]
    );
    assert!(!text(&named).contains(NOTE), "{named}");
}

#[test]
fn nt14_a_person_only_in_focus_does_not_make_the_balance_theirs() {
    let world = world();
    let mut session = world.session();
    with_ray_in_focus(&mut session, "where am i in it");
    let reply = call(&mut session, "compute", group_balance());
    assert!(!text(&reply).contains("error:"), "{reply}");
    assert!(text(&reply).contains(NOTE), "{reply}");
    assert!(
        text(&reply).contains("Sam Park") && !text(&reply).contains("Ray Ochoa"),
        "{reply}"
    );
}

#[test]
fn nt14_a_group_picked_by_number_or_by_focus_is_the_same() {
    let world = world();
    let mut session = world.session();
    with_ray_in_focus(&mut session, "what's the balance in the group");
    let group = find_in_turn(&mut session, "group", "Tahoe Trip");
    let by_number = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "rows": group}),
    );
    assert!(text(&by_number).contains(NOTE), "{by_number}");
    assert!(text(&by_number).contains("Sam Park"), "{by_number}");
    // the group is a result of the turn before (`within`): no name, no number in the call
    session.user("and where am i in it");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "group", "name": "Tahoe Trip"}),
    );
    let result = found["effect"]["result"]
        .as_str()
        .expect("a result")
        .to_owned();
    let by_result = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "within": result}),
    );
    assert!(!text(&by_result).contains("error:"), "{by_result}");
    assert!(text(&by_result).contains(NOTE), "{by_result}");
}

#[test]
fn nt14_a_person_the_call_names_is_unchanged() {
    let world = world();
    let mut session = world.session();
    with_ray_in_focus(&mut session, "and ray in the tahoe trip");
    let ray = common::number(&mut session, "person", "Ray Ochoa");
    let reply = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip", "linked_to": ray}),
    );
    assert!(text(&reply).contains("Ray Ochoa"), "{reply}");
    assert!(!text(&reply).contains(NOTE), "{reply}");
}

#[test]
fn nt14_a_person_the_message_names_or_a_pronoun_for_them_is_not_the_users() {
    let world = world();
    // the message names Ray: the runtime adds him (nt12 R1), never the user
    let mut session = world.session();
    with_ray_in_focus(&mut session, "what does ray owe in the tahoe trip");
    let reply = call(&mut session, "compute", group_balance());
    assert!(text(&reply).contains("Ray Ochoa"), "{reply}");
    assert!(!text(&reply).contains(NOTE), "{reply}");
    // a pronoun for them, no name: still not guessed
    let mut session = world.session();
    with_ray_in_focus(&mut session, "what does he owe in the tahoe trip");
    let reply = call(&mut session, "compute", group_balance());
    assert!(
        text(&reply).starts_with("error: a group's balance is one person's"),
        "{reply}"
    );
}

#[test]
fn nt14_a_group_the_user_is_not_in_stays_the_error() {
    let world = world();
    // the user left the club (it has no ledger rows, so they are no longer on its roster)
    let handle = Handle::open(world.path(), SetClock::at(1_800_000_000_000), "nt14:leave")
        .expect("the vault opens");
    handle
        .must("tally.leave_group", json!({"group_id": world.id("club")}))
        .expect("the user leaves");
    drop(handle);
    let mut session = world.session();
    with_ray_in_focus(&mut session, "where am i in the book club");
    let reply = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Book Club"}),
    );
    assert!(
        text(&reply).starts_with("error: a group's balance is one person's"),
        "{reply}"
    );
    assert!(!text(&reply).contains(NOTE), "{reply}");
}

#[test]
fn nt14_off_under_no_normalize() {
    let world = world();
    // the person is in focus only: the error it was, and a balance the old way has no note
    let mut session = replay(&world);
    with_ray_in_focus(&mut session, "where am i in it");
    let reply = call(&mut session, "compute", group_balance());
    assert!(
        text(&reply).starts_with("error: a group's balance is one person's"),
        "{reply}"
    );
    let mut session = replay(&world);
    session.user("where am i in the tahoe trip");
    let reply = call(&mut session, "compute", group_balance());
    assert!(!text(&reply).contains("error:"), "{reply}");
    assert!(!text(&reply).contains(NOTE), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// N1: a name and a day that fit no row, while the name fits rows of the kind

#[test]
fn nt14_n1_a_name_and_a_day_that_fit_nothing_answer_with_the_day_the_row_is_on() {
    let world = world();
    for tool in ["find", "answer"] {
        let mut session = world.session();
        session.user("is the dentist still on the 6th");
        let reply = call(
            &mut session,
            tool,
            json!({"kind": "event", "name": "Dentist", "when": {"date": "2026-10-06"}}),
        );
        assert!(text(&reply).contains("Dentist"), "{tool}: {reply}");
        assert!(
            text(&reply).contains("note: none Tue 2026-10-06; Dentist is on Fri 2026-10-02"),
            "{tool}: {reply}"
        );
        if tool == "find" {
            assert_eq!(reply["effect"]["rows"].as_array().map(Vec::len), Some(1));
        }
    }
}

#[test]
fn nt14_n1_never_without_a_name_and_off_under_no_normalize() {
    let world = world();
    let mut session = world.session();
    session.user("what is on the 6th");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "when": {"date": "2026-10-06"}}),
    );
    assert!(!text(&reply).contains("note: none"), "{reply}");
    assert_eq!(reply["effect"]["rows"].as_array().map(Vec::len), Some(0));
    let mut session = replay(&world);
    session.user("is the dentist still on the 6th");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Dentist", "when": {"date": "2026-10-06"}}),
    );
    assert!(!text(&reply).contains("note: none"), "{reply}");
    assert_eq!(reply["effect"]["rows"].as_array().map(Vec::len), Some(0));
}

// ---------------------------------------------------------------------------------------------
// N2: the balance of a debt

#[test]
fn nt14_n2_a_debts_balance_is_its_open_amount() {
    let world = world();
    let mut session = world.session();
    session.user("how much is left on the concert tickets");
    let debt = find_in_turn(&mut session, "debt", "concert tickets");
    let reply = call(
        &mut session,
        "compute",
        json!({"op": "balance", "rows": debt}),
    );
    assert!(!text(&reply).contains("error:"), "{reply}");
    assert!(
        text(&reply).contains("25.50 USD") && text(&reply).contains("they owe you"),
        "{reply}"
    );
    // by name, and a settled debt has nothing open
    let settled = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "debt", "name": "lunch"}),
    );
    assert!(
        text(&settled).contains("0.00 USD") && text(&settled).contains("settled"),
        "{settled}"
    );
    // under --no-normalize it is the error it was
    let mut session = replay(&world);
    session.user("how much is left on the concert tickets");
    let debt = find_in_turn(&mut session, "debt", "concert tickets");
    let error = call(
        &mut session,
        "compute",
        json!({"op": "balance", "rows": debt}),
    );
    assert!(
        text(&error).starts_with("error: balance is defined for person and for group"),
        "{error}"
    );
}

// ---------------------------------------------------------------------------------------------
// N3: a row of another kind stays the error while no kind of it is linked to a group

#[test]
fn nt14_n3_a_row_linked_to_no_group_is_the_error_it_was() {
    let world = world();
    let mut session = world.session();
    session.user("balance of the dentist");
    let event = find_in_turn(&mut session, "event", "Dentist");
    let reply = call(
        &mut session,
        "compute",
        json!({"op": "balance", "rows": event}),
    );
    assert!(
        text(&reply).starts_with("error: balance is defined for person and for group"),
        "{reply}"
    );
}

// ---------------------------------------------------------------------------------------------
// N4: reveal field synonyms

#[test]
fn nt14_n4_a_synonym_of_a_secrets_name_is_read_as_the_field() {
    let world = world();
    let mut session = world.session();
    session.user("show the pw of the bank login");
    let bank = find_in_turn(&mut session, "locker_item", "Bank login");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": bank, "args": "field: pw"}),
    );
    assert!(
        text(&reply).contains("note: read field pw as password"),
        "{reply}"
    );
    assert!(text(&reply).contains("s3cret"), "{reply}");
    // `pin` and the unknown stay the error
    session.user("and its pin");
    let pin = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": bank, "args": "field: pin"}),
    );
    assert!(
        text(&pin).starts_with("error: reveal takes field:"),
        "{pin}"
    );
    assert!(!text(&pin).contains("note: read field"), "{pin}");
    // off under --no-normalize
    let mut session = replay(&world);
    session.user("show the pw of the bank login");
    let bank = find_in_turn(&mut session, "locker_item", "Bank login");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": bank, "args": "field: pw"}),
    );
    assert!(
        text(&reply).starts_with("error: reveal takes field:"),
        "{reply}"
    );
}

#[test]
fn nt14_n4_the_table_is_closed() {
    use centraid_nativetools::meta::reveal_synonym;
    for (word, field) in [
        ("2fa", "code"),
        ("OTP", "code"),
        ("totp", "code"),
        ("authenticator", "code"),
        ("auth code", "code"),
        ("cvc", "cvv"),
        ("cvv2", "cvv"),
        ("security code", "cvv"),
        ("card", "card_number"),
        ("card no", "card_number"),
        ("card num", "card_number"),
        ("pass", "password"),
        ("pw", "password"),
    ] {
        assert_eq!(reveal_synonym(word), Some(field), "{word}");
    }
    for word in ["pin", "password", "secret", ""] {
        assert_eq!(reveal_synonym(word), None, "{word}");
    }
}

// ---------------------------------------------------------------------------------------------
// N5: a task's due date given as a range is the range's first day

#[test]
fn nt14_n5_a_task_due_in_a_month_is_due_on_its_first_day() {
    let world = world();
    let november = json!({"unit": "month", "name": 11, "rel": 0});
    let mut session = world.session();
    session.user("push the report outline to november");
    let outline = find_in_turn(&mut session, "task", "Report outline");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": outline, "args": format!("to: {november}")}),
    );
    assert!(
        text(&reply).contains("note: read 2026-11-01..2026-11-30 as its first day, Sun 2026-11-01"),
        "{reply}"
    );
    assert!(!text(&reply).contains("is a range"), "{reply}");
    // a create too
    session.user("add a task renew passport in november");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": format!("name: Renew passport\ndate: {november}")}),
    );
    assert!(text(&created).contains("as its first day"), "{created}");
    assert!(!text(&created).contains("error:"), "{created}");
    // an event keeps the refusal, and `--no-normalize` keeps it for a task
    session.user("move the dentist to november");
    let dentist = find_in_turn(&mut session, "event", "Dentist");
    let event = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": dentist, "args": format!("to: {november}")}),
    );
    assert!(!text(&event).contains("first day"), "{event}");
    let mut session = replay(&world);
    session.user("push the report outline to november");
    let outline = find_in_turn(&mut session, "task", "Report outline");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": outline, "args": format!("to: {november}")}),
    );
    assert!(text(&reply).contains("is a range"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// N6: kinship words through a person's role and nickname

fn kin_world() -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    let people = world["people"].as_array_mut().expect("people");
    people.push(json!({"key": "ravi", "name": "Ravi Menon", "role": "Father"}));
    people.push(json!({"key": "lata", "name": "Lata Menon", "nickname": "Amma"}));
    people.push(json!({"key": "meena", "name": "Meena Iyer", "role": "Mother-in-law"}));
    seeded_with(&world)
}

#[test]
fn nt14_n6_a_kinship_word_is_the_one_person_whose_role_or_nickname_it_is() {
    let world = kin_world();
    for word in ["dad", "papá", "Papa", "daddy"] {
        let mut session = world.session();
        session.user("call my dad");
        let found = call(
            &mut session,
            "find",
            json!({"kind": "person", "name": word}),
        );
        assert!(text(&found).contains("Ravi Menon"), "{word}: {found}");
        assert!(
            text(&found).contains("matched \"Ravi Menon\""),
            "{word}: {found}"
        );
    }
    let mut session = world.session();
    session.user("call ammi");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "ammi"}),
    );
    assert!(text(&found).contains("Lata Menon"), "{found}");
    // `mother-in-law` is not `mother`; with none, the path of a name nothing reaches
    let mut session = world.session();
    session.user("call mom");
    let none = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "mom"}),
    );
    assert!(!text(&none).contains("Meena Iyer"), "{none}");
    assert_eq!(
        none["effect"]["rows"].as_array().map(Vec::len),
        Some(0),
        "{none}"
    );
    // off under --no-normalize
    let mut session = replay(&world);
    session.user("call my dad");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "dad"}),
    );
    assert_eq!(
        found["effect"]["rows"].as_array().map(Vec::len),
        Some(0),
        "{found}"
    );
}

#[test]
fn nt14_n6_several_people_stay_unresolved_and_nana_is_a_name_when_the_vault_has_one() {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    let people = world["people"].as_array_mut().expect("people");
    people.push(json!({"key": "a", "name": "Ravi Menon", "role": "Father"}));
    people.push(json!({"key": "b", "name": "Joe Park", "role": "dad"}));
    let world = seeded_with(&world);
    let mut session = world.session();
    session.user("call my dad");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "dad"}),
    );
    assert_eq!(
        found["effect"]["rows"].as_array().map(Vec::len),
        Some(0),
        "{found}"
    );
    // nobody is called nana: grandma reaches the one with the role; with a Nana in the vault
    // the nickname is a name, not a role of the grandmother
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    let people = world["people"].as_array_mut().expect("people");
    people.push(json!({"key": "a", "name": "Rosa Park", "role": "Grandmother"}));
    people.push(json!({"key": "b", "name": "Joan Lee", "nickname": "Nana"}));
    let world = seeded_with(&world);
    let mut session = world.session();
    session.user("call grandma");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "grandma"}),
    );
    assert!(
        text(&found).contains("Rosa Park") && !text(&found).contains("Joan Lee"),
        "{found}"
    );
}

// ---------------------------------------------------------------------------------------------
// N9: an exact time on notes is the part of the day around it

#[test]
fn nt14_n9_an_exact_time_that_reaches_no_note_is_the_part_of_the_day() {
    let world = world();
    let mut session = world.session();
    session.user("what did i write on the evening of the 25th");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "note", "when": {"date": "2026-09-25", "time": "19:00"}}),
    );
    assert!(text(&reply).contains("Diary entry"), "{reply}");
    assert!(
        text(&reply).contains("note: read 19:00 as the evening"),
        "{reply}"
    );
    // 08:00 on the 10th is the morning
    let morning = call(
        &mut session,
        "find",
        json!({"kind": "note", "when": {"date": "2026-09-10", "time": "07:00"}}),
    );
    assert!(text(&morning).contains("Dal"), "{morning}");
    assert!(
        text(&morning).contains("note: read 07:00 as the morning"),
        "{morning}"
    );
    // events keep their exact time; `--no-normalize` keeps the exact time for notes
    let event = call(
        &mut session,
        "find",
        json!({"kind": "event", "when": {"date": "2026-10-02", "time": "10:00"}}),
    );
    assert!(!text(&event).contains("note: read"), "{event}");
    let mut session = replay(&world);
    session.user("what did i write on the evening of the 25th");
    let exact = call(
        &mut session,
        "find",
        json!({"kind": "note", "when": {"date": "2026-09-25", "time": "19:00"}}),
    );
    assert_eq!(
        exact["effect"]["rows"].as_array().map(Vec::len),
        Some(0),
        "{exact}"
    );
}
