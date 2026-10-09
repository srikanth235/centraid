//! Phase 6 of #1044, slice H: three runtime rules the model never has to learn.
//!
//! - H1: a call the runtime refused and the model sent again unchanged ends the turn in the typed
//!   outcome its error family names, never the generic "which did you mean?" (`failsoft.rs`);
//! - H4: a message that takes the request back ends the turn as `decline never_mind` before any
//!   call (`phrases::is_retraction`, `Session::user`);
//! - H5: a `log` that ends the turn also answers the row (`act.rs`, `answer_logged`).

mod common;

use centraid_nativetools::Session;
use centraid_nativetools::phrases::is_retraction;
use common::{World, call, find_in_turn, ids, seeded};
use serde_json::{Value, json};

fn said(response: &Value) -> &str {
    response["text"].as_str().unwrap_or_default()
}

/// The refused call, then the same call again: the second reply.
fn sent_twice(session: &mut Session, tool: &str, args: Value) -> Value {
    let first = call(session, tool, args.clone());
    assert_eq!(
        first["ends_turn"], false,
        "the first send only refuses: {first}"
    );
    let mut again = call(session, tool, args.clone());
    // nt10 G1: the first resend after an `error:` is a hint rung; the second ends the turn
    if said(&again).starts_with("error: that is the same call again.") {
        assert_eq!(again["ends_turn"], false, "{again}");
        again = call(session, tool, args);
    }
    assert_eq!(
        again["ends_turn"], true,
        "the repeat ends the turn: {again}"
    );
    assert!(
        said(&again).starts_with("error: repeated call at step"),
        "{again}"
    );
    assert!(again["effect"].get("invalid_repeat").is_some(), "{again}");
    again
}

fn family(response: &Value) -> (String, String) {
    let marker = &response["effect"]["failsoft"];
    (
        marker["family"].as_str().unwrap_or_default().to_owned(),
        marker["action"].as_str().unwrap_or_default().to_owned(),
    )
}

fn fix(family: &str, action: &str) -> (String, String) {
    (family.to_owned(), action.to_owned())
}

/// The ids a read ended the turn with.
fn answered(response: &Value) -> Vec<String> {
    let mut out = ids(&response["effect"]["answer"]["rows"]);
    out.sort();
    out
}

fn sorted(world: &World, keys: &[&str]) -> Vec<String> {
    let mut out: Vec<String> = keys.iter().map(|key| world.id(key)).collect();
    out.sort();
    out
}

/// The turn ended as an answer of rows, with the note the runtime wrote.
fn assert_rows(world: &World, reply: &Value, keys: &[&str], note: &str) {
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert_eq!(answered(reply), sorted(world, keys), "{reply}");
    assert!(said(reply).contains(note), "{note}: {reply}");
    assert!(reply["effect"].get("error").is_none(), "{reply}");
    assert!(reply["effect"].get("diff").is_none(), "no write: {reply}");
}

fn assert_declined(reply: &Value, reason: &str) {
    assert_eq!(reply["effect"]["tool"], "decline", "{reply}");
    assert_eq!(reply["effect"]["decline"]["reason"], reason, "{reply}");
    assert!(reply["effect"].get("diff").is_none(), "no write: {reply}");
    assert!(
        said(reply).contains(&format!("declined: {reason}")),
        "{reply}"
    );
}

// ---------------------------------------------------------------------------------------------
// H1, reads

#[test]
fn rows_and_a_selector_make_the_rows_the_scope() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is open");
    call(&mut session, "find", json!({"kind": "task"}));
    let reply = sent_twice(
        &mut session,
        "answer",
        json!({"rows": "@1", "where": "status = open"}),
    );
    assert_eq!(family(&reply), fix("rows_and_selector", "rows_to_within"));
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert!(said(&reply).contains("note: rows became the scope (within=@1)"));
    let rows = answered(&reply);
    assert!(
        !rows.is_empty() && rows.contains(&world.id("cabin")),
        "{reply}"
    );
    assert!(!rows.contains(&world.id("library")), "{reply}");
}

#[test]
fn rows_numbered_one_by_one_become_a_scope_of_their_own() {
    let world = seeded();
    let mut session = world.session();
    session.user("is the cabin open");
    let cabin = find_in_turn(&mut session, "task", "cabin");
    let reply = sent_twice(
        &mut session,
        "compute",
        json!({"op": "count", "rows": cabin, "where": "status = open"}),
    );
    assert_eq!(family(&reply), fix("rows_and_selector", "rows_to_within"));
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert_eq!(
        reply["effect"]["value"]["values"][0]["amount"], 1,
        "{reply}"
    );
}

#[test]
fn a_where_clause_the_parser_refused_is_left_out() {
    let world = seeded();
    let mut session = world.session();
    session.user("the cabin task");
    let reply = sent_twice(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Book the cabin", "where": "description > 3"}),
    );
    assert_eq!(family(&reply), fix("where_clause", "drop_where_clause"));
    assert_rows(
        &world,
        &reply,
        &["cabin"],
        "note: ignored where \"description > 3\" (description is text)",
    );
}

#[test]
fn only_the_failing_clause_of_a_where_is_dropped() {
    let world = seeded();
    let mut session = world.session();
    session.user("open tasks");
    let reply = sent_twice(
        &mut session,
        "answer",
        json!({"kind": "task", "where": "status = open and colour = red"}),
    );
    assert_eq!(family(&reply), fix("where_clause", "drop_where_clause"));
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert!(
        said(&reply)
            .contains("note: ignored where \"colour = red\" (tasks have no field \"colour\")"),
        "{reply}"
    );
    // the clause that parsed still filters
    assert!(!answered(&reply).contains(&world.id("library")), "{reply}");
    assert!(answered(&reply).contains(&world.id("cabin")), "{reply}");
}

#[test]
fn a_where_clause_on_a_text_field_is_left_out() {
    let world = seeded();
    let mut session = world.session();
    session.user("ray");
    let reply = sent_twice(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Ray", "where": "role > 3"}),
    );
    assert_eq!(family(&reply), fix("where_clause", "drop_where_clause"));
    assert_rows(
        &world,
        &reply,
        &["ray"],
        "note: ignored where \"role > 3\" (role is text)",
    );
}

#[test]
fn a_where_with_nothing_selective_left_declines_not_found() {
    let world = seeded();
    let mut session = world.session();
    session.user("red tasks");
    let reply = sent_twice(
        &mut session,
        "find",
        json!({"kind": "task", "where": "colour = red"}),
    );
    assert_eq!(family(&reply), fix("where_clause", "decline:not_found"));
    assert_declined(&reply, "not_found");
}

#[test]
fn a_date_expression_the_evaluator_could_not_read_is_left_out() {
    let world = seeded();
    let mut session = world.session();
    session.user("pay rent when");
    let reply = sent_twice(
        &mut session,
        "find",
        json!({"kind": "task", "name": "Pay rent", "when": {"foo": 1}}),
    );
    assert_eq!(family(&reply), fix("date_expression", "drop_when"));
    assert_rows(
        &world,
        &reply,
        &["pay"],
        "note: ignored when {\"foo\":1} (could not read the date expression",
    );
}

#[test]
fn a_parameter_the_tool_does_not_have_is_left_out() {
    let world = seeded();
    let mut session = world.session();
    session.user("pay rent");
    let reply = sent_twice(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Pay rent", "colour": "red"}),
    );
    assert_eq!(family(&reply), fix("unknown_param", "drop_param"));
    assert_rows(
        &world,
        &reply,
        &["pay"],
        "note: ignored colour (answer has no parameter \"colour\")",
    );
    // a parameter that may have been a filter, with nothing else to select by
    session.user("tasks");
    let reply = sent_twice(
        &mut session,
        "find",
        json!({"kind": "task", "colour": "red"}),
    );
    assert_eq!(family(&reply), fix("unknown_param", "decline:not_found"));
    assert_declined(&reply, "not_found");
}

#[test]
fn a_part_of_a_compute_that_does_not_fit_is_left_out() {
    let world = seeded();
    let mut session = world.session();
    session.user("how much effort");
    let reply = sent_twice(
        &mut session,
        "compute",
        json!({"op": "sum", "kind": "task", "field": "effort", "group": "colour"}),
    );
    assert_eq!(family(&reply), fix("ignored_param", "drop_param"));
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert!(reply["effect"]["value"]["values"].is_array(), "{reply}");
    assert!(said(&reply).contains("note: ignored group (tasks have no field \"colour\")"));
}

#[test]
fn a_kind_that_is_not_one_is_any_in_a_search_and_dropped_elsewhere() {
    let world = seeded();
    let mut session = world.session();
    session.user("neha");
    let reply = sent_twice(
        &mut session,
        "search",
        json!({"text": "Neha", "kind": "spaceship"}),
    );
    assert_eq!(family(&reply), fix("no_kind", "kind_any"));
    assert_rows(
        &world,
        &reply,
        &["neha_r", "neha_k"],
        "note: ignored kind \"spaceship\"",
    );

    session.user("the tasks");
    call(&mut session, "find", json!({"kind": "task"}));
    let reply = sent_twice(
        &mut session,
        "find",
        json!({"kind": "spaceship", "within": "@2"}),
    );
    assert_eq!(family(&reply), fix("no_kind", "drop_kind"));
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert!(answered(&reply).contains(&world.id("cabin")), "{reply}");

    // nothing else to select by: the whole vault is not the answer
    session.user("spaceships");
    let reply = sent_twice(&mut session, "find", json!({"kind": "spaceship"}));
    assert_eq!(family(&reply), fix("no_kind", "decline:not_found"));
    assert_declined(&reply, "not_found");
}

#[test]
fn a_row_number_where_a_result_is_wanted_answers_the_row() {
    let world = seeded();
    let mut session = world.session();
    session.user("pay rent");
    let pay = find_in_turn(&mut session, "task", "Pay rent");
    let reply = sent_twice(&mut session, "answer", json!({"value": pay}));
    assert_eq!(family(&reply), fix("not_a_result", "answer_rows"));
    assert_rows(&world, &reply, &["pay"], "note: read value");
}

#[test]
fn a_balance_of_nobody_asks_which_person_among_the_rows_in_reach() {
    let world = seeded();
    let mut session = world.session();
    session.user("what does zed owe");
    call(&mut session, "find", json!({"kind": "person"}));
    let reply = sent_twice(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Zed"}),
    );
    assert_eq!(family(&reply), fix("balance_none", "ask_options"));
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    assert!(
        reply["effect"]["ask"]["question"]
            .as_str()
            .is_some_and(|question| question.starts_with("balance needs one person")),
        "{reply}"
    );
    let options = ids(&reply["effect"]["ask"]["options"]);
    assert!(options.contains(&world.id("ray")), "{reply}");
    assert!(
        options
            .iter()
            .all(|id| id != &world.id("tahoe") && id != &world.id("flat")),
        "only people: {reply}"
    );

    // no row in reach: nothing to offer
    let mut session = world.session();
    session.user("what does zed owe");
    let reply = sent_twice(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Zed"}),
    );
    assert_eq!(family(&reply), fix("balance_none", "decline:not_found"));
    assert_declined(&reply, "not_found");
}

#[test]
fn a_balance_of_you_uses_the_one_other_person_in_reach() {
    // the message names no one (a message that names the person is fixed on the first send, nt12
    // R1): the person is the one other in reach
    let world = seeded();
    let mut session = world.session();
    session.user("what does he owe");
    let me = find_in_turn(&mut session, "person", "Sam Park");
    find_in_turn(&mut session, "person", "Ray");
    let reply = sent_twice(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Sam Park"}),
    );
    assert_eq!(family(&reply), fix("balance_you", "use_other_person"));
    assert_eq!(reply["effect"]["tool"], "answer", "{reply}");
    assert!(reply["effect"]["value"]["values"].is_array(), "{reply}");
    assert_eq!(
        reply["effect"]["value"]["of"]["id"],
        world.id("ray"),
        "{reply}"
    );
    assert!(
        said(&reply).contains(&format!("note: balance: {me} is you; used #")),
        "{reply}"
    );
    assert!(said(&reply).contains("person \"Ray Ochoa\""), "{reply}");

    // several other people in reach: ask which, never offering the user
    session.user("what does he owe");
    find_in_turn(&mut session, "person", "Sam Park");
    call(&mut session, "find", json!({"kind": "person"}));
    let reply = sent_twice(
        &mut session,
        "answer",
        json!({"op": "balance", "kind": "person", "name": "Sam Park"}),
    );
    assert_eq!(family(&reply), fix("balance_you", "ask_options"));
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    let options = ids(&reply["effect"]["ask"]["options"]);
    assert!(options.contains(&world.id("ray")), "{reply}");
    assert!(!options.contains(&world.id("me")), "{reply}");

    // nobody else in reach: nothing to say it of
    let mut session = world.session();
    session.user("what do i owe");
    find_in_turn(&mut session, "person", "Sam Park");
    let reply = sent_twice(
        &mut session,
        "compute",
        json!({"op": "balance", "kind": "person", "name": "Sam Park"}),
    );
    assert_eq!(family(&reply), fix("balance_you", "decline:not_found"));
    assert_declined(&reply, "not_found");
}

#[test]
fn a_selector_without_a_kind_takes_the_kind_of_the_rows_in_reach() {
    let world = seeded();
    let mut session = world.session();
    // two lists of tasks in the turn: which one is `within` is no one's to pick (a single list is
    // the `within` the first send takes, nt12 R1), but the kind of the rows in reach is clear
    session.user("pay rent");
    find_in_turn(&mut session, "task", "Pay rent");
    find_in_turn(&mut session, "task", "Book the cabin");
    let reply = sent_twice(&mut session, "find", json!({"name": "Pay rent"}));
    assert_eq!(family(&reply), fix("selector_needs_kind", "set_kind"));
    assert_rows(&world, &reply, &["pay"], "note: no kind given");

    // rows of two kinds in reach: no kind to take
    let mut session = world.session();
    session.user("pay rent and ray");
    find_in_turn(&mut session, "task", "Pay rent");
    find_in_turn(&mut session, "person", "Ray");
    let reply = sent_twice(&mut session, "find", json!({"name": "Pay rent"}));
    assert_eq!(
        family(&reply),
        fix("selector_needs_kind", "decline:not_found")
    );
    assert_declined(&reply, "not_found");
}

#[test]
fn a_link_of_the_wrong_kind_is_dropped_or_answers_the_rows_the_reply_named() {
    let world = seeded();
    let mut session = world.session();
    session.user("neha ray");
    let ray = find_in_turn(&mut session, "person", "Ray");
    // another selector remains: it is the read
    let first = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha", "linked_to": ray}),
    );
    assert!(
        said(&first).starts_with("people are not linked to people."),
        "{first}"
    );
    let reply = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neha", "linked_to": ray}),
    );
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(family(&reply), fix("no_link", "drop_linked_to"));
    assert_rows(
        &world,
        &reply,
        &["neha_r", "neha_k"],
        "note: ignored linked_to",
    );

    // nothing else: the rows the reply listed
    session.user("ray again");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let reply = sent_twice_no_link(&mut session, json!({"kind": "person", "linked_to": ray}));
    assert_eq!(family(&reply), fix("no_link", "answer_named_rows"));
    assert_rows(
        &world,
        &reply,
        &["ray"],
        "note: answered the rows the reply named",
    );
}

/// A `no_link` reply is not an `error:`, but it refuses the call all the same.
fn sent_twice_no_link(session: &mut Session, args: Value) -> Value {
    let first = call(session, "find", args.clone());
    assert!(said(&first).contains("are not linked to"), "{first}");
    let again = call(session, "find", args);
    assert_eq!(again["ends_turn"], true, "{again}");
    again
}

// ---------------------------------------------------------------------------------------------
// H1, asks

#[test]
fn an_ask_with_an_option_the_runtime_does_not_know_goes_out_with_the_good_ones() {
    let world = seeded();
    let mut session = world.session();
    session.user("which neha");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let benedikt = find_in_turn(&mut session, "person", "Benedikt");
    let reply = sent_twice(
        &mut session,
        "ask",
        json!({"question": "which one?", "options": format!("{ray}, #80, {benedikt}")}),
    );
    assert_eq!(family(&reply), fix("ask_options", "drop_options"));
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    assert!(reply["effect"].get("error").is_none(), "{reply}");
    assert_eq!(
        ids(&reply["effect"]["ask"]["options"]),
        vec![world.id("ray"), world.id("benedikt")],
        "{reply}"
    );
    assert_eq!(reply["effect"]["ask"]["question"], "which one?");
    assert!(
        said(&reply).contains("note: ignored option #80 (#80 was never shown)"),
        "{reply}"
    );
    // the options are in focus for the next turn, as for any ask
    assert!(
        session.user("the first")["focus"]
            .as_str()
            .is_some_and(|focus| focus.contains("asked:"))
    );
}

#[test]
fn an_ask_with_a_bad_option_is_completed_from_the_ambiguity_candidates() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("log a call with neha");
    let ambiguous = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    assert!(said(&ambiguous).starts_with("ambiguous:"), "{ambiguous}");
    let first = ambiguous["effect"]["ambiguous"][0]["n"].as_u64().unwrap();
    // one good option and a bad one: the reply's candidates complete the ask
    let reply = sent_twice(
        &mut session,
        "ask",
        json!({"question": "which neha?", "options": format!("#{first}, #80")}),
    );
    assert_eq!(family(&reply), fix("ask_options", "complete_options"));
    assert_eq!(
        ids(&reply["effect"]["ask"]["options"]),
        vec![world.id("neha_r"), world.id("neha_k")],
        "{reply}"
    );
    assert_eq!(reply["effect"]["ask"]["completed"], true, "{reply}");

    // no option survives: the candidates are the options
    session.user("log a call with neha");
    call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Neha", "args": "kind: call"}),
    );
    let reply = sent_twice(
        &mut session,
        "ask",
        json!({"question": "which neha?", "options": "#80, #81"}),
    );
    assert_eq!(family(&reply), fix("ask_options", "ask_candidates"));
    assert_eq!(
        ids(&reply["effect"]["ask"]["options"]),
        vec![world.id("neha_r"), world.id("neha_k")],
        "{reply}"
    );
    assert!(
        said(&reply).contains("note: ignored option #80, #81"),
        "{reply}"
    );

    // no option survives and nothing was ambiguous: the question still goes out
    session.user("which one");
    let reply = sent_twice(
        &mut session,
        "ask",
        json!({"question": "which one?", "options": "#80"}),
    );
    assert_eq!(family(&reply), fix("ask_options", "drop_options"));
    assert_eq!(reply["effect"]["tool"], "ask", "{reply}");
    assert!(
        ids(&reply["effect"]["ask"]["options"]).is_empty(),
        "{reply}"
    );
}

#[test]
fn an_ask_that_is_wrong_in_another_way_still_declines() {
    let world = seeded();
    let mut session = world.session();
    session.user("which one");
    let reply = sent_twice(&mut session, "ask", json!({"options": "#1"}));
    assert_eq!(family(&reply), fix("other", "decline:not_found"));
    assert_declined(&reply, "not_found");
}

// ---------------------------------------------------------------------------------------------
// H1, writes

#[test]
fn a_reveal_of_a_field_that_is_not_secret_answers_the_row() {
    let world = seeded();
    let mut session = world.session();
    session.user("home wifi");
    let reply = sent_twice(
        &mut session,
        "act",
        json!({"verb": "reveal", "kind": "locker item", "name": "Home wifi", "args": "foo: bar"}),
    );
    assert_eq!(family(&reply), fix("reveal_field", "answer_rows"));
    assert_rows(&world, &reply, &["wifi"], "note: answered the row instead");
    assert!(reply["effect"].get("revealed").is_none(), "{reply}");
}

#[test]
fn a_write_that_matched_no_row_declines_not_found() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("complete the zzz");
    let reply = sent_twice_no_row(&mut session);
    assert_eq!(family(&reply), fix("write_no_match", "decline:not_found"));
    assert_declined(&reply, "not_found");
}

fn sent_twice_no_row(session: &mut Session) -> Value {
    let args = json!({"verb": "complete", "kind": "task", "name": "zzz"});
    let first = call(session, "act", args.clone());
    assert!(said(&first).contains("nothing was done."), "{first}");
    let again = call(session, "act", args);
    assert_eq!(again["ends_turn"], true, "{again}");
    again
}

#[test]
fn a_write_the_verb_cannot_make_declines_out_of_scope() {
    let world = seeded();
    let mut session = world.session_uncomposed();
    session.user("complete ray");
    let reply = sent_twice(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "person", "name": "Ray"}),
    );
    assert_eq!(
        family(&reply),
        fix("write_does_not_apply", "decline:out_of_scope")
    );
    assert_declined(&reply, "out_of_scope");

    session.user("put the cabin in ray");
    let ray = find_in_turn(&mut session, "person", "Ray");
    let reply = sent_twice(
        &mut session,
        "act",
        json!({"verb": "add_to", "kind": "task", "name": "Book the cabin", "args": format!("to: {ray}")}),
    );
    assert_eq!(
        family(&reply),
        fix("write_does_not_apply", "decline:out_of_scope")
    );
    assert_declined(&reply, "out_of_scope");
}

#[test]
fn any_other_refused_write_declines_not_found_and_writes_nothing() {
    let world = seeded();
    let mut session = world.session();
    session.user("remind me to call");
    // a create the command's own checks refuse: nothing is guessed, nothing is written
    let reply = sent_twice(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: Call\neffort: lots"}),
    );
    assert_eq!(family(&reply), fix("write_other", "decline:not_found"));
    assert_declined(&reply, "not_found");
    session.user("what tasks");
    let tasks = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "Call"}),
    );
    assert_eq!(answered(&tasks).len(), 0, "{tasks}");
}

#[test]
fn a_write_that_landed_this_turn_keeps_the_loop() {
    let world = seeded();
    let mut session = world.session();
    session.user("complete the cabin then something");
    let cabin = find_in_turn(&mut session, "task", "cabin");
    call(
        &mut session,
        "act",
        json!({"verb": "complete", "rows": cabin, "more": true}),
    );
    let bad = json!({"kind": "task", "colour": "red"});
    call(&mut session, "find", bad.clone());
    call(&mut session, "find", bad.clone());
    let again = call(&mut session, "find", bad);
    assert_eq!(again["effect"]["loop"], true, "{again}");
    assert!(again["effect"].get("failsoft").is_none(), "{again}");
}

// ---------------------------------------------------------------------------------------------
// H4, a retraction ends the turn

#[test]
fn a_retraction_ends_the_turn_as_never_mind_before_any_call() {
    let world = seeded();
    let mut session = world.session();
    let user = session.user("never mind");
    let ended = &user["ended"];
    assert_eq!(ended["ends_turn"], true, "{user}");
    assert_eq!(ended["text"], "declined: never_mind");
    assert_eq!(ended["effect"]["tool"], "decline");
    assert_eq!(ended["effect"]["decline"]["reason"], "never_mind");
    // the same outcome the model's own `decline never_mind` makes
    session.user("anything");
    let own = call(&mut session, "decline", json!({"reason": "never_mind"}));
    assert_eq!(own["text"], ended["text"]);
    assert_eq!(own["effect"]["decline"], ended["effect"]["decline"]);
    // a call after the turn ended is refused as such
    let mut session = world.session();
    session.user("forget it");
    let late = call(&mut session, "find", json!({"kind": "task"}));
    assert!(
        said(&late).starts_with("error: the turn has ended"),
        "{late}"
    );
    // the next message opens a new turn
    let next = session.user("what tasks are open");
    assert!(next.get("ended").is_none(), "{next}");
    let found = call(&mut session, "find", json!({"kind": "task"}));
    assert!(said(&found).starts_with("@"), "{found}");
}

#[test]
fn a_message_that_is_not_a_retraction_has_no_ended() {
    let world = seeded();
    let mut session = world.session();
    for message in [
        "",
        "what's on friday",
        "skip it, what's on friday",
        "fine, leave him",
    ] {
        let user = session.user(message);
        assert!(user.get("ended").is_none(), "{message}: {user}");
    }
}

#[test]
fn retractions_are_the_last_clause_of_the_message() {
    for message in [
        "never mind",
        "Never mind.",
        "nevermind",
        "forget it",
        "forget that",
        "forget about it",
        "kidding",
        "just kidding",
        "I'm just kidding!",
        "skip it",
        "scratch that",
        "leave it",
        "drop it",
        "don't bother",
        "dont bother",
        "no wait... forget it",
        "no wait forget it",
        "actually no, forget it",
        "actually never mind, thanks",
        "never mind thanks",
        "what's on friday? never mind",
        "oh he's already gone? fine",
        "oh he’s already gone? fine.",
        "ok forget it for now",
    ] {
        assert!(is_retraction(message), "{message}");
    }
}

#[test]
fn a_retraction_that_continues_or_a_phrase_inside_a_thought_is_not_one() {
    for message in [
        "",
        "fine",
        "yes please",
        "fine, leave him",
        "skip it, what's on friday",
        "never mind. what's on friday?",
        "never mind the dishes, add milk",
        "forget it, add milk to the list",
        "forget it and move the dentist to friday",
        "don't forget it",
        "don't forget to call mum",
        "leave it open",
        "drop it in the taxes folder",
        "skip it and do the next one",
        "never again",
        "I'm not kidding, delete it",
        "scratch that off the list",
        "what did I forget",
        "oh he's already gone? fine, move it to friday",
    ] {
        assert!(!is_retraction(message), "{message}");
    }
}

// ---------------------------------------------------------------------------------------------
// H5, a log that ends the turn answers the row

#[test]
fn a_log_that_ends_the_turn_also_answers_the_row() {
    let world = seeded();
    let mut session = world.session();
    session.user("log a call with ray");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Ray", "args": "kind: call"}),
    );
    assert_eq!(reply["ends_turn"], true, "{reply}");
    assert_eq!(reply["effect"]["tool"], "act", "{reply}");
    // the effect an `answer rows: [#n]` makes, beside the diff
    assert_eq!(answered(&reply), sorted(&world, &["ray"]), "{reply}");
    assert_eq!(reply["effect"]["answer"]["ordered"], false);
    assert!(reply["effect"]["answer"]["result"].is_string(), "{reply}");
    assert!(reply["effect"].get("diff").is_some(), "{reply}");
    // the change line, then the row's readout line as `answer` prints it
    let lines: Vec<&str> = said(&reply).lines().collect();
    assert!(lines[0].starts_with("logged"), "{reply}");
    assert!(
        lines
            .last()
            .is_some_and(|line| line.contains("[1] person \"Ray Ochoa\"")),
        "{reply}"
    );
    // the result is a handle the next turn can scope by
    let handle = reply["effect"]["answer"]["result"]
        .as_str()
        .unwrap()
        .to_owned();
    session.user("and now");
    let scoped = call(&mut session, "find", json!({"within": handle}));
    assert_eq!(
        ids(&scoped["effect"]["rows"]),
        vec![world.id("ray")],
        "{scoped}"
    );
}

#[test]
fn a_log_with_more_changes_nothing() {
    let world = seeded();
    let mut session = world.session();
    session.user("log a call with ray and tell me");
    let reply = call(
        &mut session,
        "act",
        json!({"verb": "log", "kind": "person", "name": "Ray", "args": "kind: call", "more": true}),
    );
    assert_eq!(reply["ends_turn"], false, "{reply}");
    assert!(reply["effect"].get("answer").is_none(), "{reply}");
    assert!(reply["effect"].get("diff").is_some(), "{reply}");
}
