//! THE ONE READ AND THE ONE WRITE, THROUGH THE CORE'S OWN DOOR (#1135).
//!
//! Every case drives `Handle::call` with a `LoadRequest` or an `ActRequest` over
//! the Tahoe scenario, as a shell, the chat and the harness will.
//!
//! | Case | What it proves |
//! |---|---|
//! | [`every_app_answers_a_load_by_the_name_its_manifest_declares`] | one query per app runs and answers its own typed answer with the tables it read |
//! | [`a_load_the_manifest_does_not_declare_or_the_query_does_not_take_is_refused`] | the catalogue is the manifest, and a stranger argument is refused |
//! | [`every_app_takes_an_act_and_refuses_a_bad_input_with_its_check`] | one action per app executes; one bad input per app is refused naming `input_schema` |
//! | [`the_same_invoke_key_runs_once`] | a second tap answers the first's answer and writes nothing |
//! | [`a_frozen_vault_refuses_every_write_and_names_the_check`] | `vault_moved`, whoever asks, with nothing written |
//! | [`an_executed_act_carries_the_action_that_takes_it_back`] | the inverse, and that it works |
//! | [`a_vault_refusal_carries_its_predicate`] | the failing check is the vault's own |

mod common;

use std::collections::HashMap;

use centraid_api_proto::core_v1 as wire;
use centraid_core::CoreError;
use centraid_vault::backup::ledger::{Destination, Ledger};
use common::chat::{Sample, sample};

fn text(value: &str) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Text(value.to_owned())),
    }
}

fn int(value: i64) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Integer(value)),
    }
}

fn params(pairs: &[(&str, wire::Value)]) -> HashMap<String, wire::Value> {
    pairs
        .iter()
        .map(|(name, value)| ((*name).to_owned(), value.clone()))
        .collect()
}

fn load(
    sample: &Sample,
    app: &str,
    query: &str,
    pairs: &[(&str, wire::Value)],
) -> Result<wire::LoadResponse, CoreError> {
    let answer = sample.handle.call(&wire::Request {
        kind: Some(wire::request::Kind::Load(wire::LoadRequest {
            app: app.to_owned(),
            query: query.to_owned(),
            zone: "UTC".to_owned(),
            params: params(pairs),
            ..wire::LoadRequest::default()
        })),
    })?;
    match answer.kind {
        Some(wire::response::Kind::Load(loaded)) => Ok(loaded),
        other => panic!("a load answered {other:?}"),
    }
}

fn act_with(
    sample: &Sample,
    app: &str,
    action: &str,
    key: &str,
    pairs: &[(&str, wire::Value)],
) -> Result<wire::ActResponse, CoreError> {
    let answer = sample.handle.call(&wire::Request {
        kind: Some(wire::request::Kind::Act(wire::ActRequest {
            app: app.to_owned(),
            action: action.to_owned(),
            input: params(pairs),
            invoke_key: key.to_owned(),
        })),
    })?;
    match answer.kind {
        Some(wire::response::Kind::Act(done)) => Ok(done),
        other => panic!("an act answered {other:?}"),
    }
}

fn count(sample: &Sample, sql: &str, bind: &str) -> i64 {
    sample
        .handle
        .with_vault(|vault| {
            Ok(vault.read(|connection| {
                Ok(connection.query_row(sql, [bind], |row| row.get::<_, i64>(0))?)
            })?)
        })
        .expect("a count")
}

#[test]
fn every_app_answers_a_load_by_the_name_its_manifest_declares() {
    use wire::app_query_response::Answer as A;
    let sample = sample();
    let cases: [(&str, &str, Vec<(&str, wire::Value)>); 9] = [
        ("agenda", "upcoming", vec![]),
        ("docs", "drive", vec![("shelf", text("all"))]),
        ("health", "today", vec![]),
        ("locker", "items", vec![]),
        ("money", "spending", vec![("month", text("2026-09"))]),
        ("notes", "library", vec![("sort", text("updated"))]),
        ("people", "search", vec![("term", text("a"))]),
        ("photos", "search", vec![("term", text("a"))]),
        ("tasks", "board", vec![("view", text("today"))]),
    ];
    for (app, query, pairs) in cases {
        let loaded = load(&sample, app, query, &pairs)
            .unwrap_or_else(|error| panic!("{app}.{query}: {error}"));
        let answer = loaded
            .answer
            .and_then(|answer| answer.answer)
            .unwrap_or_else(|| panic!("{app}.{query} answered nothing"));
        let arm_matches = matches!(
            (app, &answer),
            ("agenda", A::AgendaUpcoming(_))
                | ("docs", A::DocsDrive(_))
                | ("health", A::HealthToday(_))
                | ("locker", A::LockerItems(_))
                | ("money", A::MoneySpending(_))
                | ("notes", A::NotesLibrary(_))
                | ("people", A::PeopleSearch(_))
                | ("photos", A::PhotosSearch(_))
                | ("tasks", A::TasksBoard(_))
        );
        assert!(arm_matches, "{app}.{query} answered {answer:?}");
        assert!(!matches!(answer, A::Denied(_)), "{app}.{query} was denied");
        let mut sorted = loaded.tables.clone();
        sorted.sort();
        assert_eq!(loaded.tables, sorted, "tables arrive sorted");
    }
    // THE TABLES AN ANSWER WAS DRAWN FROM are the ones the door read.
    let board = load(&sample, "tasks", "board", &[]).expect("a board");
    assert!(
        board.tables.iter().any(|table| table == "task"),
        "{:?}",
        board.tables
    );
}

#[test]
fn a_load_the_manifest_does_not_declare_or_the_query_does_not_take_is_refused() {
    let sample = sample();
    let invalid = |result: Result<wire::LoadResponse, CoreError>, needle: &str| match result {
        Err(CoreError::InvalidRequest { detail }) => {
            assert!(detail.contains(needle), "{detail}");
        }
        other => panic!("expected a refusal containing {needle:?}, got {other:?}"),
    };
    invalid(load(&sample, "nothing", "board", &[]), "not an app");
    invalid(
        load(&sample, "tasks", "no-such-query", &[]),
        "declares no query",
    );
    invalid(
        load(&sample, "tasks", "board", &[("typo", int(1))]),
        "takes no `typo`",
    );
    invalid(
        load(&sample, "tasks", "board", &[("view", text("sideways"))]),
        "`view`",
    );
    invalid(
        load(&sample, "tasks", "board", &[("project_id", int(3))]),
        "`project_id` as text",
    );
}

#[test]
fn every_app_takes_an_act_and_refuses_a_bad_input_with_its_check() {
    let sample = sample();
    // (app, action, a good input, a bad input)
    let cases: [(
        &str,
        &str,
        Vec<(&str, wire::Value)>,
        Vec<(&str, wire::Value)>,
    ); 9] = [
        (
            "agenda",
            "propose",
            vec![
                ("title", text("Lunch")),
                ("starts", text("2026-10-23T12:00")),
                ("zone", text("America/New_York")),
            ],
            vec![
                ("title", text("")),
                ("starts", text("2026-10-23T12:00:00Z")),
            ],
        ),
        (
            "docs",
            "create-text",
            vec![("title", text("Plan")), ("body_text", text("words"))],
            vec![("title", text("Plan")), ("media_type", text("image/png"))],
        ),
        (
            // `days` is an array: it travels as the text of its JSON.
            "health",
            "record-days",
            vec![(
                "days",
                text(r#"[{"day":"2026-10-21","metric":"steps","value":8000}]"#),
            )],
            vec![(
                "days",
                text(r#"[{"day":"2026-10-21","metric":"mood","value":1}]"#),
            )],
        ),
        (
            "locker",
            "add-item",
            vec![("type", text("note")), ("title", text("Combination"))],
            vec![("type", text("spaceship")), ("title", text("Combination"))],
        ),
        (
            // `on_budget` is a boolean: it travels as 0 or 1.
            "money",
            "add-account",
            vec![
                ("title", text("Joint")),
                ("type", text("checking")),
                ("on_budget", int(1)),
            ],
            vec![("title", text("Joint")), ("type", text("brokerage"))],
        ),
        (
            "notes",
            "create-note",
            vec![("title", text("Idea")), ("body", text("a thought"))],
            vec![("title", text("Idea"))],
        ),
        (
            "people",
            "add-person",
            vec![("title", text("Grace Hopper"))],
            vec![("title", text(""))],
        ),
        (
            "photos",
            "create-album",
            vec![("kind", text("album")), ("title", text("Trip"))],
            vec![("kind", text("folder")), ("title", text("Trip"))],
        ),
        (
            "tasks",
            "add",
            vec![("title", text("Buy milk"))],
            vec![("title", text(""))],
        ),
    ];
    for (app, action, good, bad) in cases {
        let done = act_with(&sample, app, action, &format!("{app}-good"), &good)
            .unwrap_or_else(|error| panic!("{app}.{action}: {error}"));
        assert_eq!(
            done.status,
            wire::ActStatus::Executed as i32,
            "{app}.{action}: {done:?}"
        );
        assert!(
            !done.invocation_id.is_empty(),
            "{app}.{action} left no journal row"
        );
        // Health's `record-days` answers `written: 1` and an empty census over this scenario:
        // the vault's, reported rather than asserted here.
        assert!(
            app == "health" || !done.tables.is_empty(),
            "{app}.{action} wrote no table: {done:?}"
        );

        if app == "locker" {
            // THE CORE MINTED THE ID THE SECRET WILL BE SEALED AGAINST, and the undo names it.
            let inverse = done.inverse.as_ref().expect("an added item can be trashed");
            assert_eq!(inverse.action, "trash-item");
            assert!(inverse.input.contains_key("id"));
        }

        let refused = act_with(&sample, app, action, &format!("{app}-bad"), &bad)
            .unwrap_or_else(|error| panic!("{app}.{action}: {error}"));
        assert_eq!(
            refused.status,
            wire::ActStatus::Refused as i32,
            "{app}.{action}: {refused:?}"
        );
        let check = refused.refusal.expect("a refusal names its check");
        assert_eq!(check.check, "input_schema", "{app}.{action}: {check:?}");
        assert!(!check.detail.is_empty());
        assert!(refused.output.is_empty() && refused.tables.is_empty());
    }
    // A name the manifest does not declare is a caller's mistake, not a refusal.
    for (app, action) in [("tasks", "teleport"), ("nothing", "add")] {
        assert!(matches!(
            act_with(&sample, app, action, "k", &[]),
            Err(CoreError::InvalidRequest { .. })
        ));
    }
    assert!(matches!(
        act_with(&sample, "tasks", "add", "", &[("title", text("x"))]),
        Err(CoreError::InvalidRequest { detail }) if detail.contains("invoke_key")
    ));
}

#[test]
fn the_same_invoke_key_runs_once() {
    let sample = sample();
    let ask = |key: &str, title: &str| {
        act_with(&sample, "tasks", "add", key, &[("title", text(title))]).expect("an act")
    };
    let first = ask("tap-1", "Dedupe me");
    assert_eq!(first.status, wire::ActStatus::Executed as i32);
    assert!(!first.replayed);

    let second = ask("tap-1", "Dedupe me");
    assert!(second.replayed, "the second tap is the first's answer");
    assert_eq!(second.invocation_id, first.invocation_id);
    assert_eq!(second.output, first.output);
    assert_eq!(
        count(
            &sample,
            "SELECT count(*) FROM entity WHERE title = ?1",
            "Dedupe me"
        ),
        1,
        "the second tap wrote nothing"
    );

    // A fresh key is a fresh act; the same key for a different act is a mistake.
    ask("tap-2", "Dedupe me");
    assert_eq!(
        count(
            &sample,
            "SELECT count(*) FROM entity WHERE title = ?1",
            "Dedupe me"
        ),
        2
    );
    assert!(matches!(
        act_with(&sample, "tasks", "add", "tap-1", &[("title", text("Something else"))]),
        Err(CoreError::InvalidRequest { detail }) if detail.contains("different act")
    ));

    // A REFUSED act is not remembered: it may be asked again.
    let refused = ask("tap-3", "");
    assert_eq!(refused.status, wire::ActStatus::Refused as i32);
    let retried = ask("tap-3", "Now it has a title");
    assert_eq!(retried.status, wire::ActStatus::Executed as i32);
    assert!(!retried.replayed);
}

#[test]
fn a_frozen_vault_refuses_every_write_and_names_the_check() {
    let sample = sample();
    let landed = act_with(
        &sample,
        "tasks",
        "add",
        "before",
        &[("title", text("Before"))],
    )
    .expect("an act");
    assert_eq!(landed.status, wire::ActStatus::Executed as i32);

    // ANOTHER PHONE TOOK THE VAULT: the ledger a pass heard it in remembers it.
    let ledger = Ledger::open(Ledger::path_for(&sample.dir().join("vault.db"))).expect("ledger");
    ledger
        .put_destination(&Destination {
            gateway_id: "gateway-1".to_owned(),
            addrs: vec!["127.0.0.1:1".to_owned()],
            cert_der: vec![1],
            token: "t".to_owned(),
            epoch: 1,
            label: "home".to_owned(),
            paired_at_ms: 1,
            last_seen_ms: None,
            last_ack_ms: None,
        })
        .expect("a destination");
    ledger.set_moved("gateway-1", 2).expect("moved");

    let refused = act_with(
        &sample,
        "tasks",
        "add",
        "after",
        &[("title", text("After"))],
    )
    .expect("a refusal is an answer");
    assert_eq!(refused.status, wire::ActStatus::Refused as i32);
    let check = refused.refusal.expect("a check");
    assert_eq!(check.check, "vault_moved");
    assert!(check.detail.contains("epoch 2"), "{}", check.detail);
    assert!(refused.reason.contains("moved to another phone"));
    assert_eq!(
        count(
            &sample,
            "SELECT count(*) FROM entity WHERE title = ?1",
            "After"
        ),
        0,
        "a frozen vault writes nothing"
    );

    // A write that landed before the freeze is still its own answer.
    let replay = act_with(
        &sample,
        "tasks",
        "add",
        "before",
        &[("title", text("Before"))],
    )
    .expect("a replay");
    assert!(replay.replayed);
    assert_eq!(replay.status, wire::ActStatus::Executed as i32);

    // AND THE CHAT'S CONFIRMED CARD IS NO WAY AROUND IT.
    use centraid_assist::native::Door as _;
    let door = sample.handle.assist_door();
    let ran = door
        .run_keyed(
            "card:1",
            "task.add",
            serde_json::json!({"title": "Through the chat"}),
        )
        .expect("a refusal is an answer");
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some("vault_moved"));
    assert_eq!(
        count(
            &sample,
            "SELECT count(*) FROM entity WHERE title = ?1",
            "Through the chat"
        ),
        0
    );
}

#[test]
fn an_executed_act_carries_the_action_that_takes_it_back() {
    let sample = sample();
    let added =
        act_with(&sample, "tasks", "add", "u1", &[("title", text("Undo me"))]).expect("an act");
    let inverse = added.inverse.expect("an add can be taken back");
    assert_eq!(inverse.action, "delete");
    let Some(wire::value::Kind::Text(id)) = inverse.input.get("id").and_then(|id| id.kind.clone())
    else {
        panic!("the inverse names what was created: {inverse:?}");
    };
    assert_eq!(
        count(
            &sample,
            "SELECT count(*) FROM entity WHERE id = ?1 AND deleted_at IS NULL",
            &id
        ),
        1
    );
    let undone = act_with(
        &sample,
        "tasks",
        &inverse.action,
        "u1-undo",
        &inverse
            .input
            .iter()
            .map(|(name, value)| (name.as_str(), value.clone()))
            .collect::<Vec<_>>(),
    )
    .expect("the undo");
    assert_eq!(
        undone.status,
        wire::ActStatus::Executed as i32,
        "{undone:?}"
    );
    assert_eq!(
        count(
            &sample,
            "SELECT count(*) FROM entity WHERE id = ?1 AND deleted_at IS NULL",
            &id
        ),
        0,
        "the task is in the trash"
    );
    // AND THE UNDO HAS ITS OWN: restoring is deleting's inverse.
    assert_eq!(undone.inverse.expect("restorable").action, "restore");

    // A purge, an edit with no prior state, and a read have none.
    let edited = act_with(
        &sample,
        "tasks",
        "edit",
        "u2",
        &[("id", text(&id)), ("title", text("Renamed"))],
    )
    .expect("an edit");
    assert!(edited.inverse.is_none());
}

#[test]
fn a_vault_refusal_carries_its_predicate() {
    let sample = sample();
    // Completing a task that is not there is the vault's refusal, not the schema's.
    let refused = act_with(
        &sample,
        "tasks",
        "complete",
        "c1",
        &[("id", text("no-such-task"))],
    )
    .expect("a refusal is an answer");
    assert_eq!(
        refused.status,
        wire::ActStatus::Refused as i32,
        "{refused:?}"
    );
    let check = refused.refusal.expect("a check");
    assert_ne!(check.check, "input_schema", "{check:?}");
    assert!(!check.check.is_empty());
    assert!(!refused.reason.is_empty());
}
