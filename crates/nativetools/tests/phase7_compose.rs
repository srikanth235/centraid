//! Phase 7 of #1044, slice M1: the model never asks or declines first (D-1044-11).
//!
//! The runtime ends the turn with the ask or the decline itself where the model used to write it
//! (`compose.rs`, SPEC §4.8), behind `Flags::compose`:
//!
//! - M1.1 a write whose selector fits several rows is the ask `Which one?`;
//! - M1.2 a read never gets an `ambiguous:` reply: it answers every row the name fits;
//! - M1.3 a write that matches nothing runs the runtime's own search (`Did you mean #n?`,
//!   `Which one?`, `decline not_found`);
//! - M1.4 a read that matches nothing by name answers the near spellings, or answers nothing;
//! - M1.5 a refusal nothing can lift is a decline, one a confirmation can lift is an ask over the
//!   rows involved;
//! - M1.6 what the model keeps, and what `--no-compose` restores.
//!
//! Slice M1b (the four runtime fixes of the refreeze v7 run), same switch:
//!
//! - R1 a `find` is a lookup: a name that reaches nothing is a plain miss the turn goes on from,
//!   with a hint that names near spellings and issues none (`answer` keeps M1.2 and M1.4);
//! - R2 a write whose selector fits several rows takes every one of them when the message says
//!   all, every, each, both or everyone, or the trace says `scope: all`;
//! - R3 a write by a name that reaches nothing goes to the one near spelling of its kind, with a
//!   note; `delete`, `remove_from`, another kind and an all-rows write keep the ask;
//! - R4 `undo` reverts the last write that changed something, past an already-so turn.
//!
//! Slice M1c (two more rules the reference gate surfaced), same switch:
//!
//! - R6 a write whose selector fits the tasks of a recurring series (one name) took the one open
//!   instance when nothing in the message said which: removed by R6c, the rows of one name,
//!   tasks and events alike, are the ask (the options are the rows the verb can change);
//! - R7 a write by a name that reaches nothing of its kind goes to the one row of another kind the
//!   name names exactly or by a word's start; a near spelling of another kind keeps the ask.
//!
//! Slice M1d (the runtime doubts of the phase-7 authors), same switch:
//!
//! - a rows handle that names a value is `error: @n is a value, not rows.`, never rows;
//! - a pick of the row the model's own lookup (a `where`, `when` or `linked_to` of its own) singled
//!   out, and one the previous turn's list bears out among the rows the verb changes, stands;
//! - next and last one read the task or event the call reads, not the people linked to it;
//! - the options of `Which one?` are the rows the verb can change, and the note counts the rest;
//! - a name's hyphens and apostrophes fold (`yunho` is `Yun-ho`, `obriens` is `O'Brien's`);
//! - a lookup of trashed rows reads names as a live one does.

mod common;

use centraid_nativetools::{Flags, Session};
use common::{
    World, call, diff_rows, find_in_turn, ids, number, seeded, seeded_with, trashed_number,
};
use serde_json::{Value, json};

fn text(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

fn tool_of(response: &Value) -> &str {
    response["effect"]["tool"].as_str().unwrap_or_default()
}

fn options(response: &Value) -> Vec<String> {
    ids(&response["effect"]["ask"]["options"])
}

fn sorted(mut list: Vec<String>) -> Vec<String> {
    list.sort();
    list
}

fn family(response: &Value) -> (String, String) {
    let marker = &response["effect"]["compose"];
    (
        marker["family"].as_str().unwrap_or_default().to_owned(),
        marker["action"].as_str().unwrap_or_default().to_owned(),
    )
}

fn fix(family: &str, action: &str) -> (String, String) {
    (family.to_owned(), action.to_owned())
}

/// The turn ended in an ask the runtime composed, over `keys`, and nothing was written.
fn assert_asked(world: &World, reply: &Value, question: &str, keys: &[&str]) {
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(tool_of(reply), "ask", "{reply}");
    assert_eq!(reply["effect"]["composed"], true, "{reply}");
    assert_eq!(reply["effect"]["ask"]["question"], question, "{reply}");
    let wanted: Vec<String> = keys.iter().map(|key| world.id(key)).collect();
    assert_eq!(sorted(options(reply)), sorted(wanted), "{reply}");
    assert!(
        text(reply).contains(&format!("asked: \"{question}\"")),
        "{reply}"
    );
    assert!(!text(reply).contains("ambiguous:"), "{reply}");
    assert!(reply["effect"].get("diff").is_none(), "no write: {reply}");
    assert!(reply["effect"].get("error").is_none(), "{reply}");
}

fn assert_declined(reply: &Value, reason: &str) {
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(tool_of(reply), "decline", "{reply}");
    assert_eq!(reply["effect"]["composed"], true, "{reply}");
    assert_eq!(reply["effect"]["decline"]["reason"], reason, "{reply}");
    assert!(
        text(reply).contains(&format!("declined: {reason}")),
        "{reply}"
    );
    assert!(reply["effect"].get("diff").is_none(), "no write: {reply}");
    assert!(reply["effect"].get("error").is_none(), "{reply}");
}

/// The turn ended in an answer the runtime composed, of these rows (in any order).
fn assert_answered(world: &World, reply: &Value, keys: &[&str]) {
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(tool_of(reply), "answer", "{reply}");
    assert_eq!(reply["effect"]["composed"], true, "{reply}");
    let wanted: Vec<String> = keys.iter().map(|key| world.id(key)).collect();
    assert_eq!(
        sorted(ids(&reply["effect"]["answer"]["rows"])),
        sorted(wanted),
        "{reply}"
    );
    assert!(!text(reply).contains("ambiguous:"), "{reply}");
}

/// A `find` that reached no row by name: the plain miss, no rows, no result, and the turn goes on.
fn assert_find_missed(reply: &Value) {
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert_eq!(tool_of(reply), "find", "{reply}");
    assert!(
        text(reply).starts_with("answered: 0 "),
        "the plain miss leads: {reply}"
    );
    assert!(text(reply).contains(" match"), "{reply}");
    assert_eq!(reply["effect"]["rows"], json!([]), "{reply}");
    for key in [
        "result",
        "answer",
        "composed",
        "ambiguous",
        "ask",
        "decline",
    ] {
        assert!(reply["effect"].get(key).is_none(), "no {key}: {reply}");
    }
    assert!(
        !text(reply).contains('@'),
        "a hint issues no result handle: {reply}"
    );
    assert_eq!(family(reply), fix("unmatched_read", "find_miss"));
}

fn uncomposed() -> Flags {
    Flags {
        compose: false,
        ..Flags::default()
    }
}

fn world_with(edit: impl FnOnce(&mut Value)) -> World {
    let mut world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    edit(&mut world);
    seeded_with(&world)
}

fn push(world: &mut Value, section: &str, row: Value) {
    world[section].as_array_mut().expect("a section").push(row);
}

/// The fixture plus two Pedros: no row is called "Ped", and both start with it.
fn pedros() -> World {
    world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "pedro_a", "name": "Pedro Almeida"}),
        );
        push(
            world,
            "people",
            json!({"key": "pedro_c", "name": "Pedro Costa"}),
        );
    })
}

const STAR: fn(&str) -> Value = |name| json!({"verb": "star", "kind": "person", "name": name});

// ---------------------------------------------------------------------------------------------
// M1.1: a write that fits several rows

#[test]
fn a_selector_that_fits_several_rows_ends_in_which_one() {
    let world = seeded();
    let mut session = world.session();
    session.user("log a call with neha");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    assert_asked(&world, &reply, "Which one?", &["neha_r", "neha_k"]);
    assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
    assert_eq!(reply["effect"]["verb"], "log", "{reply}");
    assert_eq!(
        sorted(ids(&reply["effect"]["ambiguous"])),
        sorted(options(&reply)),
        "the candidates stay in the effect: {reply}"
    );
    assert!(
        text(&reply).contains("the runtime ended the turn"),
        "{reply}"
    );
    // the turn is over, and the next one holds the options in focus
    let next = session.user("the first one");
    let focus = next["focus"].as_str().expect("a focus line");
    assert!(focus.starts_with("focus: asked: #"), "{focus}");
    // nothing was written
    let people = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha"}),
    );
    assert_eq!(people["effect"]["rows"].as_array().map(Vec::len), Some(2));
}

#[test]
fn the_candidates_are_the_first_twelve_with_the_rest_counted() {
    let world = world_with(|world| {
        for n in 1..=14 {
            push(
                world,
                "tasks",
                json!({"key": format!("box{n}"), "name": format!("Pack box {n}")}),
            );
        }
    });
    let mut session = world.session();
    session.user("tick off pack");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Pack"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(options(&reply).len(), 12, "{reply}");
    assert!(text(&reply).contains(" and 2 more"), "{reply}");
    assert_eq!(
        reply["effect"]["ambiguous"].as_array().map(Vec::len),
        Some(14),
        "{reply}"
    );
    assert!(
        reply["effect"].get("bulk").is_none(),
        "not the bulk cap: {reply}"
    );
}

#[test]
fn a_name_that_fits_several_rows_only_by_its_word_starts_is_the_same_ask() {
    let world = pedros();
    let mut session = world.session();
    session.user("star ped");
    let reply = call(&mut session, "act", STAR("Ped"));
    assert_asked(&world, &reply, "Which one?", &["pedro_a", "pedro_c"]);
    // nt11: the word starts are tier 3, a name the vault reaches: the ask of a selector that fits
    // several rows, not the ask of a name that matched nothing
    assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
}

#[test]
fn the_pick_the_words_leave_ambiguous_is_composed_too() {
    let world = pedros();
    let mut session = world.session();
    session.user("star pedro");
    let pedro = find_in_turn(&mut session, "person", "Pedro Almeida");
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": pedro}));
    assert_asked(
        &world,
        &reply,
        "which one of the 2 did you mean?",
        &["pedro_a", "pedro_c"],
    );
    assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
}

#[test]
fn the_candidates_are_the_ones_the_ambiguous_reply_listed() {
    // `--no-compose` is the old reply: the ask lists what it listed, in its order
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "a", "name": "Hen do cocktail class", "start": "2026-10-10T18:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "b", "name": "Hen do dinner", "start": "2026-10-03T20:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "c", "name": "Hen do brunch", "start": "2026-09-12T11:00"}),
        );
    });
    let call_args = json!({"verb": "cancel", "kind": "event", "name": "Hen do"});
    let mut old = world.session_with(common::TODAY, uncomposed());
    old.user("cancel the hen do");
    let listed = call(&mut old, "act", call_args.clone());
    assert!(text(&listed).starts_with("ambiguous:"), "{listed}");
    assert_eq!(listed["ends_turn"], false, "{listed}");
    let mut session = world.session();
    session.user("cancel the hen do");
    let asked = call(&mut session, "act", call_args);
    // the same rows in the same order, but for the brunch that has gone by: `cancel` is not
    // asked over an event that is over when others are ahead, and the note says so
    let listed = ids(&listed["effect"]["ambiguous"]);
    assert_eq!(listed.len(), 3, "{listed:?}");
    assert_eq!(listed.last(), Some(&world.id("c")), "{listed:?}");
    assert_eq!(
        ids(&asked["effect"]["ask"]["options"]),
        listed[..2].to_vec(),
        "the same rows in the same order"
    );
    assert!(
        text(&asked).contains("fits 3 rows (1 left out: cancel does not apply to them)"),
        "{asked}"
    );
}

#[test]
fn without_the_flag_a_write_that_fits_several_rows_is_the_old_reply() {
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("log a call with neha");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    assert!(
        text(&reply).starts_with("ambiguous: \"Neha\" fits"),
        "{reply}"
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert!(reply["effect"].get("composed").is_none(), "{reply}");
    // and the pick the words leave ambiguous keeps its old ask
    let pedros = pedros();
    let mut session = pedros.session_with(common::TODAY, uncomposed());
    session.user("star pedro");
    let pedro = find_in_turn(&mut session, "person", "Pedro Almeida");
    let picked = call(&mut session, "act", json!({"verb": "star", "rows": pedro}));
    assert!(
        text(&picked).starts_with("ambiguous: \"pedro\" fits"),
        "{picked}"
    );
    assert_eq!(picked["ends_turn"], true, "{picked}");
    assert!(picked["effect"].get("composed").is_none(), "{picked}");
}

// ---------------------------------------------------------------------------------------------
// M1.2: a read never gets an `ambiguous:` reply

#[test]
fn a_read_whose_name_fits_several_rows_answers_all_of_them() {
    // nt11 R2: `Ped` is a word start of both Pedros, tier 3: a read lists the rows of the tier
    let world = pedros();
    let mut session = world.session();
    session.user("who is ped");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Ped"}),
    );
    assert_eq!(ids(&found["effect"]["rows"]).len(), 2, "{found}");
    assert!(text(&found).contains("Pedro Almeida"), "{found}");
    assert!(text(&found).contains("Pedro Costa"), "{found}");
    assert!(!text(&found).contains("matched "), "{found}");
    session.user("who is ped");
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Ped"}),
    );
    assert_eq!(
        sorted(ids(&answered["effect"]["answer"]["rows"])),
        sorted(vec![world.id("pedro_a"), world.id("pedro_c")]),
        "{answered}"
    );
    assert!(!text(&answered).contains("matched "), "{answered}");
    // a name that fits several rows exactly was always every one of them
    session.user("who is neha");
    let exact = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha"}),
    );
    assert_eq!(ids(&exact["effect"]["rows"]).len(), 2, "{exact}");
    assert!(exact["effect"].get("composed").is_none(), "{exact}");
}

#[test]
fn without_the_flag_a_write_whose_name_fits_several_rows_is_ambiguous() {
    // a read lists the rows of tier 3 (nt11 R2); a write is the `ambiguous:` reply
    let world = pedros();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("star ped");
    let found = call(&mut session, "act", STAR("Ped"));
    assert!(text(&found).starts_with("ambiguous:"), "{found}");
    assert_eq!(found["ends_turn"], false, "{found}");
}

#[test]
fn a_write_whose_search_finds_one_row_asks_did_you_mean() {
    // `delete` is destructive: a row the person did not name exactly is asked about (R3)
    let world = seeded();
    let mut session = world.session();
    session.user("delete ray ochoo");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "person", "name": "Ray Ochoo"}),
    );
    let ray = session_number(&mut session, "ray");
    assert_asked(&world, &reply, &format!("Did you mean {ray}?"), &["ray"]);
    assert_eq!(family(&reply), fix("unmatched_write", "ask_nearest"));
    assert_eq!(reply["effect"]["verb"], "delete", "{reply}");
    assert!(
        text(&reply).contains("0 people called \"Ray Ochoo\" match; nothing was done"),
        "{reply}"
    );
}

/// `#n` of a fixture row the session has numbered, from its focus after the call.
fn session_number(session: &mut Session, key: &str) -> String {
    let world: Value = serde_json::from_str(common::FIXTURE).expect("the fixture");
    let name = world["people"]
        .as_array()
        .and_then(|people| people.iter().find(|row| row["key"] == key))
        .and_then(|row| row["name"].as_str())
        .expect("a person")
        .to_owned();
    let next = session.user("");
    let focus = next["focus"]
        .as_str()
        .expect("the options are in focus")
        .to_owned();
    let at = focus.find(&format!("person \"{name}\"")).expect("the row");
    let before = &focus[..at];
    let hash = before.rfind('#').expect("a #n");
    format!("#{}", before[hash + 1..].trim())
}

#[test]
fn a_write_whose_search_finds_several_rows_asks_which_one() {
    let world = pedros();
    let mut session = world.session();
    session.user("star pedroo");
    let reply = call(&mut session, "act", STAR("Pedroo"));
    assert_asked(&world, &reply, "Which one?", &["pedro_a", "pedro_c"]);
    // nt11 R3: `Pedroo` is a typo (tier 4) of both: asked over, never acted on
    assert_eq!(family(&reply), fix("unmatched_write", "ask_options"));
}

#[test]
fn a_write_whose_search_finds_nothing_declines_not_found() {
    let world = seeded();
    let mut session = world.session();
    session.user("tick off zzyzx");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Zzyzx"}),
    );
    assert_declined(&reply, "not_found");
    assert_eq!(family(&reply), fix("unmatched_write", "decline:not_found"));
    assert!(
        text(&reply).contains("0 tasks called \"Zzyzx\" match; nothing was done"),
        "{reply}"
    );
    assert!(
        !text(&reply).contains("0 tasks called \"Zzyzx\"."),
        "{reply}"
    );
    // a row of another kind the verb does not apply to is no candidate
    session.user("tick off dentis");
    let other = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Dentis"}),
    );
    assert_declined(&other, "not_found");
}

#[test]
fn a_write_that_matches_nothing_by_a_condition_declines_without_a_search() {
    let world = seeded();
    let mut session = world.session();
    session.user("tick off the old ones");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "where": "effort > 500"}),
    );
    assert_declined(&reply, "not_found");
    // a name with a condition that excludes the near row is not offered that row
    session.user("star ray ochoo");
    let named = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Ray Ochoo", "where": "cadence > 5"}),
    );
    assert_declined(&named, "not_found");
}

#[test]
fn a_write_on_a_trashed_row_declines_and_a_restore_finds_it() {
    let world = seeded();
    let mut session = world.session();
    session.user("tick off library books");
    let by_name = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Library books"}),
    );
    assert_declined(&by_name, "not_found");
    assert!(text(&by_name).contains("in the trash"), "{by_name}");
    // by number it is the refusal of a trashed target
    let trashed = trashed_number(&mut session, "task", "Library books");
    let by_number = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": trashed}),
    );
    assert_declined(&by_number, "not_found");
    assert_eq!(
        by_number["effect"]["refusal"]["predicate"],
        "trashed_target"
    );
    assert_eq!(family(&by_number), fix("refused_write", "decline"));
    // the restore the person asked for is a write
    session.user("restore library books");
    let restored = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "task", "name": "Library books", "trashed": true}),
    );
    assert_eq!(tool_of(&restored), "act", "{restored}");
    assert_eq!(restored["effect"]["diff"]["rows"][0]["change"], "restored");
    // a restore that gives a word start (tier 3) goes to the one trashed row it fits; the vault
    // refuses that one, past its window, and the refusal is the runtime's decline
    session.user("restore old contact");
    let near = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "person", "name": "Old Contac"}),
    );
    assert_declined(&near, "not_found");
    assert_eq!(near["effect"]["refusal"]["id"], world.id("old"), "{near}");
    assert_eq!(near["effect"]["refusal"]["predicate"], "person_trashed");
    // the refusal keeps its own marker, and says no write ran
    assert_eq!(family(&near), fix("refused_write", "decline"));
    assert!(!text(&near).contains("applied to"), "{near}");
}

#[test]
fn without_the_flag_a_write_that_matches_nothing_is_the_old_dead_end() {
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("tick off zzyzx");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Zzyzx"}),
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert_eq!(reply["effect"]["recovery"], "empty", "{reply}");
    assert!(text(&reply).contains("nothing was done."), "{reply}");
    assert!(reply["effect"].get("composed").is_none(), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// M1.4: a read that matches nothing by name

#[test]
fn a_read_that_matches_nothing_answers_the_near_spellings() {
    // nt11 R2: `Ray Ochoo` is a typo of `Ray Ochoa` (tier 4): a read takes the row and says so
    let world = seeded();
    let mut session = world.session();
    session.user("who is ray ochoo");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Ray Ochoo"}),
    );
    assert_eq!(tool_of(&reply), "answer", "{reply}");
    assert_eq!(
        ids(&reply["effect"]["answer"]["rows"]),
        vec![world.id("ray")],
        "{reply}"
    );
    assert!(
        text(&reply).contains("matched \"Ray Ochoa\" for \"Ray Ochoo\""),
        "{reply}"
    );
    assert!(reply["effect"]["answer"]["result"].is_string(), "{reply}");
    // a `find` of the same name takes the same row and says the same
    let mut session = world.session();
    session.user("who is ray ochoo");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Ray Ochoo"}),
    );
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("ray")],
        "{found}"
    );
    assert!(text(&found).contains("person \"Ray Ochoa\""), "{found}");
    assert!(
        text(&found).contains("matched \"Ray Ochoa\" for \"Ray Ochoo\""),
        "{found}"
    );
}

#[test]
fn a_read_that_matches_nothing_and_has_no_near_spelling_answers_nothing() {
    let world = seeded();
    let mut session = world.session();
    session.user("is there a zzyzx task");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Zzyzx"}),
    );
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(tool_of(&reply), "answer", "{reply}");
    assert_eq!(reply["effect"]["composed"], true, "{reply}");
    assert_eq!(reply["effect"]["answer"]["rows"], json!([]), "{reply}");
    assert_eq!(text(&reply), "answered: 0 tasks called \"Zzyzx\" match");
    assert_eq!(family(&reply), fix("unmatched_read", "answer_empty"));
    // the same `find` is the same words and a turn that goes on (R1)
    let mut session = world.session();
    session.user("is there a zzyzx task");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Zzyzx"}),
    );
    assert_find_missed(&found);
    // the hint is the one line of a name that matches only names (nt9 F1)
    assert_eq!(
        text(&found),
        "answered: 0 tasks called \"Zzyzx\" match\nhint: name matches only names; for words in a body or description use search"
    );
}

#[test]
fn a_read_of_a_name_only_a_trashed_row_has_says_so() {
    let world = seeded();
    let mut session = world.session();
    session.user("is library books in the bin");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Library books"}),
    );
    assert_answered(&world, &reply, &["library"]);
    assert!(
        text(&reply)
            .contains("note: no live row called \"Library books\"; showing the trashed ones"),
        "{reply}"
    );
}

#[test]
fn a_read_with_a_selector_beyond_the_name_keeps_its_rows() {
    let world = seeded();
    let mut session = world.session();
    session.user("is the cabin due the friday after next");
    // a name that resolves, narrowed to nothing by when, is the answer of the name alone with the
    // day the row is on (nt14 N1; D-E048's empty answer is what `--no-normalize` still says)
    let when = json!({"unit": "week", "rel": 2, "weekday": 5});
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "cabin", "when": when}),
    );
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]),
        vec![world.id("cabin")],
        "{answered}"
    );
    assert!(
        text(&answered).contains("note: none Fri 2026-10-09; Book the cabin is on Fri 2026-10-02"),
        "{answered}"
    );
    assert!(answered["effect"].get("composed").is_none(), "{answered}");
    // a name only a typo reaches (tier 4) keeps the rows that meet the other conditions
    session.user("neha raoo with a cadence");
    let met = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Neha Raoo", "where": "cadence > 0"}),
    );
    assert_eq!(
        ids(&met["effect"]["answer"]["rows"]),
        vec![world.id("neha_r")],
        "{met}"
    );
    session.user("neha raoo with a long cadence");
    let unmet = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Neha Raoo", "where": "cadence > 100"}),
    );
    assert_eq!(unmet["effect"]["answer"]["rows"], json!([]), "{unmet}");
}

#[test]
fn without_the_flag_a_read_that_matches_nothing_is_the_old_recovery() {
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("who is zebedee nobody");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Zebedee Nobody"}),
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert_eq!(reply["effect"]["recovery"], "empty", "{reply}");
}

// ---------------------------------------------------------------------------------------------
// M1.5: refusals

#[test]
fn a_verb_that_does_not_apply_to_the_kind_declines_out_of_scope() {
    let world = seeded();
    let mut session = world.session();
    session.user("star the dentist");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "event", "name": "Dentist"}),
    );
    assert_declined(&reply, "out_of_scope");
    assert_eq!(reply["effect"]["refusal"]["predicate"], "does_not_apply");
    assert_eq!(reply["effect"]["refusal"]["outcome"], "decline");
    assert!(
        text(&reply).starts_with("refused: star does not apply to events. star applies to: person"),
        "{reply}"
    );
}

#[test]
fn a_row_for_a_container_of_another_kind_declines_out_of_scope() {
    let world = seeded();
    let mut session = world.session();
    session.user("add ray to the dentist");
    let dentist = find_in_turn(&mut session, "event", "Dentist");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "person", "name": "Ray Ochoa", "args": format!("to: {dentist}")}),
    );
    assert_declined(&reply, "out_of_scope");
    assert_eq!(reply["effect"]["refusal"]["predicate"], "wrong_container");
}

#[test]
fn a_member_with_an_unsettled_balance_asks_over_the_person_and_the_group() {
    let world = seeded();
    let mut session = world.session();
    session.user("take ray off the tahoe trip");
    let tahoe = find_in_turn(&mut session, "group", "Tahoe Trip");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "remove_from", "kind": "person", "name": "Ray Ochoa", "args": format!("from: {tahoe}")}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(reply["effect"]["composed"], true, "{reply}");
    assert_eq!(
        reply["effect"]["ask"]["question"],
        "Ray Ochoa still has an unsettled balance in the Tahoe Trip group; settle up first?"
    );
    assert_eq!(options(&reply), vec![world.id("ray"), world.id("tahoe")]);
    assert_eq!(reply["effect"]["refusal"]["predicate"], "member_off_ledger");
    assert_eq!(reply["effect"]["refusal"]["outcome"], "ask");
    assert_eq!(family(&reply), fix("refused_write", "ask_options"));
    assert!(reply["effect"].get("diff").is_none(), "{reply}");
    assert!(
        text(&reply).starts_with("refused: remove_from #"),
        "{reply}"
    );
}

#[test]
fn an_event_that_clashes_in_time_asks_over_the_events_in_the_way() {
    let world = seeded();
    let mut session = world.session();
    session.user("put a call on friday at 9:15");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "event",
               "args": "name: Call\ndate: {\"date\":\"2026-10-02\",\"time\":\"09:15\"}"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(reply["effect"]["composed"], true, "{reply}");
    assert_eq!(
        reply["effect"]["ask"]["question"],
        "that time clashes with the Dentist event; pick another time?"
    );
    assert_eq!(options(&reply), vec![world.id("dentist")]);
    assert_eq!(reply["effect"]["refusal"]["predicate"], "no_busy_conflict");
    assert!(reply["effect"].get("created").is_none(), "{reply}");
    // nothing was made: the same call at a free time lands
    session.user("put a call on friday at 11");
    let free = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "event",
               "args": "name: Call\ndate: {\"date\":\"2026-10-02\",\"time\":\"11:00\"}"}),
    );
    assert_eq!(tool_of(&free), "act", "{free}");
    assert_eq!(free["effect"]["diff"]["rows"][0]["change"], "created");
}

#[test]
fn a_cancelled_event_to_reschedule_asks_over_that_event() {
    let world = seeded();
    let mut session = world.session();
    session.user("move the launch party to friday");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Launch party",
               "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":5}"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(
        reply["effect"]["ask"]["question"],
        "the Launch party event was cancelled, so it cannot be moved; plan a new one instead?"
    );
    assert_eq!(options(&reply), vec![world.id("party")]);
    assert_eq!(
        reply["effect"]["refusal"]["predicate"],
        "event_exists_not_cancelled"
    );
}

#[test]
fn the_refusals_the_model_repairs_stay_errors() {
    // a name in use is the model's to change
    let world = seeded();
    let mut session = world.session();
    session.user("rename ideas to recipes");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "notebook", "name": "Ideas", "args": "name: Recipes"}),
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert!(text(&reply).contains("was refused: "), "{reply}");
    assert!(reply["effect"].get("composed").is_none(), "{reply}");
}

#[test]
fn without_the_flag_the_refusals_are_the_old_errors() {
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("do these");
    let tahoe = find_in_turn(&mut session, "group", "Tahoe Trip");
    let dentist = find_in_turn(&mut session, "event", "Dentist");
    let calls = [
        json!({"verb": "remove_from", "kind": "person", "name": "Ray Ochoa", "args": format!("from: {tahoe}")}),
        json!({"verb": "create", "kind": "event", "args": "name: Call\ndate: {\"date\":\"2026-10-02\",\"time\":\"09:15\"}"}),
        json!({"verb": "reschedule", "kind": "event", "name": "Launch party", "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":5}"}),
        json!({"verb": "star", "kind": "event", "name": "Dentist"}),
        json!({"verb": "add_to", "kind": "person", "name": "Ray Ochoa", "args": format!("to: {dentist}")}),
    ];
    for args in calls {
        session.user("");
        let reply = call(&mut session, "act", args.clone());
        assert_eq!(reply["ends_turn"], false, "{args}: {reply}");
        assert!(reply["effect"]["error"].is_string(), "{args}: {reply}");
        assert!(reply["effect"].get("composed").is_none(), "{args}: {reply}");
    }
}

// ---------------------------------------------------------------------------------------------
// M1.6: what the model keeps

#[test]
fn an_ask_with_options_and_a_decline_not_found_are_still_accepted() {
    let world = seeded();
    let mut session = world.session();
    session.user("log a call with neha");
    let neha = find_in_turn(&mut session, "person", "neha rao");
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which one?", "options": neha}),
    );
    assert_eq!(asked["ends_turn"], true, "{asked}");
    assert_eq!(options(&asked), vec![world.id("neha_r")], "{asked}");
    assert!(asked["effect"].get("composed").is_none(), "{asked}");
    session.user("anything on zzyzx");
    let declined = call(&mut session, "decline", json!({"reason": "not_found"}));
    assert_eq!(declined["ends_turn"], true, "{declined}");
    assert_eq!(declined["effect"]["decline"]["reason"], "not_found");
    session.user("what is the wifi called");
    let open = call(&mut session, "ask", json!({"question": "which wifi?"}));
    assert_eq!(options(&open), Vec::<String>::new(), "{open}");
}

#[test]
fn the_write_that_names_its_rows_is_not_composed() {
    // `rows` is the model's pick: nothing is searched, nothing is asked
    let world = seeded();
    let mut session = world.session();
    session.user("star ray");
    let ray = find_in_turn(&mut session, "person", "Ray Ochoa");
    let starred = call(&mut session, "act", json!({"verb": "star", "rows": ray}));
    assert_eq!(tool_of(&starred), "act", "{starred}");
    assert!(starred["effect"].get("composed").is_none(), "{starred}");
}

#[test]
fn a_pick_the_words_leave_ambiguous_ends_a_repeated_refusal_in_the_composed_ask() {
    // rows and a selector together are refused (the normaliser, off here, would drop the name); sent
    // again, the typed fail-soft runs the rows, and the ask the runtime composes for them is the end
    // of the turn (not a decline)
    let world = pedros();
    let flags = Flags {
        normalize: false,
        ..Flags::default()
    };
    let mut session = world.session_with(common::TODAY, flags);
    session.user("star pedro");
    let pedro = find_in_turn(&mut session, "person", "Pedro Almeida");
    let both = json!({"verb": "star", "kind": "person", "name": "Pedro", "rows": pedro});
    let first = call(&mut session, "act", both.clone());
    assert_eq!(first["ends_turn"], false, "{first}");
    let hint = call(&mut session, "act", both.clone());
    assert_eq!(hint["ends_turn"], false, "{hint}");
    let again = call(&mut session, "act", both);
    assert_eq!(again["ends_turn"], true, "{again}");
    assert_eq!(tool_of(&again), "ask", "{again}");
    assert_eq!(
        sorted(options(&again)),
        sorted(vec![world.id("pedro_a"), world.id("pedro_c")])
    );
}

// ---------------------------------------------------------------------------------------------
// M1b R1: a find is a lookup

#[test]
fn a_find_that_matches_nothing_is_a_plain_miss_and_the_turn_goes_on() {
    // C-E094: the reference looks for a name, then searches, then answers the search's rows
    let world = world_with(|world| {
        push(
            world,
            "documents",
            json!({"key": "ryokan", "name": "Ryokan booking confirmation", "text": "two nights",
                   "created": "2026-09-01T10:00"}),
        );
    });
    let mut session = world.session();
    session.user("where's my ryokan reservation");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "document", "name": "reservation"}),
    );
    assert_find_missed(&miss);
    assert!(
        text(&miss).starts_with("answered: 0 documents called \"reservation\" match"),
        "{miss}"
    );
    // nothing was answered: the search and the answer after it are reached
    let found = call(&mut session, "search", json!({"text": "ryokan"}));
    assert_eq!(found["ends_turn"], false, "{found}");
    let handle = found["effect"]["result"]
        .as_str()
        .expect("a result")
        .to_owned();
    let answered = call(&mut session, "answer", json!({"rows": handle}));
    assert_eq!(answered["ends_turn"], true, "{answered}");
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]),
        vec![world.id("ryokan")],
        "{answered}"
    );
}

#[test]
fn a_find_never_answers_the_near_spellings_it_hints() {
    // D-E115: the reference looks among events, then answers among tasks
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "ski", "name": "Vermont ski weekend", "start": "2026-12-12T09:00"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "rentals", "name": "Reserve ski rentals"}),
        );
    });
    let mut session = world.session();
    session.user("when do i reserve the ski rentals");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "ski rentals"}),
    );
    assert_find_missed(&miss);
    assert!(text(&miss).contains("hint: near spellings: #"), "{miss}");
    assert!(
        text(&miss).contains("event \"Vermont ski weekend\""),
        "{miss}"
    );
    let hit = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "ski rentals"}),
    );
    assert_eq!(hit["ends_turn"], true, "{hit}");
    assert_eq!(
        ids(&hit["effect"]["answer"]["rows"]),
        vec![world.id("rentals")],
        "{hit}"
    );
    assert!(hit["effect"].get("composed").is_none(), "{hit}");
}

#[test]
fn the_hint_marks_a_trashed_row_and_keeps_to_the_rows_that_meet_the_other_conditions() {
    let world = seeded();
    let mut session = world.session();
    session.user("is library books around");
    let trashed = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Library books"}),
    );
    assert_find_missed(&trashed);
    assert!(
        text(&trashed).contains("hint: in the trash: #")
            && text(&trashed).contains("task \"Library books\""),
        "{trashed}"
    );
    // nt11 R2: a name only a typo reaches takes the rows that meet the other conditions
    session.user("neha raoo with a cadence");
    let met = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha Raoo", "where": "cadence > 0"}),
    );
    assert_eq!(
        ids(&met["effect"]["rows"]),
        vec![world.id("neha_r")],
        "{met}"
    );
    assert!(
        text(&met).contains("matched \"Neha Rao\" for \"Neha Raoo\""),
        "{met}"
    );
    session.user("neha raoo with a long cadence");
    let unmet = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha Raoo", "where": "cadence > 100"}),
    );
    assert_eq!(
        ids(&unmet["effect"]["rows"]),
        Vec::<String>::new(),
        "{unmet}"
    );
    assert!(!text(&unmet).contains("hint:"), "{unmet}");
}

/// `#n` of the first row a hint names.
fn hinted_number(reply: &Value) -> String {
    // nt10 G4: a row of another kind is under `other kinds (…)`, not under `near spellings`
    const LEAD: &str = "hint: other kinds (only if the message means one): #";
    let hint = text(reply)
        .lines()
        .find(|line| line.starts_with(LEAD) || line.starts_with("hint: near spellings: #"))
        .unwrap_or_else(|| panic!("a hint: {reply}"));
    let lead = if hint.starts_with(LEAD) {
        LEAD
    } else {
        "hint: near spellings: #"
    };
    let digits: String = hint[lead.len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    format!("#{digits}")
}

#[test]
fn the_hint_names_the_first_four_rows_and_counts_the_rest() {
    let world = world_with(|world| {
        for n in 1..=14 {
            push(
                world,
                "people",
                json!({"key": format!("pedro{n}"), "name": format!("Pedro {n:02}")}),
            );
        }
    });
    let mut session = world.session();
    session.user("who is ped");
    // a name only part of which the rows hold ("Zzz" is none of them) reaches no tier: the hint
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Pedro Zzz"}),
    );
    assert_find_missed(&miss);
    let hint = text(&miss)
        .lines()
        .find(|line| line.starts_with("hint:"))
        .expect("a hint");
    assert_eq!(hint.matches("person \"Pedro ").count(), 4, "{hint}");
    assert!(hint.contains(" and 10 more"), "{hint}");
}

#[test]
fn a_hint_names_rows_the_next_call_can_use_so_no_re_anchor_line_follows_it() {
    let world = seeded();
    let mut session = world.session();
    session.user("do the thing");
    // rows on the screen: what an empty reply would restate
    let seen = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha"}),
    );
    assert_eq!(ids(&seen["effect"]["rows"]).len(), 2, "{seen}");
    // a hint may name a row of another kind; it is the row to use next, so the others are not restated
    let hinted = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Dentis"}),
    );
    assert_find_missed(&hinted);
    assert!(text(&hinted).contains("event \"Dentist\""), "{hinted}");
    assert!(
        !text(&hinted).contains("rows you can still use"),
        "{hinted}"
    );
    // the row is in the block a trace picks from, although nothing but the hint showed it
    let dentist = hinted_number(&hinted);
    let compiled = session.compile(&json!({
        "intent": "write", "verb": "cancel", "pick": [{"row": dentist, "verdict": "ok"}]
    }));
    assert!(compiled.get("refused").is_none(), "{compiled}");
    // a miss with nothing to hint still restates the rows the turn can use, the hinted one among them
    let bare = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Zzyzx"}),
    );
    assert_find_missed(&bare);
    let line = text(&bare)
        .lines()
        .find(|line| line.starts_with("rows you can still use: "))
        .unwrap_or_else(|| panic!("restated: {bare}"));
    assert!(line.contains("event \"Dentist\""), "{line}");
    assert!(line.contains("person \"Neha"), "{line}");
}

#[test]
fn a_find_with_rows_a_name_that_resolves_or_a_valid_empty_is_not_a_miss() {
    let world = seeded();
    let mut session = world.session();
    // a name that reaches a row is the rows, as ever
    session.user("who is neha rao");
    let hit = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha Rao"}),
    );
    assert_eq!(
        ids(&hit["effect"]["rows"]),
        vec![world.id("neha_r")],
        "{hit}"
    );
    assert!(hit["effect"].get("compose").is_none(), "{hit}");
    // a name that reaches a row, narrowed to nothing by a date, is the name's own row with the
    // day it is on (nt14 N1), not a miss; under `--no-normalize` the empty answer of §8.5
    session.user("is the cabin due the friday after next");
    let when = json!({"unit": "week", "rel": 2, "weekday": 5});
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin", "when": when}),
    );
    assert_eq!(
        found["effect"]["rows"].as_array().map(Vec::len),
        Some(1),
        "{found}"
    );
    assert!(found["effect"].get("compose").is_none(), "{found}");
    assert!(
        text(&found).contains("note: none Fri 2026-10-09"),
        "{found}"
    );
    let mut replayed = world.session_with(
        common::TODAY,
        centraid_nativetools::Flags {
            normalize: false,
            ..centraid_nativetools::Flags::default()
        },
    );
    replayed.user("is the cabin due the friday after next");
    let empty = call(
        &mut replayed,
        "find",
        json!({"kind": "task", "name": "cabin", "when": when}),
    );
    assert_eq!(empty["effect"]["rows"], json!([]), "{empty}");
    assert!(empty["effect"].get("compose").is_none(), "{empty}");
    assert!(text(&empty).starts_with("0 tasks"), "{empty}");
}

#[test]
fn without_the_flag_a_find_that_matches_nothing_is_the_old_recovery() {
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("who is zebedee nobody");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Zebedee Nobody"}),
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert_eq!(reply["effect"]["recovery"], "empty", "{reply}");
    assert!(
        text(&reply).starts_with("0 people called \"Zebedee Nobody\""),
        "{reply}"
    );
    assert!(reply["effect"].get("compose").is_none(), "{reply}");
    assert!(!text(&reply).contains("hint:"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// M1b R2: a write the person says takes every row

/// Two starred cousins and one that is not.
fn cousins() -> World {
    world_with(|world| {
        for (key, name, starred) in [
            ("aziz", "Aziz Karimov", true),
            ("zarina", "Zarina Karimova", true),
            ("timur", "Timur Karimov", false),
        ] {
            push(
                world,
                "people",
                json!({"key": key, "name": name, "role": "cousin", "starred": starred}),
            );
        }
    })
}

fn unstar_cousins() -> Value {
    json!({"verb": "unstar", "kind": "person", "where": "role = \"cousin\" and starred = yes"})
}

fn assert_both_cousins_unstarred(world: &World, reply: &Value) {
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(tool_of(reply), "act", "{reply}");
    assert_eq!(
        sorted(ids(&reply["effect"]["diff"]["rows"])),
        sorted(vec![world.id("aziz"), world.id("zarina")]),
        "{reply}"
    );
    for row in diff_rows(reply) {
        assert_eq!(row["fields"]["starred"], json!([true, false]), "{reply}");
    }
    assert!(reply["effect"].get("composed").is_none(), "{reply}");
    assert_eq!(family(reply), fix("ambiguous_write", "apply_all"));
}

#[test]
fn a_selector_that_fits_several_rows_and_the_message_says_all_writes_every_row() {
    // T23-002: the person says all, the selector fits both starred cousins
    let world = cousins();
    let mut session = world.session();
    session.user("unstar all my cousins, too many stars");
    let reply = call(&mut session, "act", unstar_cousins());
    assert_both_cousins_unstarred(&world, &reply);
    assert!(
        text(&reply).contains(
            "note: 2 rows fit; the message says all, so the write took every one of them."
        ),
        "{reply}"
    );
    // the turn after: who is left with a star
    session.user("who's left with a star");
    let left = call(
        &mut session,
        "answer",
        json!({"kind": "person", "where": "starred = yes"}),
    );
    assert_eq!(
        ids(&left["effect"]["answer"]["rows"]),
        vec![world.id("neha_r")],
        "{left}"
    );
}

#[test]
fn every_each_both_everyone_and_everything_say_all_too() {
    for message in [
        "unstar every cousin",
        "unstar each cousin",
        "unstar both cousins",
        "unstar everyone who is a cousin",
        "unstar everything that is starred",
        "unstar the whole cousin lot",
    ] {
        let world = cousins();
        let mut session = world.session();
        session.user(message);
        let reply = call(&mut session, "act", unstar_cousins());
        assert_eq!(reply["ends_turn"], true, "{message}: {reply}");
        assert_both_cousins_unstarred(&world, &reply);
    }
}

#[test]
fn without_a_word_that_says_all_the_selector_still_ends_in_which_one() {
    let world = cousins();
    let mut session = world.session();
    session.user("unstar my cousins");
    let reply = call(&mut session, "act", unstar_cousins());
    assert_asked(&world, &reply, "Which one?", &["aziz", "zarina"]);
    assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
    // a word that merely contains one does not say it
    session.user("unstar my cousins from the mall");
    let mall = call(&mut session, "act", unstar_cousins());
    assert_eq!(tool_of(&mall), "ask", "{mall}");
}

#[test]
fn a_time_span_after_all_or_every_is_not_a_quantifier_of_rows() {
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "pottery", "name": "Pottery workshop", "start": "2026-10-10T09:00"}),
        );
        push(
            world,
            "events",
            json!({"key": "welding", "name": "Welding workshop", "start": "2026-10-11T09:00"}),
        );
    });
    let cancel = json!({"verb": "cancel", "kind": "event", "name": "workshop"});
    for message in [
        "cancel the all-day workshop",
        "cancel the workshop that runs every week",
        "cancel the workshop for the whole weekend",
    ] {
        let mut session = world.session();
        session.user(message);
        let reply = call(&mut session, "act", cancel.clone());
        assert_asked(&world, &reply, "Which one?", &["pottery", "welding"]);
    }
    // all of them is every row
    let mut session = world.session();
    session.user("cancel all the workshops");
    let reply = call(&mut session, "act", cancel);
    assert_eq!(tool_of(&reply), "act", "{reply}");
    assert_eq!(
        sorted(ids(&reply["effect"]["diff"]["rows"])),
        sorted(vec![world.id("pottery"), world.id("welding")]),
        "{reply}"
    );
}

#[test]
fn the_trace_says_which_when_it_has_a_scope_line() {
    let call_args = unstar_cousins();
    // scope all: the write takes every row, whatever the message says
    let world = cousins();
    let mut session = world.session();
    session.user("unstar my cousins");
    let by_trace = session.call_traced(
        "act",
        &call_args,
        Some("intent: write \"unstar\"\nverb: unstar\nscope: all"),
    );
    assert_both_cousins_unstarred(&world, &by_trace);
    assert!(text(&by_trace).contains("the trace says all"), "{by_trace}");
    // scope one or some: the trace decides the other way, whatever the message says
    for scope in ["one", "some"] {
        let world = cousins();
        let mut session = world.session();
        session.user("unstar all my cousins");
        let reply = session.call_traced(
            "act",
            &call_args,
            Some(&format!(
                "intent: write \"unstar\"\nverb: unstar\nscope: {scope}"
            )),
        );
        assert_eq!(tool_of(&reply), "ask", "scope {scope}: {reply}");
        assert_eq!(options(&reply).len(), 2, "scope {scope}: {reply}");
    }
}

#[test]
fn a_write_on_every_row_holds_the_cap() {
    let world = world_with(|world| {
        for n in 1..=13 {
            push(
                world,
                "tasks",
                json!({"key": format!("box{n}"), "name": format!("Pack box {n}")}),
            );
        }
    });
    let mut session = world.session();
    let complete = json!({"verb": "complete", "kind": "task", "name": "Pack"});
    session.user("tick off all the pack boxes");
    let asked = call(&mut session, "act", complete.clone());
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    assert_eq!(asked["effect"]["bulk"]["count"], 13, "{asked}");
    assert_eq!(asked["effect"]["bulk"]["confirmed"], false, "{asked}");
    assert!(asked["effect"].get("diff").is_none(), "{asked}");
    // after a yes the same write goes through, all thirteen
    session.user("yes please");
    let done = call(&mut session, "act", complete);
    assert_eq!(tool_of(&done), "act", "{done}");
    assert_eq!(diff_rows(&done).len(), 13, "{done}");
    assert_eq!(done["effect"]["bulk"]["confirmed"], true, "{done}");
}

#[test]
fn a_pick_by_number_is_never_widened_by_all() {
    // `rows` is the model's pick: the words that leave it ambiguous still end in the ask
    let world = pedros();
    let mut session = world.session();
    session.user("star all the pedros");
    let pedro = find_in_turn(&mut session, "person", "Pedro Almeida");
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": pedro}));
    assert_asked(
        &world,
        &reply,
        "which one of the 2 did you mean?",
        &["pedro_a", "pedro_c"],
    );
}

#[test]
fn without_the_flag_all_does_not_widen_a_selector_write() {
    let world = cousins();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("unstar all my cousins, too many stars");
    let reply = call(&mut session, "act", unstar_cousins());
    assert!(
        text(&reply).starts_with("ambiguous: the selector fits"),
        "{reply}"
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
    assert!(reply["effect"].get("compose").is_none(), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// M1b R3: a write by a name that reaches nothing goes to the one near spelling of its kind

#[test]
fn a_name_with_one_near_spelling_of_its_kind_is_acted_on_and_says_what_it_matched() {
    // nt12 R6: `Ray Ochoo` is a typo (tier 4) of `Ray Ochoa`, the one candidate of its kind
    let world = seeded();
    let mut session = world.session();
    session.user("star ray ochoo");
    let reply = call(&mut session, "act", STAR("Ray Ochoo"));
    assert_eq!(tool_of(&reply), "act", "{reply}");
    assert_eq!(
        ids(&reply["effect"]["diff"]["rows"]),
        vec![world.id("ray")],
        "{reply}"
    );
    assert!(
        text(&reply).contains("matched \"Ray Ochoa\" for \"Ray Ochoo\""),
        "{reply}"
    );
}

#[test]
fn a_misspelled_log_lands_on_the_near_spelling_and_says_so() {
    // T23-077: "and a call with farukh" (nt12 R6: the one typo candidate of its kind is the row)
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "farrukh", "name": "Farrukh Kasimov"}),
        );
    });
    let mut session = world.session();
    session.user("and a call with farukh");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Farukh", "args": "kind: call"}),
    );
    assert_eq!(tool_of(&reply), "act", "{reply}");
    assert_eq!(
        ids(&reply["effect"]["diff"]["rows"]),
        vec![world.id("farrukh")],
        "{reply}"
    );
    assert!(
        text(&reply).contains("matched \"Farrukh Kasimov\" for \"Farukh\""),
        "{reply}"
    );
}

#[test]
fn a_restore_by_a_misspelled_name_goes_to_the_trashed_row() {
    // nt12 R6: `Libary` is a typo (tier 4) of `Library`: the one trashed candidate is restored
    let world = seeded();
    let mut session = world.session();
    session.user("restore libary books");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "task", "name": "Libary books", "trashed": true}),
    );
    assert_eq!(tool_of(&reply), "act", "{reply}");
    assert_eq!(
        ids(&reply["effect"]["diff"]["rows"]),
        vec![world.id("library")],
        "{reply}"
    );
    assert!(
        text(&reply).contains("matched \"Library books\" for \"Libary books\""),
        "{reply}"
    );
}

#[test]
fn delete_and_remove_from_keep_the_ask_for_the_one_near_spelling() {
    let world = seeded();
    let mut session = world.session();
    session.user("take ray ochoo off the tahoe trip");
    let tahoe = find_in_turn(&mut session, "group", "Tahoe Trip");
    let removed = call(
        &mut session,
        "act",
        json!({"verb": "remove_from", "kind": "person", "name": "Ray Ochoo",
               "args": format!("from: {tahoe}")}),
    );
    let ray = session_number(&mut session, "ray");
    assert_asked(&world, &removed, &format!("Did you mean {ray}?"), &["ray"]);
    assert_eq!(family(&removed), fix("unmatched_write", "ask_nearest"));
    assert!(
        removed["effect"].get("near_spelling").is_none(),
        "{removed}"
    );
    let mut session = world.session();
    session.user("delete ray ochoo");
    let deleted = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "person", "name": "Ray Ochoo"}),
    );
    assert_eq!(tool_of(&deleted), "ask", "{deleted}");
    assert!(deleted["effect"].get("diff").is_none(), "{deleted}");
}

#[test]
fn a_reveal_and_a_settlement_keep_the_ask_for_the_one_near_spelling() {
    // a secret or real money on a row the person did not name exactly: ask, as delete does
    let world = seeded();
    let mut session = world.session();
    session.user("show me the home wiffi password");
    let revealed = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "kind": "locker item", "name": "Home wiffi", "args": "field: password"}),
    );
    assert_eq!(tool_of(&revealed), "ask", "{revealed}");
    assert!(revealed["effect"].get("reveal").is_none(), "{revealed}");
    assert!(
        revealed["effect"].get("near_spelling").is_none(),
        "{revealed}"
    );
}

#[test]
fn one_near_spelling_of_another_kind_keeps_the_ask() {
    // "dentst" is a near spelling of the event "Dentist", not a word start of it ("dentis" is, and
    // goes to the event: R7)
    let world = seeded();
    let mut session = world.session();
    session.user("change the effort of dentst to 20");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Dentst", "args": "effort: 20"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(options(&reply), vec![world.id("dentist")], "{reply}");
    assert_eq!(family(&reply), fix("unmatched_write", "ask_nearest"));
    assert!(reply["effect"].get("near_spelling").is_none(), "{reply}");
    assert!(reply["effect"].get("diff").is_none(), "{reply}");
}

#[test]
fn a_write_that_may_take_several_rows_keeps_the_ask_for_the_one_near_spelling() {
    // "all" in the message, or `scope: all` in the trace: one near row is not the several meant
    let world = seeded();
    let mut session = world.session();
    session.user("star all the ray ochoos");
    let by_message = call(&mut session, "act", STAR("Ray Ochoo"));
    assert_eq!(tool_of(&by_message), "ask", "{by_message}");
    assert!(
        by_message["effect"].get("near_spelling").is_none(),
        "{by_message}"
    );
    let mut session = world.session();
    session.user("star ray ochoo");
    let by_trace = session.call_traced(
        "act",
        &STAR("Ray Ochoo"),
        Some("intent: write \"star\"\nverb: star\nscope: all"),
    );
    assert_eq!(tool_of(&by_trace), "ask", "{by_trace}");
    assert!(diff_rows(&by_trace).is_empty(), "{by_trace}");
}

#[test]
fn a_near_spelling_is_asked_over_whatever_the_words_single_out() {
    // nt12 R6: the call names "Pedro Almeidaa", a typo (tier 4) of one row, which goes through the
    // pick check a single row meets: "pedro" fits two people and is asked over, "pedro almeidaa"
    // singles the row out and it is starred, with the matched line
    let world = pedros();
    let mut session = world.session();
    session.user("star pedro");
    let asked = call(&mut session, "act", STAR("Pedro Almeidaa"));
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    assert_eq!(options(&asked).len(), 2, "{asked}");
    assert!(diff_rows(&asked).is_empty(), "{asked}");
    let mut session = world.session();
    session.user("star pedro almeidaa");
    let done = call(&mut session, "act", STAR("Pedro Almeidaa"));
    assert_eq!(tool_of(&done), "act", "{done}");
    assert_eq!(
        ids(&done["effect"]["diff"]["rows"]),
        vec![world.id("pedro_a")],
        "{done}"
    );
    assert!(
        text(&done).contains("matched \"Pedro Almeida\" for \"Pedro Almeidaa\""),
        "{done}"
    );
}

#[test]
fn without_the_flag_a_near_spelling_is_the_old_dead_end() {
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("star ray ochoo");
    let reply = call(&mut session, "act", STAR("Ray Ochoo"));
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert_eq!(reply["effect"]["recovery"], "empty", "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
    assert!(reply["effect"].get("near_spelling").is_none(), "{reply}");
    assert!(text(&reply).contains("nothing was done."), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// M1b R4: undo reverts the last write that changed something

/// `#n` of the trashed task and a first restore of it: turn 1 of the sessions below.
fn restored_library(session: &mut Session) -> String {
    let library = trashed_number(session, "task", "Library books");
    let restored = call(session, "act", json!({"verb": "restore", "rows": library}));
    assert_eq!(diff_rows(&restored)[0]["change"], "restored", "{restored}");
    library
}

fn restore_again(session: &mut Session, library: &str) {
    session.user("restore it again");
    let again = call(session, "act", json!({"verb": "restore", "rows": library}));
    assert!(text(&again).starts_with("already: "), "{again}");
    assert!(diff_rows(&again).is_empty(), "{again}");
    assert_eq!(again["ends_turn"], false, "{again}");
}

#[test]
fn undo_reverts_the_write_before_an_already_so_turn() {
    // D-E108: t3 restores a task, t4 restores it again (already so), t5 undoes the restore
    let world = seeded();
    let mut session = world.session();
    let library = restored_library(&mut session);
    restore_again(&mut session, &library);
    session.user("undo");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    let rows = diff_rows(&undone);
    assert_eq!(rows.len(), 1, "{undone}");
    assert_eq!(rows[0]["id"], world.id("library"), "{undone}");
    assert_eq!(rows[0]["change"], "trashed", "{undone}");
    // once: a second undo has nothing
    session.user("undo again");
    let twice = text_of_call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(twice, "error: nothing to undo");
}

fn text_of_call(session: &mut Session, tool: &str, args: Value) -> String {
    text(&call(session, tool, args)).to_owned()
}

#[test]
fn an_already_so_turn_that_also_reads_the_row_does_not_end_the_undo() {
    // D-E108 t4 as the reference writes it: the restore that is already so, then the answer that
    // reads the row (the turn ends there); t5 still undoes the restore of t3
    let world = seeded();
    let mut session = world.session();
    let library = restored_library(&mut session);
    session.user("and the library books one too");
    let again = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": library}),
    );
    assert!(text(&again).starts_with("already: "), "{again}");
    let read = call(&mut session, "answer", json!({"rows": library}));
    assert_eq!(read["ends_turn"], true, "{read}");
    session.user("undo");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&undone).len(), 1, "{undone}");
    assert_eq!(diff_rows(&undone)[0]["change"], "trashed", "{undone}");
    assert_eq!(diff_rows(&undone)[0]["id"], world.id("library"), "{undone}");
}

#[test]
fn the_undo_rule_is_not_behind_the_flag() {
    // `undo` is not a composed outcome: `--no-compose` runs keep the same memory
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    let library = restored_library(&mut session);
    restore_again(&mut session, &library);
    session.user("undo");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&undone)[0]["change"], "trashed", "{undone}");
}

#[test]
fn a_run_of_already_so_turns_neither_pushes_nor_clears_the_undo_memory() {
    let world = seeded();
    let mut session = world.session();
    let library = restored_library(&mut session);
    restore_again(&mut session, &library);
    restore_again(&mut session, &library);
    session.user("undo");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&undone)[0]["change"], "trashed", "{undone}");
    // the already-so turn after the undo does not bring it back
    session.user("restore it once more");
    let again = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": library}),
    );
    assert_eq!(diff_rows(&again)[0]["change"], "restored", "{again}");
    restore_again(&mut session, &library);
    session.user("undo");
    let second = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&second)[0]["change"], "trashed", "{second}");
    session.user("undo");
    assert_eq!(
        text_of_call(&mut session, "act", json!({"verb": "undo"})),
        "error: nothing to undo"
    );
}

#[test]
fn a_turn_that_changed_nothing_has_nothing_to_undo() {
    let world = seeded();
    let mut session = world.session();
    // the report task is done already: completing it again is already-so, and nothing came before
    let report = number(&mut session, "task", "Write report");
    let again = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": report}),
    );
    assert!(text(&again).starts_with("already: "), "{again}");
    session.user("undo");
    assert_eq!(
        text_of_call(&mut session, "act", json!({"verb": "undo"})),
        "error: nothing to undo"
    );
}

#[test]
fn a_read_an_ask_or_an_undo_between_still_ends_the_undo() {
    let world = seeded();
    // a turn that only read
    let mut session = world.session();
    restored_library(&mut session);
    session.user("what is left to do");
    call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "status = open"}),
    );
    session.user("undo");
    assert_eq!(
        text_of_call(&mut session, "act", json!({"verb": "undo"})),
        "error: nothing to undo"
    );
    // a read, then an already-so turn: the read still stands between (a world of its own: the
    // first session's restore is in its vault)
    let other = seeded();
    let mut session = other.session();
    let library = restored_library(&mut session);
    session.user("what is left to do");
    call(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "status = open"}),
    );
    restore_again(&mut session, &library);
    session.user("undo");
    assert_eq!(
        text_of_call(&mut session, "act", json!({"verb": "undo"})),
        "error: nothing to undo"
    );
    // an ask between
    let asked = seeded();
    let mut session = asked.session();
    restored_library(&mut session);
    session.user("which one");
    call(&mut session, "ask", json!({"question": "which list?"}));
    session.user("undo");
    assert_eq!(
        text_of_call(&mut session, "act", json!({"verb": "undo"})),
        "error: nothing to undo"
    );
    // an undo between: what it reverted stays reverted, and an already-so turn after it is not a write
    let undone = seeded();
    let mut session = undone.session();
    let library = restored_library(&mut session);
    session.user("undo");
    let first = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&first)[0]["change"], "trashed", "{first}");
    session.user("restore it");
    let back = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": library}),
    );
    assert_eq!(diff_rows(&back)[0]["change"], "restored", "{back}");
    restore_again(&mut session, &library);
    restore_again(&mut session, &library);
    session.user("undo");
    let second = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&second)[0]["change"], "trashed", "{second}");
}

#[test]
fn an_already_so_write_in_the_turn_of_a_real_one_leaves_it_undoable() {
    let world = seeded();
    let mut session = world.session();
    let found = common::numbers(
        &mut session,
        &[("task", "Pay rent"), ("task", "Write report")],
    );
    call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": found[0], "more": true}),
    );
    let noop = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": found[1]}),
    );
    assert!(text(&noop).contains("already: "), "{noop}");
    session.user("undo");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&undone).len(), 1, "{undone}");
    assert_eq!(
        diff_rows(&undone)[0]["fields"]["status"],
        json!(["completed", "open"]),
        "{undone}"
    );
}

// ---------------------------------------------------------------------------------------------
// M1c R6, removed (R6c): rows that share one name are the ask, tasks and events alike

/// The Thursdays of twelve movie nights at 19:00: on the fixture's today (a Sunday, 2026-09-27)
/// three have gone by and nine are ahead.
const MOVIE_NIGHTS: [&str; 12] = [
    "2026-09-10",
    "2026-09-17",
    "2026-09-24",
    "2026-10-01",
    "2026-10-08",
    "2026-10-15",
    "2026-10-22",
    "2026-10-29",
    "2026-11-05",
    "2026-11-12",
    "2026-11-19",
    "2026-11-26",
];

fn movie_nights() -> World {
    world_with(|world| {
        for (n, day) in MOVIE_NIGHTS.iter().enumerate() {
            push(
                world,
                "events",
                json!({"key": format!("movie{n}"), "name": "Movie night",
                       "start": format!("{day}T19:00")}),
            );
        }
    })
}

/// The keys of the twelve movie nights.
fn movie_keys() -> Vec<String> {
    (0..MOVIE_NIGHTS.len())
        .map(|n| format!("movie{n}"))
        .collect()
}

/// The keys of the nine movie nights that are ahead of the fixture's today.
fn movie_keys_ahead() -> Vec<String> {
    movie_keys().split_off(3)
}

fn cancel_movie_night() -> Value {
    json!({"verb": "cancel", "kind": "event", "name": "Movie night"})
}

#[test]
fn a_series_of_events_with_no_date_keeps_the_ask() {
    // val's gold asks which lesson, haircut or swim class when a recurring event is named with no
    // date, whether or not one of them is ahead: the runtime has no default for events. A cancel
    // is asked over the instances still to come: the three that have gone by are not options
    let world = movie_nights();
    let all = movie_keys();
    let all: Vec<&str> = all.iter().map(String::as_str).collect();
    let ahead = movie_keys_ahead();
    let ahead: Vec<&str> = ahead.iter().map(String::as_str).collect();
    let mut session = world.session();
    session.user("cancel movie night");
    let reply = call(&mut session, "act", cancel_movie_night());
    assert_asked(&world, &reply, "Which one?", &ahead);
    assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
    assert_eq!(
        options(&reply)[0],
        world.id("movie3"),
        "the next one leads the options: {reply}"
    );
    assert!(
        text(&reply).contains("fits 12 rows (3 left out: cancel does not apply to them)"),
        "{reply}"
    );
    assert!(diff_rows(&reply).is_empty(), "{reply}");
    // a date that only says where a write goes (D-E127 "move my haircut to saturday") picks nothing,
    // and a move is asked over every instance: a night that has gone by can be moved
    session.user("move movie night to saturday");
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Movie night",
               "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":6}"}),
    );
    assert_asked(&world, &moved, "Which one?", &all);
    // and neither do the words that only repeat the request or say the next one
    for message in ["cancel movie night again", "cancel the next movie night"] {
        session.user(message);
        let reply = call(&mut session, "act", cancel_movie_night());
        assert_asked(&world, &reply, "Which one?", &ahead);
    }
}

#[test]
fn a_series_of_events_that_has_gone_by_keeps_the_ask_too() {
    // no latest-one application, whatever the day: the person says which of the past instances,
    // and when every one is over they are all the options
    let world = movie_nights();
    let keys = movie_keys();
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    let mut session = world.session_with("2027-06-01", Flags::default());
    session.user("cancel movie night");
    let reply = call(&mut session, "act", cancel_movie_night());
    assert_asked(&world, &reply, "Which one?", &keys);
    assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
    assert!(diff_rows(&reply).is_empty(), "{reply}");
    assert!(!text(&reply).contains("applied to"), "{reply}");
    assert!(!text(&reply).contains("left out"), "{reply}");
}

/// A series of tasks as it usually stands: its past instances are done and the next one is open (one
/// open, due Monday 5 October, and two done).
fn resin() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "resin_a", "name": "Order composite resin", "due": "2026-10-05"}),
        );
        for (key, due) in [("resin_done", "2026-09-01"), ("resin_old", "2026-08-01")] {
            push(
                world,
                "tasks",
                json!({"key": key, "name": "Order composite resin", "due": due,
                       "status": "completed", "completed": "2026-09-02T10:00"}),
            );
        }
    })
}

/// Two open instances with different due dates (the later one listed first), and one done.
fn resin_two_open() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "resin_b", "name": "Order composite resin", "due": "2026-11-02"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "resin_a", "name": "Order composite resin", "due": "2026-10-05"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "resin_done", "name": "Order composite resin", "due": "2026-09-01",
                   "status": "completed", "completed": "2026-09-02T10:00"}),
        );
    })
}

fn complete_resin() -> Value {
    json!({"verb": "complete", "kind": "task", "name": "Order composite resin"})
}

fn edit_resin() -> Value {
    json!({"verb": "edit", "kind": "task", "name": "Order composite resin", "args": "effort: 15"})
}

fn delete_resin() -> Value {
    json!({"verb": "delete", "kind": "task", "name": "Order composite resin"})
}

fn push_resin_to_monday() -> Value {
    json!({"verb": "reschedule", "kind": "task", "name": "Order composite resin",
           "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":1}"})
}

#[test]
fn a_series_of_tasks_with_one_open_instance_keeps_the_ask() {
    // val T23-108 ("push the gift for kamola to friday"), T03-106 ("delete pay edp bill") and
    // T12-111 ("delete the gas bill task"): two tasks of one name, one open and one done, are asked
    // about whether the write moves, deletes or edits them. The runtime does not take the open one
    let world = resin();
    for (message, args) in [
        (
            "change the effort of order composite resin to 15",
            edit_resin(),
        ),
        ("delete order composite resin", delete_resin()),
        (
            "push order composite resin to monday",
            push_resin_to_monday(),
        ),
    ] {
        let mut session = world.session();
        session.user(message);
        let reply = call(&mut session, "act", args);
        assert_asked(
            &world,
            &reply,
            "Which one?",
            &["resin_a", "resin_done", "resin_old"],
        );
        assert_eq!(
            options(&reply)[0],
            world.id("resin_a"),
            "{message}: {reply}"
        );
        assert_eq!(
            family(&reply),
            fix("ambiguous_write", "ask_options"),
            "{message}: {reply}"
        );
        assert!(diff_rows(&reply).is_empty(), "{message}: {reply}");
        assert!(!text(&reply).contains("applied to"), "{message}: {reply}");
    }
    // the T23-108 shape exactly: one open, one done
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "gift_open", "name": "Buy gift for Kamola", "due": "2026-10-05"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "gift_done", "name": "Buy gift for Kamola", "due": "2026-09-01",
                   "status": "completed", "completed": "2026-09-02T10:00"}),
        );
    });
    let mut session = world.session();
    session.user("push the gift for kamola to friday");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "task", "name": "Buy gift for Kamola",
               "args": format!("to: {{\"unit\":\"week\",\"rel\":1,\"weekday\":5}}")}),
    );
    assert_asked(&world, &reply, "Which one?", &["gift_open", "gift_done"]);
    // `complete` applies to the open one only: the pick the verb's applicability makes, which
    // predates the default and stays: a row the verb would leave as it is is no candidate
    let world = resin();
    let mut session = world.session();
    session.user("tick off order composite resin");
    let done = call(&mut session, "act", complete_resin());
    assert_eq!(diff_rows(&done)[0]["id"], world.id("resin_a"), "{done}");
    assert!(
        text(&done).contains("only that one is a row complete can change"),
        "{done}"
    );
    assert!(done["effect"].get("compose").is_none(), "{done}");
}

#[test]
fn two_open_instances_of_a_task_series_keep_the_ask() {
    // val D-E007: one due soon, one due later; a default would guess, and the row it chose is the
    // one the next turn looks for
    let world = world_with(|world| {
        for (key, due) in [("resin_b", "2026-11-02"), ("resin_a", "2026-10-05")] {
            push(
                world,
                "tasks",
                json!({"key": key, "name": "Order composite resin", "due": due}),
            );
        }
    });
    let mut session = world.session();
    session.user("tick off order composite resin");
    let reply = call(&mut session, "act", complete_resin());
    assert_asked(&world, &reply, "Which one?", &["resin_a", "resin_b"]);
    assert_eq!(
        options(&reply),
        vec![world.id("resin_a"), world.id("resin_b")],
        "the nearest due first: {reply}"
    );
    assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
    // whatever the verb: `edit` and `delete` apply to the done instance as well, and the ask is the
    // same, the open ones first
    let world = resin_two_open();
    for (message, args) in [
        ("tick off order composite resin", complete_resin()),
        (
            "change the effort of order composite resin to 15",
            edit_resin(),
        ),
        ("delete order composite resin", delete_resin()),
    ] {
        let mut session = world.session();
        session.user(message);
        let reply = call(&mut session, "act", args);
        assert_eq!(tool_of(&reply), "ask", "{message}: {reply}");
        assert_eq!(
            family(&reply),
            fix("ambiguous_write", "ask_options"),
            "{message}: {reply}"
        );
        assert!(diff_rows(&reply).is_empty(), "{message}: {reply}");
        assert_eq!(
            sorted(options(&reply)[..2].to_vec()),
            sorted(vec![world.id("resin_a"), world.id("resin_b")]),
            "{message}: {reply}"
        );
    }
}

#[test]
fn an_undated_open_instance_keeps_the_ask_too() {
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "water_open", "name": "Water the plants"}),
        );
        for (key, due) in [("water_a", "2026-09-01"), ("water_b", "2026-09-08")] {
            push(
                world,
                "tasks",
                json!({"key": key, "name": "Water the plants", "due": due,
                       "status": "completed", "completed": "2026-09-09T10:00"}),
            );
        }
    });
    let mut session = world.session();
    session.user("change the effort of water the plants to 5");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Water the plants", "args": "effort: 5"}),
    );
    assert_asked(
        &world,
        &reply,
        "Which one?",
        &["water_open", "water_a", "water_b"],
    );
    assert_eq!(options(&reply)[0], world.id("water_open"), "{reply}");
}

#[test]
fn open_instances_keep_the_ask_dated_or_not() {
    // two open instances, the first undated and the second dated, then both undated
    for second_dated in [true, false] {
        let world = world_with(|world| {
            push(
                world,
                "tasks",
                json!({"key": "first", "name": "Water the plants"}),
            );
            let mut second = json!({"key": "second", "name": "Water the plants"});
            if second_dated {
                second["due"] = json!("2026-12-01");
            }
            push(world, "tasks", second);
        });
        let mut session = world.session();
        session.user("change the effort of water the plants to 5");
        let reply = call(
            &mut session,
            "act",
            json!({"verb": "edit", "kind": "task", "name": "Water the plants", "args": "effort: 5"}),
        );
        assert_asked(&world, &reply, "Which one?", &["first", "second"]);
    }
}

#[test]
fn a_series_of_tasks_with_no_open_one_keeps_the_ask() {
    let world = world_with(|world| {
        for (key, due) in [("done_a", "2026-08-01"), ("done_b", "2026-09-01")] {
            push(
                world,
                "tasks",
                json!({"key": key, "name": "Order composite resin", "due": due,
                       "status": "completed", "completed": "2026-09-02T10:00"}),
            );
        }
    });
    let mut session = world.session();
    // `complete` applies to none of them (every row stays an option), `reopen` to both
    for (message, verb) in [
        ("tick off order composite resin", "complete"),
        ("reopen order composite resin", "reopen"),
    ] {
        session.user(message);
        let reply = call(
            &mut session,
            "act",
            json!({"verb": verb, "kind": "task", "name": "Order composite resin"}),
        );
        assert_asked(&world, &reply, "Which one?", &["done_a", "done_b"]);
        assert_eq!(family(&reply), fix("ambiguous_write", "ask_options"));
    }
}

/// A series on three different days: Thursday 1 October, Saturday 3 October, Wednesday 7 October.
fn grooming() -> World {
    world_with(|world| {
        for (key, start) in [
            ("thursday", "2026-10-01T14:00"),
            ("saturday", "2026-10-03T14:00"),
            ("wednesday", "2026-10-07T14:00"),
        ] {
            push(
                world,
                "events",
                json!({"key": key, "name": "Dog grooming", "start": start}),
            );
        }
    })
}

#[test]
fn a_date_in_the_message_narrows_first_as_it_does_today() {
    let world = grooming();
    let cancel = json!({"verb": "cancel", "kind": "event", "name": "Dog grooming"});
    let mut session = world.session();
    session.user("cancel dog grooming on saturday");
    let reply = call(&mut session, "act", cancel.clone());
    // the one on that day (the narrowing of the message's date), not the next one (Thursday)
    assert_eq!(diff_rows(&reply)[0]["id"], world.id("saturday"), "{reply}");
    assert!(text(&reply).contains("only that one is on"), "{reply}");
    assert!(reply["effect"].get("compose").is_none(), "{reply}");
    // a day none of them is on says which too: the ask
    session.user("cancel dog grooming on friday");
    let none = call(&mut session, "act", cancel.clone());
    assert_eq!(tool_of(&none), "ask", "{none}");
    assert_eq!(family(&none), fix("ambiguous_write", "ask_options"));
    // and so does a named month and day, which the narrowing does not read
    session.user("cancel dog grooming on october 7");
    let named = call(&mut session, "act", cancel);
    assert_eq!(tool_of(&named), "ask", "{named}");
}

#[test]
fn a_date_that_only_says_where_the_write_goes_does_not_say_which() {
    let world = resin();
    let mut session = world.session();
    session.user("move order composite resin to saturday");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "task", "name": "Order composite resin",
               "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":6}"}),
    );
    assert_asked(
        &world,
        &reply,
        "Which one?",
        &["resin_a", "resin_done", "resin_old"],
    );
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn all_still_takes_every_row_of_a_series() {
    let world = movie_nights();
    let mut session = world.session();
    session.user("cancel all the movie nights");
    let reply = call(&mut session, "act", cancel_movie_night());
    assert_eq!(diff_rows(&reply).len(), 12, "{reply}");
    assert_eq!(family(&reply), fix("ambiguous_write", "apply_all"));
    assert!(
        text(&reply).contains("the message says all, so the write took every one of them."),
        "{reply}"
    );
}

#[test]
fn what_else_the_message_says_does_not_turn_the_ask_into_a_write() {
    // a word that picks, a word that only repeats the request, "next", and a pronoun for the name
    // the message states: the runtime asks, whichever (it reads the message for the date and for
    // all, and for what the pick check reads, and for nothing else)
    for message in [
        "change the effort of the first order composite resin to 15",
        "change the effort of the last order composite resin to 15",
        "change the effort of the other order composite resin to 15",
        "change the effort of the old order composite resin to 15",
        "change the effort of order composite resin on thursdays to 15",
        "change the effort of order composite resin in november to 15",
        "change the effort of that one to 15",
        "change the effort of those to 15",
        "change the effort of order composite resin to 15 again",
        "change the effort of order composite resin to 15 too",
        "change the effort of the next order composite resin to 15",
        "change the effort of that order composite resin to 15",
        "change the effort of the order composite resin one to 15",
    ] {
        let world = resin();
        let mut session = world.session();
        session.user(message);
        let reply = call(&mut session, "act", edit_resin());
        assert_eq!(tool_of(&reply), "ask", "{message}: {reply}");
        assert_eq!(
            family(&reply),
            fix("ambiguous_write", "ask_options"),
            "{message}: {reply}"
        );
        assert!(diff_rows(&reply).is_empty(), "{message}: {reply}");
    }
}

#[test]
fn a_pronoun_for_the_name_the_message_states_asks_too() {
    // val T23-032 t4: "Order composite resin, push it to monday" over one open and one done
    // instance applied to the open one under the default; with the default gone it is the ask
    for message in [
        "Order composite resin, push it to monday",
        "order composite resin, move those to monday",
        "move them to monday, order composite resin",
        "order composite resin, that one to monday",
    ] {
        let world = resin();
        let mut session = world.session();
        session.user(message);
        let reply = call(&mut session, "act", push_resin_to_monday());
        assert_asked(
            &world,
            &reply,
            "Which one?",
            &["resin_a", "resin_done", "resin_old"],
        );
    }
}

#[test]
fn it_with_no_name_in_the_message_is_a_pick_of_the_focus_row() {
    // the call carries a name the message does not state ("push it to monday"): "it" is a pick
    // of an earlier result, and a pick with no focus to settle it is the ask
    let world = resin();
    let mut session = world.session();
    session.user("push it to monday");
    let reply = call(&mut session, "act", push_resin_to_monday());
    assert_asked(
        &world,
        &reply,
        "Which one?",
        &["resin_a", "resin_done", "resin_old"],
    );
    // with a row in focus the conversation was just on it: the focus pick, which is the done
    // instance the turn before wrote on, not the open one (a series of six: a list of more than four
    // rows is no focus)
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "resin_a", "name": "Order composite resin", "due": "2026-10-05"}),
        );
        for (n, due) in [
            "2026-04-01",
            "2026-05-01",
            "2026-06-01",
            "2026-07-01",
            "2026-08-01",
        ]
        .iter()
        .enumerate()
        {
            push(
                world,
                "tasks",
                json!({"key": format!("resin_d{}", n + 1), "name": "Order composite resin",
                       "due": due, "status": "completed", "completed": "2026-09-02T10:00"}),
            );
        }
    });
    let mut session = world.session();
    session.user("change the effort of the old order composite resin to 5");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Order composite resin"}),
    );
    let rows = found["effect"]["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 6, "{found}");
    let pick = rows
        .iter()
        .find(|row| row["id"] == world.id("resin_d2"))
        .map(|row| format!("#{}", row["n"]))
        .expect("a row of the series");
    call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": pick, "args": "effort: 5"}),
    );
    session.user("push it to monday");
    let focused = call(&mut session, "act", push_resin_to_monday());
    assert_eq!(
        ids(&focused["effect"]["diff"]["rows"]),
        vec![world.id("resin_d2")],
        "{focused}"
    );
    assert!(
        text(&focused).contains("it is the one this conversation was just on"),
        "{focused}"
    );
    assert!(focused["effect"].get("compose").is_none(), "{focused}");
}

#[test]
fn a_handle_selector_keeps_the_pronoun_as_a_pick() {
    // a write by number is the model's pick: "it" in the message points, as it always has, and the
    // pick check stays silent
    let world = resin();
    let mut session = world.session();
    // the series is in focus (nt9 F8: a pronoun points at a row the turn before showed)
    session.user("what about order composite resin");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Order composite resin"}),
    );
    let rows = found["effect"]["rows"].as_array().expect("rows");
    let pick = rows
        .iter()
        .find(|row| row["id"] == world.id("resin_done"))
        .map(|row| format!("#{}", row["n"]))
        .expect("a row of the series");
    session.user("Order composite resin, push it to monday");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "rows": pick,
               "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":1}"}),
    );
    assert_eq!(
        diff_rows(&reply)[0]["id"],
        world.id("resin_done"),
        "{reply}"
    );
    assert!(reply["effect"].get("compose").is_none(), "{reply}");
}

#[test]
fn a_pick_by_number_is_not_widened_to_the_open_instance() {
    let world = resin();
    let mut session = world.session();
    session.user("change the effort of order composite resin to 15");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Order composite resin"}),
    );
    let rows = found["effect"]["rows"].as_array().expect("rows");
    let pick = rows
        .iter()
        .find(|row| row["id"] == world.id("resin_done"))
        .map(|row| format!("#{}", row["n"]))
        .expect("a row of the series");
    // the model picked a done instance though nothing in the message says which: the pick check asks,
    // as before, and the open one is not put in its place
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": pick, "args": "effort: 15"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(
        reply["effect"]["ask"]["question"], "which one of the 3 did you mean?",
        "{reply}"
    );
    assert!(reply["effect"].get("diff").is_none(), "{reply}");
}

#[test]
fn a_name_that_not_every_row_shares_keeps_the_ask() {
    // nt12 R6: every row that reaches tiers 1 to 3 is a candidate: the two instances of the name
    // and the task with more words (`...supplies`) are the ask
    let world = world_with(|world| {
        for (key, name, due, done) in [
            ("a", "Order composite resin", "2026-10-05", false),
            ("b", "Order composite resin", "2026-09-01", true),
            ("c", "Order composite resin supplies", "2026-10-20", false),
        ] {
            let mut task = json!({"key": key, "name": name, "due": due});
            if done {
                task["status"] = json!("completed");
                task["completed"] = json!("2026-09-02T10:00");
            }
            push(world, "tasks", task);
        }
    });
    let mut session = world.session();
    session.user("change the effort of order composite resin to 15");
    let reply = call(&mut session, "act", edit_resin());
    assert_asked(&world, &reply, "Which one?", &["a", "b", "c"]);
}

#[test]
fn a_trace_scope_does_not_pick_an_instance() {
    // the trace's `scope: some` or `scope: one` leaves the rows the name fits to the ask: only
    // `scope: all` takes every one of them
    for scope in ["some", "one"] {
        let world = resin();
        let mut session = world.session();
        session.user("change the effort of order composite resin to 15");
        let reply = session.call_traced(
            "act",
            &edit_resin(),
            Some(&format!(
                "intent: write \"edit\"\nverb: edit\nscope: {scope}"
            )),
        );
        assert_eq!(tool_of(&reply), "ask", "scope {scope}: {reply}");
        assert!(diff_rows(&reply).is_empty(), "scope {scope}: {reply}");
    }
}

#[test]
fn without_the_flag_a_series_is_the_old_ambiguous_reply() {
    // a series of tasks and a series of events are the old `ambiguous:` reply either way
    let world = resin();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("change the effort of order composite resin to 15");
    let reply = call(&mut session, "act", edit_resin());
    assert!(
        text(&reply).starts_with("ambiguous: \"Order composite resin\" fits"),
        "{reply}"
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
    assert!(reply["effect"].get("compose").is_none(), "{reply}");
    let world = movie_nights();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("cancel movie night");
    let reply = call(&mut session, "act", cancel_movie_night());
    assert!(
        text(&reply).starts_with("ambiguous: \"Movie night\" fits"),
        "{reply}"
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// M1c R7: a name that reaches nothing of its kind goes to the one row of another kind it names

/// The fixture plus an event called `Oil change`, and no task of that name.
fn oil_change() -> World {
    world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "oil", "name": "Oil change", "start": "2026-10-10T08:00"}),
        );
    })
}

const TO_FRIDAY: &str = "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":5}";

fn move_oil_change(name: &str) -> Value {
    json!({"verb": "reschedule", "kind": "task", "name": name, "args": TO_FRIDAY})
}

#[test]
fn a_name_the_other_kind_has_exactly_is_that_row() {
    let world = oil_change();
    let mut session = world.session();
    session.user("move the oil change to friday");
    let reply = call(&mut session, "act", move_oil_change("oil change"));
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(tool_of(&reply), "act", "{reply}");
    let rows = diff_rows(&reply);
    assert_eq!(rows.len(), 1, "{reply}");
    assert_eq!(rows[0]["id"], world.id("oil"), "{reply}");
    let n = rows[0]["n"].as_u64().expect("a number");
    assert!(
        text(&reply).starts_with(&format!(
            "note: no task called \"oil change\"; applied to #{n} event \"Oil change\"\n"
        )),
        "the note leads, the write's lines follow: {reply}"
    );
    assert_eq!(family(&reply), fix("unmatched_write", "apply_other_kind"));
    assert!(reply["effect"].get("composed").is_none(), "{reply}");
    assert!(reply["effect"].get("near_spelling").is_none(), "{reply}");
}

#[test]
fn a_word_start_of_another_kind_is_that_row_too() {
    let world = oil_change();
    let mut session = world.session();
    session.user("move the oil chan to friday");
    let reply = call(&mut session, "act", move_oil_change("oil chan"));
    assert_eq!(diff_rows(&reply)[0]["id"], world.id("oil"), "{reply}");
    assert!(
        text(&reply).starts_with("note: no task called \"oil chan\"; applied to #"),
        "{reply}"
    );
    assert_eq!(family(&reply), fix("unmatched_write", "apply_other_kind"));
}

#[test]
fn a_near_spelling_of_another_kind_still_asks() {
    let world = oil_change();
    let mut session = world.session();
    session.user("move the oil chnge to friday");
    let reply = call(&mut session, "act", move_oil_change("oil chnge"));
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(options(&reply), vec![world.id("oil")], "{reply}");
    assert_eq!(family(&reply), fix("unmatched_write", "ask_nearest"));
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn delete_still_asks_for_an_exact_name_of_another_kind() {
    let world = oil_change();
    let mut session = world.session();
    session.user("delete the oil change");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "task", "name": "oil change"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(options(&reply), vec![world.id("oil")], "{reply}");
    assert_eq!(family(&reply), fix("unmatched_write", "ask_nearest"));
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn a_write_that_may_take_several_rows_still_asks_for_another_kind() {
    let world = oil_change();
    let mut session = world.session();
    session.user("move all the oil changes to friday");
    let reply = call(&mut session, "act", move_oil_change("oil change"));
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn two_rows_of_another_kind_are_which_one() {
    let world = world_with(|world| {
        for (key, start) in [("oil_a", "2026-10-10T08:00"), ("oil_b", "2026-11-14T08:00")] {
            push(
                world,
                "events",
                json!({"key": key, "name": "Oil change", "start": start}),
            );
        }
    });
    let mut session = world.session();
    session.user("move the oil change to friday");
    let reply = call(&mut session, "act", move_oil_change("oil change"));
    assert_asked(&world, &reply, "Which one?", &["oil_a", "oil_b"]);
    assert_eq!(family(&reply), fix("unmatched_write", "ask_options"));
}

#[test]
fn a_partial_fit_of_its_own_kind_does_not_shadow_the_exact_name_of_another() {
    // "Buy oil filter" has one word of "oil change"; the event has both
    let world = world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "oil", "name": "Oil change", "start": "2026-10-10T08:00"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "filter", "name": "Buy oil filter", "due": "2026-10-08"}),
        );
    });
    let mut session = world.session();
    session.user("move the oil change to friday");
    let reply = call(&mut session, "act", move_oil_change("oil change"));
    assert_eq!(diff_rows(&reply)[0]["id"], world.id("oil"), "{reply}");
    assert_eq!(family(&reply), fix("unmatched_write", "apply_other_kind"));
    // a verb the event does not take has no other kind to go to, and `Buy oil filter` holds one of
    // the two words of the name: no candidate for a write (nt15 R4: more than half the words), so
    // the turn ends in the decline
    let mut session = world.session();
    session.user("tick off oil change");
    let ask = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "oil change"}),
    );
    assert_eq!(tool_of(&ask), "decline", "{ask}");
    assert_eq!(family(&ask), fix("unmatched_write", "decline:not_found"));
    assert!(diff_rows(&ask).is_empty(), "{ask}");
}

#[test]
fn a_candidate_that_fits_one_word_of_two_is_not_one_for_a_write() {
    // "Ray Smith" reaches "Ray Ochoa" by one word of two: no candidate for a write (nt15 R4: more
    // than half of the name's words; it was the ask `Did you mean Ray Ochoa?`), and not a spelling
    // of the name either (R3 applies "Ray Ochoo", whose every word is spelled)
    let world = seeded();
    let mut session = world.session();
    session.user("star ray smith");
    let reply = call(&mut session, "act", STAR("Ray Smith"));
    assert_eq!(tool_of(&reply), "decline", "{reply}");
    assert_eq!(family(&reply), fix("unmatched_write", "decline:not_found"));
    assert!(reply["effect"].get("near_spelling").is_none(), "{reply}");
    assert!(diff_rows(&reply).is_empty(), "{reply}");
}

#[test]
fn without_the_flag_a_name_of_another_kind_is_the_old_recovery() {
    let world = oil_change();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("move the oil change to friday");
    let reply = call(&mut session, "act", move_oil_change("oil change"));
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert_eq!(reply["effect"]["recovery"], "empty", "{reply}");
    assert!(
        text(&reply).contains("Other kinds called \"oil change\": #"),
        "{reply}"
    );
    assert!(diff_rows(&reply).is_empty(), "{reply}");
    assert!(reply["effect"].get("compose").is_none(), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// M1d: a rows handle that names a value

/// A reply that is the error for a `@n` that holds a value: nothing ran, nothing was written.
fn assert_value_not_rows(reply: &Value, handle: &str) {
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert_eq!(
        reply["effect"]["error"],
        format!("error: {handle} is a value, not rows."),
        "{reply}"
    );
    assert!(
        text(reply).starts_with(&format!("error: {handle} is a value, not rows.")),
        "{reply}"
    );
    for key in ["diff", "answer", "ask", "decline", "composed", "rows"] {
        assert!(reply["effect"].get(key).is_none(), "no {key}: {reply}");
    }
}

#[test]
fn a_rows_handle_that_names_a_value_is_an_error_not_the_rows_it_was_counted_over() {
    let world = seeded();
    let mut session = world.session();
    session.user("how many tasks, and which are they");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task"}),
    );
    assert_eq!(counted["effect"]["result"], "@1", "{counted}");
    // `rows` of an answer, a write and a compute, and the options of an ask, take rows
    for (tool, args) in [
        ("answer", json!({"rows": "@1"})),
        ("act", json!({"verb": "complete", "rows": "@1"})),
        ("compute", json!({"op": "count", "rows": "@1"})),
        ("ask", json!({"question": "which one?", "options": "@1"})),
    ] {
        session.user("");
        let reply = call(&mut session, tool, args);
        assert_value_not_rows(&reply, "@1");
    }
    // a list that holds the value among rows is the same error
    session.user("");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Book the cabin"}),
    );
    assert_eq!(found["effect"]["result"], "@2", "{found}");
    let mixed = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "@2, @1"}),
    );
    assert_value_not_rows(&mixed, "@1");
    // nothing was written
    let cabin = number(&mut session, "task", "Book the cabin");
    let open = call(&mut session, "open", json!({"row": cabin}));
    assert!(text(&open).contains("status open"), "{open}");
}

#[test]
fn a_value_handle_is_never_the_rows_of_the_next_find() {
    // the value is @1, the find after it @2: `rows=@1` is the value, whatever came next
    let world = seeded();
    let mut session = world.session();
    session.user("how many people, and complete the cabin one");
    call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person"}),
    );
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Book the cabin"}),
    );
    assert_eq!(found["effect"]["result"], "@2", "{found}");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "@1"}),
    );
    assert_value_not_rows(&reply, "@1");
    // the same call sent again gets the hint, then ends the turn in the typed decline, never
    // in the rows of @2
    let hint = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "@1"}),
    );
    assert_eq!(hint["ends_turn"], false, "{hint}");
    let again = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "@1"}),
    );
    assert_declined(&again, "not_found");
    assert!(text(&again).contains("@1 is a value, not rows"), "{again}");
    assert!(again["effect"].get("diff").is_none(), "{again}");
    // and `rows=@2` is the find's rows
    let mut session = world.session();
    session.user("how many people, and complete the cabin one");
    call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "person"}),
    );
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Book the cabin"}),
    );
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "@2"}),
    );
    assert!(text(&done).starts_with("completed: "), "{done}");
}

#[test]
fn a_value_keeps_its_rows_for_within_and_exclude() {
    // the rule is on `rows`: the value is still a set of its own that `within` and `exclude` reach
    let world = seeded();
    let mut session = world.session();
    session.user("how many tasks, and which");
    call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task"}),
    );
    let within = call(
        &mut session,
        "find",
        json!({"kind": "task", "within": "@1"}),
    );
    assert_eq!(ids(&within["effect"]["rows"]).len(), 5, "{within}");
    let rest = call(
        &mut session,
        "find",
        json!({"kind": "task", "exclude": "@1"}),
    );
    assert_eq!(ids(&rest["effect"]["rows"]), Vec::<String>::new(), "{rest}");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "within": "@1"}),
    );
    assert_eq!(
        counted["effect"]["value"]["values"][0]["amount"], 5,
        "{counted}"
    );
}

#[test]
fn without_the_flag_a_rows_handle_that_names_a_value_is_the_same_error() {
    let world = seeded();
    let mut session = world.session_with(common::TODAY, uncomposed());
    session.user("how many tasks, and which are they");
    call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task"}),
    );
    let reply = call(&mut session, "answer", json!({"rows": "@1"}));
    assert_value_not_rows(&reply, "@1");
}

// ---------------------------------------------------------------------------------------------
// M1d item 2: a pick of the row the model's own lookup singled out stands

/// One bill paid again and again: one instance open (due Monday 5 October) and two done.
fn nepa() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "nepa_open", "name": "Pay NEPA", "due": "2026-10-05"}),
        );
        for (key, due) in [("nepa_d1", "2026-08-05"), ("nepa_d2", "2026-09-05")] {
            push(
                world,
                "tasks",
                json!({"key": key, "name": "Pay NEPA", "due": due,
                       "status": "completed", "completed": "2026-09-06T10:00"}),
            );
        }
    })
}

/// A lookup of this turn with a condition of the model's own; the `#n` of the row it left, when
/// it left one.
fn open_nepa(session: &mut Session) -> String {
    let found = call(
        session,
        "find",
        json!({"kind": "task", "name": "Pay NEPA", "where": "status = open"}),
    );
    let rows = found["effect"]["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 1, "{found}");
    format!("#{}", rows[0]["n"])
}

#[test]
fn a_pick_of_the_row_the_model_found_by_a_condition_of_its_own_stands() {
    // val T34-062 t4: the find left the one open instance of three namesakes, and the act on its
    // `#n` is the model's reading of the person's words, as a call that carries the `where` is
    for (message, args) in [
        (
            "edit pay nepa",
            json!({"verb": "edit", "args": "effort: 20"}),
        ),
        ("delete pay nepa", json!({"verb": "delete"})),
        (
            "push pay nepa to friday",
            json!({"verb": "reschedule", "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":5}"}),
        ),
        ("tick off pay nepa", json!({"verb": "complete"})),
    ] {
        let world = nepa();
        let mut session = world.session();
        session.user(message);
        let pick = open_nepa(&mut session);
        let mut args = args;
        args["rows"] = json!(pick);
        let reply = call(&mut session, "act", args);
        assert_eq!(reply["ends_turn"], true, "{message}: {reply}");
        assert_eq!(tool_of(&reply), "act", "{message}: {reply}");
        assert_eq!(
            ids(&reply["effect"]["diff"]["rows"]),
            vec![world.id("nepa_open")],
            "{message}: {reply}"
        );
        assert!(
            reply["effect"].get("composed").is_none(),
            "{message}: {reply}"
        );
    }
}

#[test]
fn a_lookup_with_a_when_or_a_link_of_its_own_bears_out_the_pick_too() {
    // a link: the Pay NEPA of the Home list
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "nepa_home", "name": "Pay NEPA", "due": "2026-10-05", "list": "home"}),
        );
        for key in ["nepa_a", "nepa_b"] {
            push(
                world,
                "tasks",
                json!({"key": key, "name": "Pay NEPA", "due": "2026-10-06"}),
            );
        }
    });
    let mut session = world.session();
    session.user("edit pay nepa in the home list");
    let list = find_in_turn(&mut session, "list", "Home");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Pay NEPA", "linked_to": list}),
    );
    let rows = found["effect"]["rows"].as_array().expect("rows");
    assert_eq!(ids(&found["effect"]["rows"]), vec![world.id("nepa_home")]);
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": format!("#{}", rows[0]["n"]), "args": "effort: 20"}),
    );
    assert_eq!(
        ids(&reply["effect"]["diff"]["rows"]),
        vec![world.id("nepa_home")],
        "{reply}"
    );
    // a day: the standup of one Monday
    let world = world_with(|world| {
        for (n, day) in ["2026-10-05", "2026-10-12", "2026-10-19"]
            .iter()
            .enumerate()
        {
            push(
                world,
                "events",
                json!({"key": format!("stand{n}"), "name": "Team standup",
                       "start": format!("{day}T09:00")}),
            );
        }
    });
    let mut session = world.session();
    session.user("edit the team standup");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Team standup",
               "when": {"from": {"date": "2026-10-12"}, "to": {"date": "2026-10-12"}}}),
    );
    let rows = found["effect"]["rows"].as_array().expect("rows");
    assert_eq!(
        ids(&found["effect"]["rows"]),
        vec![world.id("stand1")],
        "{found}"
    );
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": format!("#{}", rows[0]["n"]), "args": "description: moved"}),
    );
    assert_eq!(
        ids(&reply["effect"]["diff"]["rows"]),
        vec![world.id("stand1")],
        "{reply}"
    );
}

#[test]
fn a_lookup_by_the_name_alone_or_one_that_left_two_rows_bears_out_no_pick() {
    // the name alone: three namesakes found, and the open one picked
    let world = nepa();
    let mut session = world.session();
    session.user("edit pay nepa");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Pay NEPA"}),
    );
    let pick = found["effect"]["rows"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == world.id("nepa_open")))
        .map(|row| format!("#{}", row["n"]))
        .expect("the open one");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": pick, "args": "effort: 20"}),
    );
    assert_asked(
        &world,
        &reply,
        "which one of the 3 did you mean?",
        &["nepa_open", "nepa_d1", "nepa_d2"],
    );
    // a condition that left two open instances: the model has not singled one out
    let world = resin_two_open();
    let mut session = world.session();
    session.user("change the effort of order composite resin to 15");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Order composite resin", "where": "status = open"}),
    );
    assert_eq!(ids(&found["effect"]["rows"]).len(), 2, "{found}");
    let pick = found["effect"]["rows"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == world.id("resin_a")))
        .map(|row| format!("#{}", row["n"]))
        .expect("an open one");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": pick, "args": "effort: 15"}),
    );
    assert_asked(
        &world,
        &reply,
        "which one of the 3 did you mean?",
        &["resin_a", "resin_b", "resin_done"],
    );
}

#[test]
fn a_verb_that_does_not_change_the_found_row_is_asked_over_the_rows_it_changes() {
    // `reopen` of the one open instance: the lookup singled out a row the verb leaves as it is, and
    // the ask is over the two done instances it reopens, with the open one left out
    let world = nepa();
    let mut session = world.session();
    session.user("reopen pay nepa");
    let pick = open_nepa(&mut session);
    let reply = call(&mut session, "act", json!({"verb": "reopen", "rows": pick}));
    assert_asked(
        &world,
        &reply,
        "which one of the 2 did you mean?",
        &["nepa_d1", "nepa_d2"],
    );
    assert!(
        text(&reply).contains("fits 3 rows (1 left out: reopen does not apply to them)"),
        "{reply}"
    );
}

/// Three Rosas, one starred, and six nurses among whom the starred Rosa and Rosa Lee.
fn rosas() -> World {
    world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "rosa_a", "name": "Rosa Diaz", "role": "nurse", "starred": true}),
        );
        push(
            world,
            "people",
            json!({"key": "rosa_b", "name": "Rosa Lee", "role": "nurse"}),
        );
        push(
            world,
            "people",
            json!({"key": "rosa_c", "name": "Rosa Moon"}),
        );
        for n in 1..=4 {
            push(
                world,
                "people",
                json!({"key": format!("nurse{n}"), "name": format!("Nina Nurse{n}"), "role": "nurse"}),
            );
        }
    })
}

#[test]
fn a_longer_list_bears_out_the_pick_among_the_rows_the_verb_changes() {
    // the turn before listed the six nurses, among them the starred Rosa and Rosa Lee. The person
    // says "star rosa" and the model picks Rosa Lee: of the Rosas star would change (Lee and Moon)
    // only Lee was in the list the person saw
    let world = rosas();
    let mut session = world.session();
    session.user("which nurses do i know");
    let listed = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "role = nurse"}),
    );
    let rows = listed["effect"]["rows"].as_array().expect("rows");
    assert_eq!(rows.len(), 6, "{listed}");
    let lee = rows
        .iter()
        .find(|row| row["id"] == world.id("rosa_b"))
        .map(|row| format!("#{}", row["n"]))
        .expect("Rosa Lee");
    session.user("star rosa");
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": lee}));
    assert_eq!(
        ids(&reply["effect"]["diff"]["rows"]),
        vec![world.id("rosa_b")],
        "{reply}"
    );
    // the same pick of a Rosa the list did not hold is the ask, over the Rosas star would change
    let world = rosas();
    let mut session = world.session();
    session.user("which nurses do i know");
    call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "role = nurse"}),
    );
    session.user("star rosa");
    let moon = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Rosa Moon"}),
    );
    let moon = format!("#{}", moon["effect"]["rows"][0]["n"]);
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": moon}));
    assert_asked(
        &world,
        &reply,
        "which one of the 2 did you mean?",
        &["rosa_b", "rosa_c"],
    );
}

// ---------------------------------------------------------------------------------------------
// M1d item 3: the next and last rules read the dated kind the call reads

/// Three rehearsals: one a week ago, one next Saturday, one the Saturday after, with who comes.
fn rehearsals() -> World {
    world_with(|world| {
        for (key, start, who) in [
            ("reh0", "2026-09-26T19:00", json!(["ray", "benedikt"])),
            (
                "reh1",
                "2026-10-10T19:00",
                json!(["neha_r", "ray", "benedikt"]),
            ),
            ("reh2", "2026-10-17T19:00", json!(["neha_r"])),
        ] {
            push(
                world,
                "events",
                json!({"key": key, "name": "Rehearsal", "start": start, "attendees": who}),
            );
        }
    })
}

#[test]
fn next_reads_the_event_and_not_the_people_linked_to_it() {
    // val T34-065 t1: "who's at the next rehearsal" is two calls, the rehearsal and its people; only
    // the first is the next one, and the second got "from today" and returned nobody
    let world = rehearsals();
    let mut session = world.session();
    session.user("who's at the next rehearsal");
    let event = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Rehearsal"}),
    );
    assert_eq!(
        ids(&event["effect"]["rows"]),
        vec![world.id("reh1")],
        "{event}"
    );
    assert!(
        text(&event).contains("next: the message asks for the next one"),
        "{event}"
    );
    let at = format!("#{}", event["effect"]["rows"][0]["n"]);
    let people = call(
        &mut session,
        "find",
        json!({"kind": "person", "linked_to": at.clone()}),
    );
    assert_eq!(
        sorted(ids(&people["effect"]["rows"])),
        sorted(vec![
            world.id("neha_r"),
            world.id("ray"),
            world.id("benedikt")
        ]),
        "{people}"
    );
    assert!(!text(&people).contains("next:"), "{people}");
    // and an answer reads them the same way
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "person", "linked_to": at}),
    );
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]).len(),
        3,
        "{answered}"
    );
    assert!(!text(&answered).contains("next:"), "{answered}");
}

#[test]
fn last_one_reads_the_event_and_not_the_people_linked_to_it() {
    let world = rehearsals();
    let mut session = world.session();
    session.user("who was at the last one");
    let event = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Rehearsal"}),
    );
    assert_eq!(
        ids(&event["effect"]["rows"]),
        vec![world.id("reh0")],
        "{event}"
    );
    assert!(
        text(&event).contains("last: the message asks for the last one"),
        "{event}"
    );
    let at = format!("#{}", event["effect"]["rows"][0]["n"]);
    let people = call(
        &mut session,
        "find",
        json!({"kind": "person", "linked_to": at}),
    );
    assert_eq!(
        sorted(ids(&people["effect"]["rows"])),
        sorted(vec![world.id("ray"), world.id("benedikt")]),
        "{people}"
    );
    assert!(!text(&people).contains("last:"), "{people}");
}

#[test]
fn next_is_for_the_kinds_a_schedule_dates_and_last_one_is_not() {
    // a person's date is when they were last contacted, a note's when it was made: nothing of
    // them is upcoming, and "next" over them is another read
    let world = seeded();
    let mut session = world.session();
    session.user("who is next on my list");
    let people = call(&mut session, "find", json!({"kind": "person"}));
    assert_eq!(ids(&people["effect"]["rows"]).len(), 5, "{people}");
    assert!(!text(&people).contains("next:"), "{people}");
    // "last one" still reads the latest past one of them
    let mut session = world.session();
    session.user("who was the last one i spoke to");
    let people = call(&mut session, "find", json!({"kind": "person"}));
    assert_eq!(
        ids(&people["effect"]["rows"]),
        vec![world.id("neha_r")],
        "{people}"
    );
    assert!(
        text(&people).contains("last: the message asks for the last one"),
        "{people}"
    );
    // and the tasks and events keep both
    let mut session = world.session();
    session.user("when's the next dentist");
    let events = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Dentist"}),
    );
    assert!(
        text(&events).contains("next: the message asks for the next one"),
        "{events}"
    );
}

#[test]
fn a_task_found_through_its_own_kind_or_a_list_is_still_the_next_one() {
    // the exception is a call that reads what hangs off a task or an event of another kind
    let world = seeded();
    let mut session = world.session();
    session.user("what's the next task in the home list");
    let list = find_in_turn(&mut session, "list", "Home");
    let tasks = call(
        &mut session,
        "find",
        json!({"kind": "task", "linked_to": list}),
    );
    assert!(
        text(&tasks).contains("next: the message asks for the next one"),
        "{tasks}"
    );
    // tasks of an event are what hangs off it
    let mut session = world.session();
    session.user("what do i need for the next dentist");
    let dentist = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "Dentist"}),
    );
    let at = format!("#{}", dentist["effect"]["rows"][0]["n"]);
    let tasks = call(
        &mut session,
        "find",
        json!({"kind": "task", "linked_to": at}),
    );
    assert!(!text(&tasks).contains("next:"), "{tasks}");
}

// ---------------------------------------------------------------------------------------------
// M1d item 4: the options of "Which one?" are the rows the verb can change

#[test]
fn the_options_are_the_rows_the_verb_changes_and_the_note_counts_the_rest() {
    // unstar over four receipts, two of them already unstarred
    let world = world_with(|world| {
        for (n, starred) in [true, true, false, false].iter().enumerate() {
            push(
                world,
                "documents",
                json!({"key": format!("receipt{n}"), "name": format!("Receipt {n}"),
                       "starred": starred, "created": "2026-05-01T10:00"}),
            );
        }
    });
    let mut session = world.session();
    session.user("unstar the receipts");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "unstar", "kind": "document", "name": "Receipt"}),
    );
    assert_asked(&world, &reply, "Which one?", &["receipt0", "receipt1"]);
    assert!(
        text(&reply).contains("fits 4 rows (2 left out: unstar does not apply to them)"),
        "{reply}"
    );
    assert_eq!(reply["effect"]["left_out"], 2, "{reply}");
    assert_eq!(ids(&reply["effect"]["ambiguous"]).len(), 2, "{reply}");
    // complete over fifteen open instances and thirty done: the open ones, nearest due first, cut
    // at twelve with the rest counted, and the thirty the verb leaves as they are not options
    let world = world_with(|world| {
        for n in 0..15 {
            push(
                world,
                "tasks",
                json!({"key": format!("open{n}"), "name": "Pay NEPA",
                       "due": format!("2026-10-{:02}", 20 - n)}),
            );
        }
        for n in 0..30 {
            push(
                world,
                "tasks",
                json!({"key": format!("done{n}"), "name": "Pay NEPA", "due": "2026-08-01",
                       "status": "completed", "completed": "2026-08-02T10:00"}),
            );
        }
    });
    let mut session = world.session();
    session.user("tick off pay nepa");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Pay NEPA"}),
    );
    assert_eq!(tool_of(&reply), "ask", "{reply}");
    assert_eq!(options(&reply).len(), 12, "{reply}");
    assert_eq!(
        options(&reply)[0],
        world.id("open14"),
        "the nearest due first: {reply}"
    );
    assert!(text(&reply).contains(" and 3 more"), "{reply}");
    assert!(
        text(&reply).contains("fits 45 rows (30 left out: complete does not apply to them)"),
        "{reply}"
    );
    assert_eq!(ids(&reply["effect"]["ambiguous"]).len(), 15, "{reply}");
    // the question counts the options of a pick too
    let mut session = world.session();
    session.user("tick off pay nepa");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Pay NEPA", "where": "status = open"}),
    );
    // a long lookup shows some of its rows: one of them is the pick
    let pick = found["effect"]["rows"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["n"].is_u64()))
        .map(|row| format!("#{}", row["n"]))
        .expect("a row shown");
    let picked = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": pick}),
    );
    assert_eq!(
        picked["effect"]["ask"]["question"], "which one of the 15 did you mean?",
        "{picked}"
    );
}

// ---------------------------------------------------------------------------------------------
// M1d item 5: a name's hyphens and apostrophes fold

fn joined_names() -> World {
    world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "yunho", "name": "Yun-ho Kim"}),
        );
        push(world, "people", json!({"key": "hoseok", "name": "Ho-seok"}));
        push(
            world,
            "people",
            json!({"key": "seojun", "name": "Seojun Park"}),
        );
        push(
            world,
            "people",
            json!({"key": "dan_o", "name": "Dan O'Brien"}),
        );
        push(
            world,
            "events",
            json!({"key": "pub", "name": "Dinner at O'Brien's", "start": "2026-10-10T19:00"}),
        );
    })
}

fn rows_found(reply: &Value) -> Vec<String> {
    ids(&reply["effect"]["rows"])
}

#[test]
fn a_name_typed_with_or_without_its_hyphen_or_apostrophe_finds_the_row() {
    let world = joined_names();
    let mut session = world.session();
    session.user("who is yunho");
    for (kind, name, key) in [
        ("person", "yunho", "yunho"),
        ("person", "Yun-ho", "yunho"),
        ("person", "yun ho", "yunho"),
        ("person", "YUNHO KIM", "yunho"),
        ("person", "hoseok", "hoseok"),
        ("person", "ho-seok", "hoseok"),
        // a name stored without the hyphen, typed with it
        ("person", "Seo-jun", "seojun"),
        ("person", "obrien", "dan_o"),
        ("event", "obriens", "pub"),
        ("event", "obrien", "pub"),
        ("event", "o'brien's", "pub"),
    ] {
        let reply = call(&mut session, "find", json!({"kind": kind, "name": name}));
        assert_eq!(rows_found(&reply), vec![world.id(key)], "{name}: {reply}");
        session.user("");
    }
}

#[test]
fn act_answer_and_search_read_a_joined_name_the_same_way() {
    let world = joined_names();
    let mut session = world.session();
    session.user("star hoseok");
    let starred = call(&mut session, "act", STAR("hoseok"));
    assert_eq!(
        ids(&starred["effect"]["diff"]["rows"]),
        vec![world.id("hoseok")],
        "{starred}"
    );
    session.user("who is yunho");
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "yunho"}),
    );
    assert_eq!(
        ids(&answered["effect"]["answer"]["rows"]),
        vec![world.id("yunho")],
        "{answered}"
    );
    session.user("find yunho");
    let found = call(&mut session, "search", json!({"text": "yunho"}));
    assert_eq!(rows_found(&found), vec![world.id("yunho")], "{found}");
    session.user("find obriens");
    let found = call(&mut session, "search", json!({"text": "obriens"}));
    assert!(rows_found(&found).contains(&world.id("pub")), "{found}");
}

#[test]
fn the_near_spelling_of_a_joined_name_is_read_too() {
    let world = joined_names();
    let mut session = world.session();
    session.user("who is yunhoo");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "yunhoo"}),
    );
    // nt11 R2: a read takes the typo's rows and says so
    assert!(text(&found).contains("Yun-ho Kim"), "{found}");
    assert!(
        text(&found).contains("matched \"Yun-ho Kim\" for \"yunhoo\""),
        "{found}"
    );
    session.user("star hoseock");
    let done = call(&mut session, "act", STAR("hoseock"));
    assert_eq!(tool_of(&done), "act", "{done}");
    assert_eq!(
        ids(&done["effect"]["diff"]["rows"]),
        vec![world.id("hoseok")],
        "{done}"
    );
}

#[test]
fn the_vault_line_and_the_pick_check_read_a_joined_name() {
    let world = joined_names();
    let mut session = world.session();
    let turn = session.user("star yunho");
    assert!(
        turn["preground"]
            .as_str()
            .is_some_and(|line| line.contains("Yun-ho Kim")),
        "{turn}"
    );
    // two Yun-hos: the message names both, and a pick of one by number is the ask
    let world = world_with(|world| {
        push(
            world,
            "people",
            json!({"key": "yunho_k", "name": "Yun-ho Kim"}),
        );
        push(
            world,
            "people",
            json!({"key": "yunho_p", "name": "Yun-ho Park"}),
        );
    });
    let mut session = world.session();
    session.user("star yunho");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "yunho"}),
    );
    let kim = found["effect"]["rows"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["id"] == world.id("yunho_k")))
        .map(|row| format!("#{}", row["n"]))
        .expect("Yun-ho Kim");
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": kim}));
    assert_asked(
        &world,
        &reply,
        "which one of the 2 did you mean?",
        &["yunho_k", "yunho_p"],
    );
}

// ---------------------------------------------------------------------------------------------
// M1d item 6: a lookup of trashed rows reads names as a live one does

#[test]
fn a_lookup_of_trashed_rows_reads_a_word_start_and_a_near_spelling_as_a_live_one_does() {
    // the fixture's trashed task `Library books`, with the live task `Book the cabin` that has the
    // word "book" exactly: the word start still reaches the trashed one in a lookup of trashed rows
    let world = seeded();
    let mut session = world.session();
    session.user("find the deleted book");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "book", "trashed": true}),
    );
    assert_eq!(rows_found(&found), vec![world.id("library")], "{found}");
    assert!(!text(&found).contains("matched "), "{found}");
    session.user("restore the library book");
    let restored = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "task", "name": "book", "trashed": true}),
    );
    assert_eq!(
        ids(&restored["effect"]["diff"]["rows"]),
        vec![world.id("library")],
        "{restored}"
    );
    assert!(text(&restored).starts_with("restored: #"), "{restored}");
    // the word start of a live lookup is as before: a whole word comes before a word start
    let mut session = world.session();
    session.user("find book");
    let live = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "book"}),
    );
    assert_eq!(rows_found(&live), vec![world.id("cabin")], "{live}");
    // deleted by a word start, restored by the same
    let world = world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "fridges", "name": "Look at new fridges"}),
        );
    });
    let mut session = world.session();
    session.user("delete fridge");
    let deleted = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "task", "name": "fridge"}),
    );
    assert_eq!(
        ids(&deleted["effect"]["diff"]["rows"]),
        vec![world.id("fridges")]
    );
    session.user("restore fridge");
    let back = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "task", "name": "fridge", "trashed": true}),
    );
    assert_eq!(
        ids(&back["effect"]["diff"]["rows"]),
        vec![world.id("fridges")],
        "{back}"
    );
    // the fallback search: a live row that spells the name better does not hide the trashed one
    let world = world_with(|world| {
        push(world, "tasks", json!({"key": "kitchen", "name": "Kitchen"}));
        push(
            world,
            "tasks",
            json!({"key": "kitchn", "name": "Kitchn", "trashed": true}),
        );
    });
    let mut session = world.session();
    session.user("restore the kitchen one");
    let near = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "task", "name": "kitchen", "trashed": true}),
    );
    // nt12 R6: `Kitchn` is a typo of `kitchen` (tier 4), the one trashed candidate: restored
    assert_eq!(tool_of(&near), "act", "{near}");
    assert_eq!(
        ids(&near["effect"]["diff"]["rows"]),
        vec![world.id("kitchn")],
        "{near}"
    );
}
