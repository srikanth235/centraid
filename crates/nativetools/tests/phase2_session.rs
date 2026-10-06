//! The session loop's phase 2 rules (#1044): the focus line, the dates line
//! in the user turn's block, an ask that lists every candidate (D-1044-9)
//! and the repeated-call policy (SPEC §6.1, §6.3).

mod common;

use centraid_nativetools::meta::{LOOKUP_CAP, ROW_CAP};
use centraid_nativetools::{Flags, Session};
use common::{call, seeded, seeded_with, text};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(common::FIXTURE).expect("the fixture is JSON")
}

/// The fixture with `count` more people called `Sam P<n>`: one name, many rows.
fn many_sams(count: usize) -> Value {
    let mut world = fixture();
    let people = world["people"].as_array_mut().expect("people");
    for n in 0..count {
        people.push(json!({"key": format!("sam{n}"), "name": format!("Sam P{n}")}));
    }
    world
}

/// The fixture with `count` more tasks called `Bulk chore <n>`.
fn many_tasks(count: usize) -> Value {
    let mut world = fixture();
    let tasks = world["tasks"].as_array_mut().expect("tasks");
    for n in 0..count {
        tasks.push(json!({"key": format!("bulk{n}"), "name": format!("Bulk chore {n}"), "due": "2026-11-01"}));
    }
    world
}

fn focus(session: &mut Session, message: &str) -> Option<String> {
    session.user(message)["focus"].as_str().map(str::to_owned)
}

/// The `#n` of the rows a response's effect lists under `key`.
fn numbers(rows: &Value) -> Vec<u64> {
    rows.as_array()
        .expect("rows")
        .iter()
        .filter_map(|row| row["n"].as_u64())
        .collect()
}

// ---------------------------------------------------------------------------
// The focus line
// ---------------------------------------------------------------------------

#[test]
fn the_focus_line_is_absent_while_the_session_has_nothing_to_hold_on_to() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    assert_eq!(focus(&mut session, "hello"), None);
    // a find that matched nothing issues no handle, so there is still nothing
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "tabla"}),
    );
    assert_eq!(focus(&mut session, "and now"), None);
}

#[test]
fn the_focus_line_names_the_rows_of_the_last_result() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is due next week");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"unit": "week", "rel": 1}}),
    );
    assert_eq!(
        focus(&mut session, "the second one").as_deref(),
        Some("focus: @1: #9 task \"Pay rent\", #10 task \"Book the cabin\"")
    );
    // a later result is the last one
    call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "ray"}),
    );
    let line = focus(&mut session, "and him").expect("a focus line");
    assert!(
        line.starts_with("focus: @2: #") && line.contains("person \"Ray Ochoa\""),
        "{line}"
    );
}

#[test]
fn a_result_shows_the_rows_the_model_was_shown_and_counts_the_rest() {
    // twelve rows or fewer are shown whole, so the focus line holds them all
    let world = seeded_with(&many_tasks(10));
    let mut session = world.session();
    session.user("all my tasks");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    assert_eq!(found["effect"]["rows"].as_array().expect("rows").len(), 10);
    let line = focus(&mut session, "which of them").expect("a focus line");
    assert_eq!(line.matches("task \"Bulk chore").count(), 10, "{line}");
    assert!(!line.contains("more"), "{line}");
    // a longer one is shown to the lookup cap, and the line counts the rest
    let world = seeded_with(&many_tasks(14));
    let mut session = world.session();
    session.user("all my tasks");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    let line = focus(&mut session, "which of them").expect("a focus line");
    let listed = line.matches("task \"Bulk chore").count();
    assert_eq!(listed, LOOKUP_CAP, "{line}");
    assert!(
        line.ends_with(&format!(" +{} more", 14 - LOOKUP_CAP)),
        "{line}"
    );
}

#[test]
fn a_value_is_a_set_of_its_own_after_the_rows() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task"}),
    );
    let line = focus(&mut session, "which").expect("a focus line");
    // the rows keep the one-set form; the count is a set of its own under `earlier:`
    assert!(
        line.starts_with("focus: @1: #") && line.ends_with(" · earlier: @2 (counted 5 tasks)"),
        "{line}"
    );
}

#[test]
fn the_focus_line_holds_the_rows_created_this_session() {
    let world = seeded();
    let mut session = world.session();
    session.user("make a group called Lisboa");
    let made = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "group", "args": "name: Lisboa"}),
    );
    let n = made["effect"]["created"][0]["n"]
        .as_u64()
        .expect("a number");
    assert_eq!(
        focus(&mut session, "put ray in it").as_deref(),
        Some(format!("focus: created #{n} group \"Lisboa\"").as_str())
    );
    // a second create joins it, in order
    call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: Book flights"}),
    );
    let line = focus(&mut session, "and the flights").expect("a focus line");
    assert!(
        line.starts_with(&format!("focus: created #{n} group \"Lisboa\", #"))
            && line.contains("task \"Book flights\""),
        "{line}"
    );
}

#[test]
fn only_the_last_rows_created_are_shown_and_the_earlier_ones_are_counted() {
    let world = seeded();
    let mut session = world.session();
    for n in 0..8 {
        session.user("another one");
        call(
            &mut session,
            "act",
            json!({"verb": "create", "kind": "task", "args": format!("name: Chore {n}")}),
        );
    }
    let line = focus(&mut session, "what did i make").expect("a focus line");
    assert_eq!(line.matches("task \"Chore").count(), LOOKUP_CAP, "{line}");
    assert!(
        line.contains("\"Chore 7\"")
            && !line.contains("\"Chore 1\"")
            && line.ends_with(" +2 earlier"),
        "{line}"
    );
}

#[test]
fn the_focus_line_holds_the_options_of_the_last_ask() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("log a call with neha");
    let ambiguous = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    let listed = numbers(&ambiguous["effect"]["ambiguous"]);
    assert_eq!(listed.len(), 2, "{ambiguous}");
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which neha?", "options": format!("#{}, #{}", listed[1], listed[0])}),
    );
    assert_eq!(asked["ends_turn"], true);
    let line = focus(&mut session, "the first one").expect("a focus line");
    // the options, in the order the ask gave them
    let first = line
        .find(&format!("#{} person", listed[1]))
        .expect("the first option");
    let second = line
        .find(&format!("#{} person", listed[0]))
        .expect("the second option");
    assert!(
        line.starts_with("focus: asked: #") && first < second,
        "{line}"
    );
    // the next ask replaces it; an ask without options leaves nothing to hold
    session.user("the first one");
    call(&mut session, "ask", json!({"question": "what about?"}));
    assert_eq!(focus(&mut session, "hm"), None);
}

#[test]
fn the_asked_options_are_in_focus_for_the_one_turn_that_answers_the_ask() {
    let world = seeded();
    let mut session = world.session();
    session.user("log a call with neha");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    let listed = numbers(&reply["effect"]["ambiguous"]);
    call(&mut session, "ask", json!({"question": "which neha?"}));
    // the turn that answers it
    let line = focus(&mut session, "neha rao").expect("a focus line");
    assert!(line.starts_with("focus: asked: #"), "{line}");
    assert_eq!(
        line.matches("person \"Neha").count(),
        listed.len(),
        "{line}"
    );
    let star = common::find_in_turn(&mut session, "person", "neha rao");
    call(&mut session, "act", json!({"verb": "star", "rows": star}));
    // the turn after has moved on: the options are not in focus any more
    let later = focus(&mut session, "what is due this week").expect("the find's result is held");
    assert!(
        later.starts_with("focus: @1: #") && !later.contains("asked:"),
        "{later}"
    );
}

#[test]
fn the_asked_options_show_at_most_the_row_cap_and_count_the_rest() {
    let world = seeded_with(&many_tasks(14));
    let mut session = world.session();
    session.user("which chore");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    assert_eq!(found["effect"]["rows"].as_array().expect("rows").len(), 14);
    call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": "@1"}),
    );
    let line = focus(&mut session, "the third").expect("a focus line");
    let asked = line.split(" · asked: ").nth(1).expect("an asked part");
    assert_eq!(
        asked.matches("task \"Bulk chore").count(),
        ROW_CAP,
        "{line}"
    );
    assert!(
        asked.ends_with(&format!(" +{} more", 14 - ROW_CAP)),
        "{line}"
    );
}

#[test]
fn the_three_parts_come_in_order_and_the_block_adds_the_vault_and_dates_lines() {
    let world = seeded();
    let mut session = world.session();
    session.user("make a group called Lisboa");
    call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "group", "args": "name: Lisboa", "more": true}),
    );
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    call(
        &mut session,
        "ask",
        json!({"question": "sure?", "options": "#8"}),
    );
    let turn = session.user("what is neha doing next tuesday at 9pm");
    let focus = turn["focus"].as_str().expect("a focus line");
    let (created, rest) = focus.split_once(" · @").expect("created, then the result");
    assert!(
        created.starts_with("focus: created #") && rest.contains(" · asked: #8 "),
        "{focus}"
    );
    // today is Sunday 2026-09-27: next tuesday is the Tuesday of next week
    assert_eq!(
        turn["dates"],
        "dates: next tuesday = 2026-09-29 · at 9pm = 21:00"
    );
    let vault = turn["preground"].as_str().expect("a vault line");
    assert!(
        vault.starts_with("vault: #") && vault.contains("Neha"),
        "{vault}"
    );
    // one block, the lines the turn has, in this order
    assert_eq!(
        turn["block"],
        json!(format!(
            "{vault}\n{focus}\n{}",
            turn["dates"].as_str().unwrap()
        ))
    );
}

#[test]
fn the_block_keeps_only_the_lines_there_are_and_the_vault_line_stays_apart() {
    let world = seeded();
    let mut session = world.session();
    // a date phrase alone: no vault line, no focus line
    let turn = session.user("what is due this week?");
    assert!(
        turn["preground"].is_null() && turn["focus"].is_null(),
        "{turn}"
    );
    assert_eq!(turn["block"], turn["dates"]);
    assert_eq!(turn["dates"], "dates: this week = 2026-09-21..2026-09-27");
    // nothing to say at all: no block
    let turn = session.user("how many people do i know");
    assert!(turn["block"].is_null() && turn["dates"].is_null(), "{turn}");
    // a name alone: the vault line is the whole block
    let turn = session.user("neha");
    assert_eq!(turn["block"], turn["preground"]);
}

#[test]
fn without_pre_grounding_the_turn_has_no_block() {
    let world = seeded();
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            preground: false,
            ..Flags::default()
        },
    );
    session.user("make a group called Lisboa");
    call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "group", "args": "name: Lisboa"}),
    );
    let turn = session.user("neha next tuesday");
    for key in ["preground", "focus", "dates", "block"] {
        assert!(turn[key].is_null(), "{key}: {turn}");
    }
}

#[test]
fn the_focus_line_never_numbers_a_row_the_model_has_not_seen() {
    let world = seeded_with(&many_tasks(14));
    let mut session = world.session();
    session.user("all my tasks");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    let first = focus(&mut session, "which of them").expect("a focus line");
    // reading it again, and asking for a task nobody showed, mints nothing new
    let again = focus(&mut session, "and again").expect("a focus line");
    assert_eq!(first, again);
    let seventh = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "bulk chore 9"}),
    );
    let n = numbers(&seventh["effect"]["rows"])[0];
    assert!(!first.contains(&format!("#{n} ")), "{first}");
}

// ---------------------------------------------------------------------------
// Ask completion (D-1044-9)
// ---------------------------------------------------------------------------

/// A session at an `ambiguous:` reply for "Neha": the numbers it lists.
fn at_neha() -> (common::World, Session, Vec<u64>) {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("log a call with neha");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    assert!(
        text_of(&reply).starts_with("ambiguous: \"Neha\" fits"),
        "{reply}"
    );
    let listed = numbers(&reply["effect"]["ambiguous"]);
    (world, session, listed)
}

fn text_of(response: &Value) -> &str {
    response["text"].as_str().expect("a text")
}

const COMPLETED: &str = "options completed from the candidates";

#[test]
fn an_ask_that_names_some_of_the_candidates_lists_all_of_them() {
    let (_world, mut session, listed) = at_neha();
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which neha?", "options": format!("#{}", listed[1])}),
    );
    assert_eq!(asked["ends_turn"], true);
    // every candidate, in the ambiguous reply's order
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), listed);
    assert_eq!(asked["effect"]["ask"]["completed"], true);
    let reply = text_of(&asked);
    assert!(reply.ends_with(&format!(" · {COMPLETED}")), "{reply}");
    assert!(
        reply.contains("Neha Rao") && reply.contains("Neha Kulkarni"),
        "{reply}"
    );
    // and the focus of the next turn holds them all
    let line = focus(&mut session, "the second").expect("a focus line");
    assert!(
        line.contains("Neha Rao") && line.contains("Neha Kulkarni"),
        "{line}"
    );
}

#[test]
fn an_ask_without_options_after_an_ambiguity_is_completed_too() {
    let (_world, mut session, listed) = at_neha();
    let asked = call(&mut session, "ask", json!({"question": "which neha?"}));
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), listed);
    assert!(text_of(&asked).ends_with(COMPLETED), "{asked}");
}

#[test]
fn the_candidates_keep_the_order_of_the_ambiguous_reply() {
    let (_world, mut session, listed) = at_neha();
    // naming the last candidate first: the options are still the reply's order
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": format!("#{}", listed[listed.len() - 1])}),
    );
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), listed);
}

#[test]
fn an_ask_that_already_lists_every_candidate_is_left_as_it_is() {
    let (_world, mut session, listed) = at_neha();
    let reversed = format!("#{}, #{}", listed[1], listed[0]);
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": reversed}),
    );
    assert_eq!(
        numbers(&asked["effect"]["ask"]["options"]),
        [listed[1], listed[0]]
    );
    assert!(asked["effect"]["ask"].get("completed").is_none());
    assert!(!text_of(&asked).contains(COMPLETED), "{asked}");
}

#[test]
fn an_ask_whose_options_are_not_among_the_candidates_is_untouched() {
    let (_world, mut session, listed) = at_neha();
    // #1 is a group the directory numbered: a row the ambiguity never listed
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": format!("#{}, #1", listed[0])}),
    );
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), [listed[0], 1]);
    assert!(asked["effect"]["ask"].get("completed").is_none());
    assert!(!text_of(&asked).contains(COMPLETED), "{asked}");
    // only that row, outside the candidates altogether
    let (_world, mut session, _) = at_neha();
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": "#2"}),
    );
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), [2]);
    assert!(!text_of(&asked).contains(COMPLETED), "{asked}");
}

#[test]
fn an_ask_that_is_not_the_step_right_after_the_ambiguity_is_untouched() {
    let (_world, mut session, listed) = at_neha();
    // a look in between
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": format!("#{}", listed[0])}),
    );
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), [listed[0]]);
    assert!(!text_of(&asked).contains(COMPLETED), "{asked}");
}

#[test]
fn an_ambiguity_of_an_earlier_turn_does_not_complete_the_next_turns_ask() {
    let (_world, mut session, listed) = at_neha();
    // the turn ends without an ask (the cap), and the person speaks again
    session.user("neha rao");
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": format!("#{}", listed[0])}),
    );
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), [listed[0]]);
}

#[test]
fn a_candidate_the_reply_did_not_list_is_not_offered_even_when_it_has_a_number() {
    let world = seeded_with(&many_sams(14));
    let mut session = world.session_uncomposed();
    session.user("log a call with sam");
    // three of the rows past the reply's twelve were numbered by looking at them first
    let mut unlisted = Vec::new();
    for name in ["Sam P8", "Sam P9", "Sam Park"] {
        let n = common::find_in_turn(&mut session, "person", name);
        unlisted.push(n.trim_start_matches('#').parse::<u64>().expect("a number"));
    }
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Sam", "args": "kind: call"}),
    );
    let all = reply["effect"]["ambiguous"].as_array().expect("candidates");
    assert_eq!(all.len(), 15);
    assert!(
        all[ROW_CAP..].iter().all(|row| row["n"].is_u64()),
        "numbered earlier: {reply}"
    );
    let listed = numbers(&Value::Array(all[..ROW_CAP].to_vec()));
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which sam?", "options": format!("#{}", listed[0])}),
    );
    let offered = numbers(&asked["effect"]["ask"]["options"]);
    assert_eq!(offered, listed);
    assert!(unlisted.iter().all(|n| !offered.contains(n)), "{offered:?}");
}

#[test]
fn the_options_stop_where_the_ambiguous_reply_stops() {
    let world = seeded_with(&many_sams(14));
    let mut session = world.session_uncomposed();
    session.user("log a call with sam");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Sam", "args": "kind: call"}),
    );
    // the fixture's own Sam Park makes fifteen; the reply lists twelve and counts the rest
    assert!(
        text_of(&reply).contains(" and 3 more; nothing was done."),
        "{}",
        text_of(&reply)
    );
    let listed = numbers(&reply["effect"]["ambiguous"]);
    assert_eq!(listed.len(), ROW_CAP, "the reply numbers what it lists");
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which sam?", "options": format!("#{}", listed[3])}),
    );
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), listed);
    assert!(text_of(&asked).ends_with(COMPLETED), "{asked}");
}

/// The fixture plus two unstarred Pedros.
fn pedros() -> common::World {
    let mut world = fixture();
    let people = world["people"].as_array_mut().expect("people");
    for (key, name) in [("pedro_a", "Pedro Almeida"), ("pedro_c", "Pedro Costa")] {
        people.push(json!({"key": key, "name": name, "role": "friend"}));
    }
    seeded_with(&world)
}

#[test]
fn the_ask_the_runtime_ends_a_pick_with_is_held_in_focus_and_never_completed() {
    // "star pedro" fits two people; the model picked one by number, so the
    // runtime ends the turn asking with both: nothing is left to complete,
    // and the next turn starts with those options in focus
    let world = pedros();
    let mut session = world.session();
    session.user("star pedro");
    let almeida = common::find_in_turn(&mut session, "person", "Pedro Almeida");
    let picked = call(
        &mut session,
        "act",
        json!({"verb": "star", "rows": almeida}),
    );
    assert_eq!(picked["ends_turn"], true, "{picked}");
    let options = numbers(&picked["effect"]["ask"]["options"]);
    assert_eq!(options.len(), 2, "{picked}");
    assert!(picked["effect"]["ask"].get("completed").is_none());
    let line = focus(&mut session, "the second one").expect("a focus line");
    assert!(
        line.contains(" · asked: #")
            && line.contains("Pedro Almeida")
            && line.contains("Pedro Costa"),
        "{line}"
    );
    // that reply is not an ambiguity a later ask completes from
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which?", "options": format!("#{}", options[0])}),
    );
    assert_eq!(numbers(&asked["effect"]["ask"]["options"]), [options[0]]);
}

#[test]
fn a_created_row_that_was_undone_leaves_the_focus_line() {
    let world = seeded();
    let mut session = world.session();
    session.user("make a group called Lisboa");
    call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "group", "args": "name: Lisboa"}),
    );
    assert!(focus(&mut session, "undo that").is_some_and(|line| line.contains("\"Lisboa\"")));
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert!(text_of(&undone).starts_with("undone:"), "{undone}");
    assert_eq!(focus(&mut session, "and now"), None);
}

// ---------------------------------------------------------------------------
// The repeated-call policy (SPEC §6.3)
// ---------------------------------------------------------------------------

/// A call the runtime refuses as invalid: a parameter `find` does not have.
fn invalid() -> Value {
    json!({"kind": "task", "sort": "date"})
}

#[test]
fn an_invalid_call_sent_again_gets_one_hint_and_the_second_resend_ends_the_turn() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks");
    let first = call(&mut session, "find", invalid());
    assert!(
        text_of(&first).starts_with("error: find has no parameter \"sort\""),
        "{first}"
    );
    assert_eq!(first["ends_turn"], false);
    assert_eq!(session.peek_repeat("find", &invalid()), Some(0));
    // nt10 G1: the first resend is one hint rung (the error ends in no fix, so it is quoted)
    let hint = call(&mut session, "find", invalid());
    assert_eq!(hint["ends_turn"], false, "{hint}");
    assert!(
        text_of(&hint).starts_with("error: that is the same call again. find has no parameter"),
        "{hint}"
    );
    assert_eq!(hint["effect"]["repeat"], 1);
    assert_eq!(session.peek_repeat("find", &invalid()), Some(1));
    let again = call(&mut session, "find", invalid());
    assert_eq!(again["ends_turn"], true, "{again}");
    // the reply says which step it was and which step it repeated
    assert!(
        text_of(&again).starts_with(
            "error: repeated call at step 3: step 1 sent the same call and the runtime refused it as invalid."
        ),
        "{again}"
    );
    assert_eq!(again["step"], 3);
    assert_eq!(again["effect"]["repeat"], 2);
    assert_eq!(
        again["effect"]["invalid_repeat"],
        json!({"step": 3, "of": 1})
    );
    // fail-soft by error family, not the generic ask: the unknown `sort` is left
    // out and the corrected find ends the turn as an answer
    assert_eq!(
        again["effect"]["failsoft"],
        json!({"family": "unknown_param", "action": "drop_param"})
    );
    assert_eq!(again["effect"]["tool"], "answer");
    assert!(again["effect"].get("loop").is_none());
    assert!(again["effect"].get("error").is_none());
    assert!(text_of(&again).contains("\nanswered:\n@1 "), "{again}");
    assert!(
        text_of(&again).contains("note: ignored sort (find has no parameter \"sort\")"),
        "{again}"
    );
    // the third identical call never runs: the turn is over
    let third = call(&mut session, "find", invalid());
    assert!(
        text_of(&third).starts_with("error: the turn has ended"),
        "{third}"
    );
}

#[test]
fn the_reply_names_the_step_of_the_repeat_and_the_step_it_repeated() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "rent"}),
    );
    call(&mut session, "open", json!({"row": "#1, #2"}));
    call(&mut session, "open", json!({"row": "#1, #2"}));
    let again = call(&mut session, "open", json!({"row": "#1, #2"}));
    assert!(
        text_of(&again).starts_with("error: repeated call at step 5: step 3 sent the same call"),
        "{again}"
    );
    assert_eq!(
        again["effect"]["invalid_repeat"],
        json!({"step": 5, "of": 3})
    );
}

#[test]
fn a_schema_error_and_a_cardinality_error_are_both_invalid() {
    let calls = [
        ("find", json!({"kind": "unicorn"})),
        ("find", json!({"kind": "task", "where": "colour = red"})),
        ("answer", json!({"op": "sum", "kind": "task"})),
        ("act", json!({"verb": "dance", "rows": "#1"})),
        ("open", json!({"row": "#99"})),
        ("open", json!({"row": "#1, #2"})),
        (
            "compute",
            json!({"op": "count", "rows": "#1", "kind": "task", "name": "x"}),
        ),
    ];
    for (tool, args) in calls {
        let world = seeded();
        let mut session = world.session();
        session.user("x");
        let first = call(&mut session, tool, args.clone());
        assert!(
            text_of(&first).starts_with("error:"),
            "{tool} {args}: {first}"
        );
        assert_eq!(first["ends_turn"], false, "{tool} {args}");
        let hint = call(&mut session, tool, args.clone());
        assert_eq!(hint["ends_turn"], false, "{tool} {args}: {hint}");
        assert!(
            text_of(&hint).starts_with("error: that is the same call again."),
            "{hint}"
        );
        let again = call(&mut session, tool, args.clone());
        assert_eq!(again["ends_turn"], true, "{tool} {args}: {again}");
        assert!(
            text_of(&again).starts_with("error: repeated call at step 3"),
            "{again}"
        );
    }
}

#[test]
fn a_different_call_between_makes_the_same_invalid_call_a_fresh_one() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks");
    call(&mut session, "find", invalid());
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    assert_eq!(session.peek_repeat("find", &invalid()), None);
    let again = call(&mut session, "find", invalid());
    assert!(
        text_of(&again).starts_with("error: find has no parameter"),
        "{again}"
    );
    assert_eq!(again["ends_turn"], false);
}

#[test]
fn an_invalid_repeat_after_a_landed_write_stays_a_loop() {
    let world = seeded();
    let mut session = world.session();
    let cabin = common::number(&mut session, "task", "cabin");
    call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": cabin, "more": true}),
    );
    call(&mut session, "find", invalid());
    call(&mut session, "find", invalid());
    let again = call(&mut session, "find", invalid());
    assert_eq!(again["ends_turn"], true, "{again}");
    assert_eq!(again["effect"]["loop"], true);
    assert!(again["effect"].get("failsoft").is_none());
    // the cabin was found at step 1, completed at step 2, the invalid find sent at 3, hinted at 4, ended at 5
    assert!(
        text_of(&again).starts_with("error: repeated call at step 5: step 3 sent the same call"),
        "{again}"
    );
}

#[test]
fn a_valid_call_repeated_keeps_the_hint_the_nudge_and_the_cut() {
    let world = seeded();
    let mut session = world.session();
    session.user("tasks");
    let args = json!({"kind": "task", "name": "cabin"});
    call(&mut session, "find", args.clone());
    let hint = call(&mut session, "find", args.clone());
    assert!(
        text_of(&hint).starts_with(
            "error: repeated call. You already made this exact call and it returned: "
        ),
        "{hint}"
    );
    assert_eq!(
        (hint["ends_turn"].clone(), hint["effect"]["repeat"].clone()),
        (json!(false), json!(1))
    );
    assert!(hint["effect"].get("invalid_repeat").is_none());
    let nudge = call(&mut session, "find", args.clone());
    assert_eq!(text_of(&nudge), centraid_nativetools::session::REPEAT_NUDGE);
    assert_eq!(nudge["ends_turn"], false);
    let cut = call(&mut session, "find", args);
    assert_eq!(cut["ends_turn"], true);
    assert!(
        text_of(&cut).starts_with("error: repeated call\nasked: \""),
        "{cut}"
    );
    assert_eq!(cut["effect"]["failsoft"], "loop");
    assert!(cut["effect"].get("invalid_repeat").is_none());
}

#[test]
fn an_ambiguous_reply_and_an_empty_find_are_valid_calls_and_keep_the_rungs() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("neha");
    let ambiguous = json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"});
    assert!(text_of(&call(&mut session, "act", ambiguous.clone())).starts_with("ambiguous:"));
    let hint = call(&mut session, "act", ambiguous);
    assert!(
        text_of(&hint).starts_with("error: repeated call. You already"),
        "{hint}"
    );
    assert_eq!(hint["ends_turn"], false);

    session.user("tabla");
    let empty = json!({"kind": "task", "name": "tabla"});
    assert!(text_of(&call(&mut session, "find", empty.clone())).starts_with("0 tasks called"));
    let hint = call(&mut session, "find", empty);
    assert!(
        text_of(&hint).starts_with("error: repeated call. You already"),
        "{hint}"
    );
    assert_eq!(hint["ends_turn"], false);
}

#[test]
fn a_call_refused_by_its_trace_is_still_not_a_repeat() {
    let world = seeded();
    let mut session = world.session();
    session.user("what tasks are open");
    let args = json!({"kind": "task", "limit": 2});
    for _ in 0..3 {
        let refused = session.call_traced("answer", &args, Some("intent: write \"what\""));
        assert!(
            text_of(&refused).contains("contradicts the call"),
            "{refused}"
        );
        assert_eq!(refused["ends_turn"], false);
    }
}

#[test]
fn text_helper_reads_a_plain_observation() {
    // the shared helper and the session agree on a text
    let world = seeded();
    let mut session = world.session();
    session.user("x");
    let found = text(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    assert!(found.starts_with("@1 · 1 task"), "{found}");
}
