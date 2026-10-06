//! Phase 6 of #1044, slice P1: what the model sees in the turn block. Six
//! deterministic rules (the model judges, the harness composes), each pinned on
//! the block's text and on the handle or row it names resolving on the next call:
//!
//! 1. the `focus:` line holds the last three result sets, newest first, and,
//!    after them, the rows a write acted on that no set names (`acted`);
//! 2. a count or value keeps its rows (`within: @n`) and shows in focus;
//! 3. rows that share a container name it, and "that album" is grounded to it;
//! 4. the person's own row is in the `vault:` line for "my balance";
//! 5. the options of an ask carry what tells them apart, and the `answer:` line
//!    says which one the next message's words fit;
//! 6. a name many rows share is cut to the touched and the nearest copies.

mod common;

use centraid_nativetools::Session;
use common::{World, call, diff_rows, ids, number, numbers, seeded, seeded_with, text};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(common::FIXTURE).expect("the fixture is JSON")
}

/// A turn's reply line, `None` when it has none.
fn line(reply: &Value, key: &str) -> Option<String> {
    reply[key].as_str().map(str::to_owned)
}

/// The `#n` of the rows a response lists, in order.
fn ns(response: &Value) -> Vec<u64> {
    response["effect"]["rows"]
        .as_array()
        .expect("rows")
        .iter()
        .map(|row| row["n"].as_u64().expect("an n"))
        .collect()
}

/// How many rows a `find` returns (the model's next call over the handle).
fn found(session: &mut Session, args: Value) -> usize {
    ids(&call(session, "find", args)["effect"]["rows"]).len()
}

/// The `#n` of the `k`-th row a write changed.
fn written(response: &Value, k: usize) -> u64 {
    diff_rows(response)[k]["n"].as_u64().expect("an n")
}

/// Every `#n` in `text`, in order.
fn hashes(text: &str) -> Vec<u64> {
    text.split('#')
        .skip(1)
        .filter_map(|rest| {
            rest.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .ok()
        })
        .collect()
}

/// The number that follows `marker` in `text`.
fn number_after(text: &str, marker: &str) -> u64 {
    let rest = text.split(marker).nth(1).expect("the marker");
    rest.chars()
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .expect("a number")
}

// ---------------------------------------------------------------------------
// P1.1 focus depth
// ---------------------------------------------------------------------------

#[test]
fn the_focus_line_holds_the_last_three_result_sets_newest_first_with_the_rows_set_leading() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is due");
    let pay = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "pay rent"}),
    );
    session.user("who is ray");
    let ray = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "ray"}),
    );
    session.user("when is the dentist");
    let dentist = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "dentist"}),
    );
    session.user("the dal note");
    let dal = call(&mut session, "find", json!({"kind": "note", "name": "dal"}));
    let (ray, dentist, dal) = (ns(&ray)[0], ns(&dentist)[0], ns(&dal)[0]);

    let reply = session.user("and then");
    let focus = line(&reply, "focus").expect("a focus line");
    assert!(
        focus.starts_with(&format!("focus: @4: #{dal} note \"Dal\" · in #")),
        "{focus}"
    );
    // the newest rows set keeps the old one-set form; the others follow under `earlier:`
    assert!(
        focus.ends_with(&format!(
            " notebook \"Recipes\" · earlier: @3: #{dentist} event \"Dentist\", @2: #{ray} person \"Ray Ochoa\""
        )),
        "{focus}"
    );
    assert!(
        !focus.contains("@1:") && !focus.contains(&format!("#{} ", ns(&pay)[0])),
        "the fourth set back is out: {focus}"
    );
    // the handles resolve on the next call
    assert_eq!(
        found(&mut session, json!({"kind": "person", "within": "@2"})),
        1
    );
    assert_eq!(
        found(&mut session, json!({"kind": "event", "within": "@3"})),
        1
    );
    assert_eq!(
        found(&mut session, json!({"kind": "note", "within": "@4"})),
        1
    );
}

#[test]
fn one_set_keeps_the_one_set_form() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is due");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "pay rent"}),
    );
    let focus = line(&session.user("that one"), "focus").expect("a focus line");
    assert!(
        focus.starts_with("focus: @1: #") && !focus.contains(" · @"),
        "{focus}"
    );
}

#[test]
fn twelve_rows_in_all_and_the_set_that_does_not_fit_is_cut() {
    let mut world = fixture();
    let tasks = world["tasks"].as_array_mut().expect("tasks");
    for n in 0..9 {
        tasks.push(json!({"key": format!("a{n}"), "name": format!("Alpha {n}")}));
        tasks.push(json!({"key": format!("b{n}"), "name": format!("Beta {n}")}));
    }
    let world = seeded_with(&world);
    let mut session = world.session();
    session.user("the alphas");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "alpha"}),
    );
    session.user("the betas");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "beta"}),
    );
    let focus = line(&session.user("which"), "focus").expect("a focus line");
    // newest first: nine betas, then the three alphas that still fit under `earlier:`
    assert!(focus.starts_with("focus: @2: #"), "{focus}");
    assert!(focus.contains(" · earlier: @1: #"), "{focus}");
    assert_eq!(focus.matches("task \"Beta").count(), 9, "{focus}");
    assert_eq!(focus.matches("task \"Alpha").count(), 3, "{focus}");
    assert!(focus.ends_with(" +6 more"), "{focus}");
    // the whole of the older set is still one call away
    assert_eq!(
        found(&mut session, json!({"kind": "task", "within": "@1"})),
        9
    );
}

// ---------------------------------------------------------------------------
// P1.1b the rows a write acted on: `acted`
//
// A row a write reached by a selector, or off the `vault:` line, came from no
// result set, so without this part nothing is in focus after the write.
// ---------------------------------------------------------------------------

#[test]
fn a_row_a_write_reached_by_a_selector_is_named_in_the_next_turns_focus_line() {
    let world = seeded();
    let mut session = world.session();
    // nothing written yet, nothing shown: no focus line
    assert_eq!(line(&session.user("pay the rent"), "focus"), None);
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Pay rent"}),
    );
    let rent = written(&done, 0);
    // the line is the one the turn began with: this turn's own write is the next turn's
    assert_eq!(centraid_nativetools::prompt::focus_line(&session), None);
    let next = session.user("hm");
    assert_eq!(
        line(&next, "focus"),
        Some(format!("focus: acted #{rent} task \"Pay rent\""))
    );
    assert_eq!(
        next["block"],
        json!(format!("focus: acted #{rent} task \"Pay rent\""))
    );
    // the model can point at it by its place in the line
    let compiled =
        session.compile(&json!({"intent": "write", "verb": "reopen", "pick": [{"focus": 0}]}));
    assert!(compiled.get("refused").is_none(), "{compiled}");
    assert_eq!(
        compiled["resolved"]["picks"][0]["handle"],
        json!(format!("#{rent}")),
        "{compiled}"
    );
}

#[test]
fn a_row_picked_off_the_vault_line_is_named_in_the_next_turns_focus_line() {
    let world = seeded();
    let mut session = world.session();
    let vault = line(&session.user("pay the rent"), "preground").expect("a vault line");
    assert_eq!(vault, "vault: #9 task \"Pay rent\"");
    call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "#9"}),
    );
    assert_eq!(
        line(&session.user("hm"), "focus"),
        Some("focus: acted #9 task \"Pay rent\"".to_owned())
    );
}

#[test]
fn a_row_a_write_took_from_a_shown_set_is_named_once_in_the_set() {
    let world = seeded();
    let mut session = world.session();
    session.user("the rent");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "pay rent"}),
    );
    let rent = ns(&found)[0];
    let done = text(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": format!("#{rent}")}),
    );
    assert!(done.starts_with("completed: #"), "{done}");
    // the set names the row the write took from it, and `acted` has nothing left to say
    assert_eq!(
        line(&session.user("hm"), "focus"),
        Some(format!("focus: @1: #{rent} task \"Pay rent\""))
    );
    // one write takes a row the set names (the rent) and one only the `vault:` line does (the
    // cabin): only the second is `acted`
    let world = seeded();
    let mut session = world.session();
    let vault = line(&session.user("the rent and the cabin"), "preground").expect("a vault line");
    assert_eq!(
        vault,
        "vault: #9 task \"Book the cabin\" · #10 task \"Pay rent\""
    );
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "pay rent"}),
    );
    assert_eq!(ns(&found), vec![10], "{found}");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "#10, #9"}),
    );
    assert!(done.starts_with("completed: #10 "), "{done}");
    assert_eq!(
        line(&session.user("hm"), "focus"),
        Some("focus: @1: #10 task \"Pay rent\" · acted #9 task \"Book the cabin\"".to_owned())
    );
}

#[test]
fn the_acted_part_follows_created_and_the_sets_and_comes_before_asked() {
    let world = seeded();
    let mut session = world.session();
    // turn 1: a set, and a write by name (a write ends its turn)
    session.user("the rent and the cabin");
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "pay rent"}),
    );
    let rent = ns(&found)[0];
    let by_name = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Book the cabin"}),
    );
    let cabin = written(&by_name, 0);
    // turn 2: a create
    session.user("and a honeymoon list");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "list", "args": "name: Honeymoon"}),
    );
    let list = written(&created, 0);
    // turn 3: an ask
    session.user("which one is it");
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which one?", "options": format!("#{rent}, #{cabin}")}),
    );
    assert_eq!(asked["ends_turn"], true, "{asked}");
    let focus = line(&session.user("the first"), "focus").expect("a focus line");
    // the created list is `created`'s and not `acted`'s; the cabin is the only acted row
    let head = format!(
        "focus: created #{list} list \"Honeymoon\" · @1: #{rent} task \"Pay rent\" · acted #{cabin} task \"Book the cabin\" · asked: #{rent} task \"Pay rent\""
    );
    assert!(focus.starts_with(&head), "{focus}");
}

#[test]
fn an_already_so_answer_names_its_row() {
    let world = seeded();
    let mut session = world.session();
    // the fixture's "Write report" is completed already; no set, only the `vault:` line, has it
    let vault = line(&session.user("the write report task"), "preground").expect("a vault line");
    assert!(
        vault.starts_with("vault: #9 task \"Write report\""),
        "{vault}"
    );
    let already = text(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": "#9"}),
    );
    assert!(
        already.starts_with("already: #9 task \"Write report\" is completed"),
        "{already}"
    );
    assert_eq!(
        line(&session.user("hm"), "focus"),
        Some("focus: acted #9 task \"Write report\"".to_owned())
    );
}

#[test]
fn an_undo_names_the_rows_it_touched_for_its_own_three_turns() {
    let world = seeded();
    let mut session = world.session();
    session.user("pay the rent");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Pay rent"}),
    );
    let rent = written(&done, 0);
    session.user("undo that");
    let undone = text(&mut session, "act", json!({"verb": "undo"}));
    assert!(undone.starts_with(&format!("undone: #{rent} ")), "{undone}");
    // the write named the row until turn 4; the undo, a write of turn 2, names it until turn 5
    let named = Some(format!("focus: acted #{rent} task \"Pay rent\""));
    for turn in 3..=5 {
        assert_eq!(
            line(&session.user("hm"), "focus"),
            named,
            "turn {turn} follows the undo"
        );
    }
    assert_eq!(line(&session.user("hm"), "focus"), None);
}

#[test]
fn a_written_row_is_named_for_the_three_turns_after_the_write_and_stays_addressable() {
    let world = seeded();
    let mut session = world.session();
    session.user("pay the rent");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Pay rent"}),
    );
    let rent = written(&done, 0);
    let named = Some(format!("focus: acted #{rent} task \"Pay rent\""));
    for turn in 2..=4 {
        assert_eq!(line(&session.user("hm"), "focus"), named, "turn {turn}");
    }
    // the fifth turn's line has let go of it (it outranked nothing: no set, no `created`)...
    assert_eq!(line(&session.user("hm"), "focus"), None);
    // ... but the row is still addressable by its number
    let reply = call(&mut session, "answer", json!({"rows": format!("#{rent}")}));
    assert!(
        reply["text"]
            .as_str()
            .unwrap_or_default()
            .contains("Pay rent"),
        "{reply}"
    );
}

#[test]
fn a_row_touched_again_keeps_the_place_of_its_first_touch() {
    let world = seeded();
    let mut session = world.session();
    let vault =
        line(&session.user("delete the rent and the cabin"), "preground").expect("a vault line");
    assert_eq!(
        vault,
        "vault: #9 task \"Book the cabin\" · #10 task \"Pay rent\""
    );
    // one write, its rows in the order the call names them
    let done = text(
        &mut session,
        "act",
        json!({"verb": "delete", "rows": "#10, #9"}),
    );
    assert!(done.starts_with("deleted: #10 "), "{done}");
    // the undo touches them in the reverse order and does not move them
    session.user("no wait, undo");
    let undone = text(&mut session, "act", json!({"verb": "undo"}));
    assert!(undone.starts_with("undone: #"), "{undone}");
    assert_eq!(
        line(&session.user("hm"), "focus"),
        Some("focus: acted #10 task \"Pay rent\", #9 task \"Book the cabin\"".to_owned())
    );
}

#[test]
fn a_session_that_wrote_nothing_has_no_acted_part_and_an_ask_option_is_not_an_acted_row() {
    let world = seeded();
    let mut session = world.session();
    // reads only: the sets, never an `acted` part
    session.user("the rent");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "pay rent"}),
    );
    let focus = line(&session.user("and"), "focus").expect("a focus line");
    assert!(
        focus.starts_with("focus: @1: #") && !focus.contains("acted"),
        "{focus}"
    );
    // a row written long ago and offered by an ask now is `asked`, not `acted`
    let mut session = world.session();
    session.user("pay the rent");
    call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Pay rent"}),
    );
    for _ in 2..=5 {
        session.user("hm");
    }
    let vault = line(&session.user("the cabin"), "preground").expect("a vault line");
    assert_eq!(vault, "vault: #10 task \"Book the cabin\"");
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which one?", "options": "#9, #10"}),
    );
    assert_eq!(asked["ends_turn"], true, "{asked}");
    let focus = line(&session.user("the first"), "focus").expect("a focus line");
    assert!(
        focus.starts_with("focus: asked: #9 task \"Pay rent\"") && !focus.contains("acted"),
        "{focus}"
    );
}

#[test]
fn a_row_the_vault_no_longer_holds_is_not_named_but_one_in_the_trash_is() {
    let world = seeded();
    let mut session = world.session();
    session.user("delete the summer album");
    let gone = text(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "album", "name": "Summer"}),
    );
    assert!(gone.ends_with("(gone)"), "{gone}");
    assert_eq!(line(&session.user("hm"), "focus"), None);
    // a task in the trash is a row "restore it" still needs
    let mut session = world.session();
    session.user("delete the rent");
    let trashed = text(
        &mut session,
        "act",
        json!({"verb": "delete", "kind": "task", "name": "Pay rent"}),
    );
    assert!(trashed.contains("moved to the trash"), "{trashed}");
    let rent = number_after(&trashed, "#");
    assert_eq!(
        line(&session.user("hm"), "focus"),
        Some(format!("focus: acted #{rent} task \"Pay rent\""))
    );
}

/// Nine alphas and nine betas for the sets, and eight gammas to write at once.
fn alphas_betas_gammas() -> World {
    let mut world = fixture();
    let tasks = world["tasks"].as_array_mut().expect("tasks");
    for n in 0..9 {
        tasks.push(json!({"key": format!("a{n}"), "name": format!("Alpha {n}")}));
        tasks.push(json!({"key": format!("b{n}"), "name": format!("Beta {n}")}));
    }
    for n in 1..=8 {
        tasks.push(json!({"key": format!("g{n}"), "name": format!("Gamma {n}")}));
    }
    seeded_with(&world)
}

#[test]
fn the_acted_part_names_the_last_six_and_sits_outside_the_twelve_row_budget_of_the_sets() {
    let world = alphas_betas_gammas();
    let mut session = world.session();
    session.user("the alphas");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "alpha"}),
    );
    session.user("the betas");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "beta"}),
    );
    session.user("complete all the gammas");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "gamma"}),
    );
    let all: Vec<u64> = diff_rows(&done)
        .iter()
        .map(|row| row["n"].as_u64().unwrap())
        .collect();
    assert_eq!(all.len(), 8, "{done}");
    let focus = line(&session.user("which"), "focus").expect("a focus line");
    let (sets, acted) = focus.split_once(" · acted ").expect("an acted part");
    // the sets keep their twelve rows: nine betas, three alphas, six more alphas counted
    assert!(sets.starts_with("focus: @2: #"), "{focus}");
    assert_eq!(sets.matches("task \"Beta").count(), 9, "{focus}");
    assert_eq!(sets.matches("task \"Alpha").count(), 3, "{focus}");
    assert!(sets.ends_with(" +6 more"), "{focus}");
    // the acted part has its own six: the last six rows the write touched, two counted
    assert_eq!(acted.matches("task \"Gamma").count(), 6, "{focus}");
    assert!(acted.ends_with(" +2 earlier"), "{focus}");
    let named = hashes(acted);
    assert_eq!(named.len(), 6, "{focus}");
    assert!(named.iter().all(|n| all.contains(n)), "{focus}");
}

#[test]
fn the_pick_counts_a_written_row_the_line_names() {
    let world = alphas_world();
    let mut session = completed_all_alphas(&world);
    let focus = line(&session.user("actually reopen alpha 8"), "focus").expect("a focus line");
    assert!(
        focus.contains("task \"Alpha 8\"") && focus.ends_with(" +2 earlier"),
        "{focus}"
    );
    // "Alpha 8" fits two rows, the one the write completed and an older namesake;
    // the one the line names is the one the conversation was just on
    let reopened = text(
        &mut session,
        "act",
        json!({"verb": "reopen", "kind": "task", "name": "Alpha 8"}),
    );
    assert!(reopened.starts_with("reopened: #"), "{reopened}");
    assert!(
        reopened.contains("it is the one this conversation was just on"),
        "{reopened}"
    );
}

#[test]
fn the_pick_counts_no_written_row_the_line_does_not_name() {
    let world = alphas_world();
    let mut session = completed_all_alphas(&world);
    let focus = line(&session.user("actually reopen alpha 1"), "focus").expect("a focus line");
    // the cap left out the first two rows the write touched, "Alpha 1" and "Alpha 2"
    assert!(
        !focus.contains("task \"Alpha 1\"") && !focus.contains("task \"Alpha 2\""),
        "{focus}"
    );
    assert!(focus.ends_with(" +2 earlier"), "{focus}");
    // the model was not shown that row, so the runtime does not take it as the one in focus
    let asked = text(
        &mut session,
        "act",
        json!({"verb": "reopen", "kind": "task", "name": "Alpha 1"}),
    );
    assert!(asked.starts_with("asked: \"Which one?\""), "{asked}");
    assert!(
        asked.contains("\"Alpha 1\" fits 2 rows and nothing was done"),
        "{asked}"
    );
}

/// Eight open alphas, each with a completed namesake.
fn alphas_world() -> World {
    let mut world = fixture();
    let tasks = world["tasks"].as_array_mut().expect("tasks");
    for n in 1..=8 {
        tasks.push(json!({"key": format!("a{n}"), "name": format!("Alpha {n}")}));
    }
    for n in 1..=8 {
        tasks.push(json!({
            "key": format!("old{n}"), "name": format!("Alpha {n}"),
            "status": "completed", "due": "2026-08-01"
        }));
    }
    seeded_with(&world)
}

/// A session where one write completed the eight open alphas, by selector.
fn completed_all_alphas(world: &World) -> Session {
    let mut session = world.session();
    session.user("complete all the alphas");
    let done = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "alpha", "where": "status = open"}),
    );
    assert_eq!(diff_rows(&done).len(), 8, "{done}");
    session
}

// ---------------------------------------------------------------------------
// P1.2 a count or value keeps its rows
// ---------------------------------------------------------------------------

fn taxes_world() -> World {
    let mut world = fixture();
    let documents = world["documents"].as_array_mut().expect("documents");
    for n in 0..9 {
        documents.push(json!({
            "key": format!("tax{n}"), "name": format!("Tax doc {n}"), "folder": "taxes",
            "created": "2026-03-02T10:00"
        }));
    }
    seeded_with(&world)
}

#[test]
fn a_count_keeps_its_rows_and_shows_as_a_set_of_its_own() {
    let world = taxes_world();
    let mut session = world.session();
    let taxes = number(&mut session, "folder", "Taxes");
    let counted = call(
        &mut session,
        "answer",
        json!({"op": "count", "kind": "document", "linked_to": taxes}),
    );
    assert_eq!(counted["effect"]["result"], "@2", "{counted}");
    let focus = line(&session.user("which of those are from 2025"), "focus").expect("a focus line");
    assert_eq!(
        focus,
        format!(
            "focus: @1: {taxes} folder \"Taxes\" · earlier: @2 (counted 10 documents in {taxes} folder \"Taxes\")"
        )
    );
    // the rows behind the count are reachable
    assert_eq!(
        found(&mut session, json!({"kind": "document", "within": "@2"})),
        10
    );
    let rest = call(
        &mut session,
        "find",
        json!({"kind": "document", "exclude": "@2"}),
    );
    assert_eq!(
        ids(&rest["effect"]["rows"]),
        vec![world.id("lease")],
        "{rest}"
    );
    // a later count over the handle is over the same rows
    let again = call(
        &mut session,
        "compute",
        json!({"op": "count", "within": "@2"}),
    );
    assert_eq!(
        again["effect"]["value"]["values"][0]["amount"], 10,
        "{again}"
    );
}

#[test]
fn a_sum_and_a_grouped_count_say_what_they_were_over_and_keep_every_row() {
    let world = seeded();
    let mut session = world.session();
    session.user("how long are my tasks");
    call(
        &mut session,
        "compute",
        json!({"op": "sum", "kind": "task", "field": "effort"}),
    );
    session.user("and by status");
    call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "group": "status"}),
    );
    let focus = line(&session.user("which of them"), "focus").expect("a focus line");
    assert_eq!(
        focus,
        "focus: earlier: @2 (counted by status completed 1; open 4 over 5 tasks), @1 (summed 50 effort over 5 tasks)"
    );
    // a value never opens with its amount or a handle colon: it cannot be read as rows
    assert!(!focus.contains("@2:") && !focus.contains("@1:"), "{focus}");
    // a grouped value keeps all its rows
    assert_eq!(
        found(&mut session, json!({"kind": "task", "within": "@2"})),
        5
    );
    assert_eq!(
        found(&mut session, json!({"kind": "task", "within": "@1"})),
        5
    );
}

#[test]
fn a_balance_keeps_the_person_and_the_group_it_was_over() {
    let world = seeded();
    let mut session = world.session();
    session.user("do i owe neha");
    let neha = number(&mut session, "person", "Neha Rao");
    let tahoe = number(&mut session, "group", "Tahoe Trip");
    let net = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "group", "name": "Tahoe Trip", "linked_to": neha}),
    );
    assert!(
        !net["text"].as_str().unwrap_or_default().contains("error"),
        "{net}"
    );
    let focus = line(&session.user("and ray"), "focus").expect("a focus line");
    let expected = format!(
        "@3 (balance -100.00 USD over {tahoe} group \"Tahoe Trip\", {neha} person \"Neha Rao\")"
    );
    assert!(focus.contains(&expected), "{focus}");
    assert!(
        focus.contains(" · earlier: ") && !focus.contains("@3:"),
        "{focus}"
    );
    // both rows are reachable through the handle
    assert_eq!(
        found(&mut session, json!({"kind": "person", "within": "@3"})),
        1
    );
    assert_eq!(
        found(&mut session, json!({"kind": "group", "within": "@3"})),
        1
    );
    let ray = call(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Ray Ochoa"}),
    );
    let focus = line(&session.user("and now"), "focus").expect("a focus line");
    assert!(
        focus.contains("@6 (balance ")
            && focus.contains(" over #")
            && focus.contains("person \"Ray Ochoa\")"),
        "{ray} {focus}"
    );
    assert_eq!(
        found(&mut session, json!({"kind": "person", "within": "@6"})),
        1
    );
}

// ---------------------------------------------------------------------------
// P1.3 containers are named
// ---------------------------------------------------------------------------

fn wedding_world() -> World {
    let mut world = fixture();
    let photos = world["photos"].as_array_mut().expect("photos");
    for n in 1..=3 {
        photos.push(json!({
            "key": format!("ws{n}"), "name": format!("Wedding shot {n}"),
            "taken": "2026-08-01T14:00", "albums": ["empty_album"]
        }));
    }
    seeded_with(&world)
}

#[test]
fn rows_that_share_a_container_name_it() {
    let world = wedding_world();
    let mut session = world.session();
    session.user("show them");
    let shots = call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "shot"}),
    );
    assert_eq!(ns(&shots).len(), 3, "{shots}");
    let focus = line(&session.user("put them in the summer one"), "focus").expect("a focus line");
    let rows: Vec<String> = ns(&shots)
        .iter()
        .enumerate()
        .map(|(i, n)| format!("#{n} photo \"Wedding shot {}\"", i + 1))
        .collect();
    let (head, tail) = focus.split_once(" · in ").expect("a container");
    assert_eq!(head, format!("focus: @1: {}", rows.join(", ")));
    let album = number_after(tail, "#");
    assert_eq!(tail, format!("#{album} album \"Wedding\""));
    // the number is one the next call can use
    assert_eq!(
        found(
            &mut session,
            json!({"kind": "photo", "linked_to": format!("#{album}")})
        ),
        3
    );
}

#[test]
fn rows_of_two_containers_name_none() {
    let world = seeded();
    let mut session = world.session();
    session.user("show them");
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
    // Book the cabin is on the Home list; Pay rent is on none
    let all = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = open"}),
    );
    assert!(ns(&all).len() > 2, "{all}");
    let focus = line(&session.user("which"), "focus").expect("a focus line");
    // the newest set has rows of the Home list and rows of none: it names no container
    let newest = focus.split(" · earlier:").next().expect("the newest set");
    assert!(
        newest.starts_with("focus: @3: #") && !newest.contains(" · in #"),
        "{focus}"
    );
}

#[test]
fn subtasks_name_their_parent_task() {
    let world = seeded();
    let mut session = world.session();
    session.user("the outline");
    call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "report outline"}),
    );
    let focus = line(&session.user("which"), "focus").expect("a focus line");
    let parent = number_after(focus.split(" · in ").nth(1).expect("a parent"), "#");
    assert!(
        focus.ends_with(&format!(" · in #{parent} task \"Write report\"")),
        "{focus}"
    );
    assert_eq!(
        found(
            &mut session,
            json!({"kind": "task", "linked_to": format!("#{parent}")})
        ),
        1
    );
}

#[test]
fn a_container_said_by_its_kind_word_is_grounded_to_the_focus_rows_container() {
    let world = wedding_world();
    let mut session = world.session();
    session.user("show them");
    call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "shot"}),
    );
    let reply = session.user("what is in that album");
    let focus = line(&reply, "focus").expect("a focus line");
    let album = number_after(focus.split(" · in ").nth(1).expect("a container"), "#");
    assert_eq!(
        line(&reply, "preground").as_deref(),
        Some(format!("vault: #{album} album \"Wedding\" (3 photos)").as_str())
    );
    assert_eq!(
        found(
            &mut session,
            json!({"kind": "photo", "linked_to": format!("#{album}")})
        ),
        3
    );
    // without the kind word, or without rows in focus, nothing is grounded
    assert_eq!(line(&session.user("what is in it"), "preground"), None);
    let mut fresh = world.session();
    assert_eq!(
        line(&fresh.user("what is in that album"), "preground"),
        None
    );
}

#[test]
fn the_list_of_the_focus_tasks_is_grounded_by_the_word_list() {
    let world = seeded();
    let mut session = world.session();
    session.user("the cabin");
    let cabin = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "book the cabin"}),
    );
    assert_eq!(ns(&cabin).len(), 1);
    let reply = session.user("move it to the list");
    let focus = line(&reply, "focus").expect("a focus line");
    let home = number_after(focus.split(" · in ").nth(1).expect("a container"), "#");
    assert_eq!(
        line(&reply, "preground").as_deref(),
        Some(format!("vault: #{home} list \"Home\" (1 task)").as_str())
    );
}

// ---------------------------------------------------------------------------
// P1.4 me
// ---------------------------------------------------------------------------

/// The `#n` of the `(you)` part of a vault line.
fn me_in(vault: &str) -> u64 {
    let part = vault
        .trim_start_matches("vault: ")
        .split(" · ")
        .find(|part| part.ends_with("(you)"))
        .expect("a (you) part");
    number_after(part, "#")
}

#[test]
fn my_balance_puts_my_own_row_last_in_the_vault_line() {
    let world = seeded();
    for message in [
        "what's my balance",
        "what do i owe",
        "where do i stand in the tahoe trip",
    ] {
        let mut session = world.session();
        let reply = session.user(message);
        let vault = line(&reply, "preground").expect("a vault line");
        // never first, always last
        assert!(
            vault.ends_with(" person \"Sam Park\" (you)"),
            "{message}: {vault}"
        );
        // the row is selectable
        let me = me_in(&vault);
        let net = call(
            &mut session,
            "compute",
            json!({"op": "balance", "kind": "group", "name": "Tahoe Trip", "linked_to": format!("#{me}")}),
        );
        let text = net["text"].as_str().unwrap_or_default();
        assert!(
            text.contains(&format!("#{me} person \"Sam Park\"")) && !text.starts_with("error"),
            "{message}: {text}"
        );
    }
    // after a group in the message, not before it
    let mut session = world.session();
    let vault = line(
        &session.user("where do i stand in the tahoe trip"),
        "preground",
    )
    .expect("a vault line");
    assert!(
        vault.starts_with("vault: #") && vault.contains(" group \"Tahoe Trip\""),
        "{vault}"
    );
}

#[test]
fn my_row_is_left_out_whenever_someone_else_is_in_play() {
    let world = seeded();
    // a pronoun, a name, a possessive name
    for message in [
        "what's my balance with him",
        "her balance with me",
        "how much does he owe me",
        "what do i owe ray",
        "ray's balance with me",
    ] {
        let mut session = world.session();
        let vault = line(&session.user(message), "preground");
        assert!(
            vault.is_none_or(|vault| !vault.contains("(you)") && !vault.contains("Sam Park")),
            "{message}"
        );
    }
    // a person in the focus line
    let mut session = world.session();
    session.user("who is ray");
    call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "ray"}),
    );
    assert_eq!(line(&session.user("what's my balance"), "preground"), None);
    // no first person, or no balance sense: no row
    let mut session = world.session();
    assert_eq!(line(&session.user("show my tasks"), "preground"), None);
}

// ---------------------------------------------------------------------------
// P1.5 ask candidates
// ---------------------------------------------------------------------------

fn dans_world() -> World {
    let mut world = fixture();
    world["people"].as_array_mut().expect("people").extend([
        json!({"key": "dan_k", "name": "Dan Kowalski", "role": "neighbor", "nickname": "Big Dan"}),
        json!({"key": "dan_o", "name": "Dan O'Brien", "role": "nurse"}),
    ]);
    world["groups"].as_array_mut().expect("groups").extend([
        json!({"key": "blockparty", "name": "Block Party", "members": ["dan_k"]}),
        json!({"key": "bookclub", "name": "Book Club", "members": ["dan_o"]}),
    ]);
    seeded_with(&world)
}

/// A session at an ask between the two Dans; the numbers it offered.
fn asked_dans(world: &World) -> (Session, u64, u64) {
    let mut session = world.session();
    session.user("call dan");
    let dans = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "dan"}),
    );
    let listed = ns(&dans);
    assert_eq!(listed.len(), 2, "{dans}");
    let (kowalski, obrien) = (listed[0], listed[1]);
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "which dan?", "options": format!("#{kowalski}, #{obrien}")}),
    );
    assert_eq!(asked["ends_turn"], true, "{asked}");
    (session, kowalski, obrien)
}

#[test]
fn ask_options_carry_what_tells_the_people_apart() {
    let world = dans_world();
    let (mut session, kowalski, obrien) = asked_dans(&world);
    let focus = line(&session.user("the neighbor"), "focus").expect("a focus line");
    assert!(
        focus.ends_with(&format!(
            " · asked: #{kowalski} person \"Dan Kowalski\" (neighbor · Big Dan · Block Party) · #{obrien} person \"Dan O'Brien\" (nurse · Book Club)"
        )),
        "{focus}"
    );
}

#[test]
fn ask_options_carry_dates_containers_types_and_usernames() {
    let world = seeded();
    let mut session = world.session();
    let wanted = [
        ("task", "Book the cabin"),
        ("event", "Dentist"),
        ("locker item", "Bank login"),
        ("document", "W2 2025"),
        ("photo", "Beach day"),
    ];
    let rows = numbers(&mut session, &wanted);
    call(
        &mut session,
        "ask",
        json!({"question": "which one?", "options": rows.join(", ")}),
    );
    let focus = line(&session.user("the second"), "focus").expect("a focus line");
    let asked = focus.split(" · asked: ").nth(1).expect("an asked part");
    assert_eq!(
        asked,
        format!(
            "{} task \"Book the cabin\" (Fri 2026-10-02 09:00 · Home) · {} event \"Dentist\" (Fri 2026-10-02 09:00) · {} locker item \"Bank login\" (login · sam) · {} document \"W2 2025\" (Taxes) · {} photo \"Beach day\" (Summer)",
            rows[0], rows[1], rows[2], rows[3], rows[4]
        )
    );
}

#[test]
fn the_words_that_fit_one_option_say_which_row() {
    let world = dans_world();
    for (message, quoted, which) in [
        ("the neighbor", "the neighbor", 0),
        ("big dan", "big dan", 0),
        ("Big Dan please", "big dan", 0),
        ("the book club one", "the book club one", 1),
        ("the nurse", "the nurse", 1),
    ] {
        let (mut session, kowalski, obrien) = asked_dans(&world);
        let reply = session.user(message);
        let n = [kowalski, obrien][which];
        let expected = format!("answer: \"{quoted}\" → #{n}");
        assert_eq!(
            line(&reply, "answer").as_deref(),
            Some(expected.as_str()),
            "{message}"
        );
        // the block carries it between the focus and the dates
        let block = line(&reply, "block").expect("a block");
        assert!(block.contains(&format!("\n{expected}")), "{block}");
        // the row resolves on the next call
        let row = call(&mut session, "answer", json!({"rows": format!("#{n}")}));
        assert!(
            row["text"].as_str().unwrap_or_default().contains("person"),
            "{row}"
        );
    }
}

#[test]
fn no_answer_line_when_the_words_fit_two_options_or_none() {
    let world = dans_world();
    for message in [
        "dan",
        "the neighbor or the nurse",
        "the plumber",
        "the first one",
        "yes",
    ] {
        let (mut session, ..) = asked_dans(&world);
        assert_eq!(line(&session.user(message), "answer"), None, "{message}");
    }
    // and none when the previous turn asked nothing
    let mut session = world.session();
    assert_eq!(line(&session.user("the neighbor"), "answer"), None);
}

// ---------------------------------------------------------------------------
// P1.6 same-name copies
// ---------------------------------------------------------------------------

/// Ten Dentist events (the fixture's, on 2026-10-02, and nine more); today is 2026-09-27.
fn dentist_world() -> World {
    let mut world = fixture();
    let events = world["events"].as_array_mut().expect("events");
    for (n, start) in [
        "2026-06-01T09:00",
        "2026-09-28T09:00",
        "2026-12-10T09:00",
        "2027-03-01T09:00",
        "2027-06-01T09:00",
        "2027-09-01T09:00",
        "2027-12-01T09:00",
        "2028-03-01T09:00",
        "2028-06-01T09:00",
    ]
    .iter()
    .enumerate()
    {
        events.push(json!({"key": format!("d{n}"), "name": "Dentist", "start": start}));
    }
    seeded_with(&world)
}

fn open_text(session: &mut Session, n: u64) -> String {
    call(session, "open", json!({"row": format!("#{n}")}))["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

#[test]
fn a_name_more_than_six_rows_share_shows_the_six_nearest_today_and_counts_the_rest() {
    let world = dentist_world();
    let mut session = world.session();
    let vault = line(&session.user("when is the dentist"), "preground").expect("a vault line");
    let parts: Vec<&str> = vault.trim_start_matches("vault: ").split(" · ").collect();
    assert_eq!(parts.len(), 7, "{vault}");
    assert!(
        parts[..6]
            .iter()
            .all(|part| part.contains("event \"Dentist\""))
    );
    assert_eq!(parts[6], "+4 more \"Dentist\"");
    // the six nearest: the 28th, 10-02, then the four next in distance; none of 2027-09 on
    let shown: String = parts[..6]
        .iter()
        .map(|part| open_text(&mut session, number_after(part, "#")))
        .collect();
    for day in [
        "2026-09-28",
        "2026-10-02",
        "2026-12-10",
        "2026-06-01",
        "2027-03-01",
        "2027-06-01",
    ] {
        assert!(shown.contains(day), "{day} in {shown}");
    }
    for day in ["2027-09-01", "2027-12-01", "2028-03-01", "2028-06-01"] {
        assert!(!shown.contains(day), "{day} in {shown}");
    }
}

#[test]
fn a_copy_the_conversation_touched_ranks_above_the_untouched_ones() {
    let world = dentist_world();
    let mut session = world.session();
    session.user("the last dentist");
    let latest = call(
        &mut session,
        "find",
        json!({"kind": "event", "name": "dentist", "order": "date desc", "limit": 1}),
    );
    let latest = ns(&latest)[0];
    let vault = line(&session.user("move the dentist"), "preground").expect("a vault line");
    let parts: Vec<&str> = vault.trim_start_matches("vault: ").split(" · ").collect();
    // the touched copy (2028, far from today) is in, with five nearest; four left out
    assert_eq!(parts.len(), 7, "{vault}");
    assert!(
        parts
            .iter()
            .any(|part| part.starts_with(&format!("#{latest} "))),
        "{vault}"
    );
    assert_eq!(parts[6], "+4 more \"Dentist\"");
}

#[test]
fn up_to_six_copies_of_a_name_are_all_shown() {
    let mut world = fixture();
    let events = world["events"].as_array_mut().expect("events");
    for n in 0..5 {
        events.push(json!({"key": format!("e{n}"), "name": "Dentist", "start": format!("2027-{:02}-01T09:00", n + 1)}));
    }
    let world = seeded_with(&world);
    let mut session = world.session();
    let vault = line(&session.user("when is the dentist"), "preground").expect("a vault line");
    assert_eq!(vault.matches("event \"Dentist\"").count(), 6, "{vault}");
    assert!(!vault.contains("more"), "{vault}");
}
