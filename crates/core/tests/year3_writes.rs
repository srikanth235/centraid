//! The write paths this umbrella added, run on a year-3 vault (#1146, wave 8).
//!
//! These checks used to be `write_costs`, which also held each command to the 50 ms call ceiling.
//! That wall-clock assertion is removed (owner ruling 2026-11-04: timing checks flake on a loaded
//! machine and block unrelated changes); what is kept is that the writes are *correct* at the size
//! they were measured at:
//!
//! - **a label's trash and restore** re-index every member in the one commit (wave 5), so a list of
//!   thousands pays it in the command that trashes it;
//! - **the launch tidy** purges what is overdue in batches, each batch one short hold of the vault
//!   (wave 3), and the pass must empty everything that is overdue.
//!
//! The corpus is the one `query_plans` plans over: about 46,000 entities, 12,000 of them photographs.

mod year3_corpus;

use centraid_vault::commands::{Command, Registry};
use centraid_vault::{CommandStatus, Principal};

/// Members of the label that is trashed and restored.
const MEMBERS: usize = 5_000;
/// Overdue photographs the tidy empties.
const OVERDUE: usize = 2_000;
/// The launch tidy's batch (`TRASH_BATCH` in `crates/core/src/handle.rs`).
const BATCH: usize = 3;

fn run(handle: &centraid_core::Handle, name: &str, input: serde_json::Value) {
    let registry = Registry::with_system_commands().expect("the registry builds");
    let outcome = handle
        .with_vault(|vault| {
            Ok(vault.execute(
                &registry,
                &Principal::owner("measure"),
                &Command::new(name, input),
            )?)
        })
        .expect("it runs");
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
}

#[test]
fn trashing_and_restoring_a_label_of_five_thousand_both_execute() {
    let corpus = year3_corpus::found_rows();
    let held = corpus
        .handle
        .with_vault(|vault| {
            Ok(centraid_vault::testdoor::add_album_of_photos(
                vault,
                "album-big",
                MEMBERS,
            )?)
        })
        .expect("the album is written");
    assert_eq!(held, MEMBERS, "the corpus holds enough photographs");

    for _ in 0..3 {
        let id = serde_json::json!({ "id": "album-big" });
        run(&corpus.handle, "entity.trash", id.clone());
        run(&corpus.handle, "entity.restore", id);
    }
}

#[test]
fn the_launch_tidy_empties_every_overdue_photograph() {
    let corpus = year3_corpus::found_rows();
    let moved = corpus
        .handle
        .with_vault(|vault| {
            Ok(centraid_vault::testdoor::trash_photos_overdue(
                vault, OVERDUE,
            )?)
        })
        .expect("the trash is written");
    assert_eq!(moved, OVERDUE);

    let registry = Registry::with_system_commands().expect("the registry builds");
    let mut collecting = false;
    let mut purged = 0usize;
    loop {
        let batch = corpus
            .handle
            .with_vault(|vault| Ok(vault.empty_overdue_trash_step(&registry, BATCH, collecting)?))
            .expect("a batch runs");
        collecting = batch.collecting;
        purged += batch.purged;
        if !batch.more {
            break;
        }
    }
    assert!(
        purged >= OVERDUE,
        "the pass emptied {purged} of {OVERDUE} overdue"
    );
}
