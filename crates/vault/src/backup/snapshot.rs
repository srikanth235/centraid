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

use centraid_media::sealed::{self, ChunkDigest};
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

/// The manifest format this build writes and reads: a root and a tree of leaves (E9).
pub const MANIFEST_VERSION: u32 = 4;

/// Entries one leaf holds.
pub const LEAF_ENTRIES: usize = 1024;

/// Leaves one tree holds: past this a vault is too large to back up.
pub const ROOT_LEAVES: usize = 4096;

/// What the manifest's `app` says when the caller has nothing better.
pub const APP: &str = concat!("centraid-vault/", env!("CARGO_PKG_VERSION"));

/// One range, as a leaf names it.
///
/// `d` is one [`ChunkDigest`] per sealed chunk of the range's part: BLAKE3 of the chunk as it
/// opens, a function of the range's bytes alone (so one manifest serves every gateway). It is
/// empty only in a snapshot the spool could not take whole, which never leaves the phone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RangeRef {
    pub i: u32,
    pub name: Name,
    pub len: u64,
    pub d: Vec<ChunkDigest>,
}

/// One part of a blob, as a blobs leaf names it. `d` is the part's chunk digests, or `None` when
/// this phone had not sealed the part (or learned its digests) when the snapshot was taken: a
/// part with no digests is never sampled, and a later snapshot fills them in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobPart {
    pub i: u32,
    pub name: Name,
    pub d: Option<Vec<ChunkDigest>>,
}

/// One blob the vault claimed at the pin, as a blobs leaf names it: its plaintext hash, its
/// length, and the parts it is stored as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobRef {
    pub h: PlaintextHash,
    pub len: u64,
    pub parts: Vec<BlobPart>,
}

/// One leaf, as the root lists it: the entries `first .. first + count`, and the name the leaf's
/// own bytes derive (so a leaf that is not the one the root names is refused by name).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LeafRef {
    pub first: u32,
    pub count: u32,
    pub name: Name,
}

/// The root manifest as it is sealed: #1080's keys, in #1080's order, then the trees (E9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Root {
    pub v: u32,
    /// The vault identity key, hex: which vault this is a snapshot of.
    pub vault_id: String,
    pub taken_at_ms: u64,
    pub page_size: u32,
    pub db_len: u64,
    /// BLAKE3 over the vault's pages in order.
    pub db_hash: PlaintextHash,
    pub user_version: i64,
    /// `vault.writes` at the pin: how many commits had changed something when it was taken. A
    /// takeover compares it with a phone's own copy to tell which is ahead (#1146).
    pub writes: u64,
    /// `vault.written_at` as milliseconds on the vault's clock; `None` for a vault nothing has
    /// been written to.
    pub written_at_ms: Option<u64>,
    /// The build that took it.
    pub app: String,
    /// Rows per table.
    pub census: BTreeMap<String, i64>,
    /// The sealed directory of gateways (E8); `None` until a phone writes one.
    pub directory: Option<Name>,
    /// The leaves of the page ranges, in order.
    pub ranges_tree: Vec<LeafRef>,
    /// The leaves of the blob parts, in order.
    pub blobs_tree: Vec<LeafRef>,
}

impl Root {
    /// Read a root back, refusing one this build did not write.
    ///
    /// # Errors
    /// A version other than [`MANIFEST_VERSION`] or a field this version does not define.
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        let value: serde_json::Value = serde_json::from_slice(bytes)
            .map_err(|error| invariant(format!("the manifest is not JSON: {error}")))?;
        let version = value.get("v").and_then(serde_json::Value::as_u64);
        if version != Some(u64::from(MANIFEST_VERSION)) {
            return Err(invariant(format!(
                "the manifest is version {version:?}; this build reads {MANIFEST_VERSION}"
            )));
        }
        serde_json::from_value(value).map_err(|error| invariant(format!("the manifest: {error}")))
    }

    /// Every leaf name the root lists.
    #[must_use]
    pub fn leaf_names(&self) -> Vec<Name> {
        self.ranges_tree
            .iter()
            .chain(self.blobs_tree.iter())
            .map(|leaf| leaf.name)
            .collect()
    }
}

/// A leaf, sealed and named: its JSON and the name that JSON derives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Leaf {
    pub name: Name,
    pub json: Vec<u8>,
}

/// The snapshot manifest, whole: the root's fields and every range, assembled from the root and
/// its leaves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub v: u32,
    pub vault_id: String,
    pub taken_at_ms: u64,
    pub page_size: u32,
    pub db_len: u64,
    pub db_hash: PlaintextHash,
    pub user_version: i64,
    pub writes: u64,
    pub written_at_ms: Option<u64>,
    pub app: String,
    pub ranges: Vec<RangeRef>,
    /// The blobs the vault claimed at the pin, by hash: the content its rows name.
    pub blobs: Vec<BlobRef>,
    pub census: BTreeMap<String, i64>,
    pub directory: Option<Name>,
    /// The leaves of `ranges`, as the root lists them (filled by [`Manifest::to_parts`] and
    /// [`Manifest::read`]).
    pub ranges_tree: Vec<LeafRef>,
    pub blobs_tree: Vec<LeafRef>,
}

/// A manifest cut into what is stored: the root's JSON and its leaves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parts {
    pub root_json: Vec<u8>,
    pub leaves: Vec<Leaf>,
}

impl Manifest {
    /// Cut the ranges into leaves and write the root that lists them.
    ///
    /// # Errors
    /// More ranges or blobs than a tree holds ([`LEAF_ENTRIES`] × [`ROOT_LEAVES`]).
    pub fn to_parts(&self, keys: &BackupKeys) -> Result<Parts> {
        let mut leaves = Vec::new();
        let ranges_tree = cut(keys, &self.ranges, &mut leaves)?;
        let blobs_tree = cut(keys, &self.blobs, &mut leaves)?;
        let root = Root {
            v: self.v,
            vault_id: self.vault_id.clone(),
            taken_at_ms: self.taken_at_ms,
            page_size: self.page_size,
            db_len: self.db_len,
            db_hash: self.db_hash,
            user_version: self.user_version,
            writes: self.writes,
            written_at_ms: self.written_at_ms,
            app: self.app.clone(),
            census: self.census.clone(),
            directory: self.directory,
            ranges_tree,
            blobs_tree,
        };
        let root_json = serde_json::to_vec(&root)
            .map_err(|error| invariant(format!("the manifest: {error}")))?;
        Ok(Parts { root_json, leaves })
    }

    /// Put the root and the leaves it lists back together. `leaf` answers the opened bytes of a
    /// leaf by the name the root gives it.
    ///
    /// # Errors
    /// A leaf the root names that `leaf` cannot answer, one whose bytes do not derive its name,
    /// entries that do not match the root's counts, or ranges that do not tile `db_len`.
    pub fn assemble(
        root: Root,
        keys: &BackupKeys,
        leaf: &mut dyn FnMut(&Name) -> Result<Vec<u8>>,
    ) -> Result<Self> {
        let ranges: Vec<RangeRef> = unite(keys, &root.ranges_tree, leaf)?;
        let blobs: Vec<BlobRef> = unite(keys, &root.blobs_tree, leaf)?;
        // ONE ENTRY PER BLOB, IN ORDER: a blobs leaf repeated or reordered is refused.
        if blobs.windows(2).any(|pair| pair[0].h >= pair[1].h) {
            return Err(invariant("the blobs are not one entry each, by hash"));
        }
        for blob in &blobs {
            let expected = sealed::names_of(keys, &blob.h, blob.len);
            let named: Vec<(u32, Name)> =
                blob.parts.iter().map(|part| (part.i, part.name)).collect();
            let wanted: Vec<(u32, Name)> = (0_u32..).zip(expected).collect();
            if named != wanted {
                return Err(invariant(format!(
                    "blob {} does not name the parts its hash and length derive",
                    blob.h
                )));
            }
        }
        let manifest = Self {
            v: root.v,
            vault_id: root.vault_id,
            taken_at_ms: root.taken_at_ms,
            page_size: root.page_size,
            db_len: root.db_len,
            db_hash: root.db_hash,
            user_version: root.user_version,
            writes: root.writes,
            written_at_ms: root.written_at_ms,
            app: root.app,
            ranges,
            blobs,
            census: root.census,
            directory: root.directory,
            ranges_tree: root.ranges_tree,
            blobs_tree: root.blobs_tree,
        };
        manifest.validate()?;
        Ok(manifest)
    }

    /// Fetch the root named `root_name` and every leaf it lists with `fetch` (sealed bytes by
    /// name), open each under `keys` and assemble.
    ///
    /// # Errors
    /// What `fetch` refuses, a part that does not open as the name it was fetched by, and what
    /// [`Manifest::assemble`] refuses.
    pub fn read(
        keys: &BackupKeys,
        root_name: &Name,
        fetch: &mut dyn FnMut(&Name) -> std::result::Result<Vec<u8>, StoreError>,
    ) -> Result<Self> {
        let sealed_root = fetch(root_name)?;
        let json = sealed::open_whole(keys, root_name, &sealed_root)?;
        let root = Root::from_json(&json)?;
        Self::assemble(root, keys, &mut |leaf_name| {
            let sealed_leaf = fetch(leaf_name)?;
            Ok(sealed::open_whole(keys, leaf_name, &sealed_leaf)?)
        })
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

    /// Every leaf name.
    #[must_use]
    pub fn leaf_names(&self) -> Vec<Name> {
        self.ranges_tree
            .iter()
            .chain(self.blobs_tree.iter())
            .map(|leaf| leaf.name)
            .collect()
    }

    /// Every part name of every blob the snapshot's rows name.
    #[must_use]
    pub fn blob_part_names(&self) -> BTreeSet<Name> {
        self.blobs
            .iter()
            .flat_map(|blob| blob.parts.iter().map(|part| part.name))
            .collect()
    }

    /// Everything the snapshot is made of besides the root: its leaves, its ranges and the parts
    /// of the blobs its rows name, and the directory of gateways it names.
    #[must_use]
    pub fn part_names(&self) -> BTreeSet<Name> {
        let mut out = self.range_names();
        out.extend(self.leaf_names());
        out.extend(self.blob_part_names());
        out.extend(self.directory);
        out
    }
}

/// Cut `entries` into leaves of [`LEAF_ENTRIES`], appending each to `leaves`; answers the tree
/// the root lists.
fn cut<T: Serialize>(
    keys: &BackupKeys,
    entries: &[T],
    leaves: &mut Vec<Leaf>,
) -> Result<Vec<LeafRef>> {
    if entries.len() > LEAF_ENTRIES * ROOT_LEAVES {
        return Err(invariant("the vault is too large to back up"));
    }
    let mut tree = Vec::new();
    for (index, chunk) in entries.chunks(LEAF_ENTRIES).enumerate() {
        let json =
            serde_json::to_vec(chunk).map_err(|error| invariant(format!("a leaf: {error}")))?;
        let named = name(keys, &PlaintextHash::of(&json), 0);
        tree.push(LeafRef {
            first: u32::try_from(index * LEAF_ENTRIES)
                .map_err(|_| invariant("too many entries"))?,
            count: u32::try_from(chunk.len()).map_err(|_| invariant("too many entries"))?,
            name: named,
        });
        leaves.push(Leaf { name: named, json });
    }
    Ok(tree)
}

/// The entries a tree's leaves hold, in order, each leaf checked against the name and counts the
/// root gives it (so a leaf dropped, repeated, reordered or swapped is refused).
fn unite<T: serde::de::DeserializeOwned>(
    keys: &BackupKeys,
    tree: &[LeafRef],
    leaf: &mut dyn FnMut(&Name) -> Result<Vec<u8>>,
) -> Result<Vec<T>> {
    let mut out: Vec<T> = Vec::new();
    for entry in tree {
        let json = leaf(&entry.name)?;
        if name(keys, &PlaintextHash::of(&json), 0) != entry.name {
            return Err(invariant(format!(
                "leaf {} is not the bytes its name derives from",
                entry.name
            )));
        }
        let entries: Vec<T> =
            serde_json::from_slice(&json).map_err(|error| invariant(format!("a leaf: {error}")))?;
        if entries.len() != entry.count as usize
            || out.len() != entry.first as usize
            || entries.len() > LEAF_ENTRIES
        {
            return Err(invariant(format!(
                "leaf {} does not hold the entries the root says",
                entry.name
            )));
        }
        out.extend(entries);
    }
    Ok(out)
}

/// Fetch and assemble the manifest whose root is `root_name` from `store`.
///
/// # Errors
/// As [`Manifest::read`].
pub fn read_manifest(store: &dyn Store, keys: &BackupKeys, root_name: &Name) -> Result<Manifest> {
    Manifest::read(keys, root_name, &mut |part| {
        let mut bytes = Vec::new();
        store.get(part, &mut bytes)?;
        Ok(bytes)
    })
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
    /// The root's JSON; `manifest_name` is the name it derives.
    pub manifest_json: Vec<u8>,
    pub manifest_name: Name,
    /// The leaves the root lists, JSON and name, in order.
    pub leaves: Vec<Leaf>,
    /// The sealed directory of gateways the manifest names, if one was given.
    pub directory: Option<Leaf>,
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

/// What the snapshot a walk compares with named at an index: the range's name and its chunk
/// digests.
pub type Known<'a> = dyn Fn(u32) -> Option<(Name, Vec<ChunkDigest>)> + 'a;

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
    /// The chunk digests of every range in `names`, by name.
    pub digests: BTreeMap<Name, Vec<ChunkDigest>>,
    /// Sealed bytes this walk added to the spool.
    pub bytes: u64,
    /// The chunk digests this phone holds for the parts of blobs it has sealed, by name: what a
    /// blobs leaf carries as `d`.
    pub part_digests: BTreeMap<Name, Vec<ChunkDigest>>,
    /// The sealed gateway directory this snapshot names (E8): its name and plaintext.
    pub directory: Option<Leaf>,
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
            // SEALED BY AN EARLIER PASS: its digests are read back out of the part itself.
            let mut sealed_bytes = Vec::new();
            std::io::Read::read_to_end(&mut self.spool.read(&read.name)?, &mut sealed_bytes)?;
            self.out
                .digests
                .insert(read.name, chunk_digests_of(self.keys, &sealed_bytes)?);
            self.out.names.insert(read.name);
            return Ok(());
        }
        if !super::spool::admits(self.held, read.len, self.budget) {
            self.out.deferred.insert(read.name);
            return Ok(());
        }
        let (sealed, digests) = sealed::seal_part_digests(self.keys, 0, bytes, true)?;
        self.spool.write(&read.name, &sealed)?;
        self.out.digests.insert(read.name, digests);
        self.wrote.push(read.name);
        self.held += sealed.len() as u64;
        self.out.bytes += sealed.len() as u64;
        self.out.names.insert(read.name);
        Ok(())
    }

    /// Hand the sealer the chunk digests the device state holds for sealed blob parts, so the
    /// manifest's blobs tree can carry them.
    #[must_use]
    pub fn with_part_digests(mut self, digests: BTreeMap<Name, Vec<ChunkDigest>>) -> Self {
        self.out.part_digests = digests;
        self
    }

    /// The directory of gateways the snapshot's manifest names (E8).
    ///
    /// # Errors
    /// The directory will not serialise.
    pub fn with_directory(mut self, directory: &super::directory::Directory) -> Result<Self> {
        self.out.directory = Some(Leaf {
            name: directory.name(self.keys)?,
            json: directory.to_json()?,
        });
        Ok(self)
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
        self.out = Sealed {
            part_digests: std::mem::take(&mut self.out.part_digests),
            directory: self.out.directory.take(),
            ..Sealed::default()
        };
    }
}

/// The digest of every chunk of a sealed part, read by opening it.
///
/// # Errors
/// A part that does not open under `keys`.
pub fn chunk_digests_of(keys: &BackupKeys, sealed_bytes: &[u8]) -> Result<Vec<ChunkDigest>> {
    let len = sealed_bytes.len() as u64;
    let count = sealed::chunk_count(len)?;
    let header: [u8; sealed::HEADER_BYTES] = sealed_bytes
        .get(..sealed::HEADER_BYTES)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| invariant("a sealed part shorter than its header"))?;
    let mut out = Vec::with_capacity(count as usize);
    for index in 0..count {
        let span = sealed::chunk_span(len, index)?;
        let start = usize::try_from(span.offset).map_err(|_| invariant("a part past memory"))?;
        let end = start + usize::try_from(span.len).map_err(|_| invariant("a part past memory"))?;
        let frame = sealed_bytes
            .get(start..end)
            .ok_or_else(|| invariant("a chunk past the part's end"))?;
        let (_, digest) = sealed::open_chunk(keys, &header, index, span.last, frame)?;
        out.push(digest);
    }
    Ok(out)
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
    known: &Known<'_>,
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
    // A RANGE'S DIGESTS: those of the part just sealed, or the ones the snapshot it was named by
    // already carries. A range deferred by the spool has none, and its snapshot never leaves.
    let digests_of = |read: &RangeRead| -> Vec<ChunkDigest> {
        sealed.digests.get(&read.name).cloned().unwrap_or_else(|| {
            known(read.i)
                .filter(|(held, _)| *held == read.name)
                .map(|(_, d)| d)
                .unwrap_or_default()
        })
    };
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
        ranges: walked
            .ranges
            .iter()
            .map(|read| RangeRef {
                i: read.i,
                name: read.name,
                len: read.len,
                d: digests_of(read),
            })
            .collect(),
        blobs: walked
            .blobs
            .iter()
            .map(|(h, len)| BlobRef {
                h: *h,
                len: *len,
                parts: (0_u32..)
                    .zip(sealed::names_of(keys, h, *len))
                    .map(|(i, name)| BlobPart {
                        d: sealed.part_digests.get(&name).cloned(),
                        i,
                        name,
                    })
                    .collect(),
            })
            .collect(),
        census: walked.census.clone(),
        directory: sealed.directory.as_ref().map(|directory| directory.name),
        ranges_tree: Vec::new(),
        blobs_tree: Vec::new(),
    };
    manifest.validate()?;
    let parts = manifest.to_parts(keys)?;
    let tree = Root::from_json(&parts.root_json)?;
    let manifest = Manifest {
        ranges_tree: tree.ranges_tree,
        blobs_tree: tree.blobs_tree,
        ..manifest
    };
    let manifest_name = name(keys, &PlaintextHash::of(&parts.root_json), 0);
    Ok(Snapshot {
        manifest,
        manifest_json: parts.root_json,
        manifest_name,
        leaves: parts.leaves,
        directory: sealed.directory.clone(),
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
    previous: &Known<'_>,
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
    previous: &Known<'_>,
    sealer: &mut RangeSealer<'_>,
) -> Result<Snapshot> {
    PlaintextHash::from_hex(vault_id)
        .map_err(|_| invariant("a vault id is the identity key's 64 lowercase hex"))?;
    let walked = match pagesource::walk(
        path,
        keys,
        &|i| previous(i).map(|(held, _)| held),
        &mut |read, bytes| sealer.seal(read, bytes),
    ) {
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
        previous,
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
    /// Leaves the destination lacks, by name.
    pub missing_leaves: Vec<Name>,
    pub manifest_missing: bool,
    /// The destination lacks the directory the manifest names.
    pub directory_missing: bool,
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
    asked.extend(snapshot.leaves.iter().map(|leaf| leaf.name));
    asked.extend(snapshot.directory.iter().map(|directory| directory.name));
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
        missing_leaves: snapshot
            .leaves
            .iter()
            .filter(|leaf| missing.contains(&leaf.name))
            .map(|leaf| leaf.name)
            .collect(),
        manifest_missing: missing.contains(&snapshot.manifest_name),
        directory_missing: snapshot
            .directory
            .as_ref()
            .is_some_and(|directory| missing.contains(&directory.name)),
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
    let leaves: BTreeSet<Name> = plans
        .iter()
        .flat_map(|plan| plan.missing_leaves.iter().copied())
        .collect();
    Plan {
        missing_ranges,
        missing_leaves: snapshot
            .leaves
            .iter()
            .filter(|leaf| leaves.contains(&leaf.name))
            .map(|leaf| leaf.name)
            .collect(),
        manifest_missing: plans.iter().any(|plan| plan.manifest_missing),
        directory_missing: plans.iter().any(|plan| plan.directory_missing),
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
    let mut held = spool.bytes()?;
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

    // THE LEAVES, sealed once and sent as the same bytes to every gateway that lacks them.
    for leaf in &snapshot.leaves {
        if !union_plan.missing_leaves.contains(&leaf.name) {
            continue;
        }
        let gateways: Vec<&str> = plans
            .iter()
            .filter(|(_, plan)| plan.missing_leaves.contains(&leaf.name))
            .map(|(gateway, _)| gateway.as_str())
            .collect();
        let in_spool = spool.contains(&leaf.name)
            && gateways.iter().all(|gateway| {
                state
                    .outbox_row(gateway, &leaf.name)
                    .ok()
                    .flatten()
                    .is_some_and(|row| row.part_path.is_some())
            });
        if in_spool {
            out.spooled.push(leaf.name);
        } else if !out.deferred.is_empty()
            || !super::spool::admits(held, leaf.json.len() as u64, budget)
        {
            out.deferred.push(leaf.name);
        } else {
            let sealed = sealed::seal_part(keys, 0, &leaf.json, true)?;
            held += put(
                leaf.name,
                OutboxKind::Leaf,
                &gateways,
                &sealed,
                &mut out,
                &mut pending,
            )?;
            flush(&mut pending)?;
        }
    }

    // THE DIRECTORY OF GATEWAYS (E8), sealed once and sent as the same bytes to every gateway
    // that lacks it, before the manifest that names it.
    if let Some(directory) = &snapshot.directory
        && union_plan.directory_missing
    {
        let gateways: Vec<&str> = plans
            .iter()
            .filter(|(_, plan)| plan.directory_missing)
            .map(|(gateway, _)| gateway.as_str())
            .collect();
        let in_spool = spool.contains(&directory.name)
            && gateways.iter().all(|gateway| {
                state
                    .outbox_row(gateway, &directory.name)
                    .ok()
                    .flatten()
                    .is_some_and(|row| row.part_path.is_some())
            });
        if in_spool {
            out.spooled.push(directory.name);
        } else if !out.deferred.is_empty()
            || !super::spool::admits(held, directory.json.len() as u64, budget)
        {
            out.deferred.push(directory.name);
        } else {
            let sealed = sealed::seal_part(keys, 0, &directory.json, true)?;
            held += put(
                directory.name,
                OutboxKind::Directory,
                &gateways,
                &sealed,
                &mut out,
                &mut pending,
            )?;
            flush(&mut pending)?;
        }
    }

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
        let parts = snapshot.manifest.to_parts(&keys).expect("serialises");
        let json = parts.root_json;
        assert_eq!(json, snapshot.manifest_json);
        assert_eq!(parts.leaves, snapshot.leaves);
        // THE DIGESTS: one per range, a function of the range's bytes alone.
        for (range, held) in snapshot.ranges.iter().zip(&snapshot.manifest.ranges) {
            let start = usize::try_from(range.offset).expect("fits");
            let end = start + usize::try_from(range.len).expect("fits");
            let sealed_bytes =
                sealed::seal_part(&keys, 0, &bytes[start..end], true).expect("seals");
            assert_eq!(
                held.d,
                chunk_digests_of(&keys, &sealed_bytes).expect("opens")
            );
            assert_eq!(held.d.len(), 1, "a range is one chunk");
        }
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
            "\"census\"",
            "\"directory\"",
            "\"ranges_tree\"",
            "\"blobs_tree\"",
        ];
        let at: Vec<usize> = order
            .iter()
            .map(|key| text.find(key).expect("a key"))
            .collect();
        assert!(
            at.windows(2).all(|pair| pair[0] < pair[1]),
            "#1080's key order: {text}"
        );
        let root = Root::from_json(&json).expect("a root");
        let leaves: BTreeMap<Name, Vec<u8>> = snapshot
            .leaves
            .iter()
            .map(|leaf| (leaf.name, leaf.json.clone()))
            .collect();
        assert_eq!(
            Manifest::assemble(root, &keys, &mut |leaf| Ok(leaves[leaf].clone()))
                .expect("reads back"),
            snapshot.manifest
        );
    }

    fn small_manifest(ranges: usize) -> Manifest {
        let page = 4096_u32;
        let mut list = Vec::new();
        for i in 0..ranges {
            list.push(RangeRef {
                i: u32::try_from(i).expect("fits"),
                name: Name::from_bytes([u8::try_from(i % 250).expect("fits") + 1; 32]),
                len: RANGE_BYTES,
                d: vec![ChunkDigest::of(&i.to_be_bytes())],
            });
        }
        Manifest {
            v: MANIFEST_VERSION,
            vault_id: "ab".repeat(32),
            taken_at_ms: 1,
            page_size: page,
            db_len: RANGE_BYTES * ranges as u64,
            db_hash: PlaintextHash::of(b"x"),
            user_version: 9,
            writes: 4,
            written_at_ms: Some(1),
            app: APP.to_owned(),
            ranges: list,
            blobs: Vec::new(),
            census: BTreeMap::new(),
            directory: None,
            ranges_tree: Vec::new(),
            blobs_tree: Vec::new(),
        }
    }

    fn reassemble(parts: &Parts, keys: &BackupKeys) -> Result<Manifest> {
        let leaves: BTreeMap<Name, Vec<u8>> = parts
            .leaves
            .iter()
            .map(|leaf| (leaf.name, leaf.json.clone()))
            .collect();
        Manifest::assemble(Root::from_json(&parts.root_json)?, keys, &mut |leaf| {
            leaves
                .get(leaf)
                .cloned()
                .ok_or_else(|| invariant("a leaf is missing"))
        })
    }

    #[test]
    fn a_manifest_this_build_did_not_write_is_refused() {
        let keys = BackupKeys::from_root(&[3; 32]);
        let good = small_manifest(1);
        let parts = good.to_parts(&keys).expect("serialises");
        assert!(reassemble(&parts, &keys).is_ok());
        let mut future: serde_json::Value = serde_json::from_slice(&parts.root_json).expect("json");
        future["v"] = serde_json::json!(MANIFEST_VERSION + 1);
        assert!(Root::from_json(future.to_string().as_bytes()).is_err());
        let mut earlier: serde_json::Value =
            serde_json::from_slice(&parts.root_json).expect("json");
        earlier["v"] = serde_json::json!(3);
        assert!(Root::from_json(earlier.to_string().as_bytes()).is_err());
        let mut extra: serde_json::Value = serde_json::from_slice(&parts.root_json).expect("json");
        extra["surprise"] = serde_json::json!(true);
        assert!(Root::from_json(extra.to_string().as_bytes()).is_err());
        let mut short = good;
        short.db_len = 4096;
        assert!(reassemble(&short.to_parts(&keys).expect("serialises"), &keys).is_err());
    }

    /// **The tree (E9).** A vault of more than a leaf's worth of ranges is several leaves, in
    /// order; one changed range changes exactly one leaf; a leaf that is not the one the root
    /// names, or has lost an entry, is refused; a tree past the fan-out is "too large".
    #[test]
    fn the_ranges_are_a_tree_of_leaves_and_a_changed_range_changes_one_leaf() {
        let keys = BackupKeys::from_root(&[3; 32]);
        let manifest = small_manifest(LEAF_ENTRIES * 2 + 5);
        let parts = manifest.to_parts(&keys).expect("serialises");
        assert_eq!(parts.leaves.len(), 3);
        let again = reassemble(&parts, &keys).expect("reads back");
        assert_eq!(again.ranges, manifest.ranges);

        let mut edited = manifest.clone();
        edited.ranges[LEAF_ENTRIES + 7].d = vec![ChunkDigest::of(b"another")];
        let after = edited.to_parts(&keys).expect("serialises");
        let changed: Vec<usize> = (0..3)
            .filter(|at| parts.leaves[*at].name != after.leaves[*at].name)
            .collect();
        assert_eq!(changed, vec![1], "only the second leaf was rewritten");

        // A leaf that is some other leaf's bytes under this one's name.
        let mut swapped = parts.clone();
        swapped.leaves[0].json = parts.leaves[1].json.clone();
        assert!(reassemble(&swapped, &keys).is_err());
        // A leaf with an entry gone: its bytes derive another name.
        let mut cut = parts.clone();
        let mut entries: Vec<RangeRef> = serde_json::from_slice(&cut.leaves[2].json).expect("json");
        entries.pop();
        cut.leaves[2].json = serde_json::to_vec(&entries).expect("json");
        assert!(reassemble(&cut, &keys).is_err());

        let too_many = Manifest {
            ranges: vec![manifest.ranges[0].clone(); LEAF_ENTRIES * ROOT_LEAVES + 1],
            ..manifest
        };
        assert!(too_many.to_parts(&keys).is_err());
    }

    /// The root fixes the leaves' names, order and count: a range leaf dropped or repeated leaves
    /// ranges that do not tile the file, a blobs leaf repeated is refused, and a blob that names
    /// parts its hash and length do not derive is refused (decision 36).
    #[test]
    fn the_root_fixes_its_leaves_and_a_blob_names_what_its_hash_derives() {
        let keys = BackupKeys::from_root(&[3; 32]);
        let mut manifest = small_manifest(LEAF_ENTRIES * 2 + 5);
        manifest.blobs = (0..LEAF_ENTRIES + 3)
            .map(|n| {
                let h = PlaintextHash::of(&n.to_be_bytes());
                let len = 10_u64;
                BlobRef {
                    h,
                    len,
                    parts: (0_u32..)
                        .zip(sealed::names_of(&keys, &h, len))
                        .map(|(i, name)| BlobPart { i, name, d: None })
                        .collect(),
                }
            })
            .collect();
        manifest.blobs.sort_by_key(|blob| blob.h);
        let parts = manifest.to_parts(&keys).expect("serialises");
        assert_eq!(parts.leaves.len(), 3 + 2);
        let again = reassemble(&parts, &keys).expect("reads back");
        assert_eq!(again.blobs, manifest.blobs);
        assert_eq!(again.blob_part_names().len(), manifest.blobs.len());

        let root = Root::from_json(&parts.root_json).expect("a root");
        let reread = |root: &Root| {
            Manifest::assemble(root.clone(), &keys, &mut |wanted| {
                parts
                    .leaves
                    .iter()
                    .find(|leaf| &leaf.name == wanted)
                    .map(|leaf| leaf.json.clone())
                    .ok_or_else(|| invariant("no such leaf"))
            })
        };
        let mut dropped = root.clone();
        dropped.ranges_tree.pop();
        assert!(reread(&dropped).is_err(), "a range leaf dropped");
        let mut repeated = root.clone();
        let again_first = repeated.ranges_tree[0];
        repeated.ranges_tree.insert(
            1,
            LeafRef {
                first: LEAF_ENTRIES as u32,
                ..again_first
            },
        );
        assert!(reread(&repeated).is_err(), "a range leaf repeated");
        let mut twice = root.clone();
        let first = twice.blobs_tree[0];
        twice.blobs_tree[1] = LeafRef {
            first: LEAF_ENTRIES as u32,
            count: first.count,
            name: first.name,
        };
        assert!(reread(&twice).is_err(), "a blobs leaf repeated");

        let mut lying = manifest.clone();
        lying.blobs[0].parts[0].name = Name::from_bytes([9; 32]);
        let bad = lying.to_parts(&keys).expect("serialises");
        assert!(
            reassemble(&bad, &keys).is_err(),
            "a blob naming other parts"
        );
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
        let known: BTreeMap<u32, (Name, Vec<ChunkDigest>)> = first
            .manifest
            .ranges
            .iter()
            .map(|r| (r.i, (r.name, r.d.clone())))
            .collect();
        let spool = spool_at(dir.path(), "b");
        let mut sealer = RangeSealer::new(&spool, &keys, u64::MAX).expect("a sealer");
        let second = capture(
            &vault,
            &keys,
            &"cd".repeat(32),
            APP,
            &|i| known.get(&i).cloned(),
            &mut sealer,
        )
        .expect("takes");
        assert_eq!(first.manifest.range_names(), second.manifest.range_names());
        assert_eq!(first.manifest.db_hash, second.manifest.db_hash);
        assert_eq!(
            first.manifest.ranges, second.manifest.ranges,
            "the digests are carried from the snapshot the ranges were named by"
        );
        assert_eq!(
            first.leaves, second.leaves,
            "so the leaves are the same objects"
        );
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
