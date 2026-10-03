//! The store the plane writes to and restores from: one destination, through
//! one synchronous trait (#1080, gateway protocol v2).
//!
//! [`Store`] is the protocol's object and head routes as Rust calls, so the
//! snapshot, retention, restore and drill code runs unchanged against the real
//! gateway client and against [`MemoryStore`]. A store is one vault at one
//! destination under one token: the vault in the path and the token's epoch
//! are the implementation's business, and a write refused because a newer
//! writer claimed the vault arrives as [`StoreError::Moved`].
//!
//! ## WHAT THE PROTOCOL GUARANTEES, AND THIS TRAIT RELIES ON
//!
//! - `put` is acknowledged only once the destination verified the digest and
//!   holds the bytes durably. **The acknowledgement IS the backup** (#1080
//!   ruling 7).
//! - `set_head` is a compare-and-set on `prev`, and registers the snapshot.
//! - `delete` tombstones with a grace period and never deletes the head's
//!   manifest ([`Refusal::HeadInUse`]); a tombstoned manifest deregisters its
//!   snapshot.
//! - A tombstoned object is missing to `exists` and to the listing, and is
//!   still served by `get` and `get_many` until the purge takes its bytes
//!   (the root's ruling A16): the grace is what lets a restore keep reading a
//!   snapshot that retention drops while it reads.
//! - `put_many` is the protocol's `bundle` and `get_many` its `fetch`: many
//!   parts in one request, each answered as its own `put` or `get` would be
//!   (the root's rulings A14 and A15). 64 KiB ranges make a snapshot hundreds
//!   of parts, and one request per part would be hundreds of round trips.
//!
//! [`MemoryStore`] models exactly these, in memory, so a test can count what
//! was uploaded and read back what a destination would hold.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use super::naming::{Digest, Name};

/// The most names one `exists` or `delete` call carries: the protocol's cap.
pub const NAMES_PER_CALL: usize = 1000;

/// The most entries one `list` page carries: the protocol's cap.
pub const LIST_PAGE: usize = 1000;

/// The most bytes one `put_many` sends or one `get_many` answers, every
/// part's frame header included: the protocol's bundle cap, 256 MiB.
pub const BUNDLE_BYTES: u64 = 256 * 1024 * 1024;

/// What one part adds to a bundle beside its bytes: its frame header, the
/// name and the digest in hex and the length as eight bytes.
pub const FRAME_HEADER_BYTES: u64 = 64 + 64 + 8;

/// One part a `put_many` sends: a spooled file, and what it must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    pub name: Name,
    /// BLAKE3 of the file's bytes, as queued.
    pub digest: Digest,
    /// The file's length, as queued.
    pub len: u64,
    /// The spool file, read as the request is sent and never held whole.
    pub path: PathBuf,
}

impl Outgoing {
    /// What this part costs a bundle: its bytes and its frame header.
    #[must_use]
    pub const fn bundle_bytes(&self) -> u64 {
        self.len.saturating_add(FRAME_HEADER_BYTES)
    }
}

/// The destination's answer to one part of a `put_many`: exactly what a
/// `put` of that part alone would have answered.
pub type PartAnswer = Result<Put, Refusal>;

/// One destination's object and head routes.
pub trait Store {
    /// The gateway this store reaches. Confirmations are filed under it.
    fn gateway_id(&self) -> &str;

    /// Which of `names` (at most [`NAMES_PER_CALL`]) the destination does not
    /// hold. A tombstoned object is not held.
    ///
    /// # Errors
    /// [`StoreError`] when the destination cannot be asked.
    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError>;

    /// Store one sealed part of `len` bytes whose BLAKE3 is `digest`.
    ///
    /// # Errors
    /// [`Refusal::DigestMismatch`] when the bytes are not `digest`,
    /// [`Refusal::NameTaken`] when another digest holds the name, and the
    /// destination's other refusals.
    fn put(
        &self,
        name: &Name,
        digest: &Digest,
        len: u64,
        body: &mut dyn Read,
    ) -> Result<Put, StoreError>;

    /// Store several parts in one request: the protocol's `bundle`. Each is
    /// answered as its own `put` would be, in the order sent. The parts'
    /// [`Outgoing::bundle_bytes`] sum to at most [`BUNDLE_BYTES`].
    ///
    /// The default sends each part as its own `put`.
    ///
    /// # Errors
    /// [`StoreError`] when the request as a whole was not answered: the
    /// destination unreachable, the writer [`StoreError::Moved`], a spool
    /// file that cannot be read, or the bundle refused whole
    /// ([`Refusal::TooLarge`]). A refusal of one part is in its answer.
    fn put_many(&self, parts: &[Outgoing]) -> Result<Vec<(Name, PartAnswer)>, StoreError> {
        let mut answers = Vec::with_capacity(parts.len());
        for part in parts {
            let mut body = File::open(&part.path)?;
            let answer = match self.put(&part.name, &part.digest, part.len, &mut body) {
                Ok(put) => Ok(put),
                Err(StoreError::Refused(refusal)) => Err(refusal),
                Err(error) => return Err(error),
            };
            answers.push((part.name, answer));
        }
        Ok(answers)
    }

    /// Write one object's sealed bytes into `sink`, returning their length.
    /// A tombstoned object is served until its purge.
    ///
    /// # Errors
    /// [`StoreError::Missing`] for a name the destination does not hold.
    fn get(&self, name: &Name, sink: &mut dyn Write) -> Result<u64, StoreError>;

    /// Fetch several objects in one request: the protocol's `fetch`. `each`
    /// is handed every object the destination holds of `names` (at most
    /// [`NAMES_PER_CALL`], whose bytes fit [`BUNDLE_BYTES`]), with its name,
    /// in the order asked and each name once; a name it is not handed is one
    /// the destination does not hold. One object is in memory at a time.
    /// Answers how many were handed over.
    ///
    /// The default reads each name with `get`.
    ///
    /// # Errors
    /// [`StoreError`] when the request was not answered, and
    /// [`StoreError::Io`] for an error `each` returns, which ends the fetch.
    fn get_many(
        &self,
        names: &[Name],
        each: &mut dyn FnMut(&Name, &[u8]) -> std::io::Result<()>,
    ) -> Result<usize, StoreError> {
        let mut seen = BTreeSet::new();
        let mut handed = 0;
        for name in names {
            if !seen.insert(*name) {
                continue;
            }
            let mut bytes = Vec::new();
            match self.get(name, &mut bytes) {
                Ok(_) => {
                    each(name, &bytes)?;
                    handed += 1;
                }
                Err(StoreError::Missing(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(handed)
    }

    /// The vault's head, or `None` before the first snapshot is registered.
    ///
    /// # Errors
    /// [`StoreError`] when the destination cannot be asked.
    fn head(&self) -> Result<Option<Head>, StoreError>;

    /// Move the head to the manifest `name`, only if it stands at `prev`.
    ///
    /// # Errors
    /// [`StoreError::HeadConflict`] carrying the current head when it does not
    /// stand at `prev`; nothing moves.
    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: u64,
    ) -> Result<Head, StoreError>;

    /// Every registered snapshot.
    ///
    /// # Errors
    /// [`StoreError`] when the destination cannot be asked.
    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError>;

    /// Up to `limit` held objects named after `after`, in name order.
    ///
    /// # Errors
    /// [`StoreError`] when the destination cannot be asked.
    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError>;

    /// Tombstone `names` (at most [`NAMES_PER_CALL`]).
    ///
    /// # Errors
    /// [`StoreError`] when the destination cannot be asked; a per-name refusal
    /// is in [`Deleted::refused`].
    fn delete(&self, names: &[Name]) -> Result<Deleted, StoreError>;
}

/// What a `put` stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Put {
    /// The bytes are new to the destination.
    Stored,
    /// The destination already held this name with this digest.
    AlreadyStored,
}

/// A vault's head at one destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Head {
    /// The manifest the head names.
    pub name: Name,
    pub taken_at_ms: u64,
    /// The writer epoch that set it.
    pub epoch: u64,
    pub set_at_ms: u64,
}

/// One registered snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotEntry {
    /// The snapshot's manifest.
    pub name: Name,
    pub taken_at_ms: u64,
    pub registered_at_ms: u64,
}

/// One held object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectEntry {
    pub name: Name,
    pub size: u64,
    pub digest: Digest,
    pub stored_at_ms: u64,
}

/// What a `delete` did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Deleted {
    pub deleted: Vec<Name>,
    pub refused: Vec<(Name, Refusal)>,
}

/// A refusal code the destination answered with. The spellings are the
/// protocol's; a code is never a sentence.
///
/// Five of the protocol's codes are not refusals at this trait, because the
/// plane acts on them as answers: `MOVED` is [`StoreError::Moved`],
/// `HEAD_CONFLICT` is [`StoreError::HeadConflict`], `NOT_FOUND` is
/// [`StoreError::Missing`], `NO_HEAD` is a [`Store::head`] of `None`, and
/// `INTERNAL` — the destination's own fault, retried later — is
/// [`StoreError::Unreachable`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// The bytes sent are not the digest declared.
    DigestMismatch,
    /// The name is held under another digest. A name is a function of the
    /// plaintext, so the destination already holds a sealing of these bytes.
    NameTaken,
    /// Over the protocol's byte cap: an object or a bundle.
    TooLarge,
    /// Over the protocol's count cap: more than [`NAMES_PER_CALL`] names.
    TooMany,
    DiskFull,
    Unauthorized,
    /// The head's own manifest cannot be deleted.
    HeadInUse,
    /// A request the destination could not read: a bug at this end.
    BadRequest,
    /// A byte range the object cannot satisfy.
    BadRange,
    /// A pairing secret offered for a vault the destination already holds.
    VaultKnown,
    /// A claim at an epoch other than the writer epoch plus one.
    EpochConflict,
    /// A code this build does not know, kept verbatim.
    Other(String),
}

impl Refusal {
    /// Every code this build names, for the tests that hold the table whole.
    pub const NAMED: [&'static str; 11] = [
        "DIGEST_MISMATCH",
        "NAME_TAKEN",
        "TOO_LARGE",
        "TOO_MANY",
        "DISK_FULL",
        "UNAUTHORIZED",
        "HEAD_IN_USE",
        "BAD_REQUEST",
        "BAD_RANGE",
        "VAULT_KNOWN",
        "EPOCH_CONFLICT",
    ];

    /// The protocol's spelling.
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::DigestMismatch => "DIGEST_MISMATCH",
            Self::NameTaken => "NAME_TAKEN",
            Self::TooLarge => "TOO_LARGE",
            Self::TooMany => "TOO_MANY",
            Self::DiskFull => "DISK_FULL",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::HeadInUse => "HEAD_IN_USE",
            Self::BadRequest => "BAD_REQUEST",
            Self::BadRange => "BAD_RANGE",
            Self::VaultKnown => "VAULT_KNOWN",
            Self::EpochConflict => "EPOCH_CONFLICT",
            Self::Other(code) => code,
        }
    }

    /// Read a code back.
    #[must_use]
    pub fn from_code(code: &str) -> Self {
        match code {
            "DIGEST_MISMATCH" => Self::DigestMismatch,
            "NAME_TAKEN" => Self::NameTaken,
            "TOO_LARGE" => Self::TooLarge,
            "TOO_MANY" => Self::TooMany,
            "DISK_FULL" => Self::DiskFull,
            "UNAUTHORIZED" => Self::Unauthorized,
            "HEAD_IN_USE" => Self::HeadInUse,
            "BAD_REQUEST" => Self::BadRequest,
            "BAD_RANGE" => Self::BadRange,
            "VAULT_KNOWN" => Self::VaultKnown,
            "EPOCH_CONFLICT" => Self::EpochConflict,
            other => Self::Other(other.to_owned()),
        }
    }
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

/// Why a store call did not answer the question it was asked.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// The destination could not be reached, or the transfer broke. Retry
    /// later; nothing is assumed stored.
    #[error("the destination is unreachable: {0}")]
    Unreachable(String),
    /// A newer writer claimed this vault at `epoch`; this one's writes are
    /// refused and its reads still answer.
    #[error("MOVED: a writer at epoch {epoch} superseded this one")]
    Moved { epoch: u64 },
    /// `set_head` lost its compare-and-set. Nothing moved.
    #[error("HEAD_CONFLICT: the head is not where this writer last left it")]
    HeadConflict { current: Option<Head> },
    #[error("refused: {0}")]
    Refused(Refusal),
    #[error("the destination holds no object {0}")]
    Missing(Name),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Which of `names` `store` does not hold, asked [`NAMES_PER_CALL`] at a time.
///
/// # Errors
/// The first [`StoreError`] a batch met.
pub fn missing(store: &dyn Store, names: &[Name]) -> Result<BTreeSet<Name>, StoreError> {
    let mut out = BTreeSet::new();
    for batch in names.chunks(NAMES_PER_CALL) {
        out.extend(store.exists(batch)?);
    }
    Ok(out)
}

/// Every object `store` holds, paged [`LIST_PAGE`] at a time.
///
/// # Errors
/// The first [`StoreError`] a page met.
pub fn list_all(store: &dyn Store) -> Result<Vec<ObjectEntry>, StoreError> {
    let mut out: Vec<ObjectEntry> = Vec::new();
    loop {
        let page = store.list(out.last().map(|entry| &entry.name), LIST_PAGE)?;
        let full = page.len() == LIST_PAGE;
        out.extend(page);
        if !full {
            return Ok(out);
        }
    }
}

/// Tombstone `names`, [`NAMES_PER_CALL`] at a time.
///
/// # Errors
/// The first [`StoreError`] a batch met.
pub fn delete_all(store: &dyn Store, names: &[Name]) -> Result<Deleted, StoreError> {
    let mut out = Deleted::default();
    for batch in names.chunks(NAMES_PER_CALL) {
        let deleted = store.delete(batch)?;
        out.deleted.extend(deleted.deleted);
        out.refused.extend(deleted.refused);
    }
    Ok(out)
}

// ─── MemoryStore ────────────────────────────────────────────────────────────

/// How long a tombstone keeps its bytes before a purge drops them.
pub const TOMBSTONE_GRACE_MS: u64 = 7 * 24 * 60 * 60 * 1000;

struct Held {
    bytes: Vec<u8>,
    digest: Digest,
    stored_at_ms: u64,
    /// Set while tombstoned: when it was deleted.
    tombstoned_at_ms: Option<u64>,
}

#[derive(Default)]
struct Shared {
    objects: BTreeMap<Name, Held>,
    head: Option<Head>,
    snapshots: BTreeMap<Name, SnapshotEntry>,
    writer_epoch: u64,
    clock_ms: Option<u64>,
    puts: u64,
    bundles: u64,
    fetches: u64,
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.clock_ms.unwrap_or_else(|| {
            u64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis()),
            )
            .unwrap_or(u64::MAX)
        })
    }

    fn held(&self, name: &Name) -> Option<&Held> {
        self.objects
            .get(name)
            .filter(|held| held.tombstoned_at_ms.is_none())
    }

    /// What `get` serves: a held object, or a tombstoned one whose bytes the
    /// purge has not taken yet (A16).
    fn served(&self, name: &Name) -> Option<&Held> {
        self.objects.get(name)
    }
}

/// A destination in memory: one vault, its objects, its head and its
/// snapshots, shared by every handle cloned from it.
///
/// Each handle writes at the epoch it was made at. [`MemoryStore::claim`]
/// makes the handle a restore takes over with, at the next epoch, after which
/// every older handle's writes are refused [`StoreError::Moved`] and its reads
/// still answer — the protocol's fence.
#[derive(Clone)]
pub struct MemoryStore {
    shared: Arc<Mutex<Shared>>,
    gateway_id: String,
    epoch: u64,
}

impl MemoryStore {
    /// An empty destination, its first writer at epoch 1.
    #[must_use]
    pub fn new(gateway_id: &str) -> Self {
        Self {
            shared: Arc::new(Mutex::new(Shared {
                writer_epoch: 1,
                ..Shared::default()
            })),
            gateway_id: gateway_id.to_owned(),
            epoch: 1,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        // A test that panicked while holding the lock already failed; its
        // state is still the store's state.
        self.shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn writable(&self, shared: &Shared) -> Result<(), StoreError> {
        if self.epoch < shared.writer_epoch {
            return Err(StoreError::Moved {
                epoch: shared.writer_epoch,
            });
        }
        Ok(())
    }

    /// Take the vault over at the next writer epoch.
    #[must_use]
    pub fn claim(&self) -> Self {
        let mut shared = self.lock();
        shared.writer_epoch += 1;
        Self {
            shared: Arc::clone(&self.shared),
            gateway_id: self.gateway_id.clone(),
            epoch: shared.writer_epoch,
        }
    }

    /// The epoch this handle writes at.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Fix the destination's clock, so `stored_at_ms` and the purge are
    /// deterministic.
    pub fn set_clock_ms(&self, now_ms: u64) {
        self.lock().clock_ms = Some(now_ms);
    }

    /// How many `put` calls stored new bytes.
    #[must_use]
    pub fn stored_puts(&self) -> u64 {
        self.lock().puts
    }

    /// How many `put_many` requests were answered.
    #[must_use]
    pub fn bundles(&self) -> u64 {
        self.lock().bundles
    }

    /// How many `get_many` requests were answered.
    #[must_use]
    pub fn fetches(&self) -> u64 {
        self.lock().fetches
    }

    /// Every held object's name and sealed bytes — what a member's copy of
    /// the destination's folder would hold.
    #[must_use]
    pub fn contents(&self) -> Vec<(Name, Vec<u8>)> {
        self.lock()
            .objects
            .iter()
            .filter(|(_, held)| held.tombstoned_at_ms.is_none())
            .map(|(name, held)| (*name, held.bytes.clone()))
            .collect()
    }

    /// Drop the bytes of every tombstone past its grace.
    pub fn purge(&self) -> usize {
        let mut shared = self.lock();
        let now = shared.now_ms();
        let before = shared.objects.len();
        shared.objects.retain(|_, held| {
            held.tombstoned_at_ms
                .is_none_or(|at| now.saturating_sub(at) < TOMBSTONE_GRACE_MS)
        });
        before - shared.objects.len()
    }
}

impl Store for MemoryStore {
    fn gateway_id(&self) -> &str {
        &self.gateway_id
    }

    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        let shared = self.lock();
        Ok(names
            .iter()
            .filter(|name| shared.held(name).is_none())
            .copied()
            .collect())
    }

    fn put(
        &self,
        name: &Name,
        digest: &Digest,
        len: u64,
        body: &mut dyn Read,
    ) -> Result<Put, StoreError> {
        self.writable(&self.lock())?;
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes)?;
        if bytes.len() as u64 != len || Digest::of(&bytes) != *digest {
            return Err(StoreError::Refused(Refusal::DigestMismatch));
        }
        let mut shared = self.lock();
        self.writable(&shared)?;
        let now = shared.now_ms();
        if let Some(held) = shared.held(name) {
            return if held.digest == *digest {
                Ok(Put::AlreadyStored)
            } else {
                Err(StoreError::Refused(Refusal::NameTaken))
            };
        }
        shared.objects.insert(
            *name,
            Held {
                bytes,
                digest: *digest,
                stored_at_ms: now,
                tombstoned_at_ms: None,
            },
        );
        shared.puts += 1;
        Ok(Put::Stored)
    }

    /// A bundle as the gateway answers one: refused whole for a superseded
    /// writer or past [`BUNDLE_BYTES`], otherwise each part as its `put`.
    fn put_many(&self, parts: &[Outgoing]) -> Result<Vec<(Name, PartAnswer)>, StoreError> {
        self.writable(&self.lock())?;
        let total = parts
            .iter()
            .map(Outgoing::bundle_bytes)
            .fold(0_u64, u64::saturating_add);
        if total > BUNDLE_BYTES {
            return Err(StoreError::Refused(Refusal::TooLarge));
        }
        self.lock().bundles += 1;
        let mut answers = Vec::with_capacity(parts.len());
        for part in parts {
            let mut body = File::open(&part.path)?;
            let answer = match self.put(&part.name, &part.digest, part.len, &mut body) {
                Ok(put) => Ok(put),
                Err(StoreError::Refused(refusal)) => Err(refusal),
                Err(error) => return Err(error),
            };
            answers.push((part.name, answer));
        }
        Ok(answers)
    }

    fn get(&self, name: &Name, sink: &mut dyn Write) -> Result<u64, StoreError> {
        let shared = self.lock();
        let held = shared.served(name).ok_or(StoreError::Missing(*name))?;
        sink.write_all(&held.bytes)?;
        Ok(held.bytes.len() as u64)
    }

    /// A fetch as the gateway answers one: refused past [`NAMES_PER_CALL`]
    /// names or [`BUNDLE_BYTES`], otherwise every served object asked for, in
    /// order, each once.
    fn get_many(
        &self,
        names: &[Name],
        each: &mut dyn FnMut(&Name, &[u8]) -> std::io::Result<()>,
    ) -> Result<usize, StoreError> {
        if names.len() > NAMES_PER_CALL {
            return Err(StoreError::Refused(Refusal::TooMany));
        }
        let mut seen = BTreeSet::new();
        let answer: Vec<(Name, Vec<u8>)> = {
            let mut shared = self.lock();
            shared.fetches += 1;
            names
                .iter()
                .filter(|name| seen.insert(**name))
                .filter_map(|name| shared.served(name).map(|held| (*name, held.bytes.clone())))
                .collect()
        };
        let total = answer
            .iter()
            .map(|(_, bytes)| bytes.len() as u64 + FRAME_HEADER_BYTES)
            .fold(0_u64, u64::saturating_add);
        if total > BUNDLE_BYTES {
            return Err(StoreError::Refused(Refusal::TooLarge));
        }
        for (name, bytes) in &answer {
            each(name, bytes)?;
        }
        Ok(answer.len())
    }

    fn head(&self) -> Result<Option<Head>, StoreError> {
        Ok(self.lock().head)
    }

    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: u64,
    ) -> Result<Head, StoreError> {
        let mut shared = self.lock();
        self.writable(&shared)?;
        if shared.head.map(|head| head.name).as_ref() != prev {
            return Err(StoreError::HeadConflict {
                current: shared.head,
            });
        }
        if shared.held(name).is_none() {
            return Err(StoreError::Missing(*name));
        }
        let now = shared.now_ms();
        let head = Head {
            name: *name,
            taken_at_ms,
            epoch: shared.writer_epoch,
            set_at_ms: now,
        };
        shared.head = Some(head);
        shared.snapshots.insert(
            *name,
            SnapshotEntry {
                name: *name,
                taken_at_ms,
                registered_at_ms: now,
            },
        );
        Ok(head)
    }

    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        let mut entries: Vec<SnapshotEntry> = self.lock().snapshots.values().copied().collect();
        entries.sort_by_key(|entry| (entry.taken_at_ms, entry.name));
        Ok(entries)
    }

    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
        let shared = self.lock();
        Ok(shared
            .objects
            .iter()
            .filter(|(name, held)| {
                held.tombstoned_at_ms.is_none() && after.is_none_or(|after| *name > after)
            })
            .take(limit)
            .map(|(name, held)| ObjectEntry {
                name: *name,
                size: held.bytes.len() as u64,
                digest: held.digest,
                stored_at_ms: held.stored_at_ms,
            })
            .collect())
    }

    fn delete(&self, names: &[Name]) -> Result<Deleted, StoreError> {
        let mut shared = self.lock();
        self.writable(&shared)?;
        let now = shared.now_ms();
        let head = shared.head.map(|head| head.name);
        let mut out = Deleted::default();
        for name in names {
            if head == Some(*name) {
                out.refused.push((*name, Refusal::HeadInUse));
                continue;
            }
            if let Some(held) = shared.objects.get_mut(name)
                && held.tombstoned_at_ms.is_none()
            {
                held.tombstoned_at_ms = Some(now);
            }
            shared.snapshots.remove(name);
            out.deleted.push(*name);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::naming::PlaintextHash;

    fn name_of(label: &str) -> Name {
        Name::from_bytes(*PlaintextHash::of(label.as_bytes()).as_bytes())
    }

    fn put(store: &MemoryStore, name: &Name, bytes: &[u8]) -> Result<Put, StoreError> {
        store.put(
            name,
            &Digest::of(bytes),
            bytes.len() as u64,
            &mut &bytes[..],
        )
    }

    #[test]
    fn a_put_is_verified_stored_once_and_read_back() {
        let store = MemoryStore::new("gw");
        let name = name_of("a");
        assert_eq!(store.exists(&[name]).expect("asks"), vec![name]);
        assert_eq!(put(&store, &name, b"sealed").expect("stores"), Put::Stored);
        assert_eq!(
            put(&store, &name, b"sealed").expect("again"),
            Put::AlreadyStored
        );
        assert!(matches!(
            put(&store, &name, b"other bytes"),
            Err(StoreError::Refused(Refusal::NameTaken))
        ));
        assert!(matches!(
            store.put(&name_of("b"), &Digest::of(b"x"), 1, &mut &b"y"[..]),
            Err(StoreError::Refused(Refusal::DigestMismatch))
        ));
        assert!(store.exists(&[name]).expect("asks").is_empty());
        let mut back = Vec::new();
        assert_eq!(store.get(&name, &mut back).expect("reads"), 6);
        assert_eq!(back, b"sealed");
        assert!(matches!(
            store.get(&name_of("b"), &mut Vec::new()),
            Err(StoreError::Missing(_))
        ));
        assert_eq!(store.stored_puts(), 1);
    }

    #[test]
    fn the_head_moves_only_from_where_the_writer_left_it() {
        let store = MemoryStore::new("gw");
        let (first, second) = (name_of("m1"), name_of("m2"));
        assert!(matches!(
            store.set_head(&first, None, 10),
            Err(StoreError::Missing(_))
        ));
        put(&store, &first, b"one").expect("stores");
        put(&store, &second, b"two").expect("stores");
        let head = store.set_head(&first, None, 10).expect("the first head");
        assert_eq!(head.name, first);
        assert_eq!(store.head().expect("reads"), Some(head));
        match store.set_head(&second, None, 20) {
            Err(StoreError::HeadConflict { current }) => assert_eq!(current, Some(head)),
            other => panic!("expected a conflict, got {other:?}"),
        }
        store.set_head(&second, Some(&first), 20).expect("moves");
        let registered: Vec<Name> = store
            .snapshots()
            .expect("lists")
            .iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(registered, vec![first, second]);
    }

    #[test]
    fn delete_tombstones_spares_the_head_and_deregisters_a_manifest() {
        let store = MemoryStore::new("gw");
        store.set_clock_ms(1_000);
        let (first, second, range) = (name_of("m1"), name_of("m2"), name_of("r"));
        for (name, bytes) in [(&first, b"one"), (&second, b"two"), (&range, b"rng")] {
            put(&store, name, bytes).expect("stores");
        }
        store.set_head(&first, None, 1).expect("heads");
        store.set_head(&second, Some(&first), 2).expect("moves");
        let deleted = store.delete(&[first, second, range]).expect("deletes");
        assert_eq!(deleted.deleted, vec![first, range]);
        assert_eq!(deleted.refused, vec![(second, Refusal::HeadInUse)]);
        assert_eq!(
            store.exists(&[first, second, range]).expect("asks"),
            vec![first, range]
        );
        assert_eq!(store.snapshots().expect("lists").len(), 1);
        assert_eq!(store.list(None, 10).expect("lists").len(), 1);

        // Within the grace a re-upload resurrects; past it the bytes go.
        assert_eq!(put(&store, &range, b"rng").expect("stores"), Put::Stored);
        store.delete(&[range]).expect("deletes");
        assert_eq!(store.purge(), 0, "inside the grace");
        store.set_clock_ms(1_000 + TOMBSTONE_GRACE_MS);
        assert_eq!(store.purge(), 2, "past it");
    }

    #[test]
    fn a_claim_fences_the_older_writer_and_its_reads_still_answer() {
        let old = MemoryStore::new("gw");
        let name = name_of("a");
        put(&old, &name, b"bytes").expect("stores");
        let new = old.claim();
        assert_eq!(new.epoch(), 2);
        assert!(matches!(
            put(&old, &name_of("b"), b"more"),
            Err(StoreError::Moved { epoch: 2 })
        ));
        assert!(matches!(old.delete(&[name]), Err(StoreError::Moved { .. })));
        assert!(matches!(
            old.set_head(&name, None, 1),
            Err(StoreError::Moved { .. })
        ));
        assert!(
            old.exists(&[name])
                .expect("a read still answers")
                .is_empty()
        );
        new.set_head(&name, None, 1).expect("the new writer writes");
        assert_eq!(old.head().expect("reads").map(|head| head.epoch), Some(2));
    }

    #[test]
    fn the_helpers_page_and_batch_past_the_protocols_caps() {
        let store = MemoryStore::new("gw");
        let names: Vec<Name> = (0..2_500)
            .map(|index| name_of(&index.to_string()))
            .collect();
        assert_eq!(missing(&store, &names).expect("asks").len(), 2_500);
        for name in &names[..1_200] {
            put(&store, name, name.as_bytes()).expect("stores");
        }
        assert_eq!(missing(&store, &names).expect("asks").len(), 1_300);
        let listed = list_all(&store).expect("lists");
        assert_eq!(listed.len(), 1_200);
        assert!(listed.windows(2).all(|pair| pair[0].name < pair[1].name));
        let deleted = delete_all(&store, &names[..1_200]).expect("deletes");
        assert_eq!(deleted.deleted.len(), 1_200);
        assert!(list_all(&store).expect("lists").is_empty());
    }

    #[test]
    fn a_refusal_code_round_trips_and_an_unknown_one_is_kept() {
        for code in Refusal::NAMED {
            let refusal = Refusal::from_code(code);
            assert!(!matches!(refusal, Refusal::Other(_)), "{code} is named");
            assert_eq!(refusal.code(), code);
        }
        assert_eq!(
            Refusal::from_code("SOMETHING_NEW"),
            Refusal::Other("SOMETHING_NEW".to_owned())
        );
        assert_eq!(Refusal::from_code("SOMETHING_NEW").code(), "SOMETHING_NEW");
    }

    /// **A16.** A tombstone is missing to `exists` and the listing and is
    /// still served by `get` and `get_many` until the purge takes its bytes,
    /// so a restore that began from a snapshot retention drops keeps reading.
    #[test]
    fn a_tombstone_is_served_until_its_purge_and_missing_to_exists() {
        let store = MemoryStore::new("gw");
        store.set_clock_ms(1_000);
        let name = name_of("range");
        put(&store, &name, b"sealed range").expect("stores");
        store.delete(&[name]).expect("tombstones");
        assert_eq!(store.exists(&[name]).expect("asks"), vec![name]);
        assert!(store.list(None, 10).expect("lists").is_empty());
        assert!(store.contents().is_empty());
        let mut back = Vec::new();
        assert_eq!(store.get(&name, &mut back).expect("still served"), 12);
        assert_eq!(back, b"sealed range");
        let mut fetched = Vec::new();
        store
            .get_many(&[name], &mut |name, bytes| {
                fetched.push((*name, bytes.to_vec()));
                Ok(())
            })
            .expect("fetches");
        assert_eq!(fetched, vec![(name, b"sealed range".to_vec())]);
        assert!(
            matches!(store.set_head(&name, None, 1), Err(StoreError::Missing(_))),
            "a head never names a tombstone"
        );

        store.set_clock_ms(1_000 + TOMBSTONE_GRACE_MS);
        assert_eq!(store.purge(), 1);
        assert!(matches!(
            store.get(&name, &mut Vec::new()),
            Err(StoreError::Missing(_))
        ));
    }

    fn outgoing(dir: &std::path::Path, label: &str, bytes: &[u8]) -> Outgoing {
        let name = name_of(label);
        let path = dir.join(name.to_hex());
        std::fs::write(&path, bytes).expect("spools");
        Outgoing {
            name,
            digest: Digest::of(bytes),
            len: bytes.len() as u64,
            path,
        }
    }

    /// **A15.** A bundle is answered part by part exactly as each part's
    /// `put` would be, and a fetch hands back what is held, in the order
    /// asked, each name once.
    #[test]
    fn a_bundle_and_a_fetch_answer_each_part_as_one_call_would() {
        let dir = tempfile::tempdir().expect("a directory");
        let store = MemoryStore::new("gw");
        let held = outgoing(dir.path(), "held", b"held already");
        put(&store, &held.name, b"held already").expect("stores");
        let taken = outgoing(dir.path(), "taken", b"sealed again");
        put(&store, &taken.name, b"an earlier sealing").expect("stores");
        let fresh = outgoing(dir.path(), "fresh", b"new bytes");
        let mut torn = outgoing(dir.path(), "torn", b"queued bytes");
        torn.digest = Digest::of(b"other bytes");

        let answers = store
            .put_many(&[held.clone(), taken.clone(), fresh.clone(), torn.clone()])
            .expect("a bundle");
        assert_eq!(
            answers,
            vec![
                (held.name, Ok(Put::AlreadyStored)),
                (taken.name, Err(Refusal::NameTaken)),
                (fresh.name, Ok(Put::Stored)),
                (torn.name, Err(Refusal::DigestMismatch)),
            ]
        );
        assert_eq!(store.bundles(), 1);

        let absent = name_of("absent");
        let mut order = Vec::new();
        let handed = store
            .get_many(
                &[fresh.name, absent, held.name, fresh.name],
                &mut |name, bytes| {
                    order.push((*name, bytes.len()));
                    Ok(())
                },
            )
            .expect("a fetch");
        assert_eq!(handed, 2);
        assert_eq!(order, vec![(fresh.name, 9), (held.name, 12)]);
        assert_eq!(store.fetches(), 1);

        let too_many: Vec<Name> = (0..=NAMES_PER_CALL)
            .map(|index| name_of(&index.to_string()))
            .collect();
        assert!(matches!(
            store.get_many(&too_many, &mut |_, _| Ok(())),
            Err(StoreError::Refused(Refusal::TooMany))
        ));
        let mut oversized = fresh.clone();
        oversized.len = BUNDLE_BYTES;
        assert!(matches!(
            store.put_many(&[oversized]),
            Err(StoreError::Refused(Refusal::TooLarge))
        ));
        let _successor = store.claim();
        assert!(matches!(
            store.put_many(&[fresh]),
            Err(StoreError::Moved { epoch: 2 })
        ));
    }
}
