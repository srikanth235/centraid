//! THERE IS NO REPLAY LEDGER, AND THIS FILE IS WHAT KEEPS THE DOCS HONEST
//! (#1029 §1, R-1088-12).
//!
//! `replica_intent_outcome` answered a seat resubmitting an intent over a network
//! that could lose an answer. The phone is the vault and calls it in-process, so a
//! command that arrives twice was made twice: the core REQUIRES an `invoke_key`
//! (it pairs an answer with the write that caused it, in the shell) and the vault
//! never sees it. A write the shell may re-offer is therefore idempotent by its
//! own content, or by an id the phone minted before the first attempt:
//!
//! - the camera roll's re-walk, by `media.add_asset` adopting the asset that
//!   already wraps the same bytes (`crates/vault/tests/media_commands.rs`,
//!   `a_staged_original_offered_again_adopts_the_asset_it_made`);
//! - Docs' "Try again", by a pre-minted document id
//!   (`crates/vault/tests/docs_commands.rs`,
//!   `a_filing_offered_again_under_its_minted_id_files_once`);
//! - the chat's confirm, by the core door's own key memory
//!   (`crates/core/src/assist/door.rs`).
//!
//! # IF THIS FILE GOES RED, SOMEBODY ADDED A LEDGER
//!
//! `the_same_key_sent_twice_runs_the_command_twice` is deliberately the OPPOSITE
//! of what a ledger would do. If a later change makes the second send answer the
//! first outcome, this test flips — on purpose, in the same change as the ruling
//! that restores the ledger, the docs that say there is none (`docs/decisions.md`
//! R-1088-12, `crates/vault/src/commands/mod.rs`, `command.proto`, the shell's
//! `ScreenRuntime`) and the callers that were relying on their own idempotence.
//! It is not a test to delete to go green.

mod common;

use centraid_core::api_proto as wire;
use centraid_vault::commands::{Idempotency, Registry};
use common::chat::{Sample, sample};

/// `schedule.add_task` with no `task_id`: it mints a fresh row every run, and
/// nothing in its gate order notices a title it has already filed.
const COMMAND: &str = "schedule.add_task";

fn send(
    sample: &Sample,
    key: &str,
    title: &str,
) -> Result<wire::CommandOutcome, centraid_core::CoreError> {
    let answer = sample.handle.call(&wire::Request {
        kind: Some(wire::request::Kind::Command(wire::Command {
            name: COMMAND.to_owned(),
            input: serde_json::to_vec(&serde_json::json!({ "title": title })).expect("json"),
            invoke_key: key.to_owned(),
            ..wire::Command::default()
        })),
    })?;
    match answer.kind {
        Some(wire::response::Kind::Command(outcome)) => Ok(outcome),
        other => panic!("a command answered {other:?}"),
    }
}

/// Every `schedule_task` row with this title, through the page door a screen
/// reads by: `(task_id)`.
fn tasks_titled(sample: &Sample, title: &str) -> Vec<String> {
    let answer = sample
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(wire::PageQuery {
                    name: "replay-tasks".to_owned(),
                    select: vec![
                        "task_id".to_owned(),
                        "created_at".to_owned(),
                        "title".to_owned(),
                    ],
                    from: "schedule_task".to_owned(),
                    r#where: Some("title = ?".to_owned()),
                    bind: vec![wire::Value {
                        kind: Some(wire::value::Kind::Text(title.to_owned())),
                    }],
                    order: Some(wire::PageOrder {
                        sort_column: "created_at".to_owned(),
                        pk_column: "task_id".to_owned(),
                        descending: false,
                    }),
                    with_held_thumbnail: false,
                    with_note_body: false,
                    with_document_size: false,
                    with_minor_units: false,
                    local_day_columns: Vec::new(),
                    tz: String::new(),
                }),
                limit: 100,
                after: None,
            })),
        })
        .expect("the page reads");
    let Some(wire::response::Kind::Page(page)) = answer.kind else {
        panic!("a page comes back");
    };
    page.rows
        .iter()
        .map(|row| match &row.values[0].kind {
            Some(wire::value::Kind::Text(id)) => id.clone(),
            other => panic!("a task id is text, not {other:?}"),
        })
        .collect()
}

/// THE PIN. The command is `Once` — "must not be run twice for one intent" — and
/// the same `invoke_key` is sent twice down the core's real command path
/// (`Handle::call` → `api::invoke` → `Vault::execute`). Both sends EXECUTE: two
/// invocations, two receipts, two rows. Nothing answers the second from a
/// ledger, because there is none.
#[test]
fn the_same_key_sent_twice_runs_the_command_twice() {
    // The choice of command is part of the claim: it is a `Once` command, the
    // class the old ledger existed for, and not one that happens to be safe.
    let registry = Registry::with_system_commands().expect("the registry builds");
    assert_eq!(
        registry
            .get(COMMAND)
            .expect("the command is registered")
            .definition
            .idempotency,
        Idempotency::Once
    );

    let sample = sample();
    let title = "Replay pin: water the cabin plants";
    assert!(
        tasks_titled(&sample, title).is_empty(),
        "the title is new to the sample vault"
    );

    let first = send(&sample, "pin:1", title).expect("the first send answers");
    let second = send(&sample, "pin:1", title).expect("the second send answers");

    assert_eq!(
        first.status,
        wire::CommandStatus::Executed as i32,
        "{}",
        first.reason
    );
    assert_eq!(
        second.status,
        wire::CommandStatus::Executed as i32,
        "the second send EXECUTES; it is not answered from a ledger: {}",
        second.reason
    );
    assert_ne!(
        first.invocation_id, second.invocation_id,
        "two sends are two invocations, so the handler ran twice"
    );
    assert_ne!(
        first.receipt_id, second.receipt_id,
        "and each was receipted on its own"
    );
    assert_ne!(
        first.output, second.output,
        "and each minted its own task id"
    );
    assert_eq!(
        tasks_titled(&sample, title).len(),
        2,
        "one key, two sends, two tasks: the key is the shell's correlation key and nothing the vault remembers"
    );
}

/// The key is REQUIRED and still not remembered: an empty one is refused before
/// the vault is reached, which is what the field's contract says ("the core
/// requires it, and it never reaches the vault"). Pinned beside the test above so
/// that "required" is never read as "deduplicated".
#[test]
fn a_command_with_no_key_is_refused_before_the_vault_is_reached() {
    let sample = sample();
    let title = "Replay pin: a command with no key";
    let refused = send(&sample, "", title).expect_err("an empty invoke_key is refused");
    assert!(
        matches!(refused, centraid_core::CoreError::InvalidRequest { .. }),
        "{refused:?}"
    );
    assert!(
        tasks_titled(&sample, title).is_empty(),
        "and nothing was written"
    );
}
