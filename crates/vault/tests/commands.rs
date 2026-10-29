//! The gate end to end: authority, the gate order, what a refusal leaves, `ctx.touch`.
//!
//! The shared verbs' own behaviour is `shared_verbs.rs`; this is what is true
//! of every command, whichever it is.

mod common;

use centraid_vault::access::{Principal, Scope, ScopeClamp};
use centraid_vault::commands::{
    CommandCondition, CommandCtx, CommandDefinition, Idempotency, Registry,
};
use centraid_vault::{Command, CommandStatus, Vault, VaultError};

fn registry() -> Registry {
    Registry::with_system_commands().expect("the system registry builds")
}

fn owner() -> Principal {
    Principal::owner("phone")
}

fn run(
    vault: &Vault,
    registry: &Registry,
    name: &str,
    input: serde_json::Value,
) -> centraid_vault::CommandOutcome {
    vault
        .execute(registry, &owner(), &Command::new(name, input))
        .unwrap_or_else(|error| panic!("`{name}` did not run: {error}"))
}

#[test]
fn the_registry_carries_the_shared_verbs_and_lockers_and_nothing_else() {
    let registry = registry();
    let names = registry.names();
    for expected in [
        "entity.retitle",
        "entity.trash",
        "entity.restore",
        "entity.purge",
        "entity.empty_trash",
        "tag.add",
        "tag.remove",
        "flag.set",
        "flag.clear",
        "edge.add",
        "edge.remove",
        "edge.move",
        "container.create",
        "container.move",
        "blob.stage",
        "blob.collect",
        "derivative.write",
        "derivative.drop",
        "person.merge",
        "follow.contacts",
        "follow.calendar",
        "follow.files",
        "follow.health",
        "follow.statement",
        "follow.stop",
        "locker.add_item",
        "locker.mark_used",
        "note.create",
        "note.edit",
        "note.move",
        "note.restore_version",
        "event.propose",
        "event.edit",
        "event.cancel",
        "event.respond",
        "event.edit_occurrence",
        "task.add",
        "task.edit",
        "task.organize",
        "task.complete",
        "task.reopen",
        "task.cancel",
        "document.add",
        "document.create_text",
        "document.edit",
        "document.replace",
        "document.move",
        "document.restore_version",
        "photo.add",
        "photo.edit",
        "photo.set_place",
        "album.set_cover",
        "place.add",
        "place.locate",
        "account.add",
        "account.edit",
        "account.set_opening",
        "account.remember_layout",
        "txn.categorize",
        "txn.void",
        "txn.link_transfer",
        "txn.unlink_transfer",
        "budget.set",
        "budget.set_carry",
        "checkpoint.record",
        "category.add",
        "category.merge",
        "rule.add",
        "rule.edit",
        "rule.delete",
        "rule.apply",
        "measurement.record",
        "thread.save_turn",
        "thread.settle_proposal",
        "thread.clear",
        "vault.rename",
    ] {
        assert!(names.contains(&expected), "`{expected}` is not registered");
    }
    // A per-kind verb belongs to its app's lane; a lane's schema joins this list
    // when its commands land (`note` is lane 2's, `event` and `task` lane 4's, `document`, `photo`, `album` and `place` lane 5's, `account`, `txn`, `budget`, `checkpoint`, `category`, `rule` and `measurement` lane 6's, `thread` lane 7's; `vault` is the singleton's own).
    for name in &names {
        let schema = name.split('.').next().unwrap_or_default();
        assert!(
            [
                "entity",
                "tag",
                "flag",
                "edge",
                "container",
                "blob",
                "derivative",
                "person",
                "follow",
                "locker",
                "vault",
                "note",
                "event",
                "task",
                "document",
                "photo",
                "album",
                "place",
                "account",
                "txn",
                "budget",
                "checkpoint",
                "category",
                "rule",
                "measurement",
                "thread"
            ]
            .contains(&schema),
            "`{name}` is not a shared verb or Locker's"
        );
    }
    // Every schema compiles and refuses an unlisted property: the door takes
    // nothing it did not name.
    for name in &names {
        let schema = registry.get(name).expect("registered").schema();
        assert_eq!(schema["type"], "object", "{name}");
        assert_eq!(schema["additionalProperties"], false, "{name}");
    }
}

#[test]
fn a_command_executes_and_reports_the_tables_it_changed() {
    let scratch = common::Scratch::founded("executes").expect("a vault");
    let registry = registry();
    let outcome = run(
        &scratch.vault,
        &registry,
        "container.create",
        serde_json::json!({"kind": "notebook", "title": "Recipes"}),
    );
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
    // The census names the model's tables, never the action keys, the write counter or the index.
    assert!(outcome.tables.contains(&"entity".to_owned()));
    assert!(outcome.tables.contains(&"container".to_owned()));
    assert!(
        !outcome
            .tables
            .iter()
            .any(|table| table == "action_key" || table == "vault" || table.starts_with("search")),
        "{:?}",
        outcome.tables
    );
    assert!(outcome.reason.is_none() && !outcome.replayed);
}

#[test]
fn a_failed_precondition_refuses_with_a_sentence_and_writes_nothing() {
    let scratch = common::Scratch::founded("refuse").expect("a vault");
    let registry = registry();
    let outcome = run(
        &scratch.vault,
        &registry,
        "entity.retitle",
        serde_json::json!({"id": "nothing-here", "title": "X"}),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("title_is_changeable"));
    assert_eq!(
        outcome.reason.as_deref(),
        Some("there is nothing with the id `nothing-here`")
    );
    assert!(outcome.tables.is_empty(), "{:?}", outcome.tables);
}

#[test]
fn a_malformed_input_is_refused_by_the_schema() {
    let scratch = common::Scratch::founded("schema").expect("a vault");
    let registry = registry();
    let outcome = run(
        &scratch.vault,
        &registry,
        "entity.retitle",
        serde_json::json!({"id": "x", "title": 7}),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("schema"));
    assert!(outcome.tables.is_empty(), "{:?}", outcome.tables);
}

#[test]
fn an_unknown_command_is_an_error() {
    let scratch = common::Scratch::founded("unknown").expect("a vault");
    let error = scratch
        .vault
        .execute(
            &registry(),
            &owner(),
            &Command::new("txn.import", serde_json::json!({})),
        )
        .expect_err("not registered");
    assert!(matches!(error, VaultError::UnknownCommand { .. }));
}

/// A handler that errors rolls the command's writes back and leaves nothing behind.
#[test]
fn a_handler_that_errors_rolls_back_and_leaves_nothing() {
    let scratch = common::Scratch::founded("failed").expect("a vault");
    let registry = registry();
    // A 64-character hash that is not hex passes the schema and fails in the handler.
    let outcome = scratch.vault.execute(
        &registry,
        &owner(),
        &Command::new(
            "blob.stage",
            serde_json::json!({"hash": "z".repeat(64), "size": 1}),
        ),
    );
    let error = outcome.expect_err("the handler refused");
    assert!(
        matches!(error, VaultError::InvalidInput { .. }),
        "{error:?}"
    );
    assert!(error.to_string().contains("64 lowercase hex"), "{error}");
    let blobs: i64 = scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row("SELECT COUNT(*) FROM blob", [], |row| row.get(0))?)
        })
        .expect("counts");
    assert_eq!(blobs, 0);
}

#[test]
fn a_read_only_device_is_denied_before_its_input_is_looked_at() {
    let scratch = common::Scratch::founded("readonly").expect("a vault");
    let registry = registry();
    let widget = Principal::OwnerDevice {
        device_id: "widget".to_owned(),
        may_act: false,
        scope_clamp: None,
    };
    let outcome = scratch
        .vault
        .execute(
            &registry,
            &widget,
            &Command::new("container.create", serde_json::json!({"nope": 1})),
        )
        .expect("the command runs and is denied");
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert_eq!(outcome.predicate.as_deref(), Some("authority"));
    assert!(
        outcome
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("read-only"))
    );
    assert!(outcome.tables.is_empty(), "{:?}", outcome.tables);
}

#[test]
fn an_apps_declared_reach_is_a_ceiling_on_its_commands() {
    let scratch = common::Scratch::founded("clamp").expect("a vault");
    let registry = registry();
    let app = Principal::OwnerDevice {
        device_id: "notes-app".to_owned(),
        may_act: true,
        scope_clamp: Some(ScopeClamp {
            scopes: vec![Scope {
                schema: "tag".to_owned(),
                table: None,
                verb: "read+act".to_owned(),
                row_filter: Vec::new(),
                field_mask: None,
            }],
        }),
    };
    // `tag.*` is inside the reach, so the whole gate runs and the command's
    // own precondition answers.
    let inside = scratch
        .vault
        .execute(
            &registry,
            &app,
            &Command::new("tag.add", serde_json::json!({"id": "none", "label": "x"})),
        )
        .expect("runs");
    assert_eq!(inside.predicate.as_deref(), Some("entity_takes_a_tag"));
    // `container.*` is outside it.
    let outside = scratch
        .vault
        .execute(
            &registry,
            &app,
            &Command::new(
                "container.create",
                serde_json::json!({"kind": "folder", "title": "F"}),
            ),
        )
        .expect("runs");
    assert_eq!(outside.status, CommandStatus::Failed);
    assert!(
        outside
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("declared reach")),
        "{:?}",
        outside.reason
    );
}

fn touch_twice(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    ctx.touch(id)?;
    ctx.touch(id)?;
    Ok(serde_json::json!({}))
}

fn touch_nothing(ctx: &CommandCtx<'_, '_>) -> centraid_vault::Result<serde_json::Value> {
    ctx.touch("no-such-entity")?;
    Ok(serde_json::json!({}))
}

fn definition(
    name: &'static str,
    handler: fn(&CommandCtx<'_, '_>) -> centraid_vault::Result<serde_json::Value>,
) -> CommandDefinition {
    CommandDefinition::plain(
        name,
        "probe",
        r#"{"type":"object","additionalProperties":true}"#,
        Idempotency::Idempotent,
        &[] as &[CommandCondition],
        handler,
    )
}

/// `ctx.touch` stamps `updated_at` however often it is called in a commit, and puts the entity on
/// the list the index is rebuilt from.
#[test]
fn touch_stamps_the_entity_and_an_unknown_entity_is_an_error() {
    let scratch = common::Scratch::founded("touch").expect("a vault");
    let mut registry = Registry::new();
    registry
        .register(definition("probe.touch_twice", touch_twice))
        .expect("registers");
    registry
        .register(definition("probe.touch_nothing", touch_nothing))
        .expect("registers");
    let note = common::insert_note(&scratch.vault, "Holiday").expect("a note");
    let stamp = |scratch: &common::Scratch| -> String {
        scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT updated_at FROM entity WHERE id = ?1",
                    [&note],
                    |row| row.get(0),
                )?)
            })
            .expect("reads")
    };
    let born = stamp(&scratch);
    scratch.clock.advance_ms(60_000);
    run(
        &scratch.vault,
        &registry,
        "probe.touch_twice",
        serde_json::json!({"id": note}),
    );
    let touched = stamp(&scratch);
    assert_ne!(touched, born);
    assert_eq!(touched, scratch.vault.clock().now_text());
    scratch.clock.advance_ms(60_000);
    run(
        &scratch.vault,
        &registry,
        "probe.touch_twice",
        serde_json::json!({"id": note}),
    );
    assert_ne!(
        stamp(&scratch),
        touched,
        "the next commit is the next change"
    );

    let error = scratch
        .vault
        .execute(
            &registry,
            &owner(),
            &Command::new("probe.touch_nothing", serde_json::json!({})),
        )
        .expect_err("there is nothing to touch");
    assert!(error.to_string().contains("nothing to touch"), "{error}");
}

#[test]
fn a_duplicate_registration_and_a_misnamed_command_are_refused() {
    let mut registry = Registry::new();
    registry
        .register(definition("probe.touch_twice", touch_twice))
        .expect("registers");
    assert!(
        registry
            .register(definition("probe.touch_twice", touch_twice))
            .is_err()
    );
    assert!(
        registry
            .register(definition("other.touch_twice", touch_twice))
            .is_err()
    );
}
