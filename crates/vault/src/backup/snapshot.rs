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
//! - **The periodic full read.** Every [`FULL_EVERY`]th snapshot, and at
//!   least daily, every range is read and the root carries `db_hash`; a range
//!   the dirty set missed (a checkpoint behind the core's back) is caught
//!   there. Other roots carry no `db_hash`.
//! - The pin covers reading, hashing and sealing and never network I/O. The
//!   sealed range objects that changed go to staging; the tree's nodes go to
//!   the node cache. The checkpoint comes after the pin ends, and the device
//!   row is written before it, so a crash between them only makes the next
//!   snapshot read more.

use std::collections::{BTreeMap, BTreeSet};

use centraid_media::sealed::{self, BackupKeys, Class, Name, PlaintextHash, Ref};

use super::content;
use super::directory::Directory;
use super::files;
use super::staging::Staging;
use super::state::{Device, DeviceState};
use super::tree::{self, Assembled, Entry, Header, Root};
use super::{Result, invariant};
use crate::file::Vault;
use crate::pagesource::PinnedPages;

/// A full read every this many snapshots: the 4th, so three snapshots read
/// only what the WAL names between two full ones.
pub const FULL_EVERY: u64 = 4;

/// A full read at least this often.
pub const FULL_AT_LEAST_MS: u64 = 24 * 60 * 60 * 1000;

/// What a snapshot asks of the caller.
#[derive(Clone, Copy)]
pub struct Options<'a> {
    pub now_ms: u64,
    /// Read every range and set `db_hash` whatever the cadence says.
    pub force_full: bool,
    /// Stage every range the root names, not only the ones that changed: for a gateway that is
    /// owed a range staging no longer holds.
    pub restage_all: bool,
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
            bugs: super::engine::Bugs::default(),
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

fn entry_of(
    vault: &Vault,
    keys: &BackupKeys,
    state: &DeviceState,
    file: &files::ContentFile,
    size: u64,
) -> Result<Entry> {
    let class = if file.is_original() {
        Class::Originals
    } else {
        Class::Thumbnails
    };
    let mut refs = content::refs_of(vault, keys, &file.h, size, class)?.unwrap_or_default();
    // An original only the OS photo library holds is listed by the refs its stream was sealed
    // into (§6.4); its chunks reach a gateway from staging as the shell streams them.
    if refs.is_empty() && file.is_original() && size > 0 {
        refs = state.os_chunks(&file.h)?;
    }
    let (original, thumbnail) = if file.is_original() {
        (refs, Vec::new())
    } else {
        (Vec::new(), refs)
    };
    Ok(Entry {
        h: file.h,
        size,
        media_type: file.media_type.clone(),
        taken_at_ms: crate::clock::parse_iso_ms(&file.created_at)
            .and_then(|ms| u64::try_from(ms).ok())
            .unwrap_or(0),
        original,
        thumbnail,
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
    let path = vault.path().to_owned();
    let device = state.device()?;
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

    let before = crate::backup::wal::frame_pages(&path)?;
    let mut pinned = PinnedPages::begin(&path)?;
    let during = crate::backup::wal::frame_pages(&path)?;
    if let Some(on_pin) = options.on_pin {
        on_pin();
    }
    let page_size = pinned.page_size();
    let page_count = pinned.page_count();
    let range_count = pinned.range_count();

    let cadence = device.since_full + 1 >= FULL_EVERY
        || device
            .full_ms
            .is_none_or(|at| options.now_ms.saturating_sub(at) >= FULL_AT_LEAST_MS);
    let full = options.force_full
        || prior.is_none()
        || (cadence && !options.bugs.no_full_read())
        || prior
            .as_ref()
            .is_some_and(|(_, root)| root.page_size != page_size);

    let mut dirty: BTreeSet<u64> = crate::backup::wal::ranges_of(
        device.carry.iter().copied().chain(during.iter().copied()),
        page_size,
    );
    // The vault grew or shrank: the range that held the old last page changed length, and every
    // range past it is new.
    if prior
        .as_ref()
        .is_none_or(|(_, root)| root.page_count != page_count)
    {
        dirty.extend((prior_ranges.len() as u64).saturating_sub(1)..range_count);
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
    let live: BTreeMap<PlaintextHash, files::ContentFile> = files::content_files(vault)?
        .into_iter()
        .map(|file| (file.h, file))
        .collect();
    let mut entries = Vec::with_capacity(claims.len());
    let mut entries_new = 0;
    for (h, size) in claims {
        let Some(file) = live.get(&h) else { continue };
        if let Some(known) = prior_entries.get(&h)
            && known.has_bytes()
            && known.size == size
        {
            entries.push(known.clone());
            continue;
        }
        let entry = entry_of(vault, keys, state, file, size)?;
        if entry.has_bytes() {
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

    // The device row first, the checkpoint after: a crash between them only makes the next
    // snapshot read more. Both happen while nothing can commit.
    let mut failure = None;
    let kept = before.len();
    vault.with_exclusive_connection(|connection| {
        let step = (|| -> Result<()> {
            let after = crate::backup::wal::frame_pages(&path)?;
            let carry = if after.len() >= kept {
                after[kept..].to_vec()
            } else {
                after
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
            Ok(())
        })();
        if let Err(error) = step {
            failure = Some(error);
            return Ok(());
        }
        // Busy (a reader holds the log) is not a failure: the next snapshot re-reads those frames.
        let _ = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            row.get::<_, i64>(0)
        });
        Ok(())
    })?;
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
