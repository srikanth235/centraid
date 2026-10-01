//! The read tools, the selector (SPEC §4.1), values (§4.3) and the turn
//! rules (§6.3): recovery observations, the repeated call and the step cap.

mod common;

use common::{call, ids, number, numbers, seeded, text};
use serde_json::{Value, json};

fn answered(response: &Value) -> Vec<String> {
    ids(&response["effect"]["answer"]["rows"])
}

#[test]
fn a_multi_kind_selector_answers_in_one_step() {
    let world = seeded();
    let mut session = world.session();
    session.user("what have I got with Benedikt?");
    let response = call(
        &mut session,
        "answer",
        json!({"kind": "task,event", "name": "Benedikt"}),
    );
    assert_eq!(response["ends_turn"], true);
    let mut got = answered(&response);
    got.sort();
    let mut want = vec![world.id("tabla"), world.id("reed")];
    want.sort();
    assert_eq!(got, want);
}

#[test]
fn multi_kind_selectors_refuse_per_kind_parameters() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    for param in [
        json!({"where": "status = open"}),
        json!({"order": "date asc"}),
    ] {
        let mut args = json!({"kind": "task,event"});
        for (key, value) in param.as_object().unwrap() {
            args[key] = value.clone();
        }
        let refused = text(&mut session, "find", args);
        assert!(refused.contains("needs exactly one kind"), "{refused}");
        assert!(refused.contains("name, when, linked_to, within, exclude, limit, trashed"));
    }
    let any = text(&mut session, "find", json!({"kind": "any"}));
    assert_eq!(
        any,
        "error: kind=any is only for search; name one kind or a comma list."
    );
}

#[test]
fn name_is_whole_words_in_any_order() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let both = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "neha"}),
    );
    assert_eq!(ids(&both["effect"]["rows"]).len(), 2);
    let one = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Rao Neha"}),
    );
    assert_eq!(ids(&one["effect"]["rows"]), vec![world.id("neha_r")]);
    let partial = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "Neh"}),
    );
    assert!(
        ids(&partial["effect"]["rows"]).is_empty(),
        "a prefix is search's, not name's"
    );
}

#[test]
fn when_filters_the_kinds_date_and_echoes_the_range() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let next_week = call(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"unit": "week", "rel": 1}}),
    );
    let text = next_week["text"].as_str().unwrap();
    assert!(text.contains("when: 2026-09-28..2026-10-04"), "{text}");
    let mut got = ids(&next_week["effect"]["rows"]);
    got.sort();
    let mut want = vec![world.id("cabin"), world.id("pay")];
    want.sort();
    assert_eq!(got, want);
    let undated = text_of(
        &mut session,
        json!({"kind": "group", "when": {"unit": "day", "rel": 0}}),
    );
    assert!(
        undated.starts_with("error: groups have no date"),
        "{undated}"
    );
    let anchored = text_of(
        &mut session,
        json!({"kind": "task", "when": {"unit": "hour", "rel": -1, "anchor": "row"}}),
    );
    assert!(
        anchored.contains("anchor row is legal only inside act"),
        "{anchored}"
    );
}

fn text_of(session: &mut centraid_nativetools::Session, args: Value) -> String {
    text(session, "find", args)
}

#[test]
fn where_order_limit_within_and_exclude() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let open = call(
        &mut session,
        "find",
        json!({"kind": "task", "where": "status = open and effort >= 20", "order": "effort desc"}),
    );
    assert_eq!(
        ids(&open["effect"]["rows"]),
        vec![world.id("cabin"), world.id("reed")]
    );
    let result = open["effect"]["result"].as_str().unwrap().to_owned();
    let first = call(
        &mut session,
        "find",
        json!({"within": result, "where": "effort > 25"}),
    );
    assert_eq!(ids(&first["effect"]["rows"]), vec![world.id("cabin")]);
    let cabin = format!("#{}", first["effect"]["rows"][0]["n"]);
    let rest = call(
        &mut session,
        "find",
        json!({"within": result, "exclude": cabin}),
    );
    assert_eq!(ids(&rest["effect"]["rows"]), vec![world.id("reed")]);
    let one = call(
        &mut session,
        "find",
        json!({"kind": "task", "order": "date asc", "limit": 1}),
    );
    assert_eq!(ids(&one["effect"]["rows"]), vec![world.id("report")]);
    let linked = call(
        &mut session,
        "find",
        json!({"kind": "person", "where": "photo count >= 1"}),
    );
    assert_eq!(ids(&linked["effect"]["rows"]), vec![world.id("neha_r")]);
}

#[test]
fn linked_to_reads_the_metadata_links() {
    let world = seeded();
    let mut session = world.session();
    let found = numbers(
        &mut session,
        &[
            ("group", "Tahoe"),
            ("task", "Write report"),
            ("person", "Neha Rao"),
        ],
    );
    let members = call(
        &mut session,
        "find",
        json!({"kind": "person", "linked_to": found[0]}),
    );
    let mut got = ids(&members["effect"]["rows"]);
    got.sort();
    let founded = centraid_nativetools::world::World::load(
        &centraid_nativetools::vaultio::Handle::open(
            world.path(),
            centraid_nativetools::vaultio::SetClock::at(0),
            "probe",
        )
        .unwrap(),
    )
    .unwrap();
    let mut want = vec![world.id("neha_r"), world.id("ray"), founded.me.clone()];
    want.sort();
    assert_eq!(
        got, want,
        "members are people linked to the group, me included"
    );
    let subtasks = call(
        &mut session,
        "find",
        json!({"kind": "task", "linked_to": found[1]}),
    );
    assert_eq!(ids(&subtasks["effect"]["rows"]), vec![world.id("outline")]);
    let photos = call(
        &mut session,
        "find",
        json!({"kind": "photo", "linked_to": found[2]}),
    );
    assert_eq!(ids(&photos["effect"]["rows"]), vec![world.id("beach")]);
}

#[test]
fn trashed_true_searches_only_the_trash() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let bin = call(
        &mut session,
        "find",
        json!({"kind": "task", "trashed": true}),
    );
    assert_eq!(ids(&bin["effect"]["rows"]), vec![world.id("library")]);
    let people = call(
        &mut session,
        "find",
        json!({"kind": "person", "trashed": "true"}),
    );
    assert_eq!(ids(&people["effect"]["rows"]), vec![world.id("old")]);
}

#[test]
fn search_is_fuzzy_ranked_and_carries_links() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let response = call(&mut session, "search", json!({"text": "benedict"}));
    let rows = ids(&response["effect"]["rows"]);
    assert_eq!(rows[0], world.id("benedikt"), "{}", response["text"]);
    let text = response["text"].as_str().unwrap();
    assert!(text.contains("links: "), "{text}");
    let notes = call(
        &mut session,
        "search",
        json!({"text": "cumin", "kind": "note"}),
    );
    assert_eq!(
        ids(&notes["effect"]["rows"]),
        vec![world.id("dal")],
        "the FTS door reads bodies"
    );
    let nothing = call(&mut session, "search", json!({"text": "zeppelin"}));
    assert!(
        nothing["text"]
            .as_str()
            .unwrap()
            .starts_with("0 rows match \"zeppelin\"")
    );
}

#[test]
fn open_shows_every_fact_and_its_links_with_counts() {
    let world = seeded();
    let mut session = world.session();
    let neha = number(&mut session, "person", "Neha Rao");
    let opened = text(&mut session, "open", json!({"row": neha}));
    assert!(opened.contains("groups (1): #"), "{opened}");
    assert!(opened.contains("photos (1): #"), "{opened}");
    assert!(opened.contains("debts (1): #"), "{opened}");
    let many = text(&mut session, "open", json!({"row": "#1, #2"}));
    assert_eq!(many, "error: open takes exactly one row, #n.");
}

#[test]
fn values_count_sum_group_and_balance() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let count = call(
        &mut session,
        "answer",
        json!({"op": "count", "kind": "task", "where": "status = open"}),
    );
    assert_eq!(count["effect"]["value"]["values"][0]["amount"], 4);
    session.user("");
    let sum = call(
        &mut session,
        "compute",
        json!({"op": "sum", "field": "amount", "kind": "debt", "where": "status = open"}),
    );
    assert_eq!(
        sum["effect"]["value"]["values"],
        json!([{"amount": 25.5, "unit": "USD"}])
    );
    let handle = sum["effect"]["result"].as_str().unwrap().to_owned();
    assert!(
        sum["text"]
            .as_str()
            .unwrap()
            .starts_with(&format!("{handle} = 25.50 USD (sum of amount over")),
        "{}",
        sum["text"]
    );
    let value = call(&mut session, "answer", json!({"value": handle}));
    assert_eq!(value["effect"]["value"]["values"][0]["amount"], 25.5);
    session.user("");
    let grouped = call(
        &mut session,
        "compute",
        json!({"op": "count", "kind": "task", "group": "status"}),
    );
    assert_eq!(
        grouped["effect"]["value"]["groups"],
        json!([{"key": "completed", "values": [{"amount": 1, "unit": null}]}, {"key": "open", "values": [{"amount": 4, "unit": null}]}])
    );
    let balance = call(
        &mut session,
        "answer",
        json!({"op": "balance", "kind": "person", "name": "Neha Rao"}),
    );
    assert_eq!(balance["effect"]["value"]["values"][0]["amount"], 125.5);
    let found = numbers(&mut session, &[("person", "Ray")]);
    let net = call(
        &mut session,
        "answer",
        json!({"op": "balance", "kind": "group", "name": "Tahoe", "linked_to": found[0]}),
    );
    // Ray paid 60, owes 100 + 30: the group owes him -70.
    assert_eq!(
        net["effect"]["value"]["values"][0]["amount"], -70.0,
        "{}",
        net["text"]
    );
    session.user("");
    let two = text(
        &mut session,
        "answer",
        json!({"op": "balance", "kind": "person", "name": "Neha"}),
    );
    assert!(
        two.starts_with("error: balance is for one person; the selection holds 2:"),
        "{two}"
    );
    let wrong = text(
        &mut session,
        "answer",
        json!({"op": "balance", "kind": "task"}),
    );
    assert!(
        wrong.contains("balance is defined for person and for group"),
        "{wrong}"
    );
    let field = text(
        &mut session,
        "answer",
        json!({"op": "sum", "field": "status", "kind": "task"}),
    );
    assert!(
        field.contains("task number fields: effort, priority"),
        "{field}"
    );
}

#[test]
fn ask_and_decline_end_the_turn() {
    let world = seeded();
    let mut session = world.session();
    let found = numbers(
        &mut session,
        &[("person", "Neha Rao"), ("person", "Neha Kulkarni")],
    );
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "Which Neha?", "options": format!("{}, {}", found[0], found[1])}),
    );
    assert_eq!(asked["ends_turn"], true);
    assert_eq!(ids(&asked["effect"]["ask"]["options"]).len(), 2);
    session.user("");
    let declined = call(&mut session, "decline", json!({"reason": "out_of_scope"}));
    assert_eq!(declined["ends_turn"], true);
    assert_eq!(declined["effect"]["decline"]["reason"], "out_of_scope");
    session.user("");
    let bad = text(&mut session, "decline", json!({"reason": "bored"}));
    assert!(
        bad.contains("out_of_scope, unbounded_destruction, sealed_egress"),
        "{bad}"
    );
}

#[test]
fn recovery_observations_name_what_exists() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let other = text(
        &mut session,
        "find",
        json!({"kind": "task", "name": "tabla"}),
    );
    assert!(
        other.starts_with("0 tasks called \"tabla\". Other kinds called \"tabla\": #"),
        "{other}"
    );
    assert!(
        other.ends_with("event \"Tabla class with Benedikt\""),
        "{other}"
    );
    let trashed = text(
        &mut session,
        "find",
        json!({"kind": "task", "name": "library"}),
    );
    assert!(
        trashed.starts_with("no live task called \"library\"; trashed: #"),
        "{trashed}"
    );
    assert!(
        trashed.ends_with("task \"Library books\" · trashed"),
        "{trashed}"
    );
    let taxes = number(&mut session, "folder", "Taxes");
    let no_link = text(
        &mut session,
        "find",
        json!({"kind": "event", "linked_to": taxes}),
    );
    assert!(
        no_link.starts_with("events are not linked to folders."),
        "{no_link}"
    );
    let mallaig = number(&mut session, "event", "Mallaig");
    let mentions = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "folder", "args": {"name": "Mallaig trip"}}),
    );
    assert_eq!(mentions["ends_turn"], true);
    session.user("");
    let place = number(&mut session, "folder", "Mallaig");
    let names = text(
        &mut session,
        "find",
        json!({"kind": "event", "linked_to": place}),
    );
    assert!(
        names.contains(&format!(
            "Events whose name mentions \"Mallaig trip\": {mallaig}"
        )),
        "{names}"
    );
    let error = text(
        &mut session,
        "find",
        json!({"kind": "task", "where": "due_on > 3"}),
    );
    assert_eq!(
        error,
        "error: tasks have no field \"due_on\". task fields: date, status, effort, priority, completed, description."
    );
}

#[test]
fn a_call_that_fails_to_parse_is_a_step_that_lists_the_tools() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let response =
        session.call_unreadable(&centraid_nativetools::parse::unreadable("no <tool_call>"));
    assert_eq!(response["step"], 1);
    assert!(
        response["text"]
            .as_str()
            .unwrap()
            .contains("tools: search, find, open, compute, act, answer, ask, decline")
    );
    let unknown = text(&mut session, "fetch", json!({}));
    assert!(unknown.starts_with("error: could not read the call; no tool \"fetch\""));
    let param = text(
        &mut session,
        "find",
        json!({"kind": "task", "sort": "date"}),
    );
    assert!(
        param.starts_with(
            "error: find has no parameter \"sort\". find parameters: kind, name, where"
        )
    );
}

#[test]
fn an_identical_call_repeated_escalates_hint_nudge_then_ends_the_turn() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let args = json!({"kind": "task", "name": "cabin"});
    let first = call(&mut session, "find", args.clone());
    let head = first["text"].as_str().unwrap().lines().next().unwrap();
    // Same call, arguments spelled in another order: still identical.
    let same = json!({"name": "cabin", "kind": "task"});
    assert_eq!(session.peek_repeat("find", &same), Some(0));
    assert_eq!(session.peek_repeat("find", &json!({"kind": "task"})), None);
    let hint = call(&mut session, "find", same.clone());
    // The reply's first line, then a full stop when it has none.
    let want = format!(
        "error: repeated call. You already made this exact call and it returned: {head}. \
         Answer from that result, or change the call."
    );
    assert_eq!(hint["text"], want);
    assert_eq!(hint["ends_turn"], false);
    assert_eq!(hint["effect"]["repeat"], 1);
    assert!(hint["effect"].get("loop").is_none());
    assert_eq!(session.peek_repeat("find", &same), Some(1));
    let nudge = call(&mut session, "find", args.clone());
    assert_eq!(nudge["text"], centraid_nativetools::session::REPEAT_NUDGE);
    assert_eq!(nudge["ends_turn"], false);
    assert_eq!(nudge["effect"]["repeat"], 2);
    let cut = call(&mut session, "find", args);
    assert_eq!(cut["text"], "error: repeated call");
    assert_eq!(cut["ends_turn"], true);
    assert_eq!(cut["effect"]["loop"], true);
}

#[test]
fn a_different_call_resets_the_repeat_count_and_a_repeat_does_not_run_again() {
    let world = seeded();
    let mut session = world.session();
    let cabin = number(&mut session, "task", "cabin");
    let write = json!({"verb": "complete", "rows": cabin, "more": true});
    let done = call(&mut session, "act", write.clone());
    assert!(done["text"].as_str().unwrap().contains("Book the cabin"));
    let again = call(&mut session, "act", write.clone());
    assert!(
        again["text"]
            .as_str()
            .unwrap()
            .starts_with("error: repeated call. You already made this exact call"),
        "the write is not run a second time: {}",
        again["text"]
    );
    assert_eq!(again["effect"]["repeat"], 1);
    assert!(again["effect"].get("diff").is_none());
    call(&mut session, "find", json!({"kind": "person"}));
    let back = call(&mut session, "act", write);
    assert!(
        back["text"].as_str().unwrap().starts_with("already: "),
        "after another call the same write is dispatched again: {}",
        back["text"]
    );
    session.user("");
    assert_eq!(
        session.peek_repeat("find", &json!({"kind": "person"})),
        None
    );
}

#[test]
fn an_unreadable_message_is_never_a_repeat() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    for _ in 0..2 {
        let response = session.call_unreadable("error: could not read the call (no <tool_call>).");
        assert_eq!(response["ends_turn"], false);
        assert!(response["effect"].get("repeat").is_none());
    }
}

#[test]
fn the_sixth_call_that_does_not_end_the_turn_hits_the_cap() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    for limit in 1..=5 {
        let response = call(
            &mut session,
            "find",
            json!({"kind": "task", "limit": limit}),
        );
        assert_eq!(response["ends_turn"], false);
    }
    let sixth = call(&mut session, "find", json!({"kind": "task", "limit": 6}));
    assert_eq!(sixth["ends_turn"], true);
    assert_eq!(sixth["effect"]["cap"], true);
    assert!(
        sixth["text"]
            .as_str()
            .unwrap()
            .ends_with("error: step cap (6) reached; the turn ends.")
    );
    let after = call(&mut session, "find", json!({"kind": "task"}));
    assert!(
        after["text"]
            .as_str()
            .unwrap()
            .starts_with("error: the turn has ended")
    );
}

#[test]
fn a_large_lookup_shows_lookup_cap_rows_and_answer_shows_row_cap() {
    let mut fixture: Value = serde_json::from_str(common::FIXTURE).unwrap();
    let tasks = fixture["tasks"].as_array_mut().unwrap();
    for index in 0..20 {
        tasks.push(json!({"key": format!("bulk{index}"), "name": format!("Bulk chore {index}")}));
    }
    let world = common::seeded_with(&fixture);
    let mut session = world.session();
    session.user("");
    let response = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "chore"}),
    );
    let text = response["text"].as_str().unwrap();
    assert!(text.starts_with("@1 · 20 tasks (showing 6)"), "{text}");
    assert_eq!(text.matches("\n#").count(), 6, "{text}");
    assert!(
        text.contains("… 14 more in @1 (narrow with name, when, where, order or limit)"),
        "{text}"
    );
    assert_eq!(
        ids(&response["effect"]["rows"]).len(),
        20,
        "the effect holds every row"
    );
    // Every one of the 20 is still reachable through the handle.
    let last = call(
        &mut session,
        "find",
        json!({"within": "@1", "order": "name desc", "limit": 1}),
    );
    assert_eq!(ids(&last["effect"]["rows"]), vec![world.id("bulk9")]);
    // A result of up to ROW_CAP rows is shown whole; `answer` keeps ROW_CAP.
    session.user("");
    let small = text_of(
        &mut session,
        json!({"kind": "task", "name": "chore", "limit": 12}),
    );
    assert!(small.starts_with("@3 · 12 tasks (showing 12)"), "{small}");
    let answer = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "chore"}),
    );
    let answer = answer["text"].as_str().unwrap();
    assert!(answer.contains("20 tasks (showing 12)"), "{answer}");
    assert!(answer.contains("… 8 more in @4"), "{answer}");
}

#[test]
fn a_row_an_already_so_observation_names_is_addressable() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let again = call(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "name": "Write report"}),
    );
    let text = again["text"].as_str().unwrap();
    assert!(text.starts_with("already: #"), "{text}");
    let n = again["effect"]["already"][0]["n"].as_u64().unwrap();
    let answer = call(&mut session, "answer", json!({"rows": format!("#{n}")}));
    assert_eq!(answer["ends_turn"], true, "{}", answer["text"]);
    assert_eq!(
        ids(&answer["effect"]["answer"]["rows"]),
        vec![world.id("report")]
    );
}

#[test]
fn preground_prepends_name_hits_and_ignores_filler() {
    let world = seeded();
    let mut session = world.session();
    let turn = session.user("what's up with neha this week?");
    let block = turn["preground"].as_str().unwrap();
    assert!(block.starts_with("vault: #"), "{block}");
    assert!(
        block.contains("person \"Neha Rao\"") && block.contains("person \"Neha Kulkarni\""),
        "{block}"
    );
    let quiet = session.user("what is due this week?");
    assert!(quiet["preground"].is_null(), "{quiet}");
    let off = world.session_with(
        common::TODAY,
        centraid_nativetools::Flags {
            directory: true,
            preground: false,
            ..Default::default()
        },
    );
    let mut off = off;
    assert!(
        off.user("neha")
            .get("preground")
            .is_some_and(Value::is_null)
    );
}
