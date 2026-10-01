//! REGRESSIONS from the eval's runtime issues
//! (`experiments/toolchat/native/eval/runtime_issues.md`): one test per fix,
//! named by the issue number there.

mod common;

use centraid_nativetools::{Flags, parse};
use common::{call, number, seeded, seeded_with, text};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(common::FIXTURE).unwrap()
}

fn diff_rows(response: &Value) -> Vec<Value> {
    response["effect"]["diff"]["rows"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

#[test]
fn issue_1_a_locker_edit_keeps_the_fields_it_was_not_given() {
    let world = seeded();
    let mut session = world.session();
    let bank = number(&mut session, "locker item", "bank");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": bank, "args": "notes: branch on 5th"}),
    );
    let rows = diff_rows(&edited);
    assert_eq!(rows.len(), 1, "{edited}");
    let fields = rows[0]["fields"].as_object().unwrap();
    assert_eq!(fields.keys().collect::<Vec<_>>(), ["notes"], "{edited}");
    session.user("");
    let open = text(&mut session, "open", json!({"row": bank}));
    assert!(open.contains("username \"sam\""), "{open}");
    assert!(open.contains("url \"https://bank.example\""), "{open}");
    let revealed = text(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": bank, "args": "field: password"}),
    );
    assert!(revealed.contains("password: s3cret"), "{revealed}");
    // A type that keeps no notes says so instead of doing nothing.
    let wifi = number(&mut session, "locker item", "wifi");
    let refused = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": wifi, "args": "notes: router in the hall"}),
    );
    assert!(
        refused.starts_with("error: a wifi item keeps no notes; notes is kept on login, note"),
        "{refused}"
    );
}

#[test]
fn issue_6_a_note_item_keeps_its_notes_sealed_and_reveals_them() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "locker item", "args": "name: Gym locker combo\ntype: note\nnotes: 12-34-56"}),
    );
    let rows = diff_rows(&created);
    assert_eq!(rows.len(), 1, "{created}");
    assert_eq!(
        rows[0]["fields"]["notes"],
        json!([null, "sealed"]),
        "{created}"
    );
    let n = format!("#{}", rows[0]["n"]);
    session.user("");
    let revealed = text(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": n, "args": "field: notes"}),
    );
    assert!(revealed.contains("notes: 12-34-56"), "{revealed}");
    // An edit re-seals the new text and the diff says the notes changed.
    session.user("");
    let edited = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": n, "args": "notes: 65-43-21"}),
    );
    assert_eq!(
        diff_rows(&edited)[0]["fields"]["notes"],
        json!(["sealed", "sealed"]),
        "{edited}"
    );
    session.user("");
    let revealed = text(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": n, "args": "field: notes"}),
    );
    assert!(revealed.contains("notes: 65-43-21"), "{revealed}");
}

#[test]
fn issue_12_settle_up_carries_the_balance_it_moved() {
    let world = seeded();
    let mut session = world.session();
    let ray = number(&mut session, "person", "ray");
    // Tahoe Trip is #2 in the directory: Ray owes 100.00 for the cabin, and
    // I owe him 30.00 of the groceries.
    let settled = call(
        &mut session,
        "act",
        json!({"verb": "settle_up", "rows": ray, "args": "group: #2"}),
    );
    let rows = diff_rows(&settled);
    let person = rows
        .iter()
        .find(|row| row["kind"] == "person")
        .unwrap_or_else(|| panic!("{settled}"));
    assert_eq!(
        person["fields"]["balance"],
        json!([{"amount": 70.0, "unit": "USD"}, {"amount": 0.0, "unit": "USD"}]),
        "{settled}"
    );
}

#[test]
fn issue_16_a_refused_create_leaves_no_row_behind() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let refused = text(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: book the flights\nlist: #99"}),
    );
    assert!(
        refused.starts_with("error: #99 was never shown"),
        "{refused}"
    );
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": "name: pack bags"}),
    );
    let rows = diff_rows(&created);
    assert_eq!(rows.len(), 1, "{created}");
    assert_eq!(rows[0]["fields"]["name"], json!([null, "pack bags"]));
    session.user("");
    let none = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "flights"}),
    );
    assert_eq!(none["effect"]["recovery"], "empty", "{none}");
}

#[test]
fn issue_17_the_no_link_hint_stays_inside_within() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "event", "args": "name: Beach day trip\ndate: {\"date\":\"2026-10-10\"}"}),
    );
    let event = format!("#{}", diff_rows(&created)[0]["n"]);
    session.user("");
    call(
        &mut session,
        "find",
        json!({"kind": "photo", "name": "hike"}),
    );
    let inside = text(
        &mut session,
        "find",
        json!({"kind": "photo", "within": "@1", "linked_to": event}),
    );
    assert!(
        inside.starts_with(
            "photos are not linked to events. No photo in @1 mentions \"Beach day trip\"."
        ),
        "{inside}"
    );
    let everywhere = text(
        &mut session,
        "find",
        json!({"kind": "photo", "linked_to": event}),
    );
    assert!(
        everywhere.contains("Photos whose name mentions \"Beach day trip\": #"),
        "{everywhere}"
    );
}

#[test]
fn issue_7_a_semicolon_inside_a_value_stays_in_the_value() {
    let world = seeded();
    let mut session = world.session();
    let cabin = number(&mut session, "task", "cabin");
    call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": "description: washer; o-ring"}),
    );
    session.user("");
    let open = text(&mut session, "open", json!({"row": cabin}));
    assert!(open.contains("description \"washer; o-ring\""), "{open}");
    // `; field:` still separates two fields on one line.
    session.user("");
    let both = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": cabin, "args": "effort: 45; priority: 3"}),
    );
    let fields = diff_rows(&both)[0]["fields"].clone();
    assert_eq!(fields["effort"], json!([30, 45]), "{both}");
    assert_eq!(fields["priority"], json!([null, 3]), "{both}");
}

#[test]
fn issue_5_a_seeded_vault_leaves_no_write_ahead_log() {
    let world = seeded();
    let mut wal = world.path().as_os_str().to_owned();
    wal.push("-wal");
    let size = std::fs::metadata(&wal).map_or(0, |meta| meta.len());
    assert!(size <= 32, "the -wal holds {size} bytes");
}

#[test]
fn issue_4_a_world_sets_the_vault_default_currency() {
    let mut world = fixture();
    world["currency"] = json!("eur");
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    let system = session.prompt()["system"].as_str().unwrap().to_owned();
    assert!(system.contains("amount (EUR)"), "{system}");
    session.user("");
    let debt = call(
        &mut session,
        "find",
        json!({"kind": "debt", "name": "concert"}),
    );
    assert!(
        debt["text"].as_str().unwrap().contains("25.50 EUR"),
        "{debt}"
    );
    let mut bad = fixture();
    bad["currency"] = json!("euro");
    let dir = tempfile::tempdir().unwrap();
    let refused = centraid_nativetools::seed::seed(&bad, &dir.path().join("v.db"));
    assert!(refused.unwrap_err().contains("three-letter ISO code"));
}

#[test]
fn issue_2_the_previous_turn_stays_whole_and_acted_rows_stay_addressable() {
    let world = seeded();
    let mut session = world.session_with(
        common::TODAY,
        Flags {
            directory: false,
            preground: false,
            ..Flags::default()
        },
    );
    session.user("make a honeymoon list");
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "list", "args": "name: Honeymoon"}),
    );
    let list = format!("#{}", diff_rows(&created)[0]["n"]);
    session.user("what tasks are there");
    call(&mut session, "find", json!({"kind": "task"}));
    // The next turn picks from the previous one: #3 was shown, never
    // referenced, and is still addressable.
    let next = session.user("open the second one");
    assert_eq!(next["compacted"], json!([]), "{next}");
    assert!(!text(&mut session, "open", json!({"row": "#3"})).starts_with("error"));
    // Two turns on, the find compacts, but the list the model created is
    // still addressable.
    session.user("put book the flights on the honeymoon list");
    let task = text(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "task", "args": format!("name: book the flights\nlist: {list}")}),
    );
    assert!(task.starts_with("created: #"), "{task}");
}

#[test]
fn issue_3_search_reads_nicknames_roles_and_the_trash() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let nickname = call(&mut session, "search", json!({"text": "NK"}));
    assert!(
        nickname["text"]
            .as_str()
            .unwrap()
            .contains("person \"Neha Kulkarni\""),
        "{nickname}"
    );
    let role = call(&mut session, "search", json!({"text": "designer"}));
    assert!(
        role["text"]
            .as_str()
            .unwrap()
            .contains("person \"Neha Rao\""),
        "{role}"
    );
    let trashed = text(&mut session, "search", json!({"text": "library books"}));
    assert!(
        trashed.contains("task \"Library books\"") && trashed.contains("trashed"),
        "{trashed}"
    );
    let none = text(&mut session, "search", json!({"text": "zeppelin"}));
    assert!(!none.contains("decline"), "{none}");
}

#[test]
fn issue_8_an_answer_that_hits_a_recovery_does_not_end_the_turn() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let empty = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "zeppelin"}),
    );
    assert_eq!(empty["effect"]["recovery"], "empty", "{empty}");
    assert_eq!(empty["ends_turn"], false);
    let trashed = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "library"}),
    );
    assert!(
        trashed["text"].as_str().unwrap().contains("trashed"),
        "{trashed}"
    );
    assert_eq!(trashed["ends_turn"], false);
    let tabla = number(&mut session, "event", "tabla");
    let unlinked = call(
        &mut session,
        "answer",
        json!({"op": "count", "kind": "photo", "linked_to": tabla}),
    );
    assert_eq!(unlinked["effect"]["recovery"], "no_link", "{unlinked}");
    assert_eq!(unlinked["ends_turn"], false);
}

#[test]
fn issue_9_a_message_with_two_calls_runs_neither() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let call_block = |verb: &str| {
        format!(
            "<tool_call>\n<function=act>\n<parameter=verb>\n{verb}\n</parameter>\n<parameter=kind>\ntask\n</parameter>\n<parameter=name>\ncabin\n</parameter>\n</function>\n</tool_call>"
        )
    };
    let message = format!("{}\n{}", call_block("complete"), call_block("delete"));
    let error = parse::parse_call(&message).unwrap_err();
    assert_eq!(error, "error: one call per message");
    let response = session.call_unreadable(&error);
    assert_eq!(response["text"], "error: one call per message");
    assert_eq!(response["step"], 1);
    assert_eq!(response["ends_turn"], false);
    let cabin = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin"}),
    );
    assert!(
        cabin["text"].as_str().unwrap().contains("status open"),
        "{cabin}"
    );
}

#[test]
fn issue_11_a_restore_past_the_window_says_so() {
    let mut world = fixture();
    world["locker"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key": "oldgym", "name": "Old gym login", "type": "login", "username": "sam", "trashed": "2026-08-01T09:00"}));
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    let gym = common::trashed_number(&mut session, "locker item", "gym");
    let refused = text(&mut session, "act", json!({"verb": "restore", "rows": gym}));
    assert!(
        refused.contains(
            "it is in the trash but past the vault's restore window, so it cannot come back"
        ),
        "{refused}"
    );
}

#[test]
fn issue_14_the_kind_card_says_which_end_of_priority_is_high() {
    let world = seeded();
    let mut session = world.session();
    let system = session.prompt()["system"].as_str().unwrap().to_owned();
    assert!(
        system.contains("priority (1 highest..9 lowest, 0 none)"),
        "{system}"
    );
}

#[test]
fn issue_15_kind_beside_rows_is_a_check_and_ask_takes_results() {
    let world = seeded();
    let mut session = world.session();
    let cabin = number(&mut session, "task", "cabin");
    let done = text(
        &mut session,
        "act",
        json!({"verb": "complete", "kind": "task", "rows": cabin}),
    );
    assert!(done.starts_with("completed: "), "{done}");
    let tabla = number(&mut session, "event", "tabla");
    let wrong = text(
        &mut session,
        "act",
        json!({"verb": "cancel", "kind": "task", "rows": tabla}),
    );
    assert!(
        wrong.ends_with("is an event, and kind says task."),
        "{wrong}"
    );
    let mixed = text(
        &mut session,
        "act",
        json!({"verb": "cancel", "kind": "event", "name": "tabla", "rows": tabla}),
    );
    assert!(
        mixed.starts_with("error: act takes rows or a selector"),
        "{mixed}"
    );
    session.user("");
    let nehas = call(
        &mut session,
        "find",
        json!({"kind": "person", "name": "neha"}),
    );
    let asked = call(
        &mut session,
        "ask",
        json!({"question": "Which Neha?", "options": nehas["effect"]["result"]}),
    );
    assert_eq!(
        asked["effect"]["ask"]["options"].as_array().unwrap().len(),
        2,
        "{asked}"
    );
}

#[test]
fn issue_18_a_span_may_leave_one_end_open() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let before = call(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"to": {"unit": "day", "rel": -1}}}),
    );
    let text_before = before["text"].as_str().unwrap();
    assert!(text_before.contains("when: ..2026-09-26"), "{text_before}");
    assert!(text_before.contains("\"Write report\""), "{text_before}");
    let since = call(
        &mut session,
        "find",
        json!({"kind": "task", "when": {"from": {"unit": "day", "rel": 0}}}),
    );
    assert_eq!(
        since["effect"]["rows"].as_array().unwrap().len(),
        3,
        "{since}"
    );
    assert!(
        since["text"]
            .as_str()
            .unwrap()
            .contains("when: 2026-09-27..")
    );
    let neither = text(&mut session, "find", json!({"kind": "task", "when": {}}));
    assert!(
        neither.starts_with("error: could not read the date expression"),
        "{neither}"
    );
    // A write needs both ends.
    let open_event = text(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "event", "args": "name: Retreat\ndate: {\"from\": {\"unit\": \"day\", \"rel\": 1}}"}),
    );
    assert!(open_event.contains("is open-ended"), "{open_event}");
}

#[test]
fn issue_19_an_empty_answer_from_conditions_alone_ends_the_turn() {
    let world = seeded();
    let mut session = world.session();
    session.user("what is due the friday after next?");
    let nothing = call(
        &mut session,
        "answer",
        json!({"kind": "task", "when": {"unit": "week", "rel": 2, "weekday": 5}}),
    );
    assert_eq!(
        nothing["text"],
        "answered: 0 tasks match (when: Fri 2026-10-09)"
    );
    assert_eq!(nothing["ends_turn"], true);
    assert_eq!(nothing["effect"]["answer"]["rows"], json!([]));
    assert!(nothing["effect"]["recovery"].is_null());
    // A name that reached nothing is still a dead end, and the turn goes on.
    session.user("is the zeppelin task done?");
    let dead_end = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "zeppelin"}),
    );
    assert_eq!(dead_end["ends_turn"], false);
    assert_eq!(dead_end["effect"]["recovery"], "empty");
}

#[test]
fn issue_22_only_a_name_that_reaches_nothing_or_a_missing_link_is_a_dead_end() {
    let world = seeded();
    let mut session = world.session();
    // A linked row with no linked rows of the kind is an answer.
    let ray = number(&mut session, "person", "ray");
    let unlinked = call(
        &mut session,
        "answer",
        json!({"kind": "task", "linked_to": ray}),
    );
    assert_eq!(unlinked["ends_turn"], true, "{unlinked}");
    assert_eq!(unlinked["effect"]["answer"]["rows"], json!([]));
    // A name that resolves, narrowed to nothing by when, is an answer.
    session.user("is the cabin due the friday after next?");
    let when = json!({"unit": "week", "rel": 2, "weekday": 5});
    let found = call(
        &mut session,
        "find",
        json!({"kind": "task", "name": "cabin", "when": when}),
    );
    assert_eq!(
        found["text"],
        "0 tasks called \"cabin\" match (when: Fri 2026-10-09)"
    );
    assert!(found["effect"]["recovery"].is_null(), "{found}");
    assert_eq!(found["ends_turn"], false);
    let answered = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "cabin", "when": when}),
    );
    assert_eq!(answered["ends_turn"], true, "{answered}");
    assert_eq!(answered["effect"]["answer"]["rows"], json!([]));
    // A name with only trashed rows is still a dead end, with or without
    // other conditions.
    session.user("");
    let trashed = call(
        &mut session,
        "answer",
        json!({"kind": "task", "name": "library", "where": "effort > 5"}),
    );
    assert_eq!(trashed["effect"]["recovery"], "empty", "{trashed}");
    assert_eq!(trashed["ends_turn"], false);
    // A missing link is the other dead end.
    let tabla = number(&mut session, "event", "tabla");
    let no_link = call(
        &mut session,
        "answer",
        json!({"kind": "photo", "linked_to": tabla}),
    );
    assert_eq!(no_link["effect"]["recovery"], "no_link");
    assert_eq!(no_link["ends_turn"], false);
}

#[test]
fn issue_23_pre_grounding_never_matches_the_verb() {
    let mut world = fixture();
    world["photos"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key": "theatre", "name": "Starlight Theatre", "taken": "2026-06-01T20:00"}));
    world["tasks"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key": "cleanup", "name": "Delete old backups"}));
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    for message in [
        "star it",
        "delete that",
        "please complete it",
        "log a call",
        "cancel it",
    ] {
        let turn = session.user(message);
        assert!(turn["preground"].is_null(), "{message}: {turn}");
    }
    // A name still pre-grounds beside a verb.
    let turn = session.user("star the starlight theatre photo");
    assert!(
        turn["preground"]
            .as_str()
            .unwrap()
            .contains("\"Starlight Theatre\""),
        "{turn}"
    );
}

#[test]
fn issue_20_every_kind_card_lists_name_and_a_rename_is_an_edit() {
    let world = seeded();
    let mut session = world.session();
    let system = session.prompt()["system"].as_str().unwrap().to_owned();
    let kinds = system
        .split("kinds:\n")
        .nth(1)
        .unwrap()
        .split("\n\n")
        .next()
        .unwrap();
    for line in kinds.lines() {
        let (_, fields) = line.split_once(": ").unwrap();
        assert!(fields.starts_with("name"), "{line}");
    }
    assert!(kinds.contains("album: name · links: photos"), "{kinds}");
    let home = number(&mut session, "list", "home");
    let renamed = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": home, "args": "name: Home & garden"}),
    );
    assert_eq!(
        diff_rows(&renamed)[0]["fields"]["name"],
        json!(["Home", "Home & garden"])
    );
}

#[test]
fn issue_21_create_takes_its_kind_from_the_kind_parameter() {
    let world = seeded();
    let mut session = world.session();
    session.user("");
    let in_args = text(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "note", "args": "kind: note\nname: Ideas list"}),
    );
    assert_eq!(
        in_args,
        "error: create takes kind as the top-level kind parameter, not inside args; args carry the fields only (name: …)."
    );
    let missing = text(
        &mut session,
        "act",
        json!({"verb": "create", "args": "name: Ideas list"}),
    );
    assert!(
        missing.starts_with("error: create needs the kind parameter set to one of "),
        "{missing}"
    );
    let selector = text(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "note", "name": "Ideas list"}),
    );
    assert!(
        selector
            .starts_with("error: create takes no name parameter; the new row's fields go in args"),
        "{selector}"
    );
    let unknown = text(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "note", "args": "name: Ideas\ncolour: red"}),
    );
    assert!(
        unknown.starts_with("error: create note args take name, "),
        "{unknown}"
    );
    let created = call(
        &mut session,
        "act",
        json!({"verb": "create", "kind": "note", "args": "name: Ideas list\nbody: kites"}),
    );
    assert_eq!(
        diff_rows(&created)[0]["fields"]["name"],
        json!([null, "Ideas list"])
    );
}

#[test]
fn issue_24_a_list_rename_keeps_its_area() {
    let mut world = fixture();
    world["lists"][0]["area"] = json!("house");
    let seeded = seeded_with(&world);
    let mut session = seeded.session();
    let home = number(&mut session, "list", "Home");
    let renamed = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": home, "args": "name: Home stuff"}),
    );
    let rows = diff_rows(&renamed);
    let fields = rows[0]["fields"].as_object().unwrap();
    assert_eq!(fields.keys().collect::<Vec<_>>(), ["name"], "{renamed}");
    session.user("");
    let moved = call(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": home, "args": "area: garden"}),
    );
    let fields = diff_rows(&moved)[0]["fields"].as_object().unwrap().clone();
    assert_eq!(fields.keys().collect::<Vec<_>>(), ["area"], "{moved}");
}

#[test]
fn issue_26_undoing_a_photo_delete_puts_it_back_in_its_album() {
    let world = seeded();
    let mut session = world.session();
    let beach = number(&mut session, "photo", "Beach day");
    let deleted = text(
        &mut session,
        "act",
        json!({"verb": "delete", "rows": beach}),
    );
    assert!(deleted.contains("no longer in"), "{deleted}");
    session.user("undo that");
    let undone = call(&mut session, "act", json!({"verb": "undo"}));
    assert!(
        undone["text"].as_str().unwrap().contains("now in"),
        "{undone}"
    );
    let links = undone["effect"]["diff"]["links"].as_array().unwrap();
    assert_eq!(links.len(), 1, "{undone}");
    assert_eq!(links[0]["change"], "added", "{undone}");
}

#[test]
fn issue_27_a_multi_row_reveal_records_every_secret() {
    let world = seeded();
    let mut session = world.session();
    let wifi = number(&mut session, "locker item", "Home wifi");
    let bank = number(&mut session, "locker item", "Bank login");
    let both = call(
        &mut session,
        "act",
        json!({"verb": "reveal", "rows": format!("{wifi}, {bank}"), "args": "field: password"}),
    );
    let revealed = both["effect"]["revealed"].as_str().unwrap();
    assert!(revealed.contains("hunter2"), "{both}");
    assert!(revealed.contains("s3cret"), "{both}");
}

#[test]
fn issue_28_an_edit_refuses_a_number_in_the_wrong_unit() {
    let world = seeded();
    let mut session = world.session();
    let task = number(&mut session, "task", "Book the cabin");
    let refused = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": task, "args": "effort: 1.5 hours"}),
    );
    assert!(
        refused.starts_with("error: effort is a number of minutes"),
        "{refused}"
    );
    let edited = text(
        &mut session,
        "act",
        json!({"verb": "edit", "rows": task, "args": "effort: 90 minutes"}),
    );
    assert!(edited.contains("90 min"), "{edited}");
}
