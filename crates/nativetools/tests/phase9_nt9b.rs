//! Part B of nt9 (#1044, iteration 1): signals that let a small model recover from a dead end
//! (an empty read names what it nearly was, an error ends in the call to send instead), and the
//! general rules the read of the failing sessions showed (clock words, the `(you)` row, the
//! dates line, `=` on free text, a pronoun with nothing in focus, the trash).

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
// F8: a pronoun skips the which-one ask only when the focus holds a row it can refer to

fn two_wifis() -> World {
    world_with(|world| {
        push(
            world,
            "locker",
            json!({"key": "wifi2", "name": "Office wifi", "type": "wifi", "password": "x"}),
        );
        for row in world["locker"].as_array_mut().expect("locker") {
            if row["key"] == "wifi" {
                row["starred"] = json!(false);
            }
        }
    })
}

#[test]
fn a_pronoun_with_nothing_in_focus_does_not_skip_the_which_one_ask() {
    let world = two_wifis();
    let mut session = world.session();
    session.user("star the wifi, i keep needing it");
    let n = common::find_in_turn(&mut session, "locker item", "Home wifi");
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": n}));
    assert!(
        text(&reply).starts_with("asked: \"which one of the 2 did you mean?\""),
        "{reply}"
    );
}

#[test]
fn a_pronoun_with_the_row_in_focus_still_skips_the_ask() {
    let world = two_wifis();
    let mut session = world.session();
    session.user("show me the home wifi");
    let shown = call(
        &mut session,
        "find",
        json!({"kind": "locker item", "name": "Home wifi"}),
    );
    let n = format!("#{}", shown["effect"]["rows"][0]["n"]);
    call(&mut session, "answer", json!({"rows": n}));
    session.user("star it");
    let reply = call(&mut session, "act", json!({"verb": "star", "rows": n}));
    assert!(!text(&reply).starts_with("asked:"), "{reply}");
}

// ---------------------------------------------------------------------------------------------
// F9: a trash read that names no kind lists every kind

#[test]
fn a_trash_read_with_no_kind_lists_the_trash_of_every_kind() {
    let world = world_with(|world| {
        push(
            world,
            "photos",
            json!({"key": "pier", "name": "Old pier", "taken": "2026-02-01T12:00", "trashed": "2026-09-25T09:00"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "gone", "name": "Gone task", "trashed": "2026-09-25T09:00"}),
        );
    });
    let mut session = world.session();
    session.user("what is in the trash");
    let reply = call(&mut session, "find", json!({"trashed": true}));
    assert!(!text(&reply).starts_with("error:"), "{reply}");
    assert!(
        text(&reply).contains("Old pier") && text(&reply).contains("Gone task"),
        "{reply}"
    );
    assert!(!text(&reply).contains("Cabin"), "{reply}");
    // without trashed there is still a kind to name: the one list of the turn is the `within`
    // (nt12 R1), and the note says so
    let bare = call(&mut session, "find", json!({"name": "Old"}));
    assert!(!text(&bare).starts_with("error"), "{bare}");
    assert!(
        text(&bare).contains("note: used find name: \"Old\", within: @1"),
        "{bare}"
    );
}

// ---------------------------------------------------------------------------------------------
// F6: the dates line for a year, the fixed-date holidays, and the end of the day

fn dates(message: &str) -> Option<String> {
    let now = centraid_nativetools::dates::parse_now(common::TODAY).expect("a date");
    centraid_nativetools::phrases::dates_line(message, now)
}

#[test]
fn a_year_after_for_throughout_or_the_word_year_prints_its_span() {
    for message in [
        "what did we spend for 2025",
        "everything throughout 2025",
        "the year 2025",
        "from 2023 to 2025",
    ] {
        let line = dates(message).unwrap_or_default();
        assert!(
            line.contains("2025 = 2025-01-01..2025-12-31"),
            "{message}: {line}"
        );
    }
    // a year inside a name (a document, an album) is no date: no preposition leads it
    assert_eq!(dates("open the W2 2025 doc"), None);
    assert_eq!(dates("kyoto 2026 photos"), None);
}

#[test]
fn a_fixed_date_holiday_prints_its_date_like_the_month_and_day_it_is() {
    for (message, phrase, want) in [
        ("what is on new year's day", "new year's day", "01-01"),
        ("dinner on new year's eve", "new year's eve", "12-31"),
        ("remind me on christmas day", "christmas day", "12-25"),
        ("a gift for christmas eve", "christmas eve", "12-24"),
        ("flowers for valentine's day", "valentine's day", "02-14"),
        ("candy for valentine's", "valentine", "02-14"),
        ("costumes for halloween", "halloween", "10-31"),
    ] {
        let line = dates(message).unwrap_or_default();
        assert!(line.contains(&format!("{phrase} = ")), "{message}: {line}");
        assert!(line.contains(want), "{message}: {line}");
        assert_eq!(line, dates(message).unwrap_or_default());
    }
    // the word alone names the list or the album, not the day; a person may be called Valentine
    assert_eq!(dates("add it to christmas"), None);
    assert_eq!(dates("message valentine about it"), None);
}

#[test]
fn the_end_of_the_day_and_the_rest_of_today_are_today_only() {
    for message in [
        "finish it by end of the day",
        "do it by the end of today",
        "by end of day",
    ] {
        let line = dates(message).unwrap_or_default();
        assert!(line.contains("= 2026-09-27"), "{message}: {line}");
        assert!(!line.contains("2026-09-28"), "{message}: {line}");
    }
    for message in [
        "what is left for the rest of today",
        "for the rest of the day",
    ] {
        let line = dates(message).unwrap_or_default();
        assert!(
            line.contains("2026-09-27") && !line.contains("2026-09-28"),
            "{line}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// F5: the `(you)` row for money words when a group is named; a group balance defaults to you

fn vault_of(session: &mut centraid_nativetools::Session, message: &str) -> String {
    session.user(message)["preground"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn money_words_with_a_group_named_put_the_users_row_in_the_vault_line() {
    let world = seeded();
    for message in [
        "money-wise where do we stand in the tahoe trip",
        "am i up or down on the tahoe trip",
        "who fronted the most in the tahoe trip",
        "how much have i put in for the tahoe trip",
        "what did i spend in the tahoe trip",
        "i am out of pocket on the tahoe trip",
    ] {
        let mut session = world.session();
        let vault = vault_of(&mut session, message);
        assert!(
            vault.ends_with("person \"Sam Park\" (you)"),
            "{message}: {vault}"
        );
    }
}

#[test]
fn the_users_row_stays_out_without_a_group_or_with_someone_else_in_play() {
    let world = seeded();
    for message in [
        // no group is named
        "what did i spend on the cabin",
        "who paid for dinner",
        // someone else is in play
        "ray paid for the cabin in the tahoe trip",
        "did he front the tahoe trip",
    ] {
        let mut session = world.session();
        let vault = vault_of(&mut session, message);
        assert!(!vault.contains("(you)"), "{message}: {vault}");
    }
}

#[test]
fn a_group_a_word_only_starts_is_not_named() {
    // `bill` starts `Bills` and says nothing of the group: "paid" is the state of a task here
    let world = world_with(|world| {
        push(
            world,
            "groups",
            json!({"key": "bills", "name": "Flat Bills", "members": ["ray"]}),
        );
        push(
            world,
            "tasks",
            json!({"key": "gas", "name": "Pay the gas bill"}),
        );
    });
    let mut session = world.session();
    let vault = vault_of(&mut session, "the gas bill's paid, tick it off");
    assert!(!vault.contains("(you)"), "{vault}");
    // the whole word names it
    let mut session = world.session();
    let vault = vault_of(&mut session, "am i up or down on the flat bills");
    assert!(vault.contains("(you)"), "{vault}");
}

#[test]
fn a_group_balance_with_no_person_is_the_users() {
    let world = seeded();
    let mut session = world.session();
    session.user("how are we money-wise in the tahoe trip");
    let net = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip"}),
    );
    let reply = text(&net);
    assert!(!reply.starts_with("error"), "{net}");
    assert!(
        reply.contains("net of #") && reply.contains("Sam Park"),
        "{net}"
    );
    // a person the call names is still the person
    // a message about someone else: the person the model left out is still the error's to add
    session.user("what's ray's share in the tahoe trip");
    let left_out = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip"}),
    );
    // nt12 R1: the person the message names is added by the runtime, with a note
    assert!(!text(&left_out).starts_with("error"), "{left_out}");
    assert!(
        text(&left_out).contains("note: used compute op: balance, kind: group"),
        "{left_out}"
    );
    session.user("and the tahoe trip balance");
    let neha = common::find_in_turn(&mut session, "person", "Neha Rao");
    let theirs = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip", "linked_to": neha}),
    );
    assert!(
        text(&theirs).contains("Neha Rao") && !text(&theirs).contains("Sam Park"),
        "{theirs}"
    );
}

// ---------------------------------------------------------------------------------------------
// F7: `=` with a plain word on a free-text field reads as contains when equality finds nothing

fn tent_world() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "tent", "name": "Pack the car", "description": "bring the tent and the stove"}),
        );
    })
}

#[test]
fn equals_on_a_free_text_field_reads_as_contains_when_equality_finds_nothing() {
    let world = tent_world();
    let mut session = world.session();
    session.user("which task says tent");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "description = tent"}),
    );
    assert_eq!(
        found["effect"]["rows"].as_array().map_or(0, Vec::len),
        1,
        "{found}"
    );
    assert!(text(&found).contains("note: read as contains"), "{found}");
    let counted = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "where": "description = stove"}),
    );
    assert!(
        text(&counted).contains('1') && text(&counted).contains("read as contains"),
        "{counted}"
    );
    let by_role = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "role = design"}),
    );
    assert_eq!(
        by_role["effect"]["rows"].as_array().map_or(0, Vec::len),
        1,
        "{by_role}"
    );
    assert!(text(&by_role).contains("read as contains"), "{by_role}");
}

#[test]
fn equals_that_matches_or_a_phrase_or_a_word_nothing_contains_is_left_alone() {
    let world = tent_world();
    let mut session = world.session();
    session.user("which task says tent");
    // equality matches: no note
    let whole = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "description = \"bring the tent and the stove\""}),
    );
    assert_eq!(
        whole["effect"]["rows"].as_array().map_or(0, Vec::len),
        1,
        "{whole}"
    );
    assert!(!text(&whole).contains("read as contains"), "{whole}");
    // nothing contains the word: the empty read stays empty
    let none = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "description = kayak"}),
    );
    assert_eq!(
        none["effect"]["rows"].as_array().map_or(9, Vec::len),
        0,
        "{none}"
    );
    assert!(!text(&none).contains("read as contains"), "{none}");
    // a phrase is not a plain word; a field that is not free text keeps its equality
    let phrase = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "description = \"the tent\""}),
    );
    assert!(!text(&phrase).contains("read as contains"), "{phrase}");
    let status = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = ope"}),
    );
    assert!(!text(&status).contains("read as contains"), "{status}");
}

// ---------------------------------------------------------------------------------------------
// F4: a day-part word with a bare hour, "same time" on a reschedule, a message with two cues

#[test]
fn a_day_part_word_with_a_bare_hour_takes_that_half_and_the_hour() {
    for (message, want) in [
        ("move it to the morning, say 9", "say 9 = 09:00"),
        ("make it evening, say 8", "say 8 = 20:00"),
        ("push it to the evening, maybe 7", "maybe 7 = 19:00"),
        ("put it in the afternoon around 3", "around 3 = 15:00"),
        ("drinks tomorrow about 6", "about 6 = 18:00"),
    ] {
        let line = dates(message).unwrap_or_default();
        assert!(line.contains(want), "{message}: {line}");
    }
    // the day-part word of a day phrase gives its half, never the start of its window
    let line = dates("move it to tomorrow evening around 8").unwrap_or_default();
    assert!(
        line.contains("around 8 = 20:00") && !line.contains("18:00"),
        "{line}"
    );
    let line = dates("move the dentist to friday morning say 10").unwrap_or_default();
    assert!(
        line.contains("say 10 = 10:00") && !line.contains("09:00"),
        "{line}"
    );
    // with no day-part word, or a count of things, the number is no hour
    assert_eq!(dates("say 9 people came"), None);
    assert_eq!(dates("in the evening, say 3 events"), None);
}

#[test]
fn a_message_with_a_morning_and_an_afternoon_cue_lets_the_hour_decide() {
    for (message, want) in [
        (
            "not the morning, the afternoon: make it 3",
            "make it 3 = 15:00",
        ),
        (
            "morning or afternoon, whichever, make it 10",
            "make it 10 = 10:00",
        ),
        (
            "from the morning to the afternoon, make it 5",
            "make it 5 = 17:00",
        ),
    ] {
        let line = dates(message).unwrap_or_default();
        assert!(
            line.contains(want) && !line.contains("(am)"),
            "{message}: {line}"
        );
    }
    // 8 stays either way, as at_n has it; one cue still settles it
    let line = dates("morning or afternoon, make it 8").unwrap_or_default();
    assert!(line.contains("08:00") && line.contains("20:00"), "{line}");
    assert!(
        dates("in the afternoon make it 3")
            .unwrap_or_default()
            .contains("= 15:00")
    );
}

fn wedding_world() -> World {
    world_with(|world| {
        push(
            world,
            "events",
            json!({"key": "wcall", "name": "Wedding planning call", "start": "2026-10-22T19:00", "end": "2026-10-22T19:30"}),
        );
    })
}

fn rescheduled(message: &str, to: &str) -> Value {
    let world = wedding_world();
    let mut session = world.session();
    session.user(message);
    call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Wedding planning call",
               "args": format!("to: {to}")}),
    )
}

fn start_of(reply: &Value) -> &str {
    reply["effect"]["diff"]["rows"][0]["fields"]["date"][1]
        .as_str()
        .unwrap_or_default()
}

#[test]
fn same_time_on_a_reschedule_keeps_the_rows_time_when_the_call_states_another() {
    let reply = rescheduled(
        "move the wedding planning call to friday, same time",
        r#"{"date":"2026-10-02","time":"15:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-02T19:00:00", "{reply}");
    assert!(
        text(&reply).contains("date: \"same time\" keeps the row's time (19:00)."),
        "{reply}"
    );
    // the call already keeps it: nothing to say
    let reply = rescheduled(
        "move the wedding planning call to friday, same time",
        r#"{"date":"2026-10-02","time":"19:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-02T19:00:00", "{reply}");
    assert!(!text(&reply).contains("same time"), "{reply}");
    // a time the message states is the person's, "same time" or not
    let reply = rescheduled(
        "move the wedding planning call to friday at 3pm, not the same time",
        r#"{"date":"2026-10-02","time":"15:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-02T15:00:00", "{reply}");
    // without the words the call's time is the model's
    let reply = rescheduled(
        "move the wedding planning call to friday",
        r#"{"date":"2026-10-02","time":"15:00"}"#,
    );
    assert_eq!(start_of(&reply), "2026-10-02T15:00:00", "{reply}");
}

// ---------------------------------------------------------------------------------------------
// F1: an empty read names what the name nearly was

fn hint_of(reply: &Value) -> &str {
    text(reply)
        .lines()
        .find(|line| line.starts_with("hint:"))
        .unwrap_or_default()
}

fn miss_world() -> World {
    world_with(|world| {
        push(
            world,
            "albums",
            json!({"key": "kyoto", "name": "Kyoto 2026"}),
        );
        push(world, "lists", json!({"key": "xmas", "name": "Christmas"}));
        push(
            world,
            "tasks",
            json!({"key": "gone", "name": "Gone task", "trashed": "2026-09-25T09:00"}),
        );
        push(
            world,
            "people",
            json!({"key": "dan", "name": "Daniel Ortiz", "nickname": "Big Dan"}),
        );
    })
}

fn n_of(reply: &Value, name: &str) -> String {
    let hint = hint_of(reply);
    let at = hint
        .find(name)
        .unwrap_or_else(|| panic!("{name} in {hint}"));
    let before = &hint[..at];
    let hash = before.rfind('#').expect("a #n");
    before[hash..]
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn an_empty_find_names_a_row_of_another_kind_and_the_parameter_that_reaches_it() {
    let world = miss_world();
    let mut session = world.session();
    session.user("show me my kyoto photos");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "kyoto photos"}),
    );
    assert_eq!(miss["ends_turn"], false, "{miss}");
    assert_eq!(miss["effect"]["rows"], json!([]), "{miss}");
    let hint = hint_of(&miss);
    let n = n_of(&miss, "album \"Kyoto 2026\"");
    assert!(
        hint.contains(&format!("album \"Kyoto 2026\" (linked_to: {n})")),
        "{hint}"
    );
    // the number is the row's: a call may use it
    let photos = call(
        &mut session,
        "find",
        json!({"kind": "photo", "linked_to": n}),
    );
    assert!(!text(&photos).starts_with("error"), "{photos}");
    // a task and the list that holds tasks
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "christmas tasks"}),
    );
    let n = n_of(&miss, "list \"Christmas\"");
    assert!(
        hint_of(&miss).contains(&format!("(linked_to: {n})")),
        "{miss}"
    );
}

#[test]
fn an_empty_answer_by_name_stays_open_as_a_find_miss_does() {
    let world = miss_world();
    let mut session = world.session();
    session.user("show me my kyoto photos");
    let miss = call(
        &mut session,
        "answer",
        json!({"kind": "photo", "name": "kyoto photos"}),
    );
    assert_eq!(miss["ends_turn"], false, "{miss}");
    assert!(
        text(&miss).starts_with("answered: 0 photos called \"kyoto photos\" match"),
        "{miss}"
    );
    assert!(
        hint_of(&miss).contains("album \"Kyoto 2026\" (linked_to: #"),
        "{miss}"
    );
    assert!(miss["effect"].get("answer").is_none(), "{miss}");
    // sent again, it is the answer the runtime always composed: the rows of the other kind
    let again = call(
        &mut session,
        "answer",
        json!({"kind": "photo", "name": "kyoto photos"}),
    );
    assert_eq!(again["ends_turn"], true, "{again}");
    assert!(!text(&again).contains("repeated call"), "{again}");
    // nothing to name (no row of any kind, trashed or live, holds a word): the answer is what it
    // always was, the empty one, and the turn ends
    let mut session = world.session();
    session.user("is there a zzyzx task");
    let end = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Zzyzx"}),
    );
    assert_eq!(end["ends_turn"], true, "{end}");
    assert_eq!(text(&end), "answered: 0 tasks called \"Zzyzx\" match");
    // a miss after a find miss of the turn is the answer too: the hint was already shown
    let mut session = world.session();
    session.user("is there a zzyzx task");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Zzyzx"}),
    );
    let end = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Zzyzx"}),
    );
    assert_eq!(end["ends_turn"], true, "{end}");
}

#[test]
fn an_answer_that_reaches_a_row_of_its_own_kind_is_still_the_answer() {
    let world = miss_world();
    let mut session = world.session();
    session.user("who is ray ochoo");
    let reply = call(
        &mut session,
        "answer",
        json!({"kind": "person", "name": "Ray Ochoo"}),
    );
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert!(text(&reply).contains("Ray Ochoa"), "{reply}");
}

#[test]
fn an_empty_find_names_a_trashed_row_that_matches() {
    let world = miss_world();
    let mut session = world.session();
    session.user("where is the gone task");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Gone task"}),
    );
    assert!(hint_of(&miss).contains("in the trash: #"), "{miss}");
    assert!(hint_of(&miss).contains("task \"Gone task\""), "{miss}");
    // a person by nickname, from another kind's lookup
    let by_nick = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "big dan"}),
    );
    assert!(
        hint_of(&by_nick).contains("person \"Daniel Ortiz\""),
        "{by_nick}"
    );
    assert!(hint_of(&by_nick).contains("(linked_to: #"), "{by_nick}");
}

#[test]
fn the_hint_says_a_name_matches_only_names_when_the_name_was_the_whole_condition() {
    let world = miss_world();
    let mut session = world.session();
    session.user("tasks about the zzyzx");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Zzyzx"}),
    );
    assert_eq!(
        hint_of(&miss),
        "hint: name matches only names; for words in a body or description use search",
        "{miss}"
    );
    // a condition of its own, or a kind with no body to search: nothing to say
    let conditioned = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Zzyzx", "where": "status = open"}),
    );
    assert_eq!(hint_of(&conditioned), "", "{conditioned}");
    let group = call(
        &mut session,
        "find",
        json!({"kind": "group", "name": "Zzyzx"}),
    );
    assert_eq!(hint_of(&group), "", "{group}");
    // rows and the sentence share the one line, rows first
    let both = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Gone task"}),
    );
    let hint = hint_of(&both);
    assert!(
        hint.starts_with("hint: in the trash: #") && hint.ends_with("use search"),
        "{hint}"
    );
    assert_eq!(text(&both).matches("hint:").count(), 1, "{both}");
}

#[test]
fn the_hint_names_at_most_four_rows() {
    let world = world_with(|world| {
        for n in 1..=6 {
            push(
                world,
                "people",
                json!({"key": format!("pedro{n}"), "name": format!("Pedro {n:02}")}),
            );
        }
        push(
            world,
            "albums",
            json!({"key": "pedro_album", "name": "Pedro album"}),
        );
    });
    let mut session = world.session();
    // nt11: `Ped` is a word start (tier 3) and a read takes those rows; a name only part of which
    // the rows hold reaches no tier and is the hint
    session.user("who is ped");
    let miss = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Pedro Zzz"}),
    );
    let hint = hint_of(&miss);
    assert_eq!(
        hint.matches('#').count() - hint.matches("linked_to: #").count(),
        4,
        "{hint}"
    );
    assert!(hint.contains(" and 3 more"), "{hint}");
}

// ---------------------------------------------------------------------------------------------
// F2: an error that rejects a field, a link or a kind ends in the call to send instead

fn says(reply: &Value) -> &str {
    reply["effect"]["error"]
        .as_str()
        .unwrap_or_else(|| text(reply))
}

#[test]
fn an_unknown_field_names_the_field_this_kind_uses_for_that_meaning() {
    let world = seeded();
    let mut session = world.session();
    session.user("add a note to pay rent");
    // free text on a task is description
    let edit = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Pay rent", "args": "notes: bring the receipt"}),
    );
    assert!(!says(&edit).starts_with("error"), "{edit}");
    assert!(
        says(&edit).contains("note: read notes as description"),
        "{edit}"
    );
    // a due date in a condition is the date; in an edit a date changes with reschedule
    session.user("the next ask");
    let cond = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "due_on = 2026-10-01"}),
    );
    assert!(says(&cond).ends_with("For that use date."), "{cond}");
    let order = call(
        &mut session,
        "find",
        json!({"kind": "task", "order": "deadline asc"}),
    );
    // an order reads the word as the date (nt12 R2)
    assert!(
        says(&order).contains("note: read deadline as date"),
        "{order}"
    );
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "edit", "kind": "task", "name": "Pay rent", "args": "due: 2026-10-05"}),
    );
    // an edit of a date is the reschedule it names (nt12 R4)
    assert!(says(&moved).starts_with("rescheduled: #"), "{moved}");
    assert!(
        says(&moved).contains("note: used reschedule for the edit of due"),
        "{moved}"
    );
    // a note's free text is its body
    session.user("the next ask");
    let note = call(
        &mut session,
        "find",
        json!({"kind": "note", "where": "description contains \"dal\""}),
    );
    assert!(
        says(&note).contains("note: read description as body"),
        "{note}"
    );
    assert!(!says(&note).starts_with("error"), "{note}");
}

#[test]
fn an_unknown_field_another_kind_has_names_those_kinds() {
    let world = seeded();
    let mut session = world.session();
    session.user("what has priority");
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "event", "where": "priority = 1"}),
    );
    assert!(
        says(&reply).ends_with(" priority is a field of tasks."),
        "{reply}"
    );
    // nothing decidable, nothing added
    let none = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "colour = red"}),
    );
    assert!(says(&none).ends_with("description."), "{none}");
}

#[test]
fn a_link_the_kinds_lack_names_the_parameter_that_fits() {
    let world = seeded();
    let mut session = world.session();
    session.user("what do we owe in the tahoe trip");
    let group = common::find_in_turn(&mut session, "group", "Tahoe Trip");
    let money = call(
        &mut session,
        "find",
        json!({"kind": "debt", "linked_to": group}),
    );
    assert!(
        text(&money).contains("debts are not linked to groups.")
            && text(&money).contains(
                "Send compute op: balance, kind: group, name: \"Tahoe Trip\", linked_to: #"
            ),
        "{money}"
    );
    let album = common::find_in_turn(&mut session, "album", "Summer");
    let people = call(
        &mut session,
        "find",
        json!({"kind": "person", "linked_to": album}),
    );
    assert!(
        text(&people).contains("Send find kind: photo, linked_to: #"),
        "{people}"
    );
    // another kind of a group's is no money: no sentence about it
    let events = call(
        &mut session,
        "find",
        json!({"kind": "event", "linked_to": group}),
    );
    assert!(!text(&events).contains("compute op balance"), "{events}");
    // the same link in a where
    let count = call(
        &mut session,
        "find",
        json!({"kind": "debt", "where": "group count > 1"}),
    );
    assert!(
        says(&count).contains("not a kind") || says(&count).starts_with("error"),
        "{count}"
    );
}

#[test]
fn a_secret_the_item_lacks_names_the_one_it_holds() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is the cvv of the home wifi");
    let wifi = common::find_in_turn(&mut session, "locker item", "Home wifi");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": wifi, "args": "field: cvv"}),
    );
    assert!(
        says(&reply).contains("It holds: password. Send act verb: reveal, rows: #")
            && says(&reply).ends_with(", args: field: password."),
        "{reply}"
    );
}

#[test]
fn a_wrong_kind_row_in_a_write_is_a_repair_naming_the_rows_the_words_fit() {
    let world = world_with(|world| {
        push(
            world,
            "documents",
            json!({"key": "lease_doc", "name": "Home papers", "text": "x"}),
        );
        push(
            world,
            "tasks",
            json!({"key": "review", "name": "Review lease"}),
        );
        push(
            world,
            "documents",
            json!({"key": "lease2", "name": "Lease scan", "text": "y"}),
        );
        push(
            world,
            "groups",
            json!({"key": "scan_group", "name": "Scan club", "members": ["ray"]}),
        );
    });
    let fresh = |message: &str| {
        let mut session = world.session();
        session.user(message);
        session
    };
    // a verb on the wrong kind
    let mut session = fresh("tick off the lease scan");
    let scan = common::find_in_turn(&mut session, "document", "Lease scan");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": scan}),
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert!(reply["effect"].get("composed").is_none(), "{reply}");
    assert!(
        says(&reply).starts_with("error: complete does not apply to documents.")
            && says(&reply).contains("Did you mean #")
            && says(&reply).contains("task \"Review lease\"?"),
        "{reply}"
    );
    // a row into a container of the wrong kind: the containers of the right kind the words fit
    let mut session = fresh("put pay rent in home papers");
    let papers = common::find_in_turn(&mut session, "document", "Home papers");
    let pay = common::find_in_turn(&mut session, "task", "Pay rent");
    let put = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "rows": pay, "args": format!("to: {papers}")}),
    );
    assert_eq!(put["ends_turn"], false, "{put}");
    assert!(says(&put).contains("a task goes into a list, and"), "{put}");
    assert!(
        says(&put).contains("list \"Home\"? Send act verb: add_to, rows: #"),
        "{put}"
    );
    // a group that is not one: the groups the words fit
    let mut session = fresh("settle up with ray");
    let scan = common::find_in_turn(&mut session, "document", "Lease scan");
    let ray = common::find_in_turn(&mut session, "person", "Ray Ochoa");
    let settled = call(
        &mut session,
        "act",
        json!({"verb": "settle_up", "rows": ray, "args": format!("group: {scan}")}),
    );
    assert!(
        says(&settled).contains("group \"Scan club\"? Send act verb: settle_up, rows: #")
            && says(&settled).ends_with(", args: group: #3."),
        "{settled}"
    );
    // nothing of the right kind fits the words: the refusal is the decline it was
    let mut session = fresh("tick off the taxes");
    let taxes = common::find_in_turn(&mut session, "folder", "Taxes");
    let none = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": taxes}),
    );
    assert_eq!(none["ends_turn"], true, "{none}");
    assert!(
        text(&none).starts_with("refused: complete does not apply to folders"),
        "{none}"
    );
}

// ---------------------------------------------------------------------------------------------
// The which-one ask after F8: a word that extends a name word ("renewal" for "Renew") names that
// row, so the row whose name the words fit best is not asked about (val refreeze, nt9)

fn two_passport_tasks() -> World {
    world_with(|world| {
        push(
            world,
            "tasks",
            json!({"key": "passport", "name": "Renew passport", "due": "2026-11-15", "priority": 1}),
        );
        push(
            world,
            "tasks",
            json!({"key": "passphotos", "name": "Get passport photos", "due": "2026-10-21", "list": "home"}),
        );
    })
}

#[test]
fn a_word_that_extends_a_name_word_singles_the_row_out() {
    let world = two_passport_tasks();
    let mut session = world.session();
    session.user("tick off the passport renewal");
    let n = common::find_in_turn(&mut session, "task", "Renew passport");
    let reply = call(&mut session, "act", json!({"verb": "complete", "rows": n}));
    assert!(text(&reply).starts_with("completed:"), "{reply}");
}

#[test]
fn the_shared_word_alone_still_asks() {
    let world = two_passport_tasks();
    let mut session = world.session();
    session.user("tick off passport");
    let n = common::find_in_turn(&mut session, "task", "Renew passport");
    let reply = call(&mut session, "act", json!({"verb": "complete", "rows": n}));
    assert!(text(&reply).starts_with("asked:"), "{reply}");
}
