//! One snapshot: the vault read once, under one pin, into a tree
//! (spec §5, [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! - The vault is read through [`PinnedPages`]: one pinned WAL read,
//!   `sqlite_dbpage`, no plaintext copy on disk, `quick_check`, census,
//!   `user_version` and the write counter. A damaged vault is refused before
//!   any root exists.
//! - **Dirty ranges, not the whole file.** Only the 64 KiB ranges the WAL's
//!   frames name (plus the pages written during the previous pin, which the
//!   checkpoint has since folded away) are read, named and sealed; every
//!   other range reuses the previous snapshot's ref.
//! - **The periodic full read and write-behind detection.** Every [`FULL_EVERY`]th
//!   snapshot, at least daily, and whenever the main vault file may have been written
//!   behind the core's back, every range is read and the root carries `db_hash`. Other
//!   roots carry no `db_hash`. Two independent guards, neither depending on which tables
//!   a commit touched (search-index, `sqlite_stat1` and bookkeeping writes bump no
//!   counter): (1) `disk_mark`, recorded right after the core's own
//!   `wal_checkpoint(TRUNCATE)`, hashes the main file's length, mtime (ns), ctime, inode
//!   and device plus page 1 and the `vault` root page, so any later write to the file
//!   changes it; (2) a [`Vault`] handle's first snapshot is always full (`fresh_open`),
//!   since every close (which runs `PRAGMA optimize` and checkpoints) is followed by an
//!   open. A steady, unclosed vault still reads only WAL-dirty ranges.
//! - The pin covers reading, hashing and sealing and never network I/O. The
//!   sealed range objects that changed go to staging; the tree's nodes go to
//!   the node cache. The checkpoint comes after the pin ends, and the device
//!   row is written before it (clearing `disk_mark`, which is recorded once the
//!   checkpoint finishes), so a crash between them only makes the next
//!   snapshot read more.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use centraid_media::sealed::{self, BackupKeys, Class, Name, PlaintextHash, Ref};

use super::content;
use super::directory::Directory;
use super::files;
use super::staging::Staging;
use super::state::{Device, DeviceState};
use super::tree::{self, Assembled, Entry, EntryKind, Header, Root};
use super::{Result, invariant};
use crate::bytes::BlobStore;
use crate::file::Vault;
use crate::pagesource::PinnedPages;

/// A full read every this many snapshots: the 4th, so three snapshots read
/// only what the WAL names between two full ones.
pub const FULL_EVERY: u64 = 4;

/// A full read at least this often.
pub const FULL_AT_LEAST_MS: u64 = 24 * 60 * 60 * 1000;

/// Fold an oversized `-wal` into `state.db`'s persistent `dirty_range` set when it reaches this
/// many frames (~16 MiB at 4 KiB pages) while unpaired or offline (spec §5, R5).
pub const WAL_FOLD_FRAMES: usize = 4_096;

/// What a snapshot asks of the caller.
#[derive(Clone, Copy)]
pub struct Options<'a> {
    pub now_ms: u64,
    /// Read every range and set `db_hash` whatever the cadence says.
    pub force_full: bool,
    /// Stage every range the root names, not only the ones that changed: for a gateway that is
    /// owed a range staging no longer holds.
    pub restage_all: bool,
    /// Leave video originals out of the tree's originals class (thumbnails/posters are still kept).
    pub exclude_videos: bool,
    pub bugs: super::engine::Bugs,
    /// Called once the pin has begun, before any range is read: a test commits here to prove
    /// what is written during a pin is carried to the next snapshot.
    pub on_pin: Option<&'a dyn Fn()>,
}

impl Options<'_> {
    /// The ordinary options at `now_ms`.
    #[must_use]
    pub fn at(now_ms: u64) -> Self {
        Self {
            now_ms,
            force_full: false,
            restage_all: false,
            exclude_videos: false,
            bugs: super::engine::Bugs::none(),
            on_pin: None,
        }
    }
}

/// What one snapshot did.
#[derive(Debug, Clone)]
pub struct Taken {
    pub root: Ref,
    pub full: bool,
    /// Range reads through the pin: the work a one-page edit is bounded by.
    pub ranges_read: u64,
    /// Ranges whose sealed name is new (staged).
    pub ranges_new: usize,
    /// Blobs whose chunks were read and sealed for the first time.
    pub entries_new: usize,
    pub writes: u64,
}

/// The newest snapshot's tree, when the node cache still holds it.
fn previous(state: &DeviceState, keys: &BackupKeys, device: &Device) -> Option<(Ref, Root)> {
    let (name, _) = device.newest?;
    let plaintext = state.get_node(&name).ok()??;
    let reference = sealed::seal(keys, Class::Records, &plaintext)
        .ok()?
        .reference();
    if reference.name != name {
        return None;
    }
    let root = tree::root_of(state, &reference).ok()?;
    tree::ranges_of(state, &root).ok()?;
    Some((reference, root))
}

fn taken_at_ms_of(file: &files::ContentFile) -> i64 {
    crate::clock::parse_iso_ms(&file.created_at).unwrap_or(0)
}

fn entry_of(
    blobs: Option<&dyn BlobStore>,
    keys: &BackupKeys,
    state: &DeviceState,
    file: &files::ContentFile,
    size: u64,
    exclude_videos: bool,
) -> Result<Entry> {
    let taken_at_ms = taken_at_ms_of(file);
    let excluded = exclude_videos && file.is_original() && file.video;
    if excluded {
        return Ok(Entry {
            h: file.h,
            kind: EntryKind::ExcludedOriginal,
            size,
            media_type: file.media_type.clone(),
            taken_at_ms,
            original: Vec::new(),
            thumbnail: Vec::new(),
        });
    }
    let is_original = file.is_original();
    let kind = if is_original {
        EntryKind::Original
    } else {
        EntryKind::Thumbnail
    };
    let class = if is_original {
        Class::Originals
    } else {
        Class::Thumbnails
    };
    let refs = match content::refs_of_from(blobs, keys, &file.h, size, class)? {
        Some(refs) => {
            if !refs.is_empty() {
                state.put_blob_chunks(&file.h, class, &refs)?;
            }
            refs
        }
        None if size > 0 => state.blob_chunks(&file.h, class)?,
        None => Vec::new(),
    };
    let (original, thumbnail) = if is_original {
        (refs, Vec::new())
    } else {
        (Vec::new(), refs)
    };
    Ok(Entry {
        h: file.h,
        kind,
        size,
        media_type: file.media_type.clone(),
        taken_at_ms,
        original,
        thumbnail,
    })
}

/// Fingerprint of the main vault file on disk (ignoring `-wal`): its filesystem identity and
/// metadata (length, modification time at full precision, and on unix inode and device), its page 1
/// and the `vault` table's root page.
///
/// In WAL mode with `wal_autocheckpoint = 0`, normal commits write only to `-wal` and leave the
/// main file untouched until the core checkpoints after a snapshot. Anything else that reaches the
/// main file (SQLite's checkpoint on last-connection close, which follows `PRAGMA optimize`; a
/// search-only commit that a later close folds in) changes its modification time, whatever pages
/// it wrote, so the mark does not depend on which tables a commit touched. The page hashes are
/// kept as a second witness for filesystems with coarse timestamps.
fn disk_mark(
    path: &Path,
    page_size: u64,
    vault_root_page: Option<u64>,
) -> Result<Option<[u8; 32]>> {
    let page_len = usize::try_from(page_size).unwrap_or(0);
    if page_len == 0 {
        return Ok(None);
    }
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    let len = meta.len();
    if len < page_size {
        return Ok(None);
    }
    let mut hasher = blake3::Hasher::new();
    hasher.update(&len.to_le_bytes());
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    hasher.update(&modified.to_le_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        hasher.update(&meta.ino().to_le_bytes());
        hasher.update(&meta.dev().to_le_bytes());
        hasher.update(&meta.ctime().to_le_bytes());
        hasher.update(&meta.ctime_nsec().to_le_bytes());
    }

    let mut page = vec![0_u8; page_len];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut page)?;
    hasher.update(&page);

    if let Some(root) = vault_root_page
        && root > 1
    {
        let offset = (root - 1).saturating_mul(page_size);
        if offset.saturating_add(page_size) <= len {
            file.seek(SeekFrom::Start(offset))?;
            file.read_exact(&mut page)?;
            hasher.update(&page);
        }
    }

    Ok(Some(*hasher.finalize().as_bytes()))
}

/// Fold an oversized `-wal` into `state.db`'s persistent `dirty_range` set and truncate `-wal`
/// when unpaired or offline (spec §5, R5). Returns `true` if a fold ran.
///
/// # Errors
/// A WAL that will not read, a vault connection that cannot checkpoint, or a state error.
pub fn fold_wal_if_needed(
    vault: &Vault,
    state: &DeviceState,
    now_ms: u64,
    threshold_frames: usize,
) -> Result<bool> {
    if vault.depth.get() > 0 {
        return Err(invariant(
            "fold_wal_if_needed was asked for inside a commit; checkpoint between commits",
        ));
    }
    let path = vault.path().to_owned();
    let frames = crate::backup::wal::frame_pages(&path)?;
    if frames.len() < threshold_frames || frames.is_empty() {
        return Ok(false);
    }
    let mut failure: Option<super::PlaneError> = None;
    vault.with_exclusive_connection(|connection| {
        let step = (|| -> Result<()> {
            let page_size = u64::try_from(
                connection.query_row("PRAGMA page_size", [], |row| row.get::<_, i64>(0))?,
            )
            .unwrap_or(0);
            if page_size == 0 {
                return Err(invariant("vault page_size is zero during WAL fold"));
            }
            let vault_root_page = {
                use rusqlite::OptionalExtension as _;
                connection
                    .query_row(
                        "SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'vault'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .and_then(|root| u64::try_from(root).ok())
            };
            let all_frames = crate::backup::wal::frame_pages(&path)?;
            let ranges = crate::backup::wal::ranges_of(all_frames, page_size);
            state.add_dirty_ranges(ranges, now_ms)?;
            state.set_disk_mark(None)?;
            let checkpointed = connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    row.get::<_, i64>(0)
                })
                .is_ok_and(|busy| busy == 0);
            if checkpointed && let Ok(mark @ Some(_)) = disk_mark(&path, page_size, vault_root_page)
            {
                let _ = state.set_disk_mark(mark.as_ref());
            }
            Ok(())
        })();
        if let Err(error) = step {
            failure = Some(error);
        }
        Ok(())
    })?;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(true)
}

/// Populate `blob_chunk` in `state` from every entry reachable under `root_ref` (e.g., on
/// `VAULT_KNOWN` re-pair after a `state.db` reset, spec §5). Returns the count of entries
/// hydrated.
///
/// # Errors
/// Missing or malformed tree nodes, or a state write failure.
pub fn hydrate_blob_chunks_from_root(state: &DeviceState, root_ref: &Ref) -> Result<usize> {
    let root = tree::root_of(state, root_ref)?;
    let entries = tree::entries_of(state, &root.blobs)?;
    let mut hydrated = 0;
    for entry in entries {
        let mut any = false;
        if !entry.original.is_empty() {
            state.put_blob_chunks(&entry.h, Class::Originals, &entry.original)?;
            any = true;
        }
        if !entry.thumbnail.is_empty() {
            state.put_blob_chunks(&entry.h, Class::Thumbnails, &entry.thumbnail)?;
            any = true;
        }
        if any {
            hydrated += 1;
        }
    }
    Ok(hydrated)
}

/// Take one snapshot of the vault at `vault_path` into `state` and `staging` without holding
/// any lock on the vault writer during the read pin, sealing, or tree assembly (spec §5).
///
/// `finish` runs only at the end to acquire the vault's exclusive connection for recording
/// post-pin WAL carry, clearing `dirty_range`, updating `device`, and running
/// `PRAGMA wal_checkpoint(TRUNCATE)`.
///
/// # Errors
/// A damaged vault (`VaultError::Damaged`: no head may be signed over it), a
/// vault that will not read, a full staging area, or a node that will not seal.
#[allow(clippy::too_many_arguments)]
pub fn take_unlocked(
    vault_path: &Path,
    blobs: Option<&dyn BlobStore>,
    fresh_open: bool,
    now_text: &str,
    now_clock_ms: i64,
    keys: &BackupKeys,
    state: &DeviceState,
    staging: &Staging,
    directory: &Directory,
    options: Options<'_>,
    finish: impl FnOnce(
        &mut dyn FnMut(&rusqlite::Connection) -> crate::error::Result<()>,
    ) -> crate::error::Result<()>,
) -> Result<Taken> {
    let device = state.device()?;
    let prior_disk_mark = state.disk_mark()?;
    let prior = previous(state, keys, &device);
    let prior_ranges = match &prior {
        Some((_, root)) => tree::ranges_of(state, root)?,
        None => Vec::new(),
    };
    let prior_entries: BTreeMap<PlaintextHash, Entry> = match &prior {
        Some((_, root)) => tree::entries_of(state, &root.blobs)?
            .into_iter()
            .map(|entry| (entry.h, entry))
            .collect(),
        None => BTreeMap::new(),
    };

    let before = crate::backup::wal::inspect(vault_path)?;
    let mut pinned = PinnedPages::begin(vault_path)?;
    let during = crate::backup::wal::frame_pages(vault_path)?;
    if let Some(on_pin) = options.on_pin {
        on_pin();
    }
    let page_size = pinned.page_size();
    let page_count = pinned.page_count();
    let range_count = pinned.range_count();
    let vault_root_page = pinned.root_page("vault")?;
    let live_disk_mark = disk_mark(vault_path, page_size, vault_root_page)?;
    // A handle's first snapshot trusts nothing: the file may have been closed (checkpointed and
    // optimized) and reopened since the last one.
    let disk_changed = fresh_open || prior_disk_mark.is_none() || prior_disk_mark != live_disk_mark;

    let cadence = device.since_full + 1 >= FULL_EVERY
        || device
            .full_ms
            .is_none_or(|at| options.now_ms.saturating_sub(at) >= FULL_AT_LEAST_MS);
    let full = options.force_full
        || prior.is_none()
        || ((cadence || disk_changed) && !options.bugs.no_full_read())
        || prior
            .as_ref()
            .is_some_and(|(_, root)| root.page_size != page_size);

    let mut dirty: BTreeSet<u64> = crate::backup::wal::ranges_of(
        device.carry.iter().copied().chain(during.iter().copied()),
        page_size,
    );
    let consumed_dirty = state.dirty_ranges_with_stamp()?;
    dirty.extend(consumed_dirty.iter().map(|(range, _)| *range));
    // The vault grew or shrank: the range that held the old last page changed length, and every
    // range past it is new.
    if prior
        .as_ref()
        .is_none_or(|(_, root)| root.page_count != page_count)
    {
        dirty.extend(
            (prior_ranges.len() as u64)
                .min(range_count)
                .saturating_sub(1)..range_count,
        );
    }

    let mut ranges: Vec<Ref> = Vec::with_capacity(usize::try_from(range_count).unwrap_or(0));
    let mut ranges_new = 0;
    let mut seal_range = |index: u64, bytes: &[u8], ranges: &mut Vec<Ref>| -> Result<()> {
        let sealed = sealed::seal(keys, Class::Records, bytes)?;
        let slot = usize::try_from(index).unwrap_or(usize::MAX);
        if prior_ranges.get(slot).map(|prior| prior.name) == Some(sealed.name) {
            ranges.push(prior_ranges[slot]);
            if options.restage_all {
                let staged = staging.put(&sealed.name, &sealed.object)?;
                state.stage(
                    &sealed.name,
                    &staged.to_string_lossy(),
                    sealed.object.len() as u64,
                )?;
            }
        } else {
            let staged = staging.put(&sealed.name, &sealed.object)?;
            state.stage(
                &sealed.name,
                &staged.to_string_lossy(),
                sealed.object.len() as u64,
            )?;
            ranges.push(sealed.reference());
            ranges_new += 1;
        }
        Ok(())
    };
    let db_hash = if full {
        let hash = pinned.hash_with(&mut |index, bytes| seal_range(index, bytes, &mut ranges))?;
        Some(hash)
    } else {
        for index in 0..range_count {
            if dirty.contains(&index) {
                let bytes = pinned.range(index)?.to_vec();
                seal_range(index, &bytes, &mut ranges)?;
            } else {
                ranges.push(prior_ranges[usize::try_from(index).unwrap_or(0)]);
            }
        }
        None
    };
    let census = pinned.census()?;
    let claims = pinned.blobs()?;
    let live: BTreeMap<PlaintextHash, files::ContentFile> = pinned
        .content_files(now_text, now_clock_ms)?
        .into_iter()
        .map(|file| (file.h, file))
        .collect();
    let user_version = pinned.user_version()?;
    let (writes, _) = pinned.history()?;
    pinned.quick_check()?;
    let ranges_read = pinned.reads();
    pinned.end()?;
    if ranges.len() as u64 != range_count {
        return Err(invariant(
            "a snapshot named a different number of ranges than the vault has",
        ));
    }

    // Blobs: every claim that is still the member's to keep safe, newest to be read once.
    let mut entries = Vec::with_capacity(claims.len());
    let mut entries_new = 0;
    for (h, size) in claims {
        let Some(file) = live.get(&h) else { continue };
        let excluded = options.exclude_videos && file.is_original() && file.video;
        let expected_kind = if file.is_original() {
            EntryKind::Original
        } else {
            EntryKind::Thumbnail
        };
        if !excluded
            && let Some(known) = prior_entries.get(&h)
            && known.kind == expected_kind
            && known.has_bytes()
            && known.size == size
        {
            let mut reused = known.clone();
            reused.media_type.clone_from(&file.media_type);
            reused.taken_at_ms = taken_at_ms_of(file);
            entries.push(reused);
            continue;
        }
        let had_prior_bytes = prior_entries
            .get(&h)
            .is_some_and(|known| known.kind != EntryKind::ExcludedOriginal && known.has_bytes());
        let entry = entry_of(blobs, keys, state, file, size, options.exclude_videos)?;
        if !excluded && entry.has_bytes() && !had_prior_bytes {
            entries_new += 1;
        }
        entries.push(entry);
    }

    let directory_json = directory.to_json()?;
    let directory_object = sealed::seal(keys, Class::Records, &directory_json)?;
    state.put_node(&directory_object.name, &directory_json)?;
    let assembled: Assembled = tree::assemble(
        keys,
        Header {
            writes,
            user_version: u64::try_from(user_version).unwrap_or(0),
            page_size,
            page_count,
            taken_at_ms: options.now_ms,
            census: census
                .into_iter()
                .map(|(table, rows)| (table, u64::try_from(rows).unwrap_or(0)))
                .collect(),
            db_hash,
        },
        &ranges,
        &entries,
        directory_object.reference(),
    )?;
    for made in &assembled.nodes {
        state.put_node(&made.sealed.name, &made.plaintext)?;
    }

    // The device row first (clearing `disk_mark`), the checkpoint after, then `disk_mark` once the
    // checkpoint finishes: a crash anywhere in between leaves `disk_mark = None` and only makes
    // the next snapshot read more. All of it happens while nothing can commit.
    let mut failure = None;
    let kept = before.pages.len();
    let mut commit_step = |connection: &rusqlite::Connection| -> crate::error::Result<()> {
        let mut wal_reset = false;
        let step = (|| -> Result<()> {
            let after = crate::backup::wal::inspect(vault_path)?;
            let pre_ckpt_mark = disk_mark(vault_path, page_size, vault_root_page)?;
            wal_reset = (before.salts.is_some() && after.salts != before.salts)
                || after.pages.len() < kept
                || after.pages[..kept] != before.pages[..]
                || pre_ckpt_mark != live_disk_mark;
            let carry = if wal_reset {
                after.pages
            } else {
                after.pages[kept..].to_vec()
            };
            state.set_device(&Device {
                newest: Some((assembled.root.name, options.now_ms)),
                since_full: if full { 0 } else { device.since_full + 1 },
                full_ms: if full {
                    Some(options.now_ms)
                } else {
                    device.full_ms
                },
                carry,
            })?;
            state.clear_dirty_ranges_matching(&consumed_dirty)?;
            state.set_exclude_videos(options.exclude_videos)?;
            Ok(())
        })();
        if let Err(error) = step {
            failure = Some(error);
            return Ok(());
        }
        // Busy (a reader holds the log) is not a failure: the next snapshot re-reads those frames
        // and, seeing `disk_mark = None`, takes a full read.
        let checkpointed = connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .is_ok_and(|busy| busy == 0);
        if !wal_reset
            && checkpointed
            && let Ok(mark @ Some(_)) = disk_mark(vault_path, page_size, vault_root_page)
        {
            let _ = state.set_disk_mark(mark.as_ref());
        }
        Ok(())
    };
    finish(&mut commit_step)?;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(Taken {
        root: assembled.root,
        full,
        ranges_read,
        ranges_new,
        entries_new,
        writes,
    })
}

/// Take one snapshot of `vault` into `state` and `staging`.
///
/// # Errors
/// A damaged vault (`VaultError::Damaged`: no head may be signed over it), a
/// vault that will not read, a full staging area, or a node that will not seal.
pub fn take(
    vault: &Vault,
    keys: &BackupKeys,
    state: &DeviceState,
    staging: &Staging,
    directory: &Directory,
    options: Options<'_>,
) -> Result<Taken> {
    if vault.depth.get() > 0 {
        return Err(invariant(
            "a snapshot was asked for inside a commit; a snapshot is taken between commits",
        ));
    }
    let now_text = vault.clock().now_text();
    let now_clock_ms = vault.clock().now_ms();
    let taken = take_unlocked(
        vault.path(),
        vault.blobs().map(|s| s as &dyn BlobStore),
        vault.fresh_open.get(),
        &now_text,
        now_clock_ms,
        keys,
        state,
        staging,
        directory,
        options,
        |step| {
            vault.with_exclusive_connection(|connection| {
                step(connection).map_err(|err| match err {
                    crate::error::VaultError::Sqlite(sql) => sql,
                    other => rusqlite::Error::ToSqlConversionFailure(Box::new(other)),
                })
            })
        },
    )?;
    if taken.full {
        vault.fresh_open.set(false);
    }
    Ok(taken)
}

/// Take one snapshot using brief lock acquisitions via `with_vault` only to read clock/path
/// metadata before pinning and to checkpoint via `with_exclusive_connection` at the end,
/// keeping the caller's vault mutex unlocked throughout `PinnedPages`, page hashing/sealing,
/// blob sealing, and tree assembly (spec §5).
///
/// # Errors
/// A damaged vault (`VaultError::Damaged`: no head may be signed over it), a
/// vault that will not read, a full staging area, or a node that will not seal.
pub fn take_with_vault_slot(
    blobs: Option<&dyn BlobStore>,
    keys: &BackupKeys,
    state: &DeviceState,
    staging: &Staging,
    directory: &Directory,
    options: Options<'_>,
    mut with_vault: impl FnMut(
        &mut dyn FnMut(&Vault) -> crate::error::Result<()>,
    ) -> crate::error::Result<()>,
) -> Result<Taken> {
    let mut meta: Option<(std::path::PathBuf, bool, String, i64)> = None;
    with_vault(&mut |vault| {
        if vault.depth.get() > 0 {
            return Err(crate::error::VaultError::Invariant {
                context:
                    "a snapshot was asked for inside a commit; a snapshot is taken between commits"
                        .to_owned(),
            });
        }
        meta = Some((
            vault.path().to_owned(),
            vault.fresh_open.get(),
            vault.clock().now_text(),
            vault.clock().now_ms(),
        ));
        Ok(())
    })?;
    let (vault_path, fresh_open, now_text, now_clock_ms) =
        meta.ok_or_else(|| invariant("vault metadata missing during snapshot"))?;
    let taken = take_unlocked(
        &vault_path,
        blobs,
        fresh_open,
        &now_text,
        now_clock_ms,
        keys,
        state,
        staging,
        directory,
        options,
        |step| {
            with_vault(&mut |vault| {
                vault.with_exclusive_connection(|connection| {
                    step(connection).map_err(|err| match err {
                        crate::error::VaultError::Sqlite(sql) => sql,
                        other => rusqlite::Error::ToSqlConversionFailure(Box::new(other)),
                    })
                })
            })
        },
    )?;
    if taken.full {
        with_vault(&mut |vault| {
            vault.fresh_open.set(false);
            Ok(())
        })?;
    }
    Ok(taken)
}

/// A directory with no gateways, for a vault with nothing paired.
///
/// # Errors
/// Never in practice.
pub fn empty_directory() -> Result<Directory> {
    Directory::new(Vec::new())
}

/// The name of the vault's root a ref names, as a hex string.
#[must_use]
pub fn root_name(taken: &Taken) -> Name {
    taken.root.name
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A snapshot is taken between commits: inside one the plane refuses by name.
    #[test]
    fn no_snapshot_is_taken_inside_a_commit() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.found("The Household", "Ada").expect("founds");
        let keys = BackupKeys::from_root(&[3; 32]);
        let state = DeviceState::open_beside(vault.path()).expect("state");
        let staging = Staging::open(dir.path().join("vault.staging"), 1 << 30).expect("staging");
        let directory = Directory::new(Vec::new()).expect("a directory");
        let outcome = vault.commit(|_| {
            assert!(matches!(
                take(&vault, &keys, &state, &staging, &directory, Options::at(1)),
                Err(super::super::PlaneError::Invariant { .. })
            ));
            Ok(())
        });
        assert!(outcome.is_ok());
        assert_eq!(crate::pagesource::live_pins(), 0);
        assert!(
            state.device().expect("device").newest.is_none(),
            "and no root exists"
        );
    }
}
