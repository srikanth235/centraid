//! The drill: back a vault up, lose everything on the device, restore it from
//! the store, and prove it is the vault that was lost (#1080, "Drill").
//!
//! 1. Found a vault and write notes through the command plane, so the file is
//!    many ranges of real rows, receipts and full-text index.
//! 2. Snapshot, ask, spool, move, settle: the head names it.
//! 3. Back up every content item by name, sealed in one pass, and prove the
//!    ledger confirms every name its hash implies.
//! 4. Fifty more commits; snapshot again, and prove only the ranges that
//!    changed were sealed and the store grew by exactly those plus a manifest.
//! 5. Retention keeps the newest; garbage collection deletes exactly the
//!    ranges only the dropped snapshot named.
//! 6. Destroy the vault, its WAL and SHM, the spool, the ledger and the
//!    scratch: what is left is the store, which is ciphertext, and the key.
//! 7. Restore from the head; open the file through the ladder; prove its
//!    census, its `db_hash` and a dump of every row equal the lost vault's,
//!    and that a file fetched by name verifies against its hash.
//! 8. Take the vault over at the next epoch, after the checks: the old
//!    writer's next write is refused `MOVED`.
//!
//! The store is a [`MemoryStore`]; the cut-over runs the same drill against
//! the gateway, because the plane takes any [`Store`].

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::{Duration, Instant};

use centraid_media::sealed::{self, Assembler, FileSealer};

use super::PlaneError;
use super::ledger::{Destination, Ledger, PartKind, Queued};
use super::mover::{Stop, move_queue};
use super::naming::{BackupKeys, Name, PlaintextHash, content_hashes, keys_from_root, names_of};
use super::restore::{Check, RestoreError, restore_head};
use super::retention::{garbage, keep, live_names};
use super::snapshot::{self, APP, Settled, Snapshot};
use super::spool::{SPOOL_CEILING_BYTES, Spool};
use super::store::{self, MemoryStore, Store, StoreError};
use crate::access::Principal;
use crate::clock::{Clock, SystemClock};
use crate::commands::{Command, CommandStatus, Registry};
use crate::error::VaultError;
use crate::file::Vault;

/// The drill's root key. A drill holds a key the way a phone does after
/// deriving it from the words; this one derives from nothing.
const ROOT_KEY: [u8; 32] = [0xd7; 32];

/// The drill's vault identity, hex.
const VAULT_ID: &str = "d711d711d711d711d711d711d711d711d711d711d711d711d711d711d711d711";

/// Notes written before the first snapshot, and the size of each body: enough
/// to make the file several ranges, under the 64 KiB a note body may be.
const FIRST_NOTES: usize = 240;
const FIRST_BODY_BYTES: usize = 48 * 1024;

/// Commits between the two snapshots (#1080's acceptance case).
const SECOND_NOTES: usize = 50;

#[derive(Debug, thiserror::Error)]
pub enum DrillError {
    #[error(transparent)]
    Plane(#[from] PlaneError),
    #[error(transparent)]
    Restore(#[from] RestoreError),
    #[error(transparent)]
    Vault(#[from] VaultError),
    #[error(transparent)]
    Sealed(#[from] sealed::SealedError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("the drill failed: {0}")]
    Failed(String),
}

fn fail(reason: impl Into<String>) -> DrillError {
    DrillError::Failed(reason.into())
}

/// What the drill proved, with the numbers it proved it with.
#[derive(Debug, Clone)]
pub struct DrillReport {
    pub tables: usize,
    pub rows: i64,
    pub db_len: u64,
    pub ranges_first: usize,
    pub ranges_second: usize,
    /// Ranges the second snapshot had to seal, of `ranges_second`.
    pub sealed_second: usize,
    pub objects_before_second: usize,
    pub objects_after_second: usize,
    pub content_files: usize,
    pub content_parts: usize,
    /// Names garbage collection deleted after retention.
    pub collected: usize,
    pub checks: Vec<Check>,
    pub elapsed_ms: u128,
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(600)
}

fn now_ms() -> u64 {
    u64::try_from(SystemClock.now_ms()).unwrap_or(0)
}

/// A body of about `bytes` bytes, unique to `index`.
fn body(index: usize, bytes: usize) -> String {
    let mut out = format!("Note {index}.\n");
    let mut line = 0;
    while out.len() < bytes {
        out.push_str(&format!(
            "Line {line} of note {index}: the phone is the vault and the gateway holds ciphertext.\n"
        ));
        line += 1;
    }
    out
}

fn write_notes(
    vault: &Vault,
    registry: &Registry,
    from: usize,
    count: usize,
    bytes: usize,
) -> Result<(), DrillError> {
    let principal = Principal::owner("drill");
    for index in from..from + count {
        let outcome = vault.execute(
            registry,
            &principal,
            &Command::new(
                "knowledge.create_note",
                serde_json::json!({
                    "title": format!("Note {index}"),
                    "body_text": body(index, bytes),
                    "format": "plain",
                }),
            ),
        )?;
        if outcome.status != CommandStatus::Executed {
            return Err(fail(format!(
                "note {index} was refused: {:?}",
                outcome.reason
            )));
        }
    }
    Ok(())
}

/// Every row of every table a member has rows in, as text, sorted per table.
fn dump(vault: &Vault) -> Result<BTreeMap<String, Vec<String>>, DrillError> {
    Ok(vault.read(|connection| {
        let census = snapshot::census_of(connection).map_err(|error| VaultError::Invariant {
            context: error.to_string(),
        })?;
        let mut out = BTreeMap::new();
        for table in census.keys() {
            let sql = format!("SELECT * FROM {}", crate::log::identifiers::quoted(table));
            let mut statement = connection.prepare(&sql)?;
            let columns = statement.column_count();
            let mut rows: Vec<String> = statement
                .query_map([], |row| {
                    let values: Vec<rusqlite::types::Value> = (0..columns)
                        .map(|index| row.get(index))
                        .collect::<rusqlite::Result<_>>()?;
                    Ok(format!("{values:?}"))
                })?
                .collect::<rusqlite::Result<_>>()?;
            rows.sort();
            out.insert(table.clone(), rows);
        }
        Ok(out)
    })?)
}

/// Take a snapshot and move it all the way to the head.
fn back_up(
    vault: &Vault,
    keys: &BackupKeys,
    scratch: &Path,
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
) -> Result<(Snapshot, snapshot::Plan), DrillError> {
    let taken = snapshot::take(vault, keys, scratch, VAULT_ID, APP)?;
    let plan = snapshot::plan(&taken, store)?;
    let spooled = snapshot::spool(
        &taken,
        &plan,
        spool,
        ledger,
        keys,
        SPOOL_CEILING_BYTES,
        now_ms(),
    )?;
    if !spooled.deferred.is_empty() {
        return Err(fail("the spool deferred parts under the drill's budget"));
    }
    let moved = move_queue(ledger, spool, store, deadline(), &SystemClock)?;
    if moved.stopped != Stop::Empty {
        return Err(fail(format!("the move stopped early: {:?}", moved.stopped)));
    }
    match snapshot::settle(
        ledger,
        store,
        &taken.manifest_name,
        &taken.manifest,
        &SystemClock,
    )? {
        Settled::HeadSet(head) if head.name == taken.manifest_name => {}
        other => return Err(fail(format!("the head did not move: {other:?}"))),
    }
    Ok((taken, plan))
}

/// Back up every content item's bytes by name, each sealed in one pass, and
/// return how many files and parts that was.
fn back_up_content(
    vault: &Vault,
    keys: &BackupKeys,
    ledger: &Ledger,
    spool: &Spool,
    store: &dyn Store,
) -> Result<(usize, usize), DrillError> {
    let bodies: Vec<(String, String)> = vault.read(|connection| {
        let mut statement = connection.prepare(
            "SELECT i.content_hash, t.body_text FROM core_content_item i
               JOIN core_content_text t ON t.content_id = i.content_id
              ORDER BY i.content_hash",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    })?;
    let mut parts = 0;
    for (index, (hash, text)) in bodies.iter().enumerate() {
        let tag = index.to_string();
        let mut sealer = FileSealer::new(keys, false, Some(text.len() as u64), |part| {
            spool.temp_path(&tag, part)
        });
        sealer.update(text.as_bytes())?;
        let sealed = sealer.finish()?;
        if sealed.h.to_hex() != *hash {
            return Err(fail(format!(
                "content {hash} is not the bytes its row names"
            )));
        }
        for part in &sealed.parts {
            let path = spool.adopt(&part.path, &part.name)?;
            ledger.enqueue(&Queued {
                name: part.name,
                part_path: path,
                size: part.len,
                digest: part.digest,
                kind: PartKind::Original,
                media_type: Some("text/plain".to_owned()),
                created_ms: now_ms(),
                handed_off_ms: None,
                attempts: 0,
                last_error: None,
            })?;
            parts += 1;
        }
    }
    let moved = move_queue(ledger, spool, store, deadline(), &SystemClock)?;
    if moved.stopped != Stop::Empty {
        return Err(fail(format!(
            "the content move stopped early: {:?}",
            moved.stopped
        )));
    }
    let confirmed = ledger.confirmed_names(store.gateway_id())?;
    for (h, len) in content_hashes(vault)? {
        if names_of(keys, &h, len)
            .iter()
            .any(|name| !confirmed.contains(name))
        {
            return Err(fail(format!(
                "content {h} has a name the ledger never confirmed"
            )));
        }
    }
    Ok((bodies.len(), parts))
}

/// Run the drill under `dir`, which it fills and leaves for the caller.
///
/// # Errors
/// [`DrillError`] naming the step that failed.
pub fn run(dir: &Path) -> Result<DrillReport, DrillError> {
    let started = Instant::now();
    let keys = keys_from_root(&ROOT_KEY);
    let vault_path = dir.join("live").join("vault.db");
    std::fs::create_dir_all(dir.join("live"))?;
    let store = MemoryStore::new("drill-gateway");

    // ---- 1. found and write ------------------------------------------------
    let vault = Vault::create(&vault_path)?;
    vault.found("The Drill Household", "Ada")?;
    let registry = Registry::with_system_commands()?;
    registry.install(&vault)?;
    write_notes(&vault, &registry, 0, FIRST_NOTES, FIRST_BODY_BYTES)?;

    let ledger = Ledger::open(Ledger::path_for(&vault_path))?;
    ledger.put_destination(&Destination {
        gateway_id: store.gateway_id().to_owned(),
        addrs: vec!["127.0.0.1:7443".to_owned()],
        cert_der: Vec::new(),
        token: "0".repeat(64),
        epoch: store.epoch(),
        label: "The drill's gateway".to_owned(),
        paired_at_ms: now_ms(),
        last_seen_ms: None,
        last_ack_ms: None,
    })?;
    let spool = Spool::open(Spool::dir_for(&vault_path))?;
    let scratch = dir.join("live").join("scratch");

    // ---- 2. the first snapshot ---------------------------------------------
    let (first, first_plan) = back_up(&vault, &keys, &scratch, &ledger, &spool, &store)?;
    if first_plan.missing_ranges.len() != first.manifest.range_names().len() {
        return Err(fail(
            "an empty store already held part of the first snapshot",
        ));
    }

    // ---- 3. the content, by name -------------------------------------------
    let (content_files, content_parts) = back_up_content(&vault, &keys, &ledger, &spool, &store)?;

    // ---- 4. more commits, and only what changed ----------------------------
    write_notes(&vault, &registry, FIRST_NOTES, SECOND_NOTES, 200)?;
    let before: BTreeSet<Name> = store::list_all(&store)?
        .iter()
        .map(|entry| entry.name)
        .collect();
    let (second, second_plan) = back_up(&vault, &keys, &scratch, &ledger, &spool, &store)?;
    let after: BTreeSet<Name> = store::list_all(&store)?
        .iter()
        .map(|entry| entry.name)
        .collect();
    let sealed_second = second_plan.missing_ranges.len();
    if sealed_second >= second.ranges.len() {
        return Err(fail(format!(
            "the second snapshot sealed {sealed_second} of {} ranges: nothing was reused",
            second.ranges.len()
        )));
    }
    let grown: BTreeSet<Name> = after.difference(&before).copied().collect();
    let mut expected: BTreeSet<Name> = second_plan
        .missing_ranges
        .iter()
        .filter_map(|index| second.ranges.get(usize::try_from(*index).ok()?))
        .map(|range| range.name)
        .collect();
    expected.insert(second.manifest_name);
    if grown != expected {
        return Err(fail(format!(
            "the store grew by {} names; the missing ranges and the manifest are {}",
            grown.len(),
            expected.len()
        )));
    }

    // ---- 5. retention, then garbage ----------------------------------------
    // Two snapshots a few seconds apart share a day, so retention keeps the
    // newest alone — unless the drill straddled midnight UTC, when it keeps
    // both and there is nothing to collect. Either way the garbage must be
    // exactly the ranges only a dropped snapshot named.
    let decided = keep(&store.snapshots()?, now_ms());
    if decided.keep.first() != Some(&second.manifest_name) {
        return Err(fail(format!(
            "retention did not keep the newest: {decided:?}"
        )));
    }
    store::delete_all(&store, &decided.drop)?;
    for name in &decided.drop {
        ledger.forget_snapshot(name)?;
    }
    let taken = [&first, &second];
    let names_kept_by = |kept: bool| -> BTreeSet<Name> {
        taken
            .iter()
            .filter(|snapshot| decided.keep.contains(&snapshot.manifest_name) == kept)
            .flat_map(|snapshot| snapshot.manifest.range_names())
            .collect()
    };
    let mut live_ranges = names_kept_by(true);
    let only_dropped: BTreeSet<Name> = names_kept_by(false)
        .difference(&live_ranges)
        .copied()
        .collect();
    live_ranges.extend(decided.keep.iter().copied());
    let live = live_names(&keys, live_ranges, content_hashes(&vault)?);
    let listed: Vec<Name> = store::list_all(&store)?
        .iter()
        .map(|entry| entry.name)
        .collect();
    let collect = garbage(listed, &live);
    if collect.iter().copied().collect::<BTreeSet<_>>() != only_dropped {
        return Err(fail(
            "garbage is not exactly the ranges only a dropped snapshot named",
        ));
    }
    let deleted = store::delete_all(&store, &collect)?;
    if !deleted.refused.is_empty() {
        return Err(fail(format!(
            "the store refused to collect {:?}",
            deleted.refused
        )));
    }

    // ---- 6. lose everything ------------------------------------------------
    let lost = dump(&vault)?;
    let census = second.manifest.census.clone();
    let (ranges_first, ranges_second) = (first.ranges.len(), second.ranges.len());
    let head = second.manifest_name;
    first.discard()?;
    second.discard()?;
    vault.close()?;
    drop(ledger);
    std::fs::remove_dir_all(dir.join("live"))?;
    if vault_path.exists() || Spool::dir_for(&vault_path).exists() {
        return Err(fail("the device's state survived its own deletion"));
    }

    // ---- 7. restore, and prove it ------------------------------------------
    std::fs::create_dir_all(dir.join("live"))?;
    let restored = restore_head(&store, &keys, &vault_path)?;
    let reopened = Vault::open(&vault_path)?;
    let back = dump(&reopened)?;
    if back != lost {
        let differing: Vec<&String> = lost
            .keys()
            .filter(|table| back.get(*table) != lost.get(*table))
            .collect();
        return Err(fail(format!(
            "rows differ after the restore in {differing:?}"
        )));
    }
    let recounted = reopened.read(|connection| {
        snapshot::census_of(connection).map_err(|error| VaultError::Invariant {
            context: error.to_string(),
        })
    })?;
    if recounted != census {
        return Err(fail("the census through the ladder is not the manifest's"));
    }
    let (h, len) = content_hashes(&reopened)?
        .into_iter()
        .max_by_key(|(_, len)| *len)
        .ok_or_else(|| fail("the restored vault names no content"))?;
    let mut assembler = Assembler::new(h, len);
    let mut original = Vec::new();
    while let Some(name) = assembler.next_name(&keys) {
        let mut sealed_bytes = Vec::new();
        store.get(&name, &mut sealed_bytes)?;
        assembler.part(&keys, sealed_bytes.as_slice(), &mut original)?;
    }
    assembler.finish()?;
    if PlaintextHash::of(&original) != h {
        return Err(fail("the fetched original is not its hash"));
    }
    reopened.close()?;

    // ---- 8. the takeover fences the old writer -----------------------------
    let _successor = store.claim();
    match store.set_head(&head, Some(&head), 0) {
        Err(StoreError::Moved { .. }) => {}
        other => return Err(fail(format!("the old writer was not fenced: {other:?}"))),
    }

    Ok(DrillReport {
        tables: census.len(),
        rows: census.values().sum(),
        db_len: restored.manifest.db_len,
        ranges_first,
        ranges_second,
        sealed_second,
        objects_before_second: before.len(),
        objects_after_second: after.len(),
        content_files,
        content_parts,
        collected: collect.len(),
        checks: restored.checks,
        elapsed_ms: started.elapsed().as_millis(),
    })
}
