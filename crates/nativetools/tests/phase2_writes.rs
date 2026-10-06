//! The write path's phase 2 rules (#1044): the bulk cap that holds, vault
//! refusals the runtime composes into a decline or an ask (D-1044-10), the
//! candidates of an ambiguity in the order the reply lists them, and by-name
//! writes through the shared name matching (SPEC §3, §4.5, §5).

mod common;

use centraid_nativetools::meta::ROW_CAP;
use centraid_nativetools::vaultio::{Handle, SetClock};
use centraid_nativetools::{Flags, Session};
use common::{call, diff_rows, seeded_with, text};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(common::FIXTURE).expect("the fixture is JSON")
}

/// The fixture with `count` more open tasks called `Bulk chore <n>`.
fn many_chores(count: usize) -> Value {
    let mut world = fixture();
    let tasks = world["tasks"].as_array_mut().expect("tasks");
    for n in 0..count {
        tasks.push(json!({"key": format!("bulk{n}"), "name": format!("Bulk chore {n}"), "due": "2026-11-01"}));
    }
    world
}

/// A write that says all: the slot trace the model writes for it.
const SCOPE_ALL: &str = "intent: write \"delete\"\nverb: delete\nscope: all \"all\"";

/// Start a turn with `message` and find every chore: its result handle.
fn find_chores(session: &mut Session, message: &str) -> String {
    session.user(message);
    let found = call(
        session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    found["effect"]["result"]
        .as_str()
        .expect("a result handle")
        .to_owned()
}

/// How many chores are live.
fn live_chores(session: &mut Session) -> usize {
    session.user("");
    let found = call(
        session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    found["effect"]["rows"].as_array().expect("rows").len()
}

fn tool_of(response: &Value) -> &str {
    response["effect"]["tool"].as_str().unwrap_or_default()
}

fn reply(response: &Value) -> &str {
    response["text"].as_str().expect("a text")
}

fn options_of(response: &Value) -> Vec<String> {
    response["effect"]["ask"]["options"]
        .as_array()
        .expect("options")
        .iter()
        .map(|row| row["id"].as_str().expect("an id").to_owned())
        .collect()
}

/// The vault write `act` over one row picked by number.
fn act_rows(session: &mut Session, args: Value) -> Value {
    call(session, "act", args)
}

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

#[test]
fn scope_all_and_more_do_not_lift_the_cap() {
    let world = seeded_with(&many_chores(20));
    let mut session = world.session();
    let list = find_chores(&mut session, "delete all the chores");
    let asked = session.call_traced(
        "act",
        &json!({"verb": "delete", "rows": list, "more": true}),
        Some(SCOPE_ALL),
    );
    // the turn ends in the ask the runtime composed, and nothing was written
    assert_eq!(asked["ends_turn"], true, "{asked}");
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    assert!(diff_rows(&asked).is_empty(), "{asked}");
    assert_eq!(
        reply(&asked),
        format!(
            "asked: \"this would delete 20 tasks; delete all of them?\" · the runtime ended the turn: 20 rows is over the cap of {ROW_CAP} and nothing was done; after a yes, send the same write again"
        )
    );
    // the effect carries the count and the selector
    let ask = &asked["effect"]["ask"];
    assert_eq!(ask["count"], 20);
    assert_eq!(ask["selector"], list);
    assert_eq!(ask["verb"], "delete");
    assert_eq!(ask["kind"], "task");
    assert_eq!(
        ask["question"],
        "this would delete 20 tasks; delete all of them?"
    );
    assert_eq!(ask["options"], json!([]));
    assert_eq!(asked["effect"]["bulk"]["cap"], ROW_CAP);
    assert_eq!(asked["effect"]["bulk"]["confirmed"], false);
    assert_eq!(asked["effect"]["composed"], true);
    assert!(asked["effect"].get("error").is_none(), "{asked}");
    assert_eq!(live_chores(&mut session), 20, "every chore is still live");
}

#[test]
fn the_cap_does_not_read_the_trace_or_the_words() {
    // every way a call can say "all", and the ways it can say less, end the same
    let traces = [
        None,
        Some("intent: write\nverb: delete\nscope: all"),
        Some("intent: write\nverb: delete\nscope: some \"the chores\""),
        Some("intent: write\nverb: delete\nscope: one"),
        Some("intent: write\nverb: delete"),
    ];
    for message in ["delete all the chores", "delete the chores", "every one"] {
        for think in traces {
            let world = seeded_with(&many_chores(14));
            let mut session = world.session();
            let list = find_chores(&mut session, message);
            let asked = session.call_traced("act", &json!({"verb": "delete", "rows": list}), think);
            // scope one with several rows is the trace guard's refusal and not
            // the cap's: it never reaches the write
            if think.is_some_and(|think| think.contains("scope: one")) {
                assert_eq!(asked["ends_turn"], false, "{message} {think:?}: {asked}");
                continue;
            }
            assert_eq!(tool_of(&asked), "ask", "{message} {think:?}: {asked}");
            // nt11 R5: a handle over the cap ends as the selector that made it does: the cap's own
            // question when the person or the trace says all, else `Which one?` over the rows
            // (a trace that states a scope decides; with none, the message does)
            let says_all = match think {
                Some(think) if think.contains("scope:") => think.contains("scope: all"),
                _ => message.contains("all") || message.contains("every"),
            };
            if says_all {
                assert_eq!(asked["effect"]["ask"]["count"], 14, "{message} {think:?}");
            } else {
                assert_eq!(
                    asked["effect"]["ask"]["question"], "Which one?",
                    "{message} {think:?}"
                );
                assert_eq!(
                    asked["effect"]["ask"]["options"].as_array().map(Vec::len),
                    Some(ROW_CAP),
                    "{message} {think:?}: {asked}"
                );
            }
            assert_eq!(live_chores(&mut session), 14, "{message} {think:?}");
        }
    }
}

#[test]
fn rows_at_the_cap_run_and_one_more_asks() {
    for (count, runs) in [(ROW_CAP, true), (ROW_CAP + 1, false)] {
        let world = seeded_with(&many_chores(count));
        let mut session = world.session();
        let list = find_chores(&mut session, "finish all the chores");
        let done = session.call_traced(
            "act",
            &json!({"verb": "complete", "rows": list}),
            Some("intent: write\nverb: complete\nscope: all"),
        );
        if runs {
            assert_eq!(diff_rows(&done).len(), count, "{done}");
            assert_eq!(done["ends_turn"], true);
            assert_eq!(tool_of(&done), "act");
            assert!(
                done["effect"].get("bulk").is_none(),
                "under the cap: {done}"
            );
        } else {
            assert!(diff_rows(&done).is_empty(), "{done}");
            assert_eq!(tool_of(&done), "ask", "{done}");
            assert_eq!(done["effect"]["ask"]["count"], count);
            assert_eq!(
                reply(&done).split(" · ").next(),
                Some("asked: \"this would complete 13 tasks; complete all of them?\"")
            );
        }
    }
}

#[test]
fn the_question_names_the_verb_the_kinds_and_where_the_rows_go() {
    let mut world = many_chores(13);
    let people = world["people"].as_array_mut().expect("people");
    for n in 0..13 {
        people.push(json!({"key": format!("p{n}"), "name": format!("Crowd {n}")}));
    }
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("do things to everyone");
    let chores = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "bulk chore"}),
    );
    let crowd = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "crowd"}),
    );
    let (tasks, people) = (
        chores["effect"]["result"].as_str().unwrap().to_owned(),
        crowd["effect"]["result"].as_str().unwrap().to_owned(),
    );
    let question = |session: &mut Session, args: Value| {
        // each ask ends its turn; the person says everyone, so the cap's own question is asked
        session.user("do it to everyone");
        let response = act_rows(session, args);
        assert_eq!(tool_of(&response), "ask", "{response}");
        response["effect"]["ask"]["question"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    assert_eq!(
        question(
            &mut session,
            json!({"verb": "reschedule", "rows": tasks, "args": "to: {\"unit\":\"day\",\"rel\":3}"})
        ),
        "this would reschedule 13 tasks; reschedule all of them?"
    );
    assert_eq!(
        question(&mut session, json!({"verb": "star", "rows": people})),
        "this would star 13 people; star all of them?"
    );
    assert_eq!(
        question(
            &mut session,
            json!({"verb": "edit", "rows": tasks, "args": "effort: 20"})
        ),
        "this would change 13 tasks; change all of them?"
    );
    // more than one kind in one write
    let both = format!("{tasks}, {people}");
    assert_eq!(
        question(&mut session, json!({"verb": "delete", "rows": both})),
        "this would delete 26 rows: 13 tasks, 13 people; delete all of them?"
    );
}

#[test]
fn the_question_names_where_a_bulk_add_or_remove_goes() {
    let mut world = fixture();
    let photos = world["photos"].as_array_mut().unwrap();
    for n in 0..13 {
        photos.push(json!({"key": format!("shot{n}"), "name": format!("Shot {n}"), "taken": "2026-08-01T10:00"}));
    }
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("put every shot in the summer album");
    let summer = common::find_in_turn(&mut session, "album", "summer");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "shot"}),
    );
    let shots = found["effect"]["result"].as_str().unwrap().to_owned();
    let added = call(
        &mut session,
        "act",
        json!({"verb": "add_to", "rows": shots, "args": format!("to: {summer}")}),
    );
    assert_eq!(
        added["effect"]["ask"]["question"],
        "this would add 13 photos to the Summer album; add all of them?"
    );
    session.user("or take every one of them out");
    let removed = call(
        &mut session,
        "act",
        json!({"verb": "remove_from", "rows": shots, "args": format!("from: {summer}")}),
    );
    assert_eq!(
        removed["effect"]["ask"]["question"],
        "this would remove 13 photos from the Summer album; remove all of them?"
    );
}

#[test]
fn a_yes_in_the_next_turn_performs_the_same_write() {
    let world = seeded_with(&many_chores(20));
    let mut session = world.session();
    let list = find_chores(&mut session, "delete all the chores");
    let write = json!({"verb": "delete", "rows": list, "more": true});
    let asked = session.call_traced("act", &write, Some(SCOPE_ALL));
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    // the confirming call is the same write; paging is not part of it
    session.user("yes");
    let done = call(&mut session, "act", json!({"verb": "delete", "rows": list}));
    assert_eq!(tool_of(&done), "act", "{done}");
    assert_eq!(done["ends_turn"], true, "the write ends the turn");
    assert_eq!(diff_rows(&done).len(), 20, "{done}");
    assert!(
        diff_rows(&done)
            .iter()
            .all(|row| row["change"] == "trashed"),
        "{done}"
    );
    assert_eq!(
        done["effect"]["bulk"],
        json!({"count": 20, "cap": ROW_CAP, "confirmed": true})
    );
    // the echo shows the first rows and counts the rest; the effect lists them all
    let lines = reply(&done);
    assert_eq!(lines.matches("deleted: #").count(), ROW_CAP, "{lines}");
    assert!(
        lines.contains(&format!("… {} more changed", 20 - ROW_CAP)),
        "{lines}"
    );
    assert!(
        lines.contains("note: confirmed, the 20 rows the runtime asked about."),
        "{lines}"
    );
    // the whole write is one unit for `undo`
    session.user("undo that");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert_eq!(diff_rows(&undone).len(), 20, "{undone}");
    // its echo is capped like the write's
    assert!(
        reply(&undone).contains(&format!("… {} more changed", 20 - ROW_CAP)),
        "{undone}"
    );
    assert_eq!(live_chores(&mut session), 20);
}

#[test]
fn a_confirmation_needs_the_same_write() {
    let world = seeded_with(&many_chores(20));
    let mut session = world.session();
    let list = find_chores(&mut session, "complete all the chores");
    let write = json!({"verb": "complete", "rows": list});
    let asked = call(&mut session, "act", write.clone());
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    // another verb, another `args`, another rows: each is its own question
    session.user("yes");
    let other_verb = call(&mut session, "act", json!({"verb": "delete", "rows": list}));
    assert_eq!(tool_of(&other_verb), "ask", "{other_verb}");
    session.user("yes");
    let effort = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": list, "args": "effort: 10"}),
    );
    assert_eq!(tool_of(&effort), "ask", "{effort}");
    session.user("yes");
    let other = {
        let found = call(
            &mut session,
            "find",
            json!({"kind": "task", "name": "bulk chore", "limit": 13}),
        );
        found["effect"]["result"].as_str().unwrap().to_owned()
    };
    let fewer = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": other}),
    );
    // nt11 R5: the message ("yes") says no all, so the ask is `Which one?` over the rows
    assert_eq!(tool_of(&fewer), "ask", "{fewer}");
    assert_eq!(fewer["effect"]["ask"]["question"], "Which one?", "{fewer}");
    // none of that wrote anything
    assert_eq!(live_chores(&mut session), 20);
}

#[test]
fn a_confirmation_needs_a_plain_yes() {
    for message in [
        "",
        "no",
        "no, just the done ones",
        "yes but only the done ones",
        "fine just the ones i already finished, keep the open",
        "wait",
        "what would that delete",
    ] {
        let world = seeded_with(&many_chores(20));
        let mut session = world.session();
        let list = find_chores(&mut session, "delete all the chores");
        let write = json!({"verb": "delete", "rows": list});
        assert_eq!(tool_of(&call(&mut session, "act", write.clone())), "ask");
        session.user(message);
        let again = call(&mut session, "act", write);
        assert_eq!(tool_of(&again), "ask", "{message:?}: {again}");
        assert!(diff_rows(&again).is_empty(), "{message:?}: {again}");
        assert_eq!(live_chores(&mut session), 20, "{message:?}");
    }
}

#[test]
fn a_yes_answers_the_ask_of_the_turn_right_before_it() {
    let world = seeded_with(&many_chores(20));
    let mut session = world.session();
    let list = find_chores(&mut session, "delete all the chores");
    let write = json!({"verb": "delete", "rows": list});
    assert_eq!(tool_of(&call(&mut session, "act", write.clone())), "ask");
    // the person says something else first; a yes after that answers nothing
    session.user("what is on the list");
    session.user("yes");
    let late = call(&mut session, "act", write);
    assert_eq!(tool_of(&late), "ask", "{late}");
    assert_eq!(live_chores(&mut session), 20);
}

#[test]
fn a_confirmation_is_used_once() {
    let world = seeded_with(&many_chores(20));
    let mut session = world.session();
    let list = find_chores(&mut session, "finish all the chores");
    let write = json!({"verb": "complete", "rows": list});
    assert_eq!(tool_of(&call(&mut session, "act", write.clone())), "ask");
    session.user("yes");
    let done = call(&mut session, "act", write.clone());
    assert_eq!(diff_rows(&done).len(), 20, "{done}");
    // a second yes with no ask before it confirms nothing
    session.user("yes");
    let again = call(&mut session, "act", write);
    assert_eq!(tool_of(&again), "ask", "{again}");
}

#[test]
fn a_write_under_the_cap_is_unchanged() {
    let world = seeded_with(&many_chores(3));
    let mut session = world.session();
    let list = find_chores(&mut session, "finish the chores");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": list}),
    );
    assert_eq!(tool_of(&done), "act");
    assert_eq!(done["ends_turn"], true);
    assert_eq!(diff_rows(&done).len(), 3);
    assert!(reply(&done).starts_with("completed: #"), "{}", reply(&done));
    assert!(!reply(&done).contains("more changed"));
    assert!(done["effect"].get("bulk").is_none());
    // `more` still keeps the turn open for a write under the cap
    let again = {
        session.user("and open them again");
        let found = call(
            &mut session,
            "find",
            json!({"kind": "task", "name": "bulk chore"}),
        );
        let list = found["effect"]["result"].as_str().unwrap().to_owned();
        call(
            &mut session,
            "act",
            json!({"verb": "reopen", "rows": list, "more": true}),
        )
    };
    assert_eq!(again["ends_turn"], false, "{again}");
}

#[test]
fn the_cap_ask_has_no_options_and_leaves_no_asked_focus() {
    let world = seeded_with(&many_chores(20));
    let mut session = world.session();
    let list = find_chores(&mut session, "delete all the chores");
    call(&mut session, "act", json!({"verb": "delete", "rows": list}));
    let focus = session.user("yes")["focus"]
        .as_str()
        .map(str::to_owned)
        .expect("a focus line");
    // the result the write named is what the next turn holds on to
    assert!(
        focus.starts_with("focus: @1: #") && !focus.contains("asked:"),
        "{focus}"
    );
}

// ---------------------------------------------------------------------------
// Refusals of the vault: a decline when nothing can lift them
// ---------------------------------------------------------------------------

/// The fixture with a trashed row of each kind that has a trash, a long time ago.
fn long_gone() -> Value {
    let mut world = fixture();
    let gone = "2026-03-01T09:00";
    let rows = [
        (
            "people",
            json!({"key": "gone_person", "name": "Craig Nolan", "trashed": gone}),
        ),
        (
            "events",
            json!({"key": "gone_event", "name": "Old standup", "start": "2026-02-01T09:00", "trashed": gone}),
        ),
        (
            "tasks",
            json!({"key": "gone_task", "name": "Sell treadmill", "trashed": gone}),
        ),
        (
            "notes",
            json!({"key": "gone_note", "name": "Old idea", "body": "x", "trashed": gone}),
        ),
        (
            "documents",
            json!({"key": "gone_doc", "name": "Old lease", "text": "x", "trashed": gone}),
        ),
        (
            "photos",
            json!({"key": "gone_photo", "name": "Old photo", "taken": "2026-01-01T10:00", "trashed": gone}),
        ),
        (
            "locker",
            json!({"key": "gone_locker", "name": "Old gym", "type": "login", "username": "sam", "trashed": gone}),
        ),
    ];
    for (section, row) in rows {
        world[section].as_array_mut().expect("a section").push(row);
    }
    world
}

#[test]
fn a_restore_past_the_window_ends_in_a_decline_for_every_kind() {
    let world = seeded_with(&long_gone());
    for (kind, name) in [
        ("person", "Craig Nolan"),
        ("event", "Old standup"),
        ("task", "Sell treadmill"),
        ("note", "Old idea"),
        ("document", "Old lease"),
        ("photo", "Old photo"),
        ("locker item", "Old gym"),
    ] {
        let mut session = world.session();
        session.user("bring it back");
        let declined = call(
            &mut session,
            "act",
            json!({"verb": "restore", "kind": kind, "name": name, "trashed": true}),
        );
        assert_eq!(declined["ends_turn"], true, "{kind}: {declined}");
        assert_eq!(tool_of(&declined), "decline", "{kind}: {declined}");
        assert_eq!(declined["effect"]["decline"]["reason"], "not_found");
        assert!(diff_rows(&declined).is_empty(), "{kind}: {declined}");
        assert!(
            declined["effect"].get("error").is_none(),
            "{kind}: {declined}"
        );
        let refusal = &declined["effect"]["refusal"];
        assert_eq!(refusal["verb"], "restore");
        assert_eq!(refusal["kind"], kind);
        assert_eq!(refusal["outcome"], "decline");
        // the reply says what the vault refused and which of the two the runtime did
        let lines: Vec<&str> = reply(&declined).lines().collect();
        assert_eq!(lines.len(), 2, "{kind}: {declined}");
        assert!(
            lines[0].starts_with("refused: restore #")
                && lines[0].contains(&format!("{kind} \"{name}\": it is in the trash but past the vault's restore window, so it cannot come back (vault: ")),
            "{kind}: {}",
            lines[0]
        );
        assert_eq!(
            lines[1],
            "declined: not_found · the runtime ended the turn: a row past its restore window cannot be brought back",
            "{kind}"
        );
    }
}

#[test]
fn a_decline_is_not_paged_by_more_and_does_not_repeat() {
    let world = seeded_with(&long_gone());
    let mut session = world.session();
    session.user("bring craig back");
    let declined = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "person", "name": "Craig Nolan", "trashed": true, "more": true}),
    );
    assert_eq!(declined["ends_turn"], true, "{declined}");
    assert_eq!(tool_of(&declined), "decline");
    // the turn is over: the next call belongs to a new message
    let after = call(&mut session, "find", json!({"kind": "person"}));
    assert!(
        reply(&after).starts_with("error: the turn has ended"),
        "{after}"
    );
}

#[test]
fn a_restore_inside_the_window_is_unchanged() {
    let mut world = fixture();
    world["documents"].as_array_mut().unwrap().push(
        json!({"key": "recent", "name": "Recent scan", "text": "x", "trashed": "2026-09-20T09:00"}),
    );
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("bring the scan back");
    let restored = call(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "document", "name": "Recent scan", "trashed": true}),
    );
    assert_eq!(tool_of(&restored), "act", "{restored}");
    assert_eq!(restored["ends_turn"], true);
    assert_eq!(diff_rows(&restored)[0]["change"], "restored", "{restored}");
}

#[test]
fn a_restore_that_lands_in_part_stays_an_error_with_its_diff() {
    // the first row restores, the second is past its window: a write that
    // landed is never hidden behind an ask or a decline
    let mut world = fixture();
    world["documents"].as_array_mut().unwrap().extend([
        json!({"key": "recent", "name": "Recent scan", "text": "x", "trashed": "2026-09-20T09:00"}),
        json!({"key": "ancient", "name": "Ancient scan", "text": "x", "trashed": "2026-03-01T09:00"}),
    ]);
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("bring both scans back");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "document", "name": "scan", "trashed": true, "order": "name asc"}),
    );
    // by name: Ancient scan comes first, so list the recent one first by hand
    let numbers: Vec<String> = found["effect"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| format!("#{}", row["n"]))
        .collect();
    assert_eq!(numbers.len(), 2, "{found}");
    let ids: Vec<&str> = found["effect"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap())
        .collect();
    let recent = if ids[0] == seeded.id("recent") {
        &numbers[0]
    } else {
        &numbers[1]
    };
    let ancient = if ids[0] == seeded.id("recent") {
        &numbers[1]
    } else {
        &numbers[0]
    };
    let both = format!("{recent}, {ancient}");
    let partial = call(
        &mut session,
        "act",
        json!({"verb": "restore", "rows": both}),
    );
    // a write that landed ends the turn as any write does; the refusal is named in its text
    assert_eq!(partial["ends_turn"], true, "{partial}");
    assert_eq!(tool_of(&partial), "act", "{partial}");
    assert_eq!(diff_rows(&partial).len(), 1, "{partial}");
    assert!(
        reply(&partial).contains("error: restore #") && reply(&partial).contains("was refused"),
        "{partial}"
    );
    assert!(partial["effect"]["error"].is_string());
}

// ---------------------------------------------------------------------------
// Refusals of the vault: an ask when the person can still act on them
// ---------------------------------------------------------------------------

#[test]
fn a_folder_that_holds_documents_ends_in_an_ask_that_names_them() {
    let world = seeded_with(&fixture());
    let mut session = world.session();
    session.user("get rid of the taxes folder");
    let asked = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "folder", "name": "Taxes"}),
    );
    assert_eq!(asked["ends_turn"], true, "{asked}");
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    assert!(diff_rows(&asked).is_empty(), "{asked}");
    assert_eq!(
        asked["effect"]["ask"]["question"],
        "the Taxes folder still holds 1 document; take it out first, then delete the folder?"
    );
    assert_eq!(options_of(&asked), vec![world.id("w2")]);
    assert_eq!(asked["effect"]["refusal"]["predicate"], "folder_is_empty");
    assert_eq!(asked["effect"]["refusal"]["outcome"], "ask");
    let lines: Vec<&str> = reply(&asked).lines().collect();
    assert!(
        lines[0].starts_with("refused: delete #")
            && lines[0].contains("folder \"Taxes\": that folder still holds documents"),
        "{}",
        lines[0]
    );
    assert!(
        lines[1].starts_with("asked: \"the Taxes folder still holds 1 document;")
            && lines[1].contains(" · options: #")
            && lines[1].ends_with(" · the runtime ended the turn and nothing was done"),
        "{}",
        lines[1]
    );
    // the folder is still there, and the options are in focus for the answer
    let focus = session.user("yes, move it to the lease folder")["focus"]
        .as_str()
        .map(str::to_owned)
        .expect("a focus line");
    assert!(
        focus.contains("asked: #") && focus.contains("document \"W2 2025\""),
        "{focus}"
    );
    let folders = call(&mut session, "find", json!({"kind": "folder"}));
    assert_eq!(folders["effect"]["rows"].as_array().unwrap().len(), 1);
}

#[test]
fn a_trashed_document_counts_toward_what_a_folder_holds() {
    let mut world = fixture();
    world["documents"].as_array_mut().unwrap().push(
        json!({"key": "w9", "name": "W9 2025", "text": "x", "folder": "taxes", "trashed": "2026-09-20T09:00"}),
    );
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("delete the taxes folder");
    let asked = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "folder", "name": "Taxes"}),
    );
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    assert_eq!(
        asked["effect"]["ask"]["question"],
        "the Taxes folder still holds 1 document and 1 document in the trash; take them out first, then delete the folder?"
    );
    assert_eq!(
        options_of(&asked),
        vec![seeded.id("w2"), seeded.id("w9")],
        "live documents first"
    );
}

#[test]
fn an_empty_folder_deletes_as_before() {
    let mut world = fixture();
    world["folders"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key": "empty_f", "name": "Empty drawer"}));
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("delete the empty drawer folder");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "folder", "name": "Empty drawer"}),
    );
    assert_eq!(tool_of(&done), "act", "{done}");
    assert_eq!(diff_rows(&done)[0]["change"], "removed", "{done}");
}

#[test]
fn a_group_with_expenses_ends_in_an_ask_that_does_not_promise_a_way_out() {
    let world = seeded_with(&fixture());
    let mut session = world.session();
    session.user("delete the tahoe group");
    let group = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "group", "name": "Tahoe Trip"}),
    );
    assert_eq!(tool_of(&group), "ask", "{group}");
    assert_eq!(group["ends_turn"], true);
    // settling up does not lift the vault's refusal, so the question does not offer it
    assert_eq!(
        group["effect"]["ask"]["question"],
        "the Tahoe Trip group still has expenses, so it cannot be deleted; keep it, or rename it instead?"
    );
    assert_eq!(group["effect"]["refusal"]["predicate"], "group_empty");
    assert_eq!(group["effect"]["refusal"]["outcome"], "ask");
    assert!(diff_rows(&group).is_empty(), "{group}");
    // the other group has no expenses: it deletes
    session.user("and the flat one");
    let flat = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "group", "name": "Flat 4B"}),
    );
    assert_eq!(tool_of(&flat), "act", "{flat}");
    assert_eq!(diff_rows(&flat)[0]["change"], "removed");
}

#[test]
fn the_refusals_of_other_verbs_stay_errors_for_the_model() {
    // D-1044-10 reads the refusals of `restore` and `delete`; the others (a member with a
    // balance, an event that clashes, a cancelled event, a name in use) are the model's
    let world = seeded_with(&fixture());
    let mut session = world.session_uncomposed();
    session.user("do these");
    let tahoe = common::find_in_turn(&mut session, "group", "Tahoe Trip");
    let refused = [
        (
            "remove_from",
            json!({"verb": "remove_from", "kind": "person", "name": "Ray Ochoa", "args": format!("from: {tahoe}")}),
        ),
        (
            "create event",
            json!({"verb": "create", "kind": "event", "args": "name: Call\ndate: {\"date\":\"2026-10-02\",\"time\":\"09:15\"}"}),
        ),
        (
            "reschedule",
            json!({"verb": "reschedule", "kind": "event", "name": "Launch party", "args": "to: {\"unit\":\"week\",\"rel\":1,\"weekday\":5}"}),
        ),
        (
            "rename",
            json!({"verb": "edit", "kind": "notebook", "name": "Ideas", "args": "name: Recipes"}),
        ),
        (
            "create folder",
            json!({"verb": "create", "kind": "folder", "args": "name: Taxes"}),
        ),
    ];
    for (what, args) in refused {
        // a turn each: the step cap counts every call of a turn
        session.user("");
        let response = call(&mut session, "act", args);
        assert_eq!(response["ends_turn"], false, "{what}: {response}");
        assert!(
            reply(&response).contains("was refused: "),
            "{what}: {response}"
        );
        assert!(
            response["effect"]["error"].is_string(),
            "{what}: {response}"
        );
        assert!(
            response["effect"].get("refusal").is_none(),
            "{what}: {response}"
        );
        assert!(
            response["effect"].get("composed").is_none(),
            "{what}: {response}"
        );
        assert_ne!(tool_of(&response), "ask", "{what}");
    }
}

#[test]
fn a_notebook_that_holds_notebooks_ends_in_an_ask() {
    let world = seeded_with(&fixture());
    // a child notebook, made through the vault: `act` does not nest notebooks
    let handle = Handle::open(
        world.path(),
        SetClock::at(1_790_000_000_000),
        "writes-child",
    )
    .expect("the vault opens");
    handle
        .must(
            "knowledge.create_notebook",
            json!({"name": "Soups", "parent_notebook_id": world.id("recipes")}),
        )
        .expect("the child is made");
    drop(handle);
    let mut session = world.session();
    session.user("delete the recipes notebook");
    let asked = call(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "notebook", "name": "Recipes"}),
    );
    assert_eq!(tool_of(&asked), "ask", "{asked}");
    assert_eq!(
        asked["effect"]["ask"]["question"],
        "the Recipes notebook still holds other notebooks, so it cannot be deleted; keep it?"
    );
    assert_eq!(
        asked["effect"]["refusal"]["predicate"],
        "notebook_has_no_children"
    );
}

#[test]
fn a_refusal_of_the_call_itself_stays_an_error() {
    // a subtask under a subtask: the vault's `parent_open_and_top_level` check, which the
    // model repairs by naming another parent, so it is not a question for the person
    let world = seeded_with(&fixture());
    let mut session = world.session();
    session.user("add a step under the outline");
    let outline = common::find_in_turn(&mut session, "task", "Report outline");
    let refused = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": format!("name: Step\nparent: {outline}")}),
    );
    assert_eq!(refused["ends_turn"], false, "{refused}");
    assert!(
        reply(&refused).starts_with("error: create task was refused: "),
        "{refused}"
    );
    assert!(refused["effect"].get("refusal").is_none(), "{refused}");
}

#[test]
fn a_composed_ask_is_not_an_error_the_model_can_repeat() {
    let world = seeded_with(&fixture());
    let mut session = world.session();
    session.user("get rid of the taxes folder");
    let write = json!({"verb": "delete", "kind": "folder", "name": "Taxes"});
    let asked = call(&mut session, "act", write.clone());
    assert_eq!(asked["ends_turn"], true);
    // the same call again in the same turn is answered as a call after the end
    let again = call(&mut session, "act", write);
    assert!(
        reply(&again).starts_with("error: the turn has ended"),
        "{again}"
    );
}

// ---------------------------------------------------------------------------
// Names in writes go through the shared matching (search.rs)
// ---------------------------------------------------------------------------

#[test]
fn a_write_by_name_takes_the_one_row_a_word_start_fits() {
    let world = seeded_with(&fixture());
    let mut session = world.session();
    session.user("tick off mend ree");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "mend ree"}),
    );
    assert_eq!(tool_of(&done), "act", "{done}");
    assert_eq!(
        diff_rows(&done)[0]["fields"]["status"],
        json!(["open", "completed"])
    );
    // nt11 R3: a word start is tier 3, so the write acts and the reply is the write's own line
    assert!(
        !reply(&done).contains("matched ")
            && reply(&done).contains("task \"Mend reed for Benedikt\""),
        "{done}"
    );
}

#[test]
fn a_write_by_name_folds_accents_and_reads_a_nickname() {
    let mut world = fixture();
    world["people"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key": "lucia", "name": "Lucía Vega"}));
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("star lucia");
    let accent = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Lucia"}),
    );
    assert_eq!(diff_rows(&accent)[0]["id"], seeded.id("lucia"), "{accent}");
    assert!(
        !reply(&accent).contains("matched"),
        "an exact name by fold: {accent}"
    );
    session.user("star nk");
    let nickname = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "NK"}),
    );
    assert_eq!(
        diff_rows(&nickname)[0]["id"],
        seeded.id("neha_k"),
        "{nickname}"
    );
}

fn kams() -> common::World {
    let mut world = fixture();
    world["people"].as_array_mut().unwrap().extend([
        json!({"key": "kamini", "name": "Kamini Rao", "nickname": "Kami", "role": "friend"}),
        json!({"key": "kamal", "name": "Kamal Singh"}),
        json!({"key": "kamran", "name": "Kamran Ali"}),
    ]);
    seeded_with(&world)
}

#[test]
fn several_fits_by_name_are_ambiguous_and_an_ask_after_them_lists_them_all() {
    let world = kams();
    let mut session = world.session_uncomposed();
    session.user("star kam");
    let starred = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Kam"}),
    );
    let text = reply(&starred).to_owned();
    assert!(text.starts_with("ambiguous: \"Kam\" fits #"), "{text}");
    let listed: Vec<u64> = starred["effect"]["ambiguous"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|row| row["n"].as_u64())
        .collect();
    assert_eq!(listed.len(), 3, "{text}");
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which kam?", "options": format!("#{}", listed[0])}),
    );
    assert!(
        reply(&asked).contains("options completed from the candidates"),
        "{}",
        reply(&asked)
    );
    assert_eq!(
        asked["effect"]["ask"]["options"].as_array().unwrap().len(),
        3
    );
}

// ---------------------------------------------------------------------------
// The candidates of an ambiguity, in the order the reply lists them
// ---------------------------------------------------------------------------

/// Names of the rows an `ambiguous:` reply lists, in its order.
fn listed_names(response: &Value) -> Vec<String> {
    let line = reply(response);
    let (_, rows) = line.split_once(" fits ").expect("a fits list");
    rows.split("; nothing was done")
        .next()
        .unwrap()
        .split(", ")
        .map(|row| {
            row.split('"')
                .nth(1)
                .map(str::to_owned)
                .unwrap_or_else(|| row.to_owned())
        })
        .collect()
}

#[test]
fn candidates_that_are_not_over_come_first_nearest_date_first() {
    // today is 2026-09-27: twelve done "Pay rent" tasks from 2025, then the open ones
    let mut world = fixture();
    let tasks = world["tasks"].as_array_mut().unwrap();
    for month in 1..=12 {
        tasks.push(json!({
            "key": format!("done{month}"),
            "name": "Pay rent",
            "due": format!("2025-{month:02}-01"),
            "status": "completed",
            "completed": format!("2025-{month:02}-02T09:00"),
        }));
    }
    tasks.push(json!({"key": "soon", "name": "Pay rent", "due": "2026-09-28"}));
    tasks.push(json!({"key": "later", "name": "Pay rent", "due": "2026-12-01"}));
    tasks.push(json!({"key": "undated", "name": "Pay rent"}));
    let seeded = seeded_with(&world);
    let mut session = seeded.session_uncomposed();
    session.user("push the rent to friday");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "task", "name": "Pay rent", "args": "to: {\"date\":\"2026-10-09\"}"}),
    );
    assert!(
        text_of(&reply).starts_with("ambiguous: \"Pay rent\" fits #"),
        "{reply}"
    );
    // 16 fit (the fixture's own, due 2026-10-01, among them); the reply lists twelve
    assert!(
        text_of(&reply).contains(" and 4 more; nothing was done."),
        "{reply}"
    );
    let all = reply["effect"]["ambiguous"].as_array().unwrap();
    assert_eq!(all.len(), 16);
    let ids: Vec<&str> = all.iter().map(|row| row["id"].as_str().unwrap()).collect();
    // not over, nearest first (1, 4 and 65 days from today), the undated one after the dated
    assert_eq!(
        &ids[..4],
        [
            seeded.id("soon"),
            seeded.id("pay"),
            seeded.id("later"),
            seeded.id("undated")
        ],
        "{reply}"
    );
    // then the rows that are over, oldest first
    assert_eq!(ids[4], seeded.id("done1"));
    assert_eq!(ids[11], seeded.id("done8"));
    // the twelve listed are numbered, in the order the reply lists them
    assert!(all[..ROW_CAP].iter().all(|row| row["n"].is_u64()));
}

fn text_of(response: &Value) -> &str {
    response["text"].as_str().expect("a text")
}

#[test]
fn an_event_that_has_not_ended_comes_before_the_ones_that_have() {
    let mut world = fixture();
    let events = world["events"].as_array_mut().unwrap();
    for n in 1..=14 {
        events.push(json!({
            "key": format!("past{n}"),
            "name": "Piano recital",
            "start": format!("{}-{:02}-10T18:00", 2023 + n / 13, (n % 12) + 1),
        }));
    }
    events.push(json!({"key": "tomorrow", "name": "Piano recital", "start": "2026-09-28T18:00"}));
    let seeded = seeded_with(&world);
    let mut session = seeded.session_uncomposed();
    session.user("the recital is 90 minutes");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "reschedule", "kind": "event", "name": "Piano recital", "args": "to: {\"date\":\"2026-10-09\",\"time\":\"18:00\"}"}),
    );
    assert!(text_of(&reply).starts_with("ambiguous: "), "{reply}");
    let all = reply["effect"]["ambiguous"].as_array().unwrap();
    assert_eq!(all.len(), 15);
    assert_eq!(all[0]["id"], seeded.id("tomorrow"), "{reply}");
    assert_eq!(listed_names(&reply).len(), ROW_CAP);
    // an ask after the reply offers the rows the reply listed, the live one first
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which recital?", "options": format!("#{}", all[3]["n"])}),
    );
    let options = asked["effect"]["ask"]["options"].as_array().unwrap();
    assert_eq!(options.len(), ROW_CAP);
    assert_eq!(options[0]["id"], seeded.id("tomorrow"));
}

#[test]
fn rows_with_no_date_keep_the_order_the_selector_gave() {
    // people have no date and are never over: the order is the selector's, as before
    let mut world = fixture();
    let people = world["people"].as_array_mut().unwrap();
    for n in 0..14 {
        people.push(json!({"key": format!("sam{n}"), "name": format!("Sam P{n}")}));
    }
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    session.user("star sam");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "star", "kind": "person", "name": "Sam"}),
    );
    let names = listed_names(&reply);
    let mut sorted = names.clone();
    sorted.sort_by_key(|name| name.to_lowercase());
    assert_eq!(names, sorted, "{reply}");
}

// ---------------------------------------------------------------------------
// R3's flags still reach the block
// ---------------------------------------------------------------------------

#[test]
fn the_flags_still_switch_the_block_off() {
    let world = seeded_with(&fixture());
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            preground: false,
            ..Flags::default()
        },
    );
    let user = session.user("star neha");
    assert!(user["block"].is_null(), "{user}");
    // and a write over a trashed name still goes the way of its refusal
    let refused = text(
        &mut session,
        "act",
        json!({"verb": "restore", "kind": "person", "name": "Old Contact", "trashed": true}),
    );
    assert!(refused.contains("declined: not_found"), "{refused}");
}
