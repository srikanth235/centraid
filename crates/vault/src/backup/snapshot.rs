//! A snapshot: the vault read page for page through one pinned reader, cut into named ranges
//! and described by a manifest; then asked about, spooled and settled (#1080, "The vault
//! snapshot plane"; #1191 B11).
//!
//! ```text
//! walk      one pin: 64 KiB ranges, their names, the census, the quick check   (holds no store)
//! seal      inside the walk, only the ranges the previous head did not name
//! plan      one `exists` for every range the walk sealed and the manifest
//! spool     owe each gateway what it lacks, the manifest last
//! settle    once every range and the manifest are confirmed, move the head
//! ```
//!
//! ## PAGE-IDENTICAL, SO AN UNCHANGED RANGE HAS AN UNCHANGED NAME
//!
//! A range is the vault's pages at the same offsets, so a range no commit touched hashes the
//! same and is named the same as in the last snapshot: nothing is sealed for it. A snapshot
//! costs hashing the file plus sealing the ranges that changed (#1080 ruling 5). The vault
//! never runs `VACUUM` and keeps `auto_vacuum = NONE`, which is what keeps a page where it was
//! (`crate::file`).
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
//! write counter, the full-text index — so their pages are spread across the file,
//! and a large range almost always holds one of them. The cost of a small
//! range is names: a snapshot of that vault is some nine hundred ranges, which
//! `exists` asks about a thousand at a time and the mover sends in bundles
//! (A14, A15). The manifest grows with them and its format does not change.
//!
//! ## NO PLAINTEXT COPY OF THE VAULT IS EVER WRITTEN
//!
//! [`crate::pagesource::walk`] opens the vault file read-only on a connection of its own and
//! reads its pages through `sqlite_dbpage` under one WAL read transaction: the vault is the file
//! as it was when the pin began, whatever commits after, and the writer is never held. One
//! range is in memory at a time, and it goes from there to the spool already sealed. The pin
//! ends before the walk returns, and never spans a gateway call (`pagesource::live_pins`). The
//! census, `user_version`, the write counter and `quick_check` are read on the same pin, and a
//! damaged vault returns an error before any manifest exists, so no head is signed over it.
//!
//! ## A VAULT THAT HAS NOT CHANGED IS NOT WALKED AGAIN
//!
//! The vault's own write counter and `user_version` ride in every manifest. A pass whose vault shows
//! the same two as the newest snapshot, held whole at every gateway, takes no snapshot ([`unchanged`]).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use centraid_media::sealed;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use super::naming::{BackupKeys, Digest, Name, PlaintextHash, name};
use super::spool::Spool;
use super::state::{DeviceState, Outbox, OutboxKind};
use super::store::{self, Head, Store, StoreError};
use super::{Result, invariant};
use crate::clock::Clock;
use crate::file::Vault;
use crate::pagesource::{self, RangeRead, Walked};

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
pub const MANIFEST_VERSION: u32 = 3;

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
    /// `vault.writes` in the copy: how many commits had changed something when it was taken. A
    /// takeover compares it with a phone's own copy to tell which is ahead (#1146).
    pub writes: u64,
    /// `vault.written_at` in the copy, as milliseconds on the vault's clock; `None` for a vault
    /// nothing has been written to.
    pub written_at_ms: Option<u64>,
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

/// A snapshot taken: its ranges, its manifest, and which ranges the walk sealed.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub manifest: Manifest,
    pub manifest_json: Vec<u8>,
    pub manifest_name: Name,
    pub ranges: Vec<Range>,
    /// The ranges that changed since the snapshot the walk compared with, sealed into the spool
    /// (or deferred) while the pin was held. No other range's bytes are at hand.
    pub sealed: Sealed,
}

/// **HOW FAR A VAULT COPY HAS RUN**, from the write counter on its `vault` row: how many commits
/// changed something a screen reads, and when the last did. A snapshot's manifest carries the same
/// two figures, so a phone can tell whether a head holds writes its own copy never made (#1080,
/// the sweep's F4) without opening it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct History {
    /// `vault.writes`.
    pub writes: u64,
    /// `vault.written_at`, on the vault's clock; `None` for a vault nothing has been written to.
    pub last_write_ms: Option<u64>,
}

impl History {
    /// What `connection`'s `vault` row says; a file with no vault row has run nothing.
    fn of(connection: &Connection) -> rusqlite::Result<Self> {
        use rusqlite::OptionalExtension as _;
        let row: Option<(i64, Option<String>)> = connection
            .query_row("SELECT writes, written_at FROM vault", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .optional()?;
        let (writes, at) = row.unwrap_or((0, None));
        Ok(Self {
            writes: u64::try_from(writes).unwrap_or(0),
            last_write_ms: at
                .as_deref()
                .and_then(crate::clock::parse_iso_ms)
                .and_then(|at| u64::try_from(at).ok()),
        })
    }
}

/// [`History`] of `vault`.
///
/// # Errors
/// SQLite's refusal.
pub fn history(vault: &Vault) -> Result<History> {
    Ok(vault.read(|connection| Ok(History::of(connection)?))?)
}

/// Whether `vault` shows what `manifest` was taken from: the same write counter, the same moment of
/// the last write and the same `user_version`. A vault that does is not copied again; a commit that
/// changed anything a screen reads, and a migration, show up in one of the three.
///
/// # Errors
/// SQLite's refusal.
pub fn unchanged(vault: &Vault, manifest: &Manifest) -> Result<bool> {
    let now = history(vault)?;
    let user_version: i64 = vault.read(|connection| {
        Ok(connection.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    })?;
    Ok(now.writes == manifest.writes
        && now.last_write_ms == manifest.written_at_ms
        && user_version == manifest.user_version)
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
            !table.starts_with("sqlite_")
                && !crate::log::guard::is_index(table)
                && !sql.contains("CREATE VIRTUAL TABLE")
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

/// The sealer a walk hands the pinned reader: it seals each changed range into the spool the
/// moment it is read, one range in memory at a time, and keeps no plaintext.
///
/// A range already in the spool is not sealed again, and one the budget does not admit is
/// deferred: it is named in the manifest all the same and waits for a later pass.
pub struct RangeSealer<'a> {
    spool: &'a Spool,
    keys: &'a BackupKeys,
    budget: u64,
    held: u64,
    out: Sealed,
    /// The files this sealer wrote, which a walk that fails takes away again.
    wrote: Vec<Name>,
}

/// What a walk sealed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sealed {
    /// Changed ranges whose sealed part is in the spool.
    pub names: BTreeSet<Name>,
    /// Changed ranges the spool's budget did not admit.
    pub deferred: BTreeSet<Name>,
    /// Sealed bytes this walk added to the spool.
    pub bytes: u64,
}

impl<'a> RangeSealer<'a> {
    /// A sealer over `spool` that stops admitting at `budget` bytes.
    ///
    /// # Errors
    /// The filesystem's refusal.
    pub fn new(spool: &'a Spool, keys: &'a BackupKeys, budget: u64) -> Result<Self> {
        Ok(Self {
            spool,
            keys,
            budget,
            held: spool.bytes()?,
            out: Sealed::default(),
            wrote: Vec::new(),
        })
    }

    /// Seal one changed range: the callback [`crate::pagesource::walk`] calls under its pin.
    ///
    /// # Errors
    /// The filesystem's or the cipher's refusal.
    pub fn seal(&mut self, read: &RangeRead, bytes: &[u8]) -> Result<()> {
        if self.spool.contains(&read.name) {
            self.out.names.insert(read.name);
            return Ok(());
        }
        if !super::spool::admits(self.held, read.len, self.budget) {
            self.out.deferred.insert(read.name);
            return Ok(());
        }
        let sealed = sealed::seal_part(self.keys, 0, bytes, true)?;
        self.spool.write(&read.name, &sealed)?;
        self.wrote.push(read.name);
        self.held += sealed.len() as u64;
        self.out.bytes += sealed.len() as u64;
        self.out.names.insert(read.name);
        Ok(())
    }

    /// What was sealed.
    #[must_use]
    pub fn finish(self) -> Sealed {
        self.out
    }

    /// Take away the files this sealer wrote: a walk that failed has no manifest to owe them to.
    fn abandon(&mut self) {
        for name in self.wrote.drain(..) {
            let _ = self.spool.remove(&name);
        }
        self.out = Sealed::default();
    }
}

/// Names and the manifest of a walk.
///
/// # Errors
/// A `vault_id` that is not 64 lowercase hex, or ranges that do not tile the file.
pub fn describe(
    walked: &Walked,
    taken_at_ms: u64,
    keys: &BackupKeys,
    vault_id: &str,
    app: &str,
    sealed: Sealed,
) -> Result<Snapshot> {
    PlaintextHash::from_hex(vault_id)
        .map_err(|_| invariant("a vault id is the identity key's 64 lowercase hex"))?;
    let page_size =
        u32::try_from(walked.page_size).map_err(|_| invariant("a page size past 32 bits"))?;
    let ranges: Vec<Range> = walked
        .ranges
        .iter()
        .map(|read| Range {
            i: read.i,
            offset: u64::from(read.i) * RANGE_BYTES,
            len: read.len,
            h: read.h,
            name: read.name,
        })
        .collect();
    let manifest = Manifest {
        v: MANIFEST_VERSION,
        vault_id: vault_id.to_owned(),
        taken_at_ms,
        page_size,
        db_len: walked.db_len,
        db_hash: walked.db_hash,
        user_version: walked.user_version,
        writes: walked.writes,
        written_at_ms: walked.written_at_ms,
        app: app.to_owned(),
        ranges: ranges
            .iter()
            .map(|range| RangeRef {
                i: range.i,
                name: range.name,
                len: range.len,
            })
            .collect(),
        census: walked.census.clone(),
    };
    manifest.validate()?;
    let manifest_json = manifest.to_json()?;
    let manifest_name = name(keys, &PlaintextHash::of(&manifest_json), 0);
    Ok(Snapshot {
        manifest,
        manifest_json,
        manifest_name,
        ranges,
        sealed,
    })
}

/// **Read the vault and seal what changed, in one pin.** `previous(i)` is the name the newest
/// snapshot held at range `i` at every gateway of the pass; a range named otherwise is sealed
/// into `spool` as it is read. The vault is not held (the walk reads its file on a reader of its
/// own), the pin is over before this returns, and a damaged vault is refused before any manifest
/// exists.
///
/// # Errors
/// A snapshot asked for inside a commit, a `vault_id` that is not an identity key, what the
/// walk refuses (a vault that is not WAL, a damaged one, SQLite's refusal) or the spool's.
pub fn capture(
    vault: &Vault,
    keys: &BackupKeys,
    vault_id: &str,
    app: &str,
    previous: &dyn Fn(u32) -> Option<Name>,
    sealer: &mut RangeSealer<'_>,
) -> Result<Snapshot> {
    if vault.depth.get() > 0 {
        return Err(invariant(
            "a snapshot was asked for inside a commit; a snapshot is taken between commits",
        ));
    }
    let taken_at_ms = u64::try_from(vault.clock().now_ms()).unwrap_or(0);
    capture_at(
        vault.path(),
        taken_at_ms,
        keys,
        vault_id,
        app,
        previous,
        sealer,
    )
}

/// [`capture`] for a caller that holds no [`Vault`]: the vault file's path and the moment on its
/// clock. A phone's pass uses this so the writer's lock is not held for the walk.
///
/// # Errors
/// As [`capture`].
pub fn capture_at(
    path: &Path,
    taken_at_ms: u64,
    keys: &BackupKeys,
    vault_id: &str,
    app: &str,
    previous: &dyn Fn(u32) -> Option<Name>,
    sealer: &mut RangeSealer<'_>,
) -> Result<Snapshot> {
    PlaintextHash::from_hex(vault_id)
        .map_err(|_| invariant("a vault id is the identity key's 64 lowercase hex"))?;
    let walked = match pagesource::walk(path, keys, previous, &mut |read, bytes| {
        sealer.seal(read, bytes)
    }) {
        Ok(walked) => walked,
        Err(error) => {
            sealer.abandon();
            return Err(error);
        }
    };
    debug_assert_eq!(pagesource::live_pins(), 0, "the pin ends with the walk");
    describe(
        &walked,
        taken_at_ms,
        keys,
        vault_id,
        app,
        std::mem::take(&mut sealer.out),
    )
}

/// [`capture`] with nothing known of an earlier snapshot, into a sealer over `spool` with
/// `budget`: every range is sealed. For a drill, a test and a first snapshot.
///
/// # Errors
/// Whatever [`capture`] refuses.
pub fn take(
    vault: &Vault,
    keys: &BackupKeys,
    spool: &Spool,
    budget: u64,
    vault_id: &str,
    app: &str,
) -> Result<Snapshot> {
    let mut sealer = RangeSealer::new(spool, keys, budget)?;
    capture(vault, keys, vault_id, app, &|_| None, &mut sealer)
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
    // ONLY THE RANGES THE WALK SEALED ARE ASKED ABOUT: the others are the previous head's own
    // names, which every gateway of the pass was found to hold before the walk began.
    let mut asked: Vec<Name> = snapshot
        .sealed
        .names
        .iter()
        .chain(snapshot.sealed.deferred.iter())
        .copied()
        .collect();
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

/// What several destinations are missing between them: every range any of them lacks, once
/// by name, and the manifest if any lacks it. Every destination is a full replica (#1188, B1),
/// so a part is sealed for the union and each destination is sent what it lacks.
#[must_use]
pub fn union(snapshot: &Snapshot, plans: &[Plan]) -> Plan {
    let mut wanted: BTreeSet<u32> = BTreeSet::new();
    for plan in plans {
        wanted.extend(plan.missing_ranges.iter().copied());
    }
    let mut seen = BTreeSet::new();
    let missing_ranges = snapshot
        .ranges
        .iter()
        .filter(|range| wanted.contains(&range.i) && seen.insert(range.name))
        .map(|range| range.i)
        .collect();
    Plan {
        missing_ranges,
        manifest_missing: plans.iter().any(|plan| plan.manifest_missing),
    }
}

/// What [`spool`] did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Spooled {
    /// Sealed into the spool and owed, or found already there.
    pub spooled: Vec<Name>,
    /// Left for a later pass: the spool was at its budget.
    pub deferred: Vec<Name>,
    /// Sealed bytes this call added to the spool.
    pub bytes: u64,
}

/// Seal what the gateways between them are missing into the spool and owe each gateway what
/// its own plan found missing, the manifest last and only once every range it names is
/// spooled. `plans` pairs each gateway with what it lacks of `snapshot`. A name no gateway
/// lacks is not sealed; a name every gateway holds has no row, which is how [`settle`] knows
/// the head may move.
///
/// # Errors
/// The filesystem's, the state's or the cipher's refusal.
pub fn spool(
    snapshot: &Snapshot,
    plans: &[(String, Plan)],
    spool: &Spool,
    state: &DeviceState,
    keys: &BackupKeys,
    budget: u64,
    now_ms: u64,
) -> Result<Spooled> {
    let owing = |index: Option<u32>, manifest: bool| -> Vec<&str> {
        plans
            .iter()
            .filter(|(_, plan)| match index {
                Some(index) => plan.missing_ranges.contains(&index),
                None => manifest && plan.manifest_missing,
            })
            .map(|(gateway, _)| gateway.as_str())
            .collect()
    };
    let union_plan = union(
        snapshot,
        &plans
            .iter()
            .map(|(_, plan)| plan.clone())
            .collect::<Vec<_>>(),
    );
    // THE GATEWAY'S SNAPSHOT IN FLIGHT is recorded first, so the pass that moves its parts, or a
    // later one, knows which manifest the head moves to.
    for (gateway, _) in plans {
        state.set_snapshot(
            gateway,
            &snapshot.manifest_name,
            snapshot.manifest.taken_at_ms,
            snapshot.manifest.writes,
        )?;
    }
    let held = spool.bytes()?;
    let mut out = Spooled::default();

    // THE OUTBOX ROWS GO IN BATCHES, one transaction each (`PENDING_ROWS` parts): a snapshot of
    // hundreds of ranges is a handful of syncs, not one per range. A part's file is written
    // before its row, so a crash between leaves a file the opener sweeps.
    const PENDING_ROWS: usize = 256;
    let mut pending: Vec<Outbox> = Vec::new();
    let flush = |pending: &mut Vec<Outbox>| -> Result<()> {
        state.put_outbox_many(pending)?;
        pending.clear();
        Ok(())
    };
    let put = |name: Name,
               kind: OutboxKind,
               gateways: &[&str],
               sealed: &[u8],
               out: &mut Spooled,
               pending: &mut Vec<Outbox>|
     -> Result<u64> {
        let path = spool.write(&name, sealed)?;
        let digest = Digest::of(sealed);
        for gateway in gateways {
            pending.push(Outbox::sealed(
                gateway,
                name,
                kind,
                path.clone(),
                sealed.len() as u64,
                digest,
                now_ms,
            ));
        }
        out.bytes += sealed.len() as u64;
        out.spooled.push(name);
        Ok(sealed.len() as u64)
    };

    // A RANGE IS OWED FROM THE FILE THE WALK SEALED (or an earlier pass left): its bytes are not
    // in the vault any more, only in the spool, so a missing range with no file waits for the next
    // snapshot.
    for index in &union_plan.missing_ranges {
        let range = snapshot
            .ranges
            .get(usize::try_from(*index).unwrap_or(usize::MAX))
            .ok_or_else(|| invariant(format!("the plan names range {index}, which is not here")))?;
        let gateways = owing(Some(*index), false);
        if !spool.contains(&range.name) {
            out.deferred.push(range.name);
            continue;
        }
        if gateways.iter().all(|gateway| {
            state
                .outbox_row(gateway, &range.name)
                .ok()
                .flatten()
                .is_some_and(|row| row.part_path.is_some())
        }) {
            out.spooled.push(range.name);
            continue;
        }
        let mut sealed = Vec::new();
        std::io::Read::read_to_end(&mut spool.read(&range.name)?, &mut sealed)?;
        let path = spool.path(&range.name);
        let digest = Digest::of(&sealed);
        for gateway in &gateways {
            pending.push(Outbox::sealed(
                gateway,
                range.name,
                OutboxKind::Range,
                path.clone(),
                sealed.len() as u64,
                digest,
                now_ms,
            ));
        }
        out.spooled.push(range.name);
        if pending.len() >= PENDING_ROWS {
            flush(&mut pending)?;
        }
    }
    flush(&mut pending)?;

    if union_plan.manifest_missing {
        let name = snapshot.manifest_name;
        let gateways = owing(None, true);
        if spool.contains(&name)
            && gateways.iter().all(|gateway| {
                state
                    .outbox_row(gateway, &name)
                    .ok()
                    .flatten()
                    .is_some_and(|row| row.part_path.is_some())
            })
        {
            out.spooled.push(name);
        } else if !out.deferred.is_empty()
            || !super::spool::admits(held, snapshot.manifest_json.len() as u64, budget)
        {
            out.deferred.push(name);
        } else {
            let sealed = sealed::seal_part(keys, 0, &snapshot.manifest_json, true)?;
            put(
                name,
                OutboxKind::Manifest,
                &gateways,
                &sealed,
                &mut out,
                &mut pending,
            )?;
            flush(&mut pending)?;
        }
    }
    // A RANGE THE WALK SEALED THAT EVERY GATEWAY TURNED OUT TO HOLD is owed to no one: its file
    // goes, unless another row (an earlier pass's) still needs it.
    let wanted: BTreeSet<Name> = union_plan
        .missing_ranges
        .iter()
        .filter_map(|index| {
            snapshot
                .ranges
                .get(usize::try_from(*index).unwrap_or(usize::MAX))
                .map(|range| range.name)
        })
        .collect();
    let unowed: Vec<Name> = snapshot
        .sealed
        .names
        .iter()
        .filter(|name| !wanted.contains(*name))
        .copied()
        .collect();
    let owed = state.owed_among(&unowed)?;
    for name in unowed.iter().filter(|name| !owed.contains(*name)) {
        spool.remove(name)?;
    }
    Ok(out)
}

/// What [`settle`] found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settled {
    /// The head now names this snapshot.
    HeadSet(Head),
    /// The gateway has no snapshot to move its head to, or its head already names it.
    Nothing,
    /// These names of the snapshot are still owed to the gateway.
    Waiting { unconfirmed: Vec<Name> },
    /// The head is somewhere this device did not leave it, and is not a
    /// snapshot this device took. Nothing moved.
    Conflict { current: Option<Head> },
}

/// Move the gateway's head to the newest snapshot spooled for it
/// ([`DeviceState::set_snapshot`]) once none of its records is still owed to it (every range,
/// leaf and the manifest). A name that is not owed is held: the plan found it so, or the mover let
/// go of it on the gateway's own answer.
///
/// The head's `prev` is the head this device last set at the gateway. A head that stands
/// somewhere this device did not leave it, but at or before this snapshot's own
/// writes and time (a crash between setting and recording, or a gateway put back as it was a
/// backup ago), or none at all, is the vault's own past and is tried once more; any other head is
/// a [`Settled::Conflict`].
///
/// # Errors
/// The state's refusal, or a store error other than the conflict.
pub fn settle(state: &DeviceState, store: &dyn Store, clock: &dyn Clock) -> Result<Settled> {
    let gateway = store.gateway_id().to_owned();
    let Some(row) = state.gateway(&gateway)? else {
        return Ok(Settled::Nothing);
    };
    let (Some(manifest_name), Some(taken_at_ms)) = (row.snapshot, row.snapshot_ms) else {
        return Ok(Settled::Nothing);
    };
    if row.head == Some(manifest_name) {
        return Ok(Settled::Nothing);
    }
    let owed: Vec<Name> = state
        .outbox(&gateway)?
        .into_iter()
        .filter(|row| {
            matches!(
                row.kind,
                OutboxKind::Range | OutboxKind::Leaf | OutboxKind::Manifest | OutboxKind::Directory
            )
        })
        .map(|row| row.name)
        .collect();
    if !owed.is_empty() {
        return Ok(Settled::Waiting { unconfirmed: owed });
    }

    let mut prev = row.head;
    for attempt in 0..2 {
        match store.set_head(
            &manifest_name,
            prev.as_ref(),
            taken_at_ms,
            row.snapshot_writes,
        ) {
            Ok(head) => {
                // ONE STATEMENT: the head, and the generation and writes it was signed at, which
                // the next signed record continues from (E3).
                state.record_head(
                    &gateway,
                    &manifest_name,
                    head.generation,
                    head.writes,
                    taken_at_ms,
                )?;
                state.touch_ack(&gateway, u64::try_from(clock.now_ms()).unwrap_or(0))?;
                return Ok(Settled::HeadSet(head));
            }
            Err(StoreError::HeadConflict { current }) => {
                let ours = current.as_ref().is_none_or(|head| {
                    head.writes <= row.snapshot_writes && head.taken_at_ms <= taken_at_ms
                });
                if attempt == 0 && ours {
                    prev = current.map(|head| head.name);
                    continue;
                }
                return Ok(Settled::Conflict { current });
            }
            Err(StoreError::Missing(name)) => {
                // The gateway does not hold a name believed held: the next pass's plan finds it
                // missing and seals it again.
                return Ok(Settled::Waiting {
                    unconfirmed: vec![name],
                });
            }
            Err(error) => return Err(error.into()),
        }
    }
    Err(invariant("settle tried the head twice"))
}

/// Whether the vault has committed nothing since a snapshot whose `writes` counter was
/// `writes`: the counter rises with every commit, so equal is unchanged. A vault that shows
/// this is not copied again.
///
/// # Errors
/// SQLite's refusal.
pub fn unchanged_since(vault: &Vault, writes: u64) -> Result<bool> {
    Ok(history(vault)?.writes == writes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::state::Gateway;
    use crate::pagesource;

    fn founded(dir: &Path) -> Vault {
        let vault = Vault::create(dir.join("vault.db")).expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        vault
    }

    /// A spool of its own under `dir`.
    fn spool_at(dir: &Path, tag: &str) -> Spool {
        Spool::open(dir.join(tag)).expect("a spool")
    }

    fn add_party(vault: &Vault, label: &str) {
        let id = vault.ids().next();
        let now = vault.clock().now_text();
        vault
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO entity (id, kind, title, created_at, updated_at)
                     VALUES (?1, 'person', ?2, ?3, ?3)",
                    rusqlite::params![id, label, now],
                )?;
                tx.connection()
                    .execute("INSERT INTO person (id) VALUES (?1)", [&id])?;
                Ok(())
            })
            .expect("commits");
    }

    #[test]
    fn a_vault_is_unchanged_until_a_commit_or_a_migration_shows() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = BackupKeys::from_root(&[3; 32]);
        let taken = take(
            &vault,
            &keys,
            &spool_at(dir.path(), "s"),
            u64::MAX,
            &"ab".repeat(32),
            APP,
        )
        .expect("takes");
        assert!(unchanged(&vault, &taken.manifest).expect("compares"));
        add_party(&vault, "Somebody");
        assert!(!unchanged(&vault, &taken.manifest).expect("compares"));
    }

    #[test]
    fn a_snapshot_tiles_the_file_and_names_its_ranges_from_their_bytes() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = BackupKeys::from_root(&[3; 32]);
        let vault_id = "ab".repeat(32);
        let snapshot = take(
            &vault,
            &keys,
            &spool_at(dir.path(), "s"),
            u64::MAX,
            &vault_id,
            APP,
        )
        .expect("takes");
        // THE PAGES AS THE PIN SAW THEM: the vault has not changed since.
        let mut pinned = pagesource::PinnedPages::begin(vault.path()).expect("a pin");
        let mut bytes = Vec::new();
        for index in 0..pinned.range_count() {
            bytes.extend_from_slice(pinned.range(index).expect("a range"));
        }
        pinned.end().expect("ends");
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
        assert_eq!(snapshot.manifest.census.get("person"), Some(&1));
        assert!(
            !snapshot
                .manifest
                .census
                .keys()
                .any(|table| table.starts_with("sqlite_") || table.ends_with("_docsize")),
            "SQLite's and FTS5's own tables are not a member's rows"
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
    }

    #[test]
    fn a_manifest_this_build_did_not_write_is_refused() {
        let good = Manifest {
            v: MANIFEST_VERSION,
            vault_id: "ab".repeat(32),
            taken_at_ms: 1,
            page_size: 4096,
            db_len: 8192,
            db_hash: PlaintextHash::of(b"x"),
            user_version: 9,
            writes: 4,
            written_at_ms: Some(1),
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
        future["v"] = serde_json::json!(MANIFEST_VERSION + 1);
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
        let spool = spool_at(dir.path(), "s");
        assert!(take(&vault, &keys, &spool, u64::MAX, "not-hex", APP).is_err());
        assert!(
            spool.names().expect("lists").is_empty(),
            "a refused snapshot seals nothing"
        );
    }

    /// A snapshot is taken between commits: inside one the plane refuses by name.
    #[test]
    fn no_snapshot_is_taken_inside_a_commit() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = BackupKeys::from_root(&[3; 32]);
        let spool = spool_at(dir.path(), "s");
        let outcome = vault.commit(|_| {
            assert!(matches!(
                take(&vault, &keys, &spool, u64::MAX, &"ab".repeat(32), APP),
                Err(super::super::PlaneError::Invariant { .. })
            ));
            Ok(())
        });
        assert!(outcome.is_ok());
        assert_eq!(pagesource::live_pins(), 0);
    }

    #[test]
    fn a_second_snapshot_of_an_unchanged_vault_names_the_same_ranges_and_seals_none() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        add_party(&vault, "Grace");
        let keys = BackupKeys::from_root(&[3; 32]);
        let first = take(
            &vault,
            &keys,
            &spool_at(dir.path(), "a"),
            u64::MAX,
            &"cd".repeat(32),
            APP,
        )
        .expect("takes");
        assert!(
            !first.sealed.names.is_empty(),
            "a first snapshot seals every range"
        );
        let known: BTreeMap<u32, Name> = first.ranges.iter().map(|r| (r.i, r.name)).collect();
        let spool = spool_at(dir.path(), "b");
        let mut sealer = RangeSealer::new(&spool, &keys, u64::MAX).expect("a sealer");
        let second = capture(
            &vault,
            &keys,
            &"cd".repeat(32),
            APP,
            &|i| known.get(&i).copied(),
            &mut sealer,
        )
        .expect("takes");
        assert_eq!(first.manifest.range_names(), second.manifest.range_names());
        assert_eq!(first.manifest.db_hash, second.manifest.db_hash);
        assert!(
            second.sealed.names.is_empty() && second.sealed.deferred.is_empty(),
            "nothing changed, so nothing was sealed"
        );
        assert!(spool.names().expect("lists").is_empty());
    }

    /// **The spool never holds more than its budget.** Ranges past what fits
    /// wait for the next snapshot, and the manifest waits with them.
    #[test]
    fn a_snapshot_spools_no_more_than_the_budget() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = founded(dir.path());
        let keys = BackupKeys::from_root(&[3; 32]);
        let spool_dir = Spool::open(dir.path().join("vault.spool")).expect("a spool");
        // THE BUDGET IS ONE RANGE'S WORST CASE, not a number of bytes. A part is admitted into
        // an empty spool whatever the budget, and into a held one only when its sealed bound
        // fits beside what is held, so a budget of exactly one bound admits the first range and
        // defers every other. A fixed byte count means "less than the whole snapshot" only while
        // the founded vault is as large and as poorly compressible as the day it was written;
        // the schema moves that, and the squash of the ladder did (a founded vault seals to
        // ~85 KB now, which a budget of 150 KiB admits whole).
        let budget = super::super::spool::sealed_bound(RANGE_BYTES);
        let snapshot =
            take(&vault, &keys, &spool_dir, budget, &"ab".repeat(32), APP).expect("takes");
        assert!(snapshot.ranges.len() > 3, "a founded vault is a few ranges");
        let store = super::super::store::MemoryStore::new("gw");
        let planned = plan(&snapshot, &store).expect("plans");
        let state = DeviceState::open(dir.path().join("vault.state.db")).expect("a device state");
        state
            .put_gateway(&Gateway::paired(
                "gw".to_owned(),
                Vec::new(),
                Vec::new(),
                "laptop".to_owned(),
                1,
                0,
            ))
            .expect("pairs");
        let spooled = spool(
            &snapshot,
            &[("gw".to_owned(), planned)],
            &spool_dir,
            &state,
            &keys,
            budget,
            1,
        )
        .expect("spools");
        assert!(
            spool_dir.bytes().expect("sums") <= budget,
            "{} bytes under a budget of {budget}",
            spool_dir.bytes().expect("sums")
        );
        assert!(!spooled.spooled.is_empty(), "what fits was spooled");
        assert!(
            spooled.deferred.len() > 1,
            "the ranges past what fits wait: {spooled:?}"
        );
        assert!(spooled.deferred.contains(&snapshot.manifest_name));
    }

    /// **A name the gateway holds is no row.** A phone with a fresh device state — a restored
    /// phone's, or one that was lost — finds every range already held: it owes only the manifest,
    /// and the head moves once that is sent.
    #[test]
    fn ranges_a_gateway_already_holds_are_not_owed_and_the_head_moves() {
        use super::super::mover::{Stop, move_queue};
        use super::super::store::MemoryStore;

        let dir = tempfile::tempdir().expect("a directory");
        // A FIXED CLOCK THE TEST TICKS, so the second manifest is a new name by construction.
        let tick = std::sync::Arc::new(crate::clock::FixedClock::frozen());
        let vault = Vault::create_with(
            dir.path().join("vault.db"),
            Box::new(std::sync::Arc::clone(&tick)),
            Box::new(crate::clock::ClockIds::new(Box::new(
                std::sync::Arc::clone(&tick),
            ))),
        )
        .expect("a vault");
        vault.found("Household", "Ada").expect("founds");
        add_party(&vault, "Grace");
        let keys = BackupKeys::from_root(&[3; 32]);
        let store = MemoryStore::new("gw");
        let paired = |state: &DeviceState| {
            state
                .put_gateway(&Gateway::paired(
                    "gw".to_owned(),
                    Vec::new(),
                    Vec::new(),
                    "laptop".to_owned(),
                    1,
                    0,
                ))
                .expect("pairs");
        };
        let vault_id = "ab".repeat(32);

        // One device sends a snapshot whole.
        let first_state = DeviceState::open(dir.path().join("one.state.db")).expect("a state");
        paired(&first_state);
        let first_spool = Spool::open(dir.path().join("one.spool")).expect("a spool");
        let taken = take(&vault, &keys, &first_spool, u64::MAX, &vault_id, APP).expect("takes");
        let planned = plan(&taken, &store).expect("plans");
        spool(
            &taken,
            &[("gw".to_owned(), planned)],
            &first_spool,
            &first_state,
            &keys,
            u64::MAX,
            1,
        )
        .expect("spools");
        let far = std::time::Instant::now() + std::time::Duration::from_secs(60);
        let clock = crate::clock::FixedClock::frozen();
        let moved = move_queue(&first_state, &first_spool, &store, far, &clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);

        // A second device state, knowing nothing, snapshots the same vault — a millisecond
        // later, so its manifest is a new name.
        tick.advance_ms(1);
        let state = DeviceState::open(dir.path().join("two.state.db")).expect("a state");
        paired(&state);
        let fresh = Spool::open(dir.path().join("two.spool")).expect("a spool");
        let again = take(&vault, &keys, &fresh, u64::MAX, &vault_id, APP).expect("takes");
        let replanned = plan(&again, &store).expect("plans");
        assert!(replanned.missing_ranges.is_empty(), "every range is held");
        let spooled = spool(
            &again,
            &[("gw".to_owned(), replanned)],
            &fresh,
            &state,
            &keys,
            u64::MAX,
            2,
        )
        .expect("spools");
        assert_eq!(
            spooled.spooled,
            vec![again.manifest_name],
            "only the manifest is new"
        );
        assert_eq!(
            fresh.names().expect("lists"),
            vec![again.manifest_name],
            "the ranges the walk sealed and the gateway holds are not kept"
        );
        let waiting = settle(&state, &store, &clock).expect("settles");
        assert!(
            matches!(waiting, Settled::Waiting { .. }),
            "with the manifest still owed the head cannot move: {waiting:?}"
        );
        let moved = move_queue(&state, &fresh, &store, far, &clock).expect("moves");
        assert_eq!(moved.stopped, Stop::Empty);
        assert!(matches!(
            settle(&state, &store, &clock).expect("settles"),
            Settled::HeadSet(head) if head.name == again.manifest_name
        ));
    }
}
