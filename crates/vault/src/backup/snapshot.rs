//! A snapshot: the vault copied page for page, cut into named ranges and
//! described by a manifest; then asked about, spooled and settled (#1080,
//! "The vault snapshot plane").
//!
//! ```text
//! copy      sqlite3_backup of the live vault into a scratch file   (holds the vault)
//! describe  census, 64 KiB page-aligned ranges, their names, the manifest  (does not)
//! plan      one `exists` for every range and the manifest
//! spool     seal only what is missing, queue it in the ledger
//! settle    once every range and the manifest are confirmed, move the head
//! ```
//!
//! ## PAGE-IDENTICAL, SO AN UNCHANGED RANGE HAS AN UNCHANGED NAME
//!
//! The online backup API copies page N to page N, so a range no commit touched
//! is byte-identical to the last snapshot's, hashes the same, and is named the
//! same: `exists` answers "held" and nothing is sealed for it. A snapshot costs
//! hashing the file plus sealing the ranges that changed (#1080 ruling 5). The
//! vault never runs `VACUUM` and keeps `auto_vacuum = NONE`, which is what
//! keeps a page where it was (`crate::file`).
//!
//! ## WHY A RANGE IS 64 KiB (Q-1080-B1, the root's ruling A14)
//!
//! A range that holds one changed page is sealed again whole, so the range
//! size decides what a snapshot costs. Measured on the drill's vault — 57 MiB,
//! 14,601 pages — after fifty small notes:
//!
//! | Range | Pages changed | Resealed |
//! |---|---|---|
//! | 4 MiB | about 300, across some fifty b-trees | 52 of 57 MiB (13 of 15 ranges) |
//! | 64 KiB | the same | about 6 MiB |
//!
//! Small commits land in many b-trees at once — the table, its indexes, the
//! receipts, the full-text index — so their pages are spread across the file,
//! and a large range almost always holds one of them. The cost of a small
//! range is names: a snapshot of that vault is some nine hundred ranges, which
//! `exists` asks about a thousand at a time and the mover sends in bundles
//! (A14, A15). The manifest grows with them and its format does not change.
//!
//! ## THE COPY CANNOT INTERLEAVE WITH A COMMIT, BY CONSTRUCTION (R-1080-B6)
//!
//! [`copy`] runs the whole backup in one step on the vault's own connection,
//! holding `&Vault`, and `Vault` is `!Sync`: no other thread can hold the vault
//! while the copy does, and a vault shared across threads is behind a `Mutex`
//! that serialises `commit` and `copy`. The assertion below this header fails
//! to compile if `Vault` ever becomes `Sync`. The one interleaving left — a
//! copy asked for from inside a commit, on the connection holding the write —
//! SQLite answers `BUSY`, and [`copy`] refuses it first, by name.
//!
//! ## THE CENSUS IS COUNTED ON THE COPY
//!
//! Every table a member has rows in, by `count(*)` on the scratch copy after
//! the vault is released: SQLite's own tables, FTS5's shadow tables and every
//! virtual table are left out, the same rule the commit guard reports changes
//! by. It costs a scan of the copy, off the vault and off the request path, and
//! a restore compares it table by table.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use centraid_media::sealed;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use super::ledger::{Ledger, PartKind, Queued};
use super::naming::{BackupKeys, Digest, Name, PlaintextHash, name};
use super::spool::Spool;
use super::store::{self, Head, Store, StoreError};
use super::{Result, invariant};
use crate::clock::Clock;
use crate::file::Vault;

const _: fn() = || {
    trait AmbiguousIfSync<A> {
        fn some_item() {}
    }
    impl<T: ?Sized> AmbiguousIfSync<()> for T {}
    struct IsSync;
    impl<T: ?Sized + Sync> AmbiguousIfSync<IsSync> for T {}
    let _ = <Vault as AmbiguousIfSync<_>>::some_item;
};

/// A range: 64 KiB, a whole number of pages at any page size SQLite allows
/// (its largest page is 64 KiB). See the module header for why this size.
pub const RANGE_BYTES: u64 = 64 * 1024;

/// The manifest format this build writes and reads.
pub const MANIFEST_VERSION: u32 = 2;

/// What the manifest's `app` says when the caller has nothing better.
pub const APP: &str = concat!("centraid-vault/", env!("CARGO_PKG_VERSION"));

/// The snapshot manifest: #1080's keys, in #1080's order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub v: u32,
    /// The vault identity key, hex: which vault this is a snapshot of.
    pub vault_id: String,
    pub taken_at_ms: u64,
    pub page_size: u32,
    pub db_len: u64,
    /// BLAKE3 of the whole copied file.
    pub db_hash: PlaintextHash,
    pub user_version: i64,
    /// The build that took it.
    pub app: String,
    pub ranges: Vec<RangeRef>,
    /// Rows per table.
    pub census: BTreeMap<String, i64>,
}

/// One range, as the manifest names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RangeRef {
    pub i: u32,
    pub name: Name,
    pub len: u64,
}

impl Manifest {
    /// The JSON whose BLAKE3 names the manifest.
    ///
    /// # Errors
    /// Never in practice: every field serialises.
    pub fn to_json(&self) -> Result<Vec<u8>> {
        serde_json::to_vec(self).map_err(|error| invariant(format!("the manifest: {error}")))
    }

    /// Read a manifest back, refusing one this build did not write.
    ///
    /// # Errors
    /// A version other than [`MANIFEST_VERSION`], a field this version does
    /// not define, or ranges that do not tile `db_len`.
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|error| invariant(format!("the manifest is not JSON: {error}")))?;
        let version = value.get("v").and_then(serde_json::Value::as_u64);
        if version != Some(u64::from(MANIFEST_VERSION)) {
            return Err(invariant(format!(
                "the manifest is version {version:?}; this build reads {MANIFEST_VERSION}"
            )));
        }
        let manifest: Self = serde_json::from_value(value)
            .map_err(|error| invariant(format!("the manifest: {error}")))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// The ranges tile the file: in order from 0, each a full range but the
    /// last, summing to `db_len`, which is whole pages.
    fn validate(&self) -> Result<()> {
        if !self.page_size.is_power_of_two() || !(512..=65_536).contains(&self.page_size) {
            return Err(invariant(format!(
                "page_size {} is not SQLite's",
                self.page_size
            )));
        }
        if self.db_len == 0 || !self.db_len.is_multiple_of(u64::from(self.page_size)) {
            return Err(invariant("db_len is not a whole number of pages"));
        }
        let mut covered = 0_u64;
        for (position, range) in self.ranges.iter().enumerate() {
            let last = position + 1 == self.ranges.len();
            if u64::from(range.i) != position as u64
                || range.len == 0
                || range.len > RANGE_BYTES
                || (!last && range.len != RANGE_BYTES)
            {
                return Err(invariant(format!(
                    "range {} does not tile the file",
                    range.i
                )));
            }
            covered += range.len;
        }
        if covered != self.db_len {
            return Err(invariant("the ranges do not cover db_len"));
        }
        Ok(())
    }

    /// Every distinct range name.
    #[must_use]
    pub fn range_names(&self) -> BTreeSet<Name> {
        self.ranges.iter().map(|range| range.name).collect()
    }
}

/// One range of a snapshot, with what the manifest does not carry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Range {
    pub i: u32,
    pub offset: u64,
    pub len: u64,
    /// BLAKE3 of the range's bytes; its name is `name(h, 0)`.
    pub h: PlaintextHash,
    pub name: Name,
}

/// A snapshot taken: the scratch copy, its ranges and its manifest.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// The scratch copy the ranges are read from until they are spooled.
    pub path: PathBuf,
    pub manifest: Manifest,
    pub manifest_json: Vec<u8>,
    pub manifest_name: Name,
    pub ranges: Vec<Range>,
}

impl Snapshot {
    /// Remove the scratch copy.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn discard(self) -> Result<()> {
        remove_copy(&self.path)
    }
}

/// The page-identical copy and when it was taken.
#[derive(Debug, Clone)]
pub struct Copied {
    pub path: PathBuf,
    pub taken_at_ms: u64,
}

/// Copy the vault page for page into a fresh file under `scratch_dir`.
///
/// The caller holds the vault for this call alone; everything after it reads
/// the copy.
///
/// # Errors
/// A copy asked for inside a commit, or SQLite's or the filesystem's refusal.
pub fn copy(vault: &Vault, scratch_dir: &Path) -> Result<Copied> {
    if vault.depth.get() > 0 {
        return Err(invariant(
            "a snapshot was asked for inside a commit; a copy is taken between commits",
        ));
    }
    fs::create_dir_all(scratch_dir)?;
    let taken_at_ms = u64::try_from(vault.clock().now_ms()).unwrap_or(0);
    // A RANDOM SUFFIX, not the time alone: a copy whose ranges are still
    // being spooled must never be replaced by a second copy taken in the same
    // millisecond, or by any copy under a clock a test holds still.
    let path = scratch_dir.join(format!(
        "snapshot-{taken_at_ms}-{:016x}.db",
        rand::random::<u64>()
    ));
    remove_copy(&path)?;
    backup_into(vault.connection(), &path)?;
    Ok(Copied { path, taken_at_ms })
}

/// `sqlite3_backup` of `source` into a new file at `target`, in ONE step:
/// `-1` is every remaining page, so the copy is one read transaction and
/// there is no window in which it is half-made while the source moves.
fn backup_into(source: &Connection, target: &Path) -> Result<()> {
    let mut destination = Connection::open(target)?;
    {
        let backup = rusqlite::backup::Backup::new(source, &mut destination)?;
        let step = backup.step(-1)?;
        if step != rusqlite::backup::StepResult::Done {
            return Err(invariant(format!(
                "the copy did not finish in one step: {step:?}"
            )));
        }
    }
    destination.close().map_err(|(_, error)| error)?;
    Ok(())
}

/// Remove a scratch copy and anything SQLite left beside it.
fn remove_copy(path: &Path) -> Result<()> {
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut target = path.as_os_str().to_owned();
        target.push(suffix);
        match fs::remove_file(PathBuf::from(target)) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.into());
            }
            _ => {}
        }
    }
    Ok(())
}

/// Read a copy through SQLite, read-only, and remove the `-wal` and `-shm`
/// a WAL-mode header makes SQLite create beside it. Reading never changes a
/// page of the copy.
pub(crate) fn read_copy<T>(path: &Path, body: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let outcome = body(&connection);
    connection.close().map_err(|(_, error)| error)?;
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let sidecar = PathBuf::from(sidecar);
        if sidecar.exists() {
            fs::remove_file(&sidecar)?;
        }
    }
    outcome
}

/// Rows per table a member has rows in: no SQLite table, no FTS5 shadow
/// table, no virtual table.
pub(crate) fn census_of(connection: &Connection) -> Result<BTreeMap<String, i64>> {
    let mut statement = connection.prepare(
        r"SELECT name, coalesce(sql, '') FROM sqlite_schema
            WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
            ORDER BY name",
    )?;
    let tables: Vec<String> = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(table, sql)| {
            crate::log::guard::is_reportable(table) && !sql.contains("CREATE VIRTUAL TABLE")
        })
        .map(|(table, _)| table)
        .collect();
    let mut census = BTreeMap::new();
    for table in tables {
        let sql = format!(
            "SELECT count(*) FROM {}",
            crate::log::identifiers::quoted(&table)
        );
        let count: i64 = connection.query_row(&sql, [], |row| row.get(0))?;
        census.insert(table, count);
    }
    Ok(census)
}

/// Census, ranges, names and the manifest of a copy.
///
/// # Errors
/// A `vault_id` that is not 64 lowercase hex, a copy that is not whole pages,
/// or the filesystem's or SQLite's refusal.
pub fn describe(copied: &Copied, keys: &BackupKeys, vault_id: &str, app: &str) -> Result<Snapshot> {
    PlaintextHash::from_hex(vault_id)
        .map_err(|_| invariant("a vault id is the identity key's 64 lowercase hex"))?;
    let (census, page_size, user_version) = read_copy(&copied.path, |connection| {
        let page_size: i64 = connection.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        let user_version: i64 =
            connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        Ok((census_of(connection)?, page_size, user_version))
    })?;
    let page_size = u32::try_from(page_size).map_err(|_| invariant("a negative page size"))?;

    let mut file = File::open(&copied.path)?;
    let db_len = file.metadata()?.len();
    let mut whole = blake3::Hasher::new();
    let mut buffer = vec![0_u8; usize::try_from(RANGE_BYTES).unwrap_or(usize::MAX)];
    let mut ranges = Vec::new();
    let mut offset = 0_u64;
    while offset < db_len {
        let len = RANGE_BYTES.min(db_len - offset);
        let chunk = &mut buffer[..usize::try_from(len).unwrap_or(usize::MAX)];
        file.read_exact(chunk)?;
        whole.update(chunk);
        let h = PlaintextHash::of(chunk);
        let i = u32::try_from(ranges.len()).map_err(|_| invariant("too many ranges"))?;
        ranges.push(Range {
            i,
            offset,
            len,
            h,
            name: name(keys, &h, 0),
        });
        offset += len;
    }

    let manifest = Manifest {
        v: MANIFEST_VERSION,
        vault_id: vault_id.to_owned(),
        taken_at_ms: copied.taken_at_ms,
        page_size,
        db_len,
        db_hash: PlaintextHash::from_bytes(*whole.finalize().as_bytes()),
        user_version,
        app: app.to_owned(),
        ranges: ranges
            .iter()
            .map(|range| RangeRef {
                i: range.i,
                name: range.name,
                len: range.len,
            })
            .collect(),
        census,
    };
    manifest.validate()?;
    let manifest_json = manifest.to_json()?;
    let manifest_name = name(keys, &PlaintextHash::of(&manifest_json), 0);
    Ok(Snapshot {
        path: copied.path.clone(),
        manifest,
        manifest_json,
        manifest_name,
        ranges,
    })
}

/// [`copy`], then [`describe`].
///
/// # Errors
/// Whatever either refuses.
pub fn take(
    vault: &Vault,
    keys: &BackupKeys,
    scratch_dir: &Path,
    vault_id: &str,
    app: &str,
) -> Result<Snapshot> {
    let copied = copy(vault, scratch_dir)?;
    describe(&copied, keys, vault_id, app).inspect_err(|_| {
        let _ = remove_copy(&copied.path);
    })
}

// ─── upload ─────────────────────────────────────────────────────────────────

/// What a destination is missing of a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Indices of the ranges to seal: one per missing name, in file order.
    pub missing_ranges: Vec<u32>,
    pub manifest_missing: bool,
}

/// Ask `store` about every range and the manifest, in as few `exists` calls
/// as the protocol allows.
///
/// # Errors
/// The store's refusal.
pub fn plan(snapshot: &Snapshot, store: &dyn Store) -> Result<Plan> {
    let mut asked: Vec<Name> = snapshot.manifest.range_names().into_iter().collect();
    asked.push(snapshot.manifest_name);
    let missing = store::missing(store, &asked)?;
    let mut seen = BTreeSet::new();
    let missing_ranges = snapshot
        .ranges
        .iter()
        .filter(|range| missing.contains(&range.name) && seen.insert(range.name))
        .map(|range| range.i)
        .collect();
    Ok(Plan {
        missing_ranges,
        manifest_missing: missing.contains(&snapshot.manifest_name),
    })
}

/// Record what `plan` found `gateway_id` already holds: every range and the
/// manifest its `exists` did not name missing. Answers how many names that
/// was.
///
/// The ledger is a cache of the destination's own answer (#1080 ruling 7), and
/// [`settle`] moves the head only over names the ledger confirms. A range held
/// before this device's ledger knew of it — every range of the first snapshot
/// after a restore, or after the ledger was lost — is confirmed here or never,
/// because nothing seals or sends it again.
///
/// # Errors
/// The ledger's refusal.
pub fn confirm_held(
    snapshot: &Snapshot,
    plan: &Plan,
    ledger: &Ledger,
    gateway_id: &str,
    now_ms: u64,
) -> Result<usize> {
    let missing: BTreeSet<Name> = plan
        .missing_ranges
        .iter()
        .filter_map(|index| snapshot.ranges.get(usize::try_from(*index).ok()?))
        .map(|range| range.name)
        .collect();
    let mut held: BTreeMap<Name, u64> = BTreeMap::new();
    for range in &snapshot.ranges {
        if !missing.contains(&range.name) {
            held.insert(range.name, range.len);
        }
    }
    if !plan.manifest_missing {
        held.insert(snapshot.manifest_name, snapshot.manifest_json.len() as u64);
    }
    let held: Vec<(Name, u64)> = held.into_iter().collect();
    ledger.confirm_many(&held, gateway_id, now_ms)?;
    Ok(held.len())
}

/// What [`spool`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spooled {
    /// Sealed into the spool and queued, or found already there.
    pub spooled: Vec<Name>,
    /// Left for a later pass: the spool was at its budget.
    pub deferred: Vec<Name>,
    /// Sealed bytes this call added to the spool.
    pub bytes: u64,
}

/// Seal what `plan` found missing into the spool and queue it, the manifest
/// last and only once every range it names is spooled. The snapshot is
/// recorded in the ledger first, so a collection that runs before it settles
/// knows its names are in flight.
///
/// # Errors
/// The filesystem's, the ledger's or the cipher's refusal.
pub fn spool(
    snapshot: &Snapshot,
    plan: &Plan,
    spool: &Spool,
    ledger: &Ledger,
    keys: &BackupKeys,
    budget: u64,
    now_ms: u64,
) -> Result<Spooled> {
    let json = std::str::from_utf8(&snapshot.manifest_json)
        .map_err(|_| invariant("the manifest is not UTF-8"))?;
    ledger.record_snapshot(&snapshot.manifest_name, snapshot.manifest.taken_at_ms, json)?;
    let queued: BTreeSet<Name> = ledger.queued()?.iter().map(|part| part.name).collect();
    let mut held = spool.bytes()?;
    let mut out = Spooled::default();
    let mut file = File::open(&snapshot.path)?;
    let mut buffer = Vec::new();

    let put = |name: Name, kind: PartKind, sealed: &[u8], out: &mut Spooled| -> Result<u64> {
        let path = spool.write(&name, sealed)?;
        ledger.enqueue(&Queued {
            name,
            part_path: path,
            size: sealed.len() as u64,
            digest: Digest::of(sealed),
            kind,
            media_type: None,
            created_ms: now_ms,
            handed_off_ms: None,
            attempts: 0,
            last_error: None,
        })?;
        out.bytes += sealed.len() as u64;
        out.spooled.push(name);
        Ok(sealed.len() as u64)
    };

    for index in &plan.missing_ranges {
        let range = snapshot
            .ranges
            .get(usize::try_from(*index).unwrap_or(usize::MAX))
            .ok_or_else(|| invariant(format!("the plan names range {index}, which is not here")))?;
        if queued.contains(&range.name) && spool.contains(&range.name) {
            out.spooled.push(range.name);
            continue;
        }
        if held >= budget {
            out.deferred.push(range.name);
            continue;
        }
        buffer.resize(usize::try_from(range.len).unwrap_or(usize::MAX), 0);
        file.seek(SeekFrom::Start(range.offset))?;
        file.read_exact(&mut buffer)?;
        // VERIFY BEFORE SEALING: the name was computed from these bytes when
        // the copy was described, and a part sealed under it from any other
        // bytes would be a range no restore could open as its own.
        if PlaintextHash::of(&buffer) != range.h {
            return Err(invariant(format!(
                "range {} of the scratch copy changed after it was named",
                range.i
            )));
        }
        let sealed = sealed::seal_part(keys, 0, &buffer, true)?;
        held += put(range.name, PartKind::Range, &sealed, &mut out)?;
    }

    if plan.manifest_missing {
        let name = snapshot.manifest_name;
        if queued.contains(&name) && spool.contains(&name) {
            out.spooled.push(name);
        } else if !out.deferred.is_empty() || held >= budget {
            out.deferred.push(name);
        } else {
            let sealed = sealed::seal_part(keys, 0, &snapshot.manifest_json, true)?;
            put(name, PartKind::Manifest, &sealed, &mut out)?;
        }
    }
    Ok(out)
}

/// What [`settle`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    /// The head now names this snapshot.
    HeadSet(Head),
    /// These names are not yet confirmed at the destination.
    Waiting { unconfirmed: Vec<Name> },
    /// The head is somewhere this device did not leave it, and is not a
    /// snapshot this device took. Nothing moved.
    Conflict { current: Option<Head> },
}

/// Move the destination's head to the manifest `manifest_name` once every
/// range it names and the manifest itself are confirmed there.
///
/// The head's `prev` is the head this device last set at the destination. A
/// head that moved to a snapshot this device took but never recorded the ack
/// of (a crash between the two) is adopted and tried once more; any other
/// head is a [`Settled::Conflict`].
///
/// # Errors
/// The ledger's refusal, or a store error other than the conflict.
pub fn settle(
    ledger: &Ledger,
    store: &dyn Store,
    manifest_name: &Name,
    manifest: &Manifest,
    clock: &dyn Clock,
) -> Result<Settled> {
    let gateway = store.gateway_id().to_owned();
    let confirmed = ledger.confirmed_names(&gateway)?;
    let mut needed = manifest.range_names();
    needed.insert(*manifest_name);
    let unconfirmed: Vec<Name> = needed
        .into_iter()
        .filter(|name| !confirmed.contains(name))
        .collect();
    if !unconfirmed.is_empty() {
        return Ok(Settled::Waiting { unconfirmed });
    }

    let mut prev = ledger.head(&gateway)?;
    for attempt in 0..2 {
        match store.set_head(manifest_name, prev.as_ref(), manifest.taken_at_ms) {
            Ok(head) => {
                let now = u64::try_from(clock.now_ms()).unwrap_or(0);
                ledger.set_head(&gateway, manifest_name)?;
                ledger.ack_snapshot(manifest_name, now)?;
                return Ok(Settled::HeadSet(head));
            }
            Err(StoreError::HeadConflict { current }) => {
                let ours = current.is_some_and(|head| {
                    ledger
                        .snapshots()
                        .is_ok_and(|taken| taken.iter().any(|snapshot| snapshot.name == head.name))
                });
                if attempt == 0 && ours {
                    prev = current.map(|head| head.name);
                    continue;
                }
                return Ok(Settled::Conflict { current });
            }
            Err(StoreError::Missing(name)) => {
                ledger.unconfirm(&name, &gateway)?;
                return Ok(Settled::Waiting {
                    unconfirmed: vec![name],
                });
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(invariant("settle tried the head twice"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::VaultError;

    fn founded(dir: &Path) -> Vault {
        let vault = Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        vault
    }

    fn add_party(vault: &Vault, label: &str) {
        let id = vault.ids().next();
        let now = vault.clock().now_text();
        vault
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                     VALUES (?1, 'person', ?2, ?3, ?3)",
                    rusqlite::params![id, label, now],
                )?;
                Ok(())
            })
            .expect("commits");
    }

    fn parties(path: &Path) -> i64 {
        read_copy(path, |connection| {
            Ok(connection.query_row("SELECT count(*) FROM core_party", [], |row| row.get(0))?)
        })
        .expect("counts")
    }

    /// **R-1080-B6.** Inside a commit no copy is made: the plane refuses by
    /// name, and the backup underneath would not run there either — SQLite
    /// answers `BUSY` on the connection holding the write — so no copy can
    /// carry a row that then rolls back. Between commits it holds exactly what
    /// committed.
    #[test]
    fn no_copy_is_made_inside_a_commit_and_one_between_holds_what_committed() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let torn = dir.path().join("torn.db");
        let id = vault.ids().next();
        let now = vault.clock().now_text();
        let outcome = vault.commit(|tx| {
            tx.connection().execute(
                "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
                 VALUES (?1, 'person', 'Nobody', ?2, ?2)",
                rusqlite::params![id, now],
            )?;
            assert!(
                matches!(
                    copy(&vault, &dir.path().join("scratch")),
                    Err(super::super::PlaneError::Invariant { .. })
                ),
                "the plane refuses a copy here"
            );
            let underneath = backup_into(tx.connection(), &torn);
            assert!(
                underneath
                    .as_ref()
                    .is_err_and(|error| error.to_string().contains("Busy")),
                "SQLite does not back up a connection mid-write: {underneath:?}"
            );
            Err::<(), _>(VaultError::Invariant {
                context: "roll back".to_owned(),
            })
        });
        assert!(outcome.is_err());
        let copied = copy(&vault, &dir.path().join("scratch")).expect("copies");
        assert_eq!(parties(&copied.path), 1, "the rolled-back row is nowhere");
    }

    #[test]
    fn a_snapshot_tiles_the_file_and_names_its_ranges_from_their_bytes() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = BackupKeys::from_root(&[3; 32]);
        let vault_id = "ab".repeat(32);
        let snapshot =
            take(&vault, &keys, &dir.path().join("scratch"), &vault_id, APP).expect("takes");
        let bytes = fs::read(&snapshot.path).expect("reads");
        assert_eq!(snapshot.manifest.db_len, bytes.len() as u64);
        assert_eq!(snapshot.manifest.db_hash, PlaintextHash::of(&bytes));
        assert_eq!(snapshot.manifest.page_size, 4096);
        assert!(!snapshot.ranges.is_empty());
        for range in &snapshot.ranges {
            let start = usize::try_from(range.offset).expect("fits");
            let end = start + usize::try_from(range.len).expect("fits");
            assert_eq!(range.h, PlaintextHash::of(&bytes[start..end]));
            assert_eq!(range.name, name(&keys, &range.h, 0));
        }
        assert_eq!(snapshot.manifest.census.get("core_party"), Some(&1));
        assert!(
            !snapshot
                .manifest
                .census
                .keys()
                .any(|table| table.starts_with("sqlite_") || table.ends_with("_docsize")),
            "SQLite's and FTS5's own tables are not a member's rows"
        );
        // Reading the copy changed none of it.
        assert_eq!(
            PlaintextHash::of(&fs::read(&snapshot.path).expect("reads")),
            snapshot.manifest.db_hash
        );

        let json = snapshot.manifest.to_json().expect("serialises");
        assert_eq!(json, snapshot.manifest_json);
        assert_eq!(
            snapshot.manifest_name,
            name(&keys, &PlaintextHash::of(&json), 0)
        );
        let text = String::from_utf8(json.clone()).expect("UTF-8");
        let order = [
            "\"v\"",
            "\"vault_id\"",
            "\"taken_at_ms\"",
            "\"page_size\"",
            "\"db_len\"",
            "\"db_hash\"",
            "\"user_version\"",
            "\"app\"",
            "\"ranges\"",
            "\"census\"",
        ];
        let at: Vec<usize> = order
            .iter()
            .map(|key| text.find(key).expect("a key"))
            .collect();
        assert!(
            at.windows(2).all(|pair| pair[0] < pair[1]),
            "#1080's key order: {text}"
        );
        assert_eq!(
            Manifest::from_json(&json).expect("reads back"),
            snapshot.manifest
        );
        snapshot.discard().expect("discards");
    }

    #[test]
    fn a_manifest_this_build_did_not_write_is_refused() {
        let good = Manifest {
            v: 2,
            vault_id: "ab".repeat(32),
            taken_at_ms: 1,
            page_size: 4096,
            db_len: 8192,
            db_hash: PlaintextHash::of(b"x"),
            user_version: 9,
            app: APP.to_owned(),
            ranges: vec![RangeRef {
                i: 0,
                name: Name::from_bytes([1; 32]),
                len: 8192,
            }],
            census: BTreeMap::new(),
        };
        assert!(Manifest::from_json(&good.to_json().expect("serialises")).is_ok());
        let mut future = serde_json::to_value(&good).expect("a value");
        future["v"] = serde_json::json!(3);
        assert!(Manifest::from_json(future.to_string().as_bytes()).is_err());
        let mut extra = serde_json::to_value(&good).expect("a value");
        extra["surprise"] = serde_json::json!(true);
        assert!(Manifest::from_json(extra.to_string().as_bytes()).is_err());
        let mut short = good;
        short.db_len = 4096;
        assert!(Manifest::from_json(&short.to_json().expect("serialises")).is_err());
    }

    #[test]
    fn a_vault_id_that_is_not_an_identity_key_is_refused() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = BackupKeys::from_root(&[3; 32]);
        assert!(take(&vault, &keys, &dir.path().join("scratch"), "not-hex", APP).is_err());
        assert!(
            fs::read_dir(dir.path().join("scratch"))
                .expect("lists")
                .next()
                .is_none(),
            "a refused snapshot leaves no scratch copy"
        );
    }

    #[test]
    fn a_second_snapshot_of_an_unchanged_vault_names_the_same_ranges() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        add_party(&vault, "Grace");
        let keys = BackupKeys::from_root(&[3; 32]);
        let first =
            take(&vault, &keys, &dir.path().join("a"), &"cd".repeat(32), APP).expect("takes");
        let second =
            take(&vault, &keys, &dir.path().join("b"), &"cd".repeat(32), APP).expect("takes");
        assert_eq!(first.manifest.range_names(), second.manifest.range_names());
        assert_eq!(first.manifest.db_hash, second.manifest.db_hash);
    }

    /// A held clock gives two copies one `taken_at_ms`; they still never share
    /// a file, so neither replaces a copy the other is spooling from.
    #[test]
    fn two_copies_under_a_held_clock_never_share_a_file() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = Vault::create_with(
            dir.path().join("vault.db"),
            Box::new(crate::clock::FixedClock::frozen()),
            Box::new(crate::clock::SeededIds::new("copies")),
        )
        .expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        let scratch = dir.path().join("scratch");
        let first = copy(&vault, &scratch).expect("copies");
        let second = copy(&vault, &scratch).expect("copies");
        assert_eq!(first.taken_at_ms, second.taken_at_ms);
        assert_ne!(first.path, second.path);
        assert!(first.path.exists() && second.path.exists());
    }

    /// **Verify before sealing.** A range is sealed under the name its bytes
    /// were given when the copy was described; a copy that changed since is
    /// refused rather than sealed under a name that is no longer its own.
    #[test]
    fn a_scratch_copy_that_changed_after_it_was_named_is_not_spooled() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = BackupKeys::from_root(&[3; 32]);
        let snapshot = take(
            &vault,
            &keys,
            &dir.path().join("scratch"),
            &"ef".repeat(32),
            APP,
        )
        .expect("takes");
        let store = super::super::store::MemoryStore::new("gw");
        let plan = plan(&snapshot, &store).expect("plans");
        let mut bytes = fs::read(&snapshot.path).expect("reads");
        bytes[5_000] ^= 0xff;
        fs::write(&snapshot.path, &bytes).expect("tampers");
        let ledger = Ledger::open(dir.path().join("vault.backup.db")).expect("a ledger");
        let spool_dir = Spool::open(dir.path().join("vault.spool")).expect("a spool");
        let outcome = spool(&snapshot, &plan, &spool_dir, &ledger, &keys, u64::MAX, 1);
        assert!(
            outcome
                .as_ref()
                .is_err_and(|error| error.to_string().contains("changed after it was named")),
            "{outcome:?}"
        );
        assert!(
            spool_dir.names().expect("lists").is_empty(),
            "nothing was sealed"
        );
    }

    /// **A held range is confirmed from the destination's answer.** A ledger
    /// that never sent a snapshot — a restored phone's, or one that was lost —
    /// finds every range already held; without `confirm_held` the head would
    /// wait on names nothing will ever send again.
    #[test]
    fn ranges_a_destination_already_holds_are_confirmed_and_the_head_moves() {
        use super::super::ledger::Destination;
        use super::super::mover::{Stop, move_queue};
        use super::super::store::MemoryStore;

        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        add_party(&vault, "Grace");
        let keys = BackupKeys::from_root(&[3; 32]);
        let store = MemoryStore::new("gw");
        let destination = |ledger: &Ledger| {
            ledger
                .put_destination(&Destination {
                    gateway_id: "gw".to_owned(),
                    addrs: Vec::new(),
                    cert_der: Vec::new(),
                    token: "t".to_owned(),
                    epoch: 1,
                    label: "laptop".to_owned(),
                    paired_at_ms: 0,
                    last_seen_ms: None,
                    last_ack_ms: None,
                })
                .expect("pairs");
        };
        let vault_id = "ab".repeat(32);

        // One device sends a snapshot whole.
        let first_ledger = Ledger::open(dir.path().join("one.backup.db")).expect("a ledger");
        destination(&first_ledger);
        let first_spool = Spool::open(dir.path().join("one.spool")).expect("a spool");
        let taken = take(&vault, &keys, &dir.path().join("a"), &vault_id, APP).expect("takes");
        let planned = plan(&taken, &store).expect("plans");
        spool(
            &taken,
            &planned,
            &first_spool,
            &first_ledger,
            &keys,
            u64::MAX,
            1,
        )
        .expect("spools");
        let far = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let clock = crate::clock::FixedClock::frozen();
        let moved = move_queue(&first_ledger, &first_spool, &store, far, &clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);

        // A second ledger, knowing nothing, snapshots the same vault — a
        // millisecond later at least, so its manifest is a new name.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let ledger = Ledger::open(dir.path().join("two.backup.db")).expect("a ledger");
        destination(&ledger);
        let again = take(&vault, &keys, &dir.path().join("b"), &vault_id, APP).expect("takes");
        let replanned = plan(&again, &store).expect("plans");
        assert!(replanned.missing_ranges.is_empty(), "every range is held");
        let waiting = settle(
            &ledger,
            &store,
            &again.manifest_name,
            &again.manifest,
            &clock,
        )
        .expect("settles");
        assert!(
            matches!(waiting, Settled::Waiting { .. }),
            "with nothing confirmed the head cannot move: {waiting:?}"
        );
        let confirmed = confirm_held(&again, &replanned, &ledger, "gw", 2).expect("confirms");
        assert_eq!(confirmed, again.manifest.range_names().len());
        let fresh = Spool::open(dir.path().join("two.spool")).expect("a spool");
        let spooled =
            spool(&again, &replanned, &fresh, &ledger, &keys, u64::MAX, 2).expect("spools");
        assert_eq!(
            spooled.spooled,
            vec![again.manifest_name],
            "only the manifest is new"
        );
        let moved = move_queue(&ledger, &fresh, &store, far, &clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert!(matches!(
            settle(&ledger, &store, &again.manifest_name, &again.manifest, &clock)
                .expect("settles"),
            Settled::HeadSet(head) if head.name == again.manifest_name
        ));
    }
}
