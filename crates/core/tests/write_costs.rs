//! What the write paths this umbrella added cost on a year-3 vault (#1146, wave 8).
//!
//! `call_budget` bounds how long a read may take; a write is measured here by how long it holds the
//! vault, because that is how long a request waits behind it. Both numbers are stated against the
//! same 50 ms ceiling (`contracts/ledgers/call-budget.json`):
//!
//! - **a label's trash and restore** re-index every member in the one commit (wave 5), so a list of
//!   thousands pays it in the command that trashes it;
//! - **the launch tidy** purges what is overdue in batches that hold the vault for one batch each
//!   (wave 3), so the number to bound is one batch, not the pass. The p95 over the batches is
//!   what is held to the ceiling, as the call budget states its own.
//!
//! The corpus is the one `query_plans` plans over: about 46,000 entities, 12,000 of them photographs.
#![allow(clippy::cast_precision_loss)]

mod year3_corpus;

use std::time::{Duration, Instant};

use centraid_vault::commands::{Command, Registry};
use centraid_vault::{CommandStatus, Principal};

/// The call budget's ceiling, `contracts/ledgers/call-budget.json`.
const CEILING: Duration = Duration::from_millis(50);
/// Members of the label the first measurement trashes.
const MEMBERS: usize = 5_000;
/// Overdue photographs the second measurement empties.
const OVERDUE: usize = 2_000;
/// The launch tidy's batch (`TRASH_BATCH` in `crates/core/src/handle.rs`).
const BATCH: usize = 5;

fn run(handle: &centraid_core::Handle, name: &str, input: serde_json::Value) -> Duration {
    let registry = Registry::with_system_commands().expect("the registry builds");
    let started = Instant::now();
    let outcome = handle
        .with_vault(|vault| {
            Ok(vault.execute(
                &registry,
                &Principal::owner("measure"),
                &Command::new(name, input),
            )?)
        })
        .expect("it runs");
    let took = started.elapsed();
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{name}: {:?}",
        outcome.reason
    );
    took
}

#[test]
fn trashing_and_restoring_a_label_of_five_thousand_holds_the_vault_inside_the_call_budget() {
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

    let trash = run(
        &corpus.handle,
        "entity.trash",
        serde_json::json!({ "id": "album-big" }),
    );
    let restore = run(
        &corpus.handle,
        "entity.restore",
        serde_json::json!({ "id": "album-big" }),
    );
    println!(
        "label of {MEMBERS}: trash {:.1} ms, restore {:.1} ms (ceiling {} ms)",
        trash.as_secs_f64() * 1e3,
        restore.as_secs_f64() * 1e3,
        CEILING.as_millis()
    );
    assert!(
        trash <= CEILING,
        "trashing a label of {MEMBERS} held the vault {trash:?}"
    );
    assert!(
        restore <= CEILING,
        "restoring a label of {MEMBERS} held the vault {restore:?}"
    );
}

#[test]
fn a_launch_batch_of_the_overdue_trash_holds_the_vault_inside_the_call_budget() {
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
    let mut every = Vec::new();
    let mut collecting = false;
    let mut slowest = (Duration::ZERO, 0usize, false);
    let mut worst = Duration::ZERO;
    let mut total = Duration::ZERO;
    let mut batches = 0usize;
    let mut purged = 0usize;
    loop {
        let started = Instant::now();
        let batch = corpus
            .handle
            .with_vault(|vault| Ok(vault.empty_overdue_trash_step(&registry, BATCH, collecting)?))
            .expect("a batch runs");
        let took = started.elapsed();
        if took > slowest.0 {
            slowest = (took, batches, collecting);
        }
        collecting = batch.collecting;
        worst = worst.max(took);
        every.push(took);
        total += took;
        batches += 1;
        purged += batch.purged;
        if !batch.more {
            break;
        }
    }
    every.sort();
    println!(
        "slowest step: {:?} at step {} (collecting: {})",
        slowest.0, slowest.1, slowest.2
    );
    // p95, nearest-rank: the statistic the call budget is stated in. The worst step is printed
    // and not asserted: it is SQLite's own WAL checkpoint landing in one commit now and then.
    let p95 = every[(every.len() * 95).div_ceil(100) - 1];
    println!(
        "batch p50 {:?} p95 {p95:?} worst {worst:?}",
        every[every.len() / 2]
    );
    println!(
        "overdue trash of {OVERDUE}: {batches} batches of {BATCH}, worst {:.1} ms, total {:.1} s (ceiling {} ms)",
        worst.as_secs_f64() * 1e3,
        total.as_secs_f64(),
        CEILING.as_millis()
    );
    assert!(
        purged >= OVERDUE,
        "the pass emptied {purged} of {OVERDUE} overdue"
    );
    assert!(
        p95 <= CEILING,
        "a batch of {BATCH} held the vault {p95:?} at p95"
    );
}
