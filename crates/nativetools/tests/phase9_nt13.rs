//! nt13 (#1044, iteration 3): resolve more, guess nothing. The runtime fixes what it can fix
//! without a guess and runs the call fixed, with one `note:` line; several readings, egress, a
//! dropped filter and a changed target row the message does not name still ask or error. B1 and
//! B2 are bugs of the readings (on under `--no-normalize` too); R1 to R6 are resolutions (off
//! under `--no-normalize`, the replay of an author's bad steps).

mod common;

use centraid_nativetools::Flags;
use common::{World, call, diff_rows, find_in_turn, ids, seeded, seeded_with};
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

fn replay(world: &World) -> centraid_nativetools::Session {
    world.session_with(
        common::TODAY,
        Flags {
            normalize: false,
            ..Flags::default()
        },
    )
}

// ---------------------------------------------------------------------------------------------
// B1: a stated kind restricts a write's name resolution

#[test]
fn nt13_b1_a_person_that_is_not_one_is_not_a_task_for_a_group() {
    let world = seeded();
    let mut session = world.session();
    session.user("add pay rent to the tahoe trip");
    let tahoe = find_in_turn(&mut session, "group", "Tahoe Trip");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "person", "name": "Pay rent", "args": format!("to: {tahoe}")}),
    );
    assert!(!text(&reply).contains("goes into a"), "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
    assert_eq!(reply["effect"]["refusal"], Value::Null, "{reply}");
    assert_eq!(
        reply["effect"]["compose"]["action"], "decline:not_found",
        "{reply}"
    );
}

#[test]
fn nt13_b1_also_under_no_normalize() {
    let world = seeded();
    let mut session = replay(&world);
    session.user("add pay rent to the tahoe trip");
    let tahoe = find_in_turn(&mut session, "group", "Tahoe Trip");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "person", "name": "Pay rent", "args": format!("to: {tahoe}")}),
    );
    assert!(!text(&reply).contains("goes into a"), "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn nt13_b1_a_name_of_a_row_the_container_holds_still_goes_to_it() {
    // the kind said is wrong, the container is a list: the one task is what goes into it
    let world = seeded();
    let mut session = world.session();
    session.user("put pay rent in home");
    let home = find_in_turn(&mut session, "list", "Home");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "person", "name": "Pay rent", "args": format!("to: {home}")}),
    );
    assert_eq!(
        reply["effect"]["diff"]["links"].as_array().map(Vec::len),
        Some(1),
        "{reply}"
    );
    assert!(text(&reply).contains("applied to"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// B2: a group is selected by the resolver's precedence for a balance

fn two_houses() -> World {
    world_with(|world| {
        push(
            world,
            "groups",
            json!({"key": "house_g", "name": "House", "members": ["ray"]}),
        );
        push(
            world,
            "groups",
            json!({"key": "beach_g", "name": "Beach House 2026", "members": ["ray"]}),
        );
    })
}

#[test]
fn nt13_b2_an_exact_group_name_beats_a_longer_one_in_a_balance() {
    let world = two_houses();
    let mut session = world.session();
    session.user("what is the balance in house");
    let reply = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "House"}),
    );
    assert!(!text(&reply).starts_with("error:"), "{reply}");
    assert!(text(&reply).contains("House"), "{reply}");
    assert!(!text(&reply).contains("Beach"), "{reply}");
}

#[test]
fn nt13_b2_also_under_no_normalize() {
    let world = two_houses();
    let mut session = replay(&world);
    session.user("what is the balance in house");
    let reply = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "House"}),
    );
    assert!(!text(&reply).starts_with("error:"), "{reply}");
}

#[test]
fn nt13_b2_several_rows_on_the_winning_tier_are_still_the_error() {
    let world = seeded();
    let mut session = world.session();
    session.user("what does neha owe");
    let reply = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Neha"}),
    );
    assert!(text(&reply).contains("the selection holds 2"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// R1: an enumerated value

fn lockers() -> World {
    world_with(|world| {
        push(
            world,
            "locker",
            json!({"key": "savings", "name": "Savings account", "type": "bank_account"}),
        );
        push(
            world,
            "locker",
            json!({"key": "licence", "name": "Driving licence", "type": "driving_licence"}),
        );
        push(
            world,
            "locker",
            json!({"key": "software", "name": "Editor licence", "type": "software_licence"}),
        );
    })
}

fn locker_by_type(session: &mut centraid_nativetools::Session, said: &str) -> Value {
    call(
        session,
        "find",
        json!({"kind": "locker_item", "where": format!("type = \"{said}\"")}),
    )
}

#[test]
fn nt13_r1_a_word_of_a_value_is_that_value() {
    let world = lockers();
    let mut session = world.session();
    session.user("my bank items");
    let found = locker_by_type(&mut session, "bank");
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("savings")],
        "{found}"
    );
    assert!(
        text(&found).contains("note: read bank as bank_account"),
        "{found}"
    );
}

#[test]
fn nt13_r1_case_space_and_hyphen_are_no_difference() {
    let world = lockers();
    let mut session = world.session();
    session.user("my bank items");
    let found = locker_by_type(&mut session, "Bank-Account");
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("savings")],
        "{found}"
    );
    assert!(
        text(&found).contains("note: read Bank-Account as bank_account"),
        "{found}"
    );
}

#[test]
fn nt13_r1_one_edit_away_is_that_value() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "gone", "name": "Cancelled gig", "start": "2026-10-09T20:00", "cancelled": true}),
        );
    });
    let mut session = world.session();
    session.user("which events are cancelled");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "event", "where": "status = canceled"}),
    );
    assert!(
        text(&found).contains("note: read canceled as cancelled"),
        "{found}"
    );
    assert!(
        ids(&found["effect"]["rows"]).contains(&world.id("gone")),
        "{found}"
    );
}

#[test]
fn nt13_r1_a_list_and_a_not_equal_are_read_value_by_value() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks that are not done");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status != complete"}),
    );
    assert!(
        text(&found).contains("note: read complete as completed"),
        "{found}"
    );
    assert!(
        !ids(&found["effect"]["rows"]).contains(&world.id("report")),
        "{found}"
    );
    let listed = call(
        &mut session,
        "find",
        json!({"kind": "event", "where": "status in (\"canceled\", \"tentative\")"}),
    );
    assert!(
        text(&listed).contains("note: read canceled as cancelled"),
        "{listed}"
    );
    assert!(
        ids(&listed["effect"]["rows"]).contains(&world.id("party")),
        "{listed}"
    );
}

#[test]
fn nt13_r1_a_prefix_of_a_status_is_that_status() {
    let world = seeded();
    let mut session = world.session();
    session.user("which tasks are done");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = complete"}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("report")],
        "{found}"
    );
    assert!(
        text(&found).contains("note: read complete as completed"),
        "{found}"
    );
}

#[test]
fn nt13_r1_several_values_are_still_the_error() {
    let world = lockers();
    let mut session = world.session();
    session.user("my licences");
    let found = locker_by_type(&mut session, "licence");
    assert!(text(&found).starts_with("error:"), "{found}");
    assert!(text(&found).contains("no value"), "{found}");
}

#[test]
fn nt13_r1_no_value_is_still_the_error() {
    let world = lockers();
    let mut session = world.session();
    session.user("my vehicles");
    let found = locker_by_type(&mut session, "vehicle");
    assert!(text(&found).starts_with("error:"), "{found}");
}

#[test]
fn nt13_r1_an_arg_literal_is_read_the_same_way() {
    let world = seeded();
    let mut session = world.session();
    session.user("add a bank account entry called Savings");
    let made = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "locker_item", "args": "name: Savings\ntype: bank"}),
    );
    assert!(!text(&made).starts_with("error:"), "{made}");
    assert!(
        text(&made).contains("note: read bank as bank_account"),
        "{made}"
    );
    assert_eq!(diff_rows(&made).len(), 1, "{made}");
}

#[test]
fn nt13_r1_an_edit_arg_is_read_the_same_way() {
    let world = seeded();
    let mut session = world.session();
    session.user("the report task is in progress");
    let handle = find_in_turn(&mut session, "task", "outline");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": [handle], "args": "status: in progres"}),
    );
    assert!(!text(&edited).starts_with("error:"), "{edited}");
    assert!(
        text(&edited).contains("note: read in progres as in_progress"),
        "{edited}"
    );
}

fn peso_world() -> World {
    world_with(|world| {
        push(
            world,
            "groups",
            json!({"key": "cancun", "name": "Cancun", "currency": "MXN", "members": ["ray"]}),
        );
    })
}

#[test]
fn nt13_r1_a_currency_name_is_the_one_code_the_vault_holds() {
    let world = peso_world();
    let mut session = world.session();
    session.user("the group in pesos");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "group", "where": "currency = \"pesos\""}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("cancun")],
        "{found}"
    );
    assert!(text(&found).contains("note: read pesos as MXN"), "{found}");
}

#[test]
fn nt13_r1_a_near_code_is_the_one_code_that_fits() {
    let world = peso_world();
    for said in ["MX", "MXP"] {
        let mut session = world.session();
        session.user("the group in pesos");
        let found = call(
            &mut session,
            "find",
            json!({"kind": "group", "where": format!("currency = {said}")}),
        );
        assert_eq!(
            ids(&found["effect"]["rows"]),
            vec![world.id("cancun")],
            "{said}: {found}"
        );
        assert!(
            text(&found).contains(&format!("note: read {said} as MXN")),
            "{said}: {found}"
        );
    }
}

#[test]
fn nt13_r1_a_money_where_takes_a_currency_name() {
    let world = peso_world();
    let mut session = world.session();
    session.user("debts over 5 pesos");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "debt", "where": "amount >= 5 pesos"}),
    );
    assert!(!text(&found).starts_with("error:"), "{found}");
    assert!(text(&found).contains("note: read pesos as MXN"), "{found}");
}

#[test]
fn nt13_r1_a_currency_name_with_no_code_in_the_vault_is_still_the_error() {
    let world = seeded();
    let mut session = world.session();
    session.user("debts over 5 pesos");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "debt", "where": "amount >= 5 pesos"}),
    );
    assert!(text(&found).starts_with("error:"), "{found}");
}

#[test]
fn nt13_r1_a_currency_name_two_held_codes_share_is_still_the_error() {
    let world = world_with(|world| {
        push(
            world,
            "groups",
            json!({"key": "a", "name": "Cancun", "currency": "MXN", "members": []}),
        );
        push(
            world,
            "groups",
            json!({"key": "b", "name": "Bogota", "currency": "COP", "members": []}),
        );
    });
    let mut session = world.session();
    session.user("debts over 5 pesos");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "debt", "where": "amount >= 5 pesos"}),
    );
    assert!(text(&found).starts_with("error:"), "{found}");
}

#[test]
fn nt13_r1_is_off_under_no_normalize() {
    let world = lockers();
    let mut session = replay(&world);
    session.user("my bank items");
    let found = locker_by_type(&mut session, "bank");
    assert!(text(&found).starts_with("error:"), "{found}");
}

// ---------------------------------------------------------------------------------------------
// R2: a text literal that reaches no row is read by the resolver's tiers

fn roles() -> World {
    world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "mil", "name": "Lena Brandt", "role": "Mother-in-law"}),
        );
        push(
            world,
            "people",
            json!({"key": "landlord", "name": "Omar Haddad", "role": "landlord"}),
        );
    })
}

#[test]
fn nt13_r2_hyphens_and_spaces_are_no_difference() {
    let world = roles();
    let mut session = world.session();
    session.user("who is my mother in law");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "role = \"mother in law\""}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("mil")],
        "{found}"
    );
    assert!(
        text(&found).contains("note: read role \"mother in law\" as \"Mother-in-law\""),
        "{found}"
    );
}

#[test]
fn nt13_r2_one_word_typo() {
    let world = roles();
    let mut session = world.session();
    session.user("who is my landlord");
    let found = call(
        &mut session,
        "answer",
        json!({"kind": "person", "where": "role = \"landlrod\""}),
    );
    assert_eq!(
        ids(&found["effect"]["answer"]["rows"]),
        vec![world.id("landlord")],
        "{found}"
    );
    assert!(
        text(&found).contains("note: read role \"landlrod\" as \"landlord\""),
        "{found}"
    );
}

#[test]
fn nt13_r2_an_extra_qualifier_in_the_literal() {
    let world = roles();
    let mut session = world.session();
    session.user("who is my lease landlord");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "role contains \"lease landlord\""}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("landlord")],
        "{found}"
    );
    assert!(
        text(&found).contains("note: read role \"lease landlord\" as \"landlord\""),
        "{found}"
    );
}

#[test]
fn nt13_r2_a_compute_reads_it_too() {
    let world = roles();
    let mut session = world.session();
    session.user("how many mothers in law");
    let found = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person", "where": "role = \"mother in law\""}),
    );
    assert!(text(&found).contains("= 1 "), "{found}");
    assert!(text(&found).contains("note: read role"), "{found}");
}

#[test]
fn nt13_r2_nothing_near_is_still_nothing() {
    let world = roles();
    let mut session = world.session();
    session.user("who is my plumber");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "role = \"plumber\""}),
    );
    assert!(ids(&found["effect"]["rows"]).is_empty(), "{found}");
    assert!(!text(&found).contains("note: read role"), "{found}");
}

#[test]
fn nt13_r2_a_write_acts_when_exactly_one_row_results() {
    let world = roles();
    let mut session = world.session();
    session.user("star my landlord");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "where": "role = \"landlrod\""}),
    );
    assert_eq!(diff_rows(&done).len(), 1, "{done}");
    assert_eq!(diff_rows(&done)[0]["id"], world.id("landlord"), "{done}");
    assert!(
        text(&done).contains("note: read role \"landlrod\" as \"landlord\""),
        "{done}"
    );
}

#[test]
fn nt13_r2_a_write_over_several_rows_does_not_act() {
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "l1", "name": "Omar Haddad", "role": "landlord"}),
        );
        push(
            world,
            "people",
            json!({"key": "l2", "name": "Ines Vogel", "role": "landlord"}),
        );
    });
    let mut session = world.session();
    session.user("star my landlord");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "where": "role = \"landlrod\""}),
    );
    assert!(diff_rows(&done).is_empty(), "{done}");
}

#[test]
fn nt13_r2_is_off_under_no_normalize() {
    let world = roles();
    let mut session = replay(&world);
    session.user("who is my mother in law");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "role = \"mother in law\""}),
    );
    assert!(ids(&found["effect"]["rows"]).is_empty(), "{found}");
}

// ---------------------------------------------------------------------------------------------
// R3: names, normalised on both sides in the resolver tiers

#[test]
fn nt13_r3_an_honorific_is_dropped_when_the_rest_matches() {
    use centraid_nativetools::resolve::{Tier, resolve};
    let tier = |query: &str, name: &str| resolve(query, &[(0, vec![name])]).tier;
    assert_eq!(tier("Dr Rao", "Neha Rao"), Some(Tier::Typo));
    assert_eq!(tier("Rao-san", "Neha Rao"), Some(Tier::Typo));
    assert_eq!(tier("Neha-sensei", "Neha Rao"), Some(Tier::Typo));
    assert_eq!(tier("Prof Neha Rao", "Neha Rao"), Some(Tier::Typo));
    assert_eq!(tier("Neha Rao", "Dr. Neha Rao"), Some(Tier::Contains));
    assert_eq!(tier("Dr Neha", "Prof. Neha Rao"), Some(Tier::Typo));
    // the rest must match
    assert_eq!(tier("Dr Weiss", "Neha Rao"), None);
    // a name that is only the honorific is its own name
    assert_eq!(tier("Dr", "Dr"), Some(Tier::Equal));
}

#[test]
fn nt13_r3_a_light_stem_matches_a_form_of_the_word() {
    use centraid_nativetools::resolve::{Tier, resolve};
    let tier = |query: &str, name: &str| resolve(query, &[(0, vec![name])]).tier;
    assert_eq!(tier("passport renewal", "Renew passport"), Some(Tier::Typo));
    assert_eq!(tier("cabin booking", "Book the cabin"), Some(Tier::Typo));
    assert_eq!(tier("booked cabin", "Book the cabin"), Some(Tier::Typo));
    assert_eq!(tier("payment", "Pay rent"), None);
    // a better tier is never given up
    assert_eq!(tier("cabin", "Book the cabin"), Some(Tier::Contains));
}

#[test]
fn nt13_r3_a_name_the_stems_reach_is_found_with_the_matched_note() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "passport", "name": "Renew passport", "due": "2026-10-20"}),
        );
    });
    let mut session = world.session();
    session.user("passport renewal");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "passport renewal"}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("passport")],
        "{found}"
    );
    assert!(
        text(&found).contains("matched \"Renew passport\" for \"passport renewal\""),
        "{found}"
    );
}

#[test]
fn nt13_r3_a_write_by_an_honorific_name_acts_on_the_one_row() {
    let world = seeded();
    let mut session = world.session();
    session.user("star benedikt-san");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Benedikt-san"}),
    );
    assert_eq!(diff_rows(&done).len(), 1, "{done}");
    assert_eq!(diff_rows(&done)[0]["id"], world.id("benedikt"), "{done}");
    assert!(
        text(&done).contains("matched \"Benedikt Weiss\" for \"Benedikt-san\""),
        "{done}"
    );
}

#[test]
fn nt13_r3_a_possessive_is_dropped_on_both_sides() {
    use centraid_nativetools::resolve::{Tier, resolve};
    let tier = |query: &str, name: &str| resolve(query, &[(0, vec![name])]).tier;
    assert_eq!(tier("Lucas' recital", "Lucas recital"), Some(Tier::Equal));
    assert_eq!(tier("Lucia's recital", "Lucias recital"), Some(Tier::Equal));
}

#[test]
fn nt13_r3_is_off_under_no_normalize() {
    let world = seeded();
    let mut session = replay(&world);
    session.user("star benedikt-san");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Benedikt-san"}),
    );
    assert!(diff_rows(&done).is_empty(), "{done}");
}

// ---------------------------------------------------------------------------------------------
// R4: a container of the wrong kind with the same name as the right one

fn home_note() -> World {
    world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "home_note", "name": "Home", "body": "the house file"}),
        );
    })
}

#[test]
fn nt13_r4_a_destination_of_the_wrong_kind_goes_to_the_container_of_that_name() {
    let world = home_note();
    let mut session = world.session();
    session.user("put pay rent in home");
    let pay = find_in_turn(&mut session, "task", "pay rent");
    let wrong = find_in_turn(&mut session, "note", "home");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "rows": [pay], "args": format!("to: {wrong}")}),
    );
    assert!(!text(&done).starts_with("error:"), "{done}");
    assert!(text(&done).contains("note: used #"), "{done}");
    assert!(text(&done).contains("list \"Home\""), "{done}");
    let links = done["effect"]["diff"]["links"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    assert_eq!(links.len(), 1, "{done}");
}

#[test]
fn nt13_r4_two_containers_of_that_name_are_still_the_error() {
    let world = world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "home_note", "name": "Home", "body": "the house file"}),
        );
        push(world, "lists", json!({"key": "home2", "name": "Home"}));
    });
    let mut session = world.session();
    session.user("put pay rent in home");
    let pay = find_in_turn(&mut session, "task", "pay rent");
    let wrong = find_in_turn(&mut session, "note", "home");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "rows": [pay], "args": format!("to: {wrong}")}),
    );
    assert!(text(&done).starts_with("error:"), "{done}");
}

#[test]
fn nt13_r4_is_off_under_no_normalize() {
    let world = home_note();
    let mut session = replay(&world);
    session.user("put pay rent in home");
    let pay = find_in_turn(&mut session, "task", "pay rent");
    let wrong = find_in_turn(&mut session, "note", "home");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "rows": [pay], "args": format!("to: {wrong}")}),
    );
    assert!(text(&done).starts_with("error:"), "{done}");
}

#[test]
fn nt13_r4_a_name_that_is_only_close_is_still_the_error() {
    let world = world_with(|world| {
        push(
            world,
            "notes",
            json!({"key": "home_note", "name": "Home office", "body": "the house file"}),
        );
    });
    let mut session = world.session();
    session.user("put pay rent in home office");
    let pay = find_in_turn(&mut session, "task", "pay rent");
    let wrong = find_in_turn(&mut session, "note", "home office");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "rows": [pay], "args": format!("to: {wrong}")}),
    );
    assert!(text(&done).starts_with("error:"), "{done}");
}

// ---------------------------------------------------------------------------------------------
// R5: `group` written as a condition

#[test]
fn nt13_r5_a_group_written_as_a_condition_groups_by_its_field() {
    let world = seeded();
    let mut session = world.session();
    session.user("how many people are starred and how many are not");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person", "group": "starred = yes"}),
    );
    assert!(!text(&counted).starts_with("error:"), "{counted}");
    assert!(text(&counted).contains("by starred"), "{counted}");
    assert!(
        text(&counted).contains("note: grouped by starred"),
        "{counted}"
    );
}

#[test]
fn nt13_r5_a_status_condition_groups_by_status() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks by status");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "group": "status = open"}),
    );
    assert!(text(&counted).contains("by status"), "{counted}");
    assert!(
        text(&counted).contains("note: grouped by status"),
        "{counted}"
    );
}

#[test]
fn nt13_r5_a_word_that_is_no_field_is_still_the_error() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks by mood");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "group": "mood = good"}),
    );
    assert!(text(&counted).starts_with("error:"), "{counted}");
}

#[test]
fn nt13_r5_is_off_under_no_normalize() {
    let world = seeded();
    let mut session = replay(&world);
    session.user("tasks by status");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "group": "status = open"}),
    );
    assert!(text(&counted).starts_with("error:"), "{counted}");
}

// ---------------------------------------------------------------------------------------------
// R6: the offer to plan a new row, then the yes

fn party_world() -> World {
    world_with(|world| {
        let events = world["events"].as_array_mut().expect("events");
        for event in events.iter_mut() {
            if event["key"] == "party" {
                event["attendees"] = json!(["benedikt"]);
                event["description"] = json!("bring the cake");
                event["end"] = json!("2026-11-20T21:00");
            }
        }
    })
}

const PARTY_TO: &str = r#"to: {"date":"2026-12-04","time":"19:00"}"#;

fn move_party() -> Value {
    json!({"verb": "reschedule", "kind": "event", "name": "Launch party", "args": PARTY_TO})
}

#[test]
fn nt13_r6_the_yes_after_the_offer_plans_a_new_event() {
    let world = party_world();
    let mut session = world.session();
    session.user("move the launch party to december 4");
    let offer = call(&mut session, "act", move_party());
    assert!(text(&offer).contains("plan a new one instead?"), "{offer}");
    session.user("yes, plan a new one");
    let done = call(&mut session, "act", move_party());
    assert!(!text(&done).starts_with("error:"), "{done}");
    assert!(
        text(&done).contains("note: planned a new event (the old one is cancelled)"),
        "{done}"
    );
    let rows = diff_rows(&done);
    assert_eq!(rows.len(), 1, "{done}");
    assert_ne!(rows[0]["id"], world.id("party"), "{done}");
    assert_eq!(rows[0]["change"], "created", "{done}");
    assert!(text(&done).contains("Launch party"), "{done}");
    // the copy keeps the name, the duration, the description and the attendee
    session.user("show it");
    let shown = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Launch party", "where": "status = tentative"}),
    );
    let rows = ids(&shown["effect"]["rows"]);
    assert_eq!(rows.len(), 1, "{shown}");
    assert!(text(&shown).contains("2026-12-04"), "{shown}");
    assert!(text(&shown).contains("19:00"), "{shown}");
    assert!(text(&shown).contains("bring the cake"), "{shown}");
    assert!(text(&shown).contains("120"), "{shown}");
}

#[test]
fn nt13_r6_the_new_event_has_the_attendees_of_the_old_one() {
    let world = party_world();
    let mut session = world.session();
    session.user("move the launch party to december 4");
    let _ = call(&mut session, "act", move_party());
    session.user("yes");
    let done = call(&mut session, "act", move_party());
    let created = diff_rows(&done)[0]["id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    session.user("who is going");
    let people = call(
        &mut session,
        "find",
        json!({"kind": "person", "linked_to": format!("#{}", diff_rows(&done)[0]["n"])}),
    );
    assert_eq!(
        ids(&people["effect"]["rows"]),
        vec![world.id("benedikt")],
        "{people} {created}"
    );
}

#[test]
fn nt13_r6_without_the_offer_the_refusal_stays() {
    let world = party_world();
    let mut session = world.session();
    session.user("yes, plan a new one");
    let reply = call(&mut session, "act", move_party());
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn nt13_r6_an_offer_two_turns_old_is_no_offer() {
    let world = party_world();
    let mut session = world.session();
    session.user("move the launch party to december 4");
    let _ = call(&mut session, "act", move_party());
    session.user("what is on friday");
    let _ = call(&mut session, "find", json!({"kind": "event"}));
    session.user("yes, plan a new one");
    let reply = call(&mut session, "act", move_party());
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn nt13_r6_another_cancelled_row_is_no_yes_to_the_offer() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "gala", "name": "Winter gala", "start": "2026-12-01T19:00", "cancelled": true}),
        );
    });
    let mut session = world.session();
    session.user("move the launch party to december 4");
    let _ = call(&mut session, "act", move_party());
    session.user("yes, and move the gala too");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Winter gala", "args": PARTY_TO}),
    );
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}
