//! THE SWEEPS: purge & compact hourly, scrub quarterly (`CGW4`, #1080, #1212).
//!
//! The rules are [`crate::rules::engine::Gateway::purge`] and
//! [`crate::rules::engine::Gateway::record_scrub`]; what is here is a clock,
//! a loop, sequential packfile hashing, and sparse/small packfile compaction.
//! **All sweeps log counts only**: a blind gateway may say how many objects or
//! packfiles it read, compacted and removed, never which.
//!
//! # TWO CADENCES
//!
//! **Purge is hourly**: shifts holds across any unwatched gap, removes held
//! deletes past their seven days, compacts sparse packfiles (≥ 50% dead bytes)
//! and coalesces small packfiles (< 16 MiB) up to 256 MiB, prunes expired
//! nonces/secrets/revoked tombstones, and removes orphan staging/pack files.
//!
//! **Scrub is quarterly** (and on demand via `scrub`): walks `object_by_pack`
//! in `(vault, pack_id, pack_offset)` order, opening each packfile once and
//! hashing each object slice sequentially against its recorded digest.

use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::Path;
use std::time::Duration;

use crate::rules::engine::{Finding, ScrubCounts, examine};
use crate::rules::ids::{Name, VaultId};
use crate::rules::limits::{LIST_LIMIT, ORPHAN_MIN_AGE_MS};
use crate::rules::state::{Fault, State as _, StoreFault};
use crate::server::state::PackObjectRow;
use crate::server::store::{ObjectStore, PackId, PackLocation, StagedPack, StoredPack};
use crate::server::{Handle, Shared};

/// One hour.
pub const PURGE_EVERY: Duration = Duration::from_secs(60 * 60);

/// Ninety days.
pub const SCRUB_EVERY: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// Packfiles strictly smaller than 16 MiB are coalesced when ≥ 2 exist for a vault.
pub const SMALL_PACK_BYTES: u64 = 16 * 1024 * 1024;

/// Maximum target size of a compacted/coalesced packfile (256 MiB).
pub const MAX_COMPACTED_PACK_BYTES: u64 = 256 * 1024 * 1024;

/// Rows per page.
const PAGE: usize = 256;

/// Buffer size for sequential packfile reads and compaction writes (256 KiB).
const IO_BUF_BYTES: usize = 256 * 1024;

/// How often each sweep runs. Zero turns one off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Schedule {
    pub purge_every: Duration,
    pub scrub_every: Duration,
}

impl Default for Schedule {
    fn default() -> Self {
        Self {
            purge_every: PURGE_EVERY,
            scrub_every: SCRUB_EVERY,
        }
    }
}

/// How long after a failed sweep it is tried again.
pub const RETRY: Duration = Duration::from_secs(60 * 60);

/// Where the gateway keeps when each sweep last finished.
pub const SWEEPS_FILE: &str = "sweeps.json";

/// When each sweep last finished, in the gateway's milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Finished {
    pub purge_ms: i64,
    pub scrub_ms: i64,
}

impl Finished {
    /// What `data_dir` recorded. A gateway that never swept starts both
    /// clocks at `now_ms` and records that at once.
    ///
    /// # Errors
    ///
    /// If a missing record cannot be written.
    pub fn load_or_start(data_dir: &Path, now_ms: i64) -> std::io::Result<Self> {
        let recorded = std::fs::read_to_string(data_dir.join(SWEEPS_FILE))
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok());
        if let Some(recorded) = recorded {
            return Ok(recorded);
        }
        let started = Self {
            purge_ms: now_ms,
            scrub_ms: now_ms,
        };
        started.save(data_dir)?;
        Ok(started)
    }

    /// Record these times, whole: written aside and renamed into place.
    ///
    /// # Errors
    ///
    /// If the data directory cannot be written.
    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        let staged = data_dir.join(format!("{SWEEPS_FILE}.tmp"));
        std::fs::write(
            &staged,
            serde_json::to_string(self).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(&staged, data_dir.join(SWEEPS_FILE))
    }
}

/// Is a sweep that runs `every` and last finished at `last_ms` due at
/// `now_ms`? A clock set back waits for itself to pass `last_ms` again.
#[must_use]
pub fn due(every: Duration, last_ms: i64, now_ms: i64) -> bool {
    !every.is_zero()
        && now_ms.saturating_sub(last_ms) >= i64::try_from(every.as_millis()).unwrap_or(i64::MAX)
}

/// The finish time to record for a sweep that failed at `now_ms`, so it is
/// due again [`RETRY`] later rather than a whole interval later.
#[must_use]
pub fn failed_at(every: Duration, now_ms: i64) -> i64 {
    let every = i64::try_from(every.as_millis()).unwrap_or(i64::MAX);
    let retry = i64::try_from(RETRY.as_millis()).unwrap_or(i64::MAX);
    now_ms.saturating_sub(every.saturating_sub(retry).max(0))
}

/// The hourly sweep: shift every hold by the whole gap since `last_purge_ms`
/// if past three sweep intervals, purge due holds (excluding frozen vaults),
/// unlink emptied packfiles, compact sparse/small packfiles, prune expired
/// nonces/secrets/revoked tombstones, and remove orphan staging/pack files.
/// Blocking: run off the runtime. Answers how many objects it purged.
///
/// # Errors
///
/// A store fault.
pub fn purge_once(shared: &Shared, last_purge_ms: i64) -> Result<u64, Fault> {
    let now = shared.now();
    let unwatched = shared.rules(|gateway| gateway.account_for_gap(last_purge_ms, now))?;
    if unwatched > 0 {
        tracing::info!(
            minutes = unwatched / 60_000,
            "the gateway was not watching: every hold moved later by that time"
        );
    }
    let mut purged = 0;
    let mut touched_packs: BTreeSet<(VaultId, PackId)> = BTreeSet::new();
    let mut cursor: Option<(i64, VaultId, Name)> = None;
    loop {
        let due_rows = shared.rules(|gateway| {
            gateway.purgeable(
                cursor.as_ref().map(|(at, vault, name)| (*at, vault, name)),
                now,
                PAGE,
            )
        })?;
        let Some(last) = due_rows.last().copied() else {
            break;
        };
        cursor = Some(last);
        for (_, vault, name) in due_rows {
            let removed = shared.rules(|gateway| {
                let pack_id = gateway
                    .state
                    .object_with_location(&vault, &name)?
                    .map(|(_, loc)| loc.pack_id);
                let did = gateway.purge(&vault, &name, now, || Ok(()))?;
                Ok(did.then_some(pack_id).flatten())
            })?;
            if let Some(pack_id) = removed {
                purged += 1;
                touched_packs.insert((vault, pack_id));
            }
        }
    }
    for (vault, pack_id) in touched_packs {
        let store = shared.store();
        shared.rules(|gateway| {
            if !gateway.state.pack_has_objects(&vault, &pack_id)? {
                store.remove_pack(&vault, &pack_id)?;
            }
            Ok(())
        })?;
    }
    let compacted = compact_packs_once(shared)?;
    let pruned = shared.rules(|gateway| gateway.prune(now))?;
    let orphans = orphans_once(shared)?;
    tracing::info!(
        nonces = pruned.nonces,
        secrets = pruned.secrets,
        revoked_tokens = pruned.revoked_tokens,
        compacted,
        orphans,
        "housekeeping"
    );
    Ok(purged)
}

#[derive(Debug, Clone, Copy)]
struct PackCandidate {
    pack_id: PackId,
    live_bytes: u64,
    is_sparse: bool,
    is_small: bool,
}

/// Inspect each unfrozen vault's packfiles on disk against `SUM(size)` in
/// `object`: compact any packfile with ≥ 50% dead bytes
/// (`live_bytes * 2 <= file_len` and `file_len > 0`) and coalesce multiple
/// small packfiles (`file_len < 16 MiB`, when ≥ 2 small packs exist) into
/// new dense packfiles up to 256 MiB. Answers how many old packfiles were
/// compacted/coalesced away.
///
/// # Errors
///
/// A store fault or I/O failure.
pub fn compact_packs_once(shared: &Shared) -> Result<u64, Fault> {
    if shared.commits_in_flight() {
        return Ok(0);
    }
    let mut vaults = Vec::new();
    let mut after_vault: Option<VaultId> = None;
    loop {
        let page = shared
            .rules(|gateway| Ok(gateway.state.vaults(after_vault.as_ref(), LIST_LIMIT)?))?;
        let done = page.len() < LIST_LIMIT;
        for record in page {
            after_vault = Some(record.vault);
            if record.frozen_at_ms.is_none() {
                vaults.push(record.vault);
            }
        }
        if done {
            break;
        }
    }

    let mut compacted_packs = 0_u64;
    for vault in vaults {
        let mut on_disk: Vec<StoredPack> = shared
            .store()
            .vault_pack_files(&vault)
            .map_err(|error| StoreFault::new(error.to_string()))?;
        on_disk.sort_by_key(|pack| pack.pack_id);

        let mut candidates = Vec::new();
        for pack in on_disk {
            let (row_count, live_bytes) =
                shared.rules(|gateway| Ok(gateway.state.pack_stats(&vault, &pack.pack_id)?))?;
            if row_count == 0 {
                continue;
            }
            let is_sparse = pack.len > 0 && live_bytes.saturating_mul(2) <= pack.len;
            let is_small = pack.len < SMALL_PACK_BYTES;
            if is_sparse || is_small {
                candidates.push(PackCandidate {
                    pack_id: pack.pack_id,
                    live_bytes,
                    is_sparse,
                    is_small,
                });
            }
        }

        let sparse_count = candidates.iter().filter(|c| c.is_sparse).count();
        let small_count = candidates.iter().filter(|c| c.is_small).count();
        if sparse_count == 0 && small_count < 2 {
            continue;
        }

        let mut buckets: Vec<Vec<PackCandidate>> = Vec::new();
        let mut current_bucket: Vec<PackCandidate> = Vec::new();
        let mut current_bytes = 0_u64;
        for candidate in candidates {
            if !current_bucket.is_empty()
                && current_bytes.saturating_add(candidate.live_bytes) > MAX_COMPACTED_PACK_BYTES
            {
                buckets.push(std::mem::take(&mut current_bucket));
                current_bytes = 0;
            }
            current_bytes = current_bytes.saturating_add(candidate.live_bytes);
            current_bucket.push(candidate);
        }
        if !current_bucket.is_empty() {
            buckets.push(current_bucket);
        }

        for bucket in buckets {
            if bucket.len() >= 2 || bucket.iter().any(|c| c.is_sparse) {
                compacted_packs += compact_bucket(shared, &vault, &bucket)?;
            }
        }
    }
    Ok(compacted_packs)
}

fn compact_bucket(
    shared: &Shared,
    vault: &VaultId,
    bucket: &[PackCandidate],
) -> Result<u64, Fault> {
    let store = shared.store();
    let mut usable: Vec<(PackCandidate, Vec<PackObjectRow>)> = Vec::new();
    for candidate in bucket {
        let mut rows = Vec::new();
        let mut after: Option<(u64, Name)> = None;
        let mut all_present = true;
        loop {
            let page = shared.rules(|gateway| {
                Ok(gateway.state.pack_objects_page(
                    vault,
                    &candidate.pack_id,
                    after.as_ref().map(|(offset, name)| (*offset, name)),
                    PAGE,
                )?)
            })?;
            let done = page.len() < PAGE;
            if let Some(last) = page.last() {
                after = Some((last.pack_offset, last.name));
            }
            for row in page {
                let loc = PackLocation {
                    pack_id: candidate.pack_id,
                    pack_offset: row.pack_offset,
                };
                if !store.has_slice(vault, loc, row.size) {
                    all_present = false;
                    break;
                }
                rows.push(row);
            }
            if !all_present || done {
                break;
            }
        }
        if all_present && !rows.is_empty() {
            usable.push((*candidate, rows));
        }
    }

    if usable.len() < 2 && !usable.iter().any(|(c, _)| c.is_sparse) {
        return Ok(0);
    }

    let new_pack_id = PackId::random();
    let staged_path = store.staging_pack_path(&new_pack_id);
    let file =
        std::fs::File::create(&staged_path).map_err(crate::server::store::StageError::from)?;
    let mut writer = std::io::BufWriter::with_capacity(IO_BUF_BYTES, file);
    let mut scratch = vec![0_u8; IO_BUF_BYTES];
    let mut remaps: Vec<(Name, PackLocation, PackLocation)> = Vec::new();
    let mut out_offset = 0_u64;

    let copy_outcome = (|| -> std::io::Result<()> {
        for (candidate, rows) in &usable {
            let src_file = std::fs::File::open(store.pack_path(vault, &candidate.pack_id))?;
            for row in rows {
                let old_loc = PackLocation {
                    pack_id: candidate.pack_id,
                    pack_offset: row.pack_offset,
                };
                let new_loc = PackLocation {
                    pack_id: new_pack_id,
                    pack_offset: out_offset,
                };
                let mut pos = row.pack_offset;
                let mut remaining = row.size;
                while remaining > 0 {
                    let want = usize::try_from(remaining.min(scratch.len() as u64))
                        .unwrap_or(scratch.len());
                    ObjectStore::read_at(&src_file, pos, &mut scratch[..want])?;
                    writer.write_all(&scratch[..want])?;
                    pos = pos.saturating_add(want as u64);
                    remaining -= want as u64;
                }
                out_offset = out_offset.saturating_add(row.size);
                remaps.push((row.name, old_loc, new_loc));
            }
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
        Ok(())
    })();

    if let Err(error) = copy_outcome {
        drop(writer);
        let _ = std::fs::remove_file(&staged_path);
        return Err(crate::server::store::StageError::from(error).into());
    }
    drop(writer);

    let staged_pack = StagedPack::from_synced(new_pack_id, staged_path, out_offset);
    let _committing = shared.commit_guard();
    let promoted_id = store.promote_compacted_pack(staged_pack, vault)?;

    let old_pack_ids: Vec<PackId> = usable.iter().map(|(c, _)| c.pack_id).collect();
    let remapped = shared.rules(|gateway| {
        gateway.state.atomically(|state| {
            for (name, old_loc, new_loc) in &remaps {
                state.remap_object_pack(vault, name, *old_loc, *new_loc)?;
            }
            let new_has_rows = state.pack_has_objects(vault, &promoted_id)?;
            let mut empty_old = Vec::new();
            for old_id in &old_pack_ids {
                if !state.pack_has_objects(vault, old_id)? {
                    empty_old.push(*old_id);
                }
            }
            Ok((new_has_rows, empty_old))
        })
    });

    let (new_has_rows, empty_old) = match remapped {
        Ok(outcome) => outcome,
        Err(fault) => {
            let _ = store.remove_pack(vault, &promoted_id);
            return Err(fault);
        }
    };

    if !new_has_rows {
        store.remove_pack(vault, &promoted_id)?;
    }
    for old_id in &empty_old {
        store.remove_pack(vault, old_id)?;
    }
    Ok(empty_old.len() as u64)
}

/// Remove old staged files in `staging/` and any `.pack` file under
/// `packs/<vault>/` older than [`ORPHAN_MIN_AGE_MS`] that has zero rows in
/// `object` referencing `(vault, pack_id)`. Counts only.
///
/// # Errors
///
/// A store fault, or a directory read error.
pub fn orphans_once(shared: &Shared) -> Result<u64, Fault> {
    if shared.commits_in_flight() {
        return Ok(0);
    }
    let now = shared.now();
    let store = shared.store();
    let mut removed = 0_u64;

    let staged = store
        .staged_entries()
        .map_err(|error| StoreFault::new(error.to_string()))?;
    for entry in staged {
        if now.saturating_sub(entry.modified_ms) > ORPHAN_MIN_AGE_MS {
            store.remove_staged_file(&entry.path)?;
            removed += 1;
        }
    }

    let packs = store
        .pack_files()
        .map_err(|error| StoreFault::new(error.to_string()))?;
    for pack in packs {
        if now.saturating_sub(pack.modified_ms) <= ORPHAN_MIN_AGE_MS {
            continue;
        }
        if shared.rules(|gateway| {
            gateway.state.atomically(|state| {
                if state.pack_has_objects(&pack.vault, &pack.pack_id)? {
                    return Ok(false);
                }
                #[cfg(feature = "test-harness")]
                store.knobs().before_orphan_unlink();
                store.remove_pack(&pack.vault, &pack.pack_id)?;
                Ok(true)
            })
        })? {
            removed += 1;
        }
    }
    Ok(removed)
}

/// Re-hash every stored object sequentially by `(vault, pack_id, pack_offset)`
/// using `object_by_pack`, opening each packfile once, and mark what no longer
/// matches. Blocking: run off the runtime.
///
/// # Errors
///
/// A store fault, or a read error other than a missing packfile.
struct OpenScrubPack {
    vault: VaultId,
    pack_id: PackId,
    opened: Option<(std::fs::File, u64)>,
}

pub fn scrub_once(shared: &Shared) -> Result<ScrubCounts, Fault> {
    let mut counts = ScrubCounts::default();
    let mut after: Option<(VaultId, PackId, u64, Name)> = None;
    let mut open_pack: Option<OpenScrubPack> = None;
    let mut scratch = vec![0_u8; IO_BUF_BYTES];

    loop {
        let page = shared.rules(|gateway| {
            Ok(gateway.state.scrub_pack_page(
                after
                    .as_ref()
                    .map(|(vault, pack_id, offset, name)| (vault, pack_id, *offset, name)),
                PAGE,
            )?)
        })?;
        let Some((last_vault, last_loc, last_record)) = page.last() else {
            return Ok(counts);
        };
        after = Some((
            *last_vault,
            last_loc.pack_id,
            last_loc.pack_offset,
            last_record.name,
        ));

        for (vault, loc, record) in page {
            let reuse = open_pack
                .as_ref()
                .is_some_and(|open| open.vault == vault && open.pack_id == loc.pack_id);
            if !reuse {
                let opened =
                    match std::fs::File::open(shared.store().pack_path(&vault, &loc.pack_id)) {
                        Ok(file) => {
                            let len = file
                                .metadata()
                                .map_err(|error| StoreFault::new(error.to_string()))?
                                .len();
                            Some((file, len))
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                        Err(error) => return Err(StoreFault::new(error.to_string()).into()),
                    };
                open_pack = Some(OpenScrubPack {
                    vault,
                    pack_id: loc.pack_id,
                    opened,
                });
            }

            let finding = match open_pack.as_ref().and_then(|open| open.opened.as_ref()) {
                None => Finding::Missing,
                Some((_, file_len))
                    if loc.pack_offset > *file_len
                        || (record.size > 0 && loc.pack_offset == *file_len) =>
                {
                    Finding::Missing
                }
                Some((_, file_len))
                    if loc
                        .pack_offset
                        .checked_add(record.size)
                        .is_none_or(|end| end > *file_len) =>
                {
                    Finding::Corrupt
                }
                Some((file, _)) => {
                    let digest = ObjectStore::hash_slice_in_file(
                        file,
                        loc.pack_offset,
                        record.size,
                        &mut scratch,
                    )
                    .map_err(|error| StoreFault::new(error.to_string()))?;
                    examine(&record.digest, Some(&digest))
                }
            };

            counts.read += 1;
            match finding {
                Finding::Intact => {}
                Finding::Corrupt => counts.corrupt += 1,
                Finding::Missing => counts.missing += 1,
            }
            if finding != Finding::Intact || record.damaged_at_ms.is_some() {
                let now = shared.now();
                shared.rules(|gateway| gateway.record_scrub(&vault, &record, finding, now))?;
            }
        }
    }
}

/// Run both sweeps on their cadences, forever. Spawned beside the listener.
pub async fn run(shared: Handle, schedule: Schedule) {
    const TICK: Duration = Duration::from_secs(60);
    let mut finished = match Finished::load_or_start(shared.data_dir(), shared.now()) {
        Ok(finished) => finished,
        Err(error) => {
            tracing::warn!(%error, "the sweeps cannot record their times; not sweeping");
            return;
        }
    };
    loop {
        tokio::time::sleep(TICK).await;
        if due(schedule.purge_every, finished.purge_ms, shared.now()) {
            let held = shared.clone();
            let last_purge = finished.purge_ms;
            finished.purge_ms =
                match tokio::task::spawn_blocking(move || purge_once(&held, last_purge)).await {
                    Ok(Ok(purged)) => {
                        tracing::info!(purged, "purge sweep");
                        shared.now()
                    }
                    Ok(Err(fault)) => {
                        tracing::warn!(%fault, "purge sweep failed");
                        failed_at(schedule.purge_every, shared.now())
                    }
                    Err(error) => {
                        tracing::warn!(%error, "purge sweep did not finish");
                        failed_at(schedule.purge_every, shared.now())
                    }
                };
            record(&shared, &finished);
        }
        if due(schedule.scrub_every, finished.scrub_ms, shared.now()) {
            let held = shared.clone();
            finished.scrub_ms = match tokio::task::spawn_blocking(move || scrub_once(&held)).await {
                Ok(Ok(counts)) => {
                    tracing::info!(
                        read = counts.read,
                        corrupt = counts.corrupt,
                        missing = counts.missing,
                        "scrub sweep"
                    );
                    shared.now()
                }
                Ok(Err(fault)) => {
                    tracing::warn!(%fault, "scrub sweep failed");
                    failed_at(schedule.scrub_every, shared.now())
                }
                Err(error) => {
                    tracing::warn!(%error, "scrub sweep did not finish");
                    failed_at(schedule.scrub_every, shared.now())
                }
            };
            record(&shared, &finished);
        }
    }
}

/// Keep the sweeps' times. A write that fails is logged and the times held
/// in memory still pace this run.
fn record(shared: &Shared, finished: &Finished) {
    if let Err(error) = finished.save(shared.data_dir()) {
        tracing::warn!(%error, "the sweeps could not record their times");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 3_600_000;
    const DAY_MS: i64 = 24 * HOUR_MS;

    #[test]
    fn a_zero_interval_is_off() {
        assert!(!due(Duration::ZERO, 0, i64::MAX));
    }

    #[test]
    fn a_sweep_is_due_once_its_interval_has_passed() {
        let last = 1_000 * DAY_MS;
        assert!(!due(PURGE_EVERY, last, last + HOUR_MS - 1));
        assert!(due(PURGE_EVERY, last, last + HOUR_MS));
        assert!(due(PURGE_EVERY, last, last + 30 * DAY_MS));
        assert!(!due(PURGE_EVERY, last, last - DAY_MS));
        assert_eq!(SCRUB_EVERY.as_secs(), 90 * 24 * 3_600, "quarterly");
    }

    #[test]
    fn a_restart_keeps_the_quarter() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let first_start = 1_000 * DAY_MS;
        let started = Finished::load_or_start(dir.path(), first_start).expect("starts");
        assert_eq!(started.scrub_ms, first_start);
        assert!(dir.path().join(SWEEPS_FILE).is_file(), "recorded at once");

        let restarted =
            Finished::load_or_start(dir.path(), first_start + 89 * DAY_MS).expect("restarts");
        assert_eq!(restarted, started, "a restart does not move the quarter");
        assert!(!due(
            SCRUB_EVERY,
            restarted.scrub_ms,
            first_start + 89 * DAY_MS
        ));
        assert!(due(
            SCRUB_EVERY,
            restarted.scrub_ms,
            first_start + 90 * DAY_MS
        ));

        let swept = Finished {
            scrub_ms: first_start + 90 * DAY_MS,
            ..restarted
        };
        swept.save(dir.path()).expect("records");
        assert_eq!(
            Finished::load_or_start(dir.path(), 0).expect("reads"),
            swept
        );
    }

    #[test]
    fn a_failed_sweep_is_tried_again_in_an_hour() {
        let now = 1_000 * DAY_MS;
        for every in [PURGE_EVERY, SCRUB_EVERY] {
            let last = failed_at(every, now);
            assert!(!due(every, last, now + HOUR_MS - 1), "{every:?}");
            assert!(due(every, last, now + HOUR_MS), "{every:?}");
        }
    }
}
