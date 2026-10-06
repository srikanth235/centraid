//! nt10 (#1044, iteration 2, runtime batch 3): replies that let the model recover. G1 one hint
//! rung on an invalid resend, G2 errors end in the concrete call, G3 a read that came back empty
//! names the condition that emptied it, G4 rows of other kinds in a miss hint are labelled apart.

mod common;

use common::{World, call, seeded, seeded_with};
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

// ---------------------------------------------------------------------------------------------
// G1: the first identical resend after an `error:` is one hint rung

#[test]
fn a_resend_after_an_error_with_a_fix_quotes_the_fix_and_the_turn_stays_open() {
    // a field the kind names otherwise runs fixed (nt12 R1); a secret the item lacks is egress and
    // stays an error that ends in the call to send
    let world = seeded();
    let mut session = world.session();
    session.user("show the cvv of the home wifi");
    let wifi = common::find_in_turn(&mut session, "locker_item", "home wifi");
    let bad = json!({"verb": "reveal", "rows": [wifi], "args": "field: cvv"});
    let first = call(&mut session, "act", bad.clone());
    assert!(text(&first).starts_with("error:"), "{first}");
    assert!(text(&first).contains("Send act"), "{first}");
    let hint = call(&mut session, "act", bad);
    assert_eq!(hint["ends_turn"], false, "{hint}");
    assert!(
        text(&hint).starts_with("error: that is the same call again. Send act"),
        "{hint}"
    );
}

#[test]
fn a_resend_after_an_error_that_ends_in_a_sentence_of_advice_quotes_that_sentence() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks due soon");
    let bad = json!({"kind": "task", "where": "due_on < 5"});
    let first = call(&mut session, "find", bad.clone());
    assert!(text(&first).ends_with("For that use date."), "{first}");
    let hint = call(&mut session, "find", bad);
    assert_eq!(
        text(&hint),
        "error: that is the same call again. For that use date.",
        "{hint}"
    );
}

#[test]
fn a_resend_after_an_error_without_a_fix_quotes_the_errors_own_text() {
    let world = seeded();
    let mut session = world.session();
    session.user("x");
    let bad = json!({"kind": "task", "sort": "date"});
    let first = call(&mut session, "find", bad.clone());
    let hint = call(&mut session, "find", bad);
    let said = text(&first).strip_prefix("error: ").expect("an error");
    assert_eq!(hint["ends_turn"], false, "{hint}");
    assert_eq!(
        text(&hint),
        format!("error: that is the same call again. {said}"),
        "{hint}"
    );
}

#[test]
fn the_second_resend_ends_exactly_as_the_first_did_before() {
    let world = seeded();
    let mut session = world.session();
    session.user("x");
    let bad = json!({"kind": "task", "sort": "date"});
    call(&mut session, "find", bad.clone());
    call(&mut session, "find", bad.clone());
    let ended = call(&mut session, "find", bad);
    assert_eq!(ended["ends_turn"], true, "{ended}");
    assert!(
        text(&ended).starts_with(
            "error: repeated call at step 3: step 1 sent the same call and the runtime refused it as invalid."
        ),
        "{ended}"
    );
    assert_eq!(
        ended["effect"]["invalid_repeat"],
        json!({"step": 3, "of": 1})
    );
    assert!(ended["effect"]["failsoft"].is_object(), "{ended}");
}

#[test]
fn a_different_call_between_gives_the_next_resend_its_hint_again() {
    let world = seeded();
    let mut session = world.session();
    session.user("x");
    let bad = json!({"kind": "task", "sort": "date"});
    call(&mut session, "find", bad.clone());
    call(&mut session, "find", bad.clone());
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    call(&mut session, "find", bad.clone());
    let hint = call(&mut session, "find", bad);
    assert_eq!(hint["ends_turn"], false, "{hint}");
    assert!(
        text(&hint).starts_with("error: that is the same call again."),
        "{hint}"
    );
}

#[test]
fn a_refusal_that_is_no_error_reply_still_ends_on_the_first_resend() {
    // an act that matched no row is invalid but is not an `error:` reply: no hint rung for it
    let world = seeded();
    let mut session = world.session();
    session.user("complete zzyzx");
    let call_args = json!({"verb": "complete", "kind": "task", "name": "Zzyzx"});
    let first = call(&mut session, "act", call_args.clone());
    assert!(!text(&first).starts_with("error:"), "{first}");
    let again = call(&mut session, "act", call_args);
    assert!(
        !text(&again).starts_with("error: that is the same call again."),
        "{again}"
    );
}

// ---------------------------------------------------------------------------------------------
// G3: a read with 2+ conditions that came back empty names the condition that emptied it

fn hint_of(reply: &Value) -> &str {
    text(reply)
        .lines()
        .find(|line| line.starts_with("hint:"))
        .unwrap_or_default()
}

fn busy_world() -> World {
    world_with(|world| {
        for index in 1..=6 {
            push(
                world,
                "tasks",
                json!({"key": format!("extra{index}"), "name": format!("Extra chore {index}"), "due": "2026-10-08"}),
            );
        }
    })
}

#[test]
fn an_invented_where_literal_is_named_with_the_row_it_hid() {
    let world = seeded();
    let mut session = world.session();
    session.user("show me the rent task");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Pay rent", "where": "description contains \"gutter\""}),
    );
    assert_eq!(miss["ends_turn"], false, "{miss}");
    assert!(
        text(&miss).starts_with("0 tasks called \"Pay rent\" match"),
        "{miss}"
    );
    assert!(
        hint_of(&miss).contains("without where description contains \"gutter\": #"),
        "{miss}"
    );
    assert!(hint_of(&miss).contains("task \"Pay rent\""), "{miss}");
}

#[test]
fn a_when_the_message_never_said_is_named() {
    let world = seeded();
    let mut session = world.session();
    session.user("what about the cabin task");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin", "when": {"unit": "day", "rel": 1}}),
    );
    assert!(hint_of(&miss).contains("without when"), "{miss}");
    assert!(hint_of(&miss).contains("task \"Book the cabin\""), "{miss}");
}

#[test]
fn a_condition_the_message_states_is_never_offered_for_removal() {
    let world = seeded();
    let mut session = world.session();
    // the time span and the name are in the message: nothing to drop, the empty read stands
    session.user("is the dentist task due tomorrow");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Dentist", "when": {"unit": "day", "rel": 1}}),
    );
    assert!(!text(&miss).contains("without"), "{miss}");
    session.user("any tasks due tomorrow that mention gutter");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"unit": "day", "rel": 1}, "where": "description contains \"gutter\""}),
    );
    assert!(!text(&miss).contains("without"), "{miss}");
}

#[test]
fn one_condition_alone_gets_no_line() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks about gutters");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "description contains \"gutter\""}),
    );
    assert!(!text(&miss).contains("without"), "{miss}");
}

#[test]
fn a_link_nobody_said_is_named_and_the_line_holds_four_rows() {
    let world = busy_world();
    let mut session = world.session();
    session.user("neha");
    let neha = common::find_in_turn(&mut session, "person", "Neha Rao");
    // three lists later it is no longer on screen, and nothing of the new message says it
    for (message, kind) in [("photos", "photo"), ("albums", "album"), ("lists", "list")] {
        session.user(message);
        call(&mut session, "find", json!({"kind": kind}));
    }
    session.user("what tasks are still open");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "linked_to": neha, "where": "status = open"}),
    );
    let hint = hint_of(&miss);
    assert!(
        hint.contains(&format!("without linked_to {neha}: #")),
        "{miss}"
    );
    assert_eq!(hint.matches("task \"").count(), 4, "{hint}");
    assert!(hint.contains(" and "), "{hint}");
    assert!(hint.contains(" more"), "{hint}");
}

#[test]
fn what_a_follow_up_carries_from_the_last_message_is_the_persons_and_never_offered() {
    let world = seeded();
    // "the next one": the name is in the message before, the time is the message's own
    let mut session = world.session();
    session.user("when is the write report task due");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Write report"}),
    );
    session.user("when's the next one due");
    let end = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Write report", "when": {"from": {"unit": "day", "rel": 0}}}),
    );
    assert_eq!(end["ends_turn"], true, "{end}");
    assert!(!text(&end).contains("without"), "{end}");
    // "and what's he got in january": a person in focus and a pronoun, a time said, an enum
    let mut session = world.session();
    session.user("what does ray have");
    let ray = common::find_in_turn(&mut session, "person", "Ray Ochoa");
    session.user("and what's he got in january");
    let end = call(
        &mut session,
        "answer",
        json!({"kind": "event", "linked_to": ray, "where": "status != cancelled", "when": {"unit": "month", "rel": 1, "name": 1}}),
    );
    assert_eq!(end["ends_turn"], true, "{end}");
    assert!(!text(&end).contains("without"), "{end}");
    // an elliptical follow-up that says no time of its own still carries the time before it
    let mut session = world.session();
    session.user("what's on this week");
    call(
        &mut session,
        "find",
        json!({"kind": "event", "when": {"unit": "week", "rel": 0}}),
    );
    session.user("and the dentist");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Dentist", "when": {"unit": "week", "rel": 3}}),
    );
    assert!(!text(&miss).contains("without"), "{miss}");
}

#[test]
fn a_trashed_flag_the_message_never_said_is_named() {
    let world = seeded();
    let mut session = world.session();
    session.user("show me the rent task");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Pay rent", "trashed": true}),
    );
    assert!(hint_of(&miss).contains("without trashed"), "{miss}");
}

#[test]
fn an_answer_whose_hint_has_a_row_to_name_stays_open_once() {
    let world = seeded();
    let mut session = world.session();
    session.user("show me the rent task");
    let args =
        json!({"kind": "task", "name": "Pay rent", "where": "description contains \"gutter\""});
    let miss = call(&mut session, "answer", args.clone());
    assert_eq!(miss["ends_turn"], false, "{miss}");
    assert!(hint_of(&miss).contains("without where"), "{miss}");
    // sent again it is the second miss and ends as it always did
    let end = call(&mut session, "answer", args);
    assert_eq!(end["ends_turn"], true, "{end}");
    assert!(!text(&end).contains("repeated call"), "{end}");
    assert!(
        text(&end).starts_with("answered: 0 tasks called \"Pay rent\" match"),
        "{end}"
    );
}

#[test]
fn a_legitimate_empty_answer_still_ends_the_turn() {
    let world = seeded();
    let mut session = world.session();
    session.user("any tasks due tomorrow");
    let end = call(
        &mut session,
        "answer",
        json!({"kind": "task", "when": {"unit": "day", "rel": 1}}),
    );
    assert_eq!(end["ends_turn"], true, "{end}");
    // two conditions, both stated by the message: nothing to name
    session.user("any open tasks due tomorrow");
    let end = call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "status = open", "when": {"unit": "day", "rel": 1}}),
    );
    assert_eq!(end["ends_turn"], true, "{end}");
    assert!(!text(&end).contains("without"), "{end}");
}

#[test]
fn a_count_that_is_zero_names_the_condition_too() {
    let world = seeded();
    let mut session = world.session();
    session.user("how many rent tasks");
    let zero = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "name": "Pay rent", "where": "description contains \"gutter\""}),
    );
    assert!(
        text(&zero).contains("without where description contains \"gutter\": #"),
        "{zero}"
    );
}

// ---------------------------------------------------------------------------------------------
// G4: rows of another kind in a miss hint are labelled apart

#[test]
fn rows_of_another_kind_read_as_other_kinds_and_not_as_a_match() {
    let world = world_with(|world| {
        push(
            world,
            "albums",
            json!({"key": "kyoto", "name": "Kyoto 2026"}),
        );
    });
    let mut session = world.session();
    session.user("show me my kyoto photos");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "kyoto photos"}),
    );
    let hint = hint_of(&miss);
    assert!(
        hint.contains("other kinds (only if the message means one): #"),
        "{hint}"
    );
    assert!(
        hint.contains("album \"Kyoto 2026\" (linked_to: #"),
        "{hint}"
    );
    assert!(!hint.contains("near spellings"), "{hint}");
}

#[test]
fn near_spellings_of_the_same_kind_keep_their_label_and_come_first() {
    let world = world_with(|world| {
        push(
            world,
            "albums",
            json!({"key": "kyoto", "name": "Kyoto 2026"}),
        );
        push(
            world,
            "photos",
            json!({"key": "kyoto_p", "name": "Kyoto temple"}),
        );
    });
    let mut session = world.session();
    session.user("show me my kyoto photos");
    // nt11: `kyotto` alone is a typo (tier 4) of `Kyoto temple`, which a read takes; a name only
    // part of which the rows hold (`album`) reaches no tier, and the hint is where they are named
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "kyotto album"}),
    );
    let hint = hint_of(&miss);
    let own = hint.find("near spellings: #").expect("near spellings");
    let other = hint.find("other kinds (only if the message means one)");
    assert!(other.is_none_or(|other| own < other), "{hint}");
}

// ---------------------------------------------------------------------------------------------
// G2: an error ends in the concrete call, with real handles, when the fix is decidable

fn ends_with_send(reply: &Value, call_text: &str) {
    let said = text(reply).lines().next().unwrap_or_default();
    assert!(
        said.ends_with(&format!("Send {call_text}.")),
        "wanted `Send {call_text}.` in {reply}"
    );
}

#[test]
fn a_groups_balance_sent_with_linked_to_the_group_runs_the_call_for_the_user() {
    let world = seeded();
    let mut session = world.session();
    session.user("what's my balance in the tahoe trip group");
    let group = common::find_in_turn(&mut session, "group", "Tahoe Trip");
    let wrong = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "linked_to": group}),
    );
    // the call is fixed and run (nt12 R1), and the note says which call
    assert!(!text(&wrong).starts_with("error"), "{wrong}");
    assert!(
        text(&wrong).contains(
            "note: used compute op: balance, kind: group, name: \"Tahoe Trip\", linked_to: #"
        ),
        "{wrong}"
    );
    let me = common::number(&mut session, "person", "Sam Park");
    let right = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip", "linked_to": me}),
    );
    assert!(!text(&right).starts_with("error"), "{right}");
}

#[test]
fn the_same_when_the_result_is_the_group_and_when_someone_else_is_in_play() {
    let world = seeded();
    let mut session = world.session();
    session.user("what's my balance in the tahoe trip group");
    call(
        &mut session,
        "find",
        json!({"kind": "group", "name": "Tahoe Trip"}),
    );
    let within = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "within": "@1"}),
    );
    assert!(
        text(&within).contains("note: used compute op: balance, kind: group"),
        "{within}"
    );
    assert!(!text(&within).starts_with("error"), "{within}");
    // the message is about ray: whose balance it is, is not the user's to assume
    let mut session = world.session();
    session.user("what's ray's balance in the tahoe trip group");
    let group = common::find_in_turn(&mut session, "group", "Tahoe Trip");
    let wrong = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "linked_to": group}),
    );
    let ray = common::number(&mut session, "person", "Ray Ochoa");
    assert!(
        text(&wrong).contains(&format!(
            "note: used compute op: balance, kind: group, name: \"Tahoe Trip\", linked_to: {ray}"
        )),
        "{wrong}"
    );
}

#[test]
fn that_is_you_names_the_person_row_the_words_fit() {
    let world = seeded();
    let mut session = world.session();
    session.user("what's my balance with ray");
    let wrong = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Sam Park"}),
    );
    let ray = common::number(&mut session, "person", "Ray Ochoa");
    assert!(!text(&wrong).starts_with("error"), "{wrong}");
    assert!(
        text(&wrong).contains(&format!("note: used compute op: balance, rows: {ray}")),
        "{wrong}"
    );
    // two persons fit the words ("neha"): that is a guess, the error is what it was
    let mut session = world.session();
    session.user("what's my balance with neha");
    let wrong = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Sam Park"}),
    );
    assert_eq!(
        text(&wrong),
        "error: that is you; balance is you versus someone else."
    );
}

#[test]
fn a_group_balance_of_someone_the_message_names_runs_the_call_with_that_person() {
    let world = seeded();
    let mut session = world.session();
    session.user("what's ray's share in the tahoe trip");
    let wrong = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip"}),
    );
    let ray = common::number(&mut session, "person", "Ray Ochoa");
    assert!(!text(&wrong).starts_with("error"), "{wrong}");
    assert!(
        text(&wrong).contains(&format!(
            "note: used compute op: balance, kind: group, name: \"Tahoe Trip\", linked_to: {ray}"
        )),
        "{wrong}"
    );
}

#[test]
fn a_narrowing_that_lost_its_within_names_it() {
    let world = busy_world();
    let mut session = world.session();
    session.user("my tasks");
    let shown = call(&mut session, "find", json!({"kind": "task"}));
    assert_eq!(shown["effect"]["result"], "@1", "{shown}");
    session.user("only the ones due this week");
    let lost = call(
        &mut session,
        "find",
        json!({"when": {"unit": "week", "rel": 0}}),
    );
    assert!(!text(&lost).starts_with("error"), "{lost}");
    assert!(
        text(&lost).contains("note: used find when: {\"rel\":0,\"unit\":\"week\"}, within: @1"),
        "{lost}"
    );
    // two results in the turn before: which one is a guess
    let mut session = busy_world().session();
    session.user("tasks and people");
    call(&mut session, "find", json!({"kind": "task"}));
    call(&mut session, "find", json!({"kind": "person"}));
    session.user("only the ones due this week");
    let lost = call(
        &mut session,
        "find",
        json!({"when": {"unit": "week", "rel": 0}}),
    );
    assert!(!text(&lost).contains("within: @"), "{lost}");
}

#[test]
fn a_field_the_kind_names_otherwise_runs_as_that_field() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks that mention the cabin");
    let fixed = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = open and notes contains \"cabin\""}),
    );
    assert!(!text(&fixed).starts_with("error"), "{fixed}");
    assert!(
        text(&fixed).contains("note: read notes as description"),
        "{fixed}"
    );
    // an order
    let ordered = call(
        &mut session,
        "find",
        json!({"kind": "task", "order": "importance desc"}),
    );
    assert!(
        text(&ordered).contains("note: read importance as priority"),
        "{ordered}"
    );
    // an edit line
    let cabin = common::number(&mut session, "task", "Book the cabin");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": "notes: bring the key"}),
    );
    assert!(!text(&edited).starts_with("error"), "{edited}");
    assert!(
        text(&edited).contains("note: read notes as description"),
        "{edited}"
    );
    // a date has no field call: a date changes with reschedule, its expression is the model's
    let wrong = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": "due: tomorrow"}),
    );
    assert!(!text(&wrong).contains("Send act"), "{wrong}");
}

#[test]
fn a_secret_the_item_lacks_ends_in_the_whole_reveal_call() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is the cvv of the home wifi");
    let wifi = common::find_in_turn(&mut session, "locker item", "Home wifi");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": wifi, "args": "field: cvv"}),
    );
    ends_with_send(
        &reply,
        &format!("act verb: reveal, rows: {wifi}, args: field: password"),
    );
}

#[test]
fn a_wrong_kind_row_with_one_row_the_words_fit_ends_in_the_call_on_that_row() {
    let world = world_with(|world| {
        push(
            world,
            "documents",
            json!({"key": "scan", "name": "Lease scan", "text": "y"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "review", "name": "Review lease"}),
        );
    });
    let mut session = world.session();
    session.user("tick off the lease scan");
    let scan = common::find_in_turn(&mut session, "document", "Lease scan");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": scan}),
    );
    let review = common::number(&mut session, "task", "Review lease");
    assert!(
        text(&reply).contains(&format!("Did you mean {review} task \"Review lease\"?")),
        "{reply}"
    );
    ends_with_send(&reply, &format!("act verb: complete, rows: {review}"));
}

#[test]
fn a_link_the_kinds_lack_ends_in_the_call_with_real_handles() {
    let world = seeded();
    let mut session = world.session();
    session.user("what do i owe in the tahoe trip");
    let group = common::find_in_turn(&mut session, "group", "Tahoe Trip");
    let money = call(
        &mut session,
        "find",
        json!({"kind": "debt", "linked_to": group}),
    );
    let me = common::number(&mut session, "person", "Sam Park");
    assert!(
        text(&money).contains(&format!(
            "Send compute op: balance, kind: group, name: \"Tahoe Trip\", linked_to: {me}."
        )),
        "{money}"
    );
    let album = common::find_in_turn(&mut session, "album", "Summer");
    let people = call(
        &mut session,
        "find",
        json!({"kind": "person", "linked_to": album}),
    );
    assert!(
        text(&people).contains(&format!("Send find kind: photo, linked_to: {album}.")),
        "{people}"
    );
}
