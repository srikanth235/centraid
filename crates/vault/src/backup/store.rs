//! The store the plane writes to and restores from: one destination, through
//! one synchronous trait (#1080, gateway protocol v3).
//!
//! [`Store`] is the protocol's object and head routes as Rust calls, so the
//! snapshot, retention, restore and drill code runs unchanged against the real
//! gateway client and against [`MemoryStore`]. A store is one vault at one
//! destination under one token: the vault in the path and the token's epoch
//! are the implementation's business, and a write (or read with a revoked
//! token) refused because a newer writer claimed the vault arrives as
//! [`StoreError::Moved`].
//!
//! Protocol limits, refusal codes, wire enums and [`MemoryStore`]'s state
//! machine come directly from `centraid_gateway::rules` (built with
//! `default-features = false`, zero I/O), so the vault plane and the gateway
//! cannot drift.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::File;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use centraid_gateway::rules::bundle::HEADER_LEN;
use centraid_gateway::rules::code::{Code as WireCode, Refusal as WireRefusal};
use centraid_gateway::rules::engine::{Arrival, Gateway, PutOutcome};
use centraid_gateway::rules::ids::{
    Digest as WireDigest, GatewayId, Name as WireName, Secret, Token, VaultId,
};
use centraid_gateway::rules::limits::{GRACE_MS, LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_NAMES};
use centraid_gateway::rules::memory::MemoryState;
use centraid_gateway::rules::signing::{
    HeadFields, sign_check, sign_claim, sign_delete, sign_head, sign_pair, sign_undo,
};
use centraid_gateway::rules::state::Fault;
use centraid_gateway::rules::wire::{
    CheckRequest, CheckState, ClaimBody, DeleteRequest, HeadView, HeldEntry as WireHeldEntry,
    ObjectEntry as WireObjectEntry, PairKind, PairRequest, SecretBody, SetHead, SnapshotView,
    UndoRequest,
};
use ed25519_dalek::SigningKey;

use super::naming::{Digest, Name};

/// The most names one `exists` or `delete` call carries: the protocol's cap.
pub const NAMES_PER_CALL: usize = MAX_NAMES;

/// The most entries one `list` page carries: the protocol's cap.
pub const LIST_PAGE: usize = LIST_LIMIT;

/// The most bytes one `put_many` sends or one `get_many` answers, every part's
/// frame header included: the protocol's bundle cap.
pub const BUNDLE_BYTES: u64 = MAX_BUNDLE_BYTES;

/// How long a tombstone keeps its bytes before a purge drops them.
pub const TOMBSTONE_GRACE_MS: u64 = GRACE_MS as u64;

/// What one part adds to a bundle beside its bytes: its frame header, the
/// name and the digest in hex and the length as eight bytes.
pub const FRAME_HEADER_BYTES: u64 = HEADER_LEN as u64;

/// What a held delete is.
pub use centraid_gateway::rules::wire::HeldKind;

/// Why a name a `put` wanted is not free.
pub use centraid_gateway::rules::wire::NameState;

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

    /// Ask the destination to hash one stored object against its recorded digest and mark the
    /// name damaged if they differ (decision 34). Signed by the vault key, so a token alone
    /// cannot ask. The default is a destination that cannot.
    ///
    /// # Errors
    /// As [`Store::delete`]; `BUSY` past the destination's cap is a refusal.
    fn check_name(&self, _name: &Name) -> Result<NameCheck, StoreError> {
        Ok(NameCheck::Unsupported)
    }

    /// Write `len` bytes (to the end when `None`) of one object from `offset` into `sink`,
    /// returning how many: the protocol's single `Range` read. The default reads the whole
    /// object and cuts it; a destination that can read a range does.
    ///
    /// # Errors
    /// As [`Store::get`]; an object shorter than `offset` is an `InvalidData` I/O error.
    fn get_range(
        &self,
        name: &Name,
        offset: u64,
        len: Option<u64>,
        sink: &mut dyn Write,
    ) -> Result<u64, StoreError> {
        let mut all = Vec::new();
        self.get(name, &mut all)?;
        let start = usize::try_from(offset).unwrap_or(usize::MAX);
        if start > all.len() {
            return Err(StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "the object is shorter than the range asked",
            )));
        }
        let end = len.map_or(all.len(), |len| {
            start
                .saturating_add(usize::try_from(len).unwrap_or(usize::MAX))
                .min(all.len())
        });
        sink.write_all(&all[start..end])?;
        Ok((end - start) as u64)
    }

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

    /// The generation the last signed record this store sent (or read back as
    /// standing) used: what the next signed record continues from (E3). A
    /// store that signs nothing answers its own counter.
    fn generation(&self) -> u64 {
        0
    }

    /// Move the head to the manifest `name`, only if it stands at `prev`,
    /// signed by the vault key at the next generation. `writes` is the
    /// vault's write counter in that snapshot (E2).
    ///
    /// # Errors
    /// [`StoreError::HeadConflict`] carrying the current head when it does not
    /// stand at `prev`; nothing moves. [`Refusal::OutOfOrder`] when the
    /// destination holds something newer (after one re-sign),
    /// [`Refusal::ClockAhead`] when `taken_at_ms` is ahead of its clock.
    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: u64,
        writes: u64,
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

    /// Up to `limit` deletes still held, named after `after`, in name order:
    /// what the member may still undo (E6).
    ///
    /// # Errors
    /// [`StoreError`] when the destination cannot be asked.
    fn held(&self, after: Option<&Name>, limit: usize) -> Result<Vec<HeldEntry>, StoreError>;

    /// Lift the holds on `names`, or on every hold when `None`, signed by the
    /// vault key. Answers how many were lifted.
    ///
    /// # Errors
    /// [`StoreError`] when the destination cannot be asked.
    fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError>;
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
    /// The head this one replaced, as signed.
    pub prev: Option<Name>,
    pub taken_at_ms: u64,
    /// The writer epoch that set it, as signed.
    pub epoch: u64,
    /// The generation and writes it was signed at (E2, E3).
    pub generation: u64,
    pub writes: u64,
    pub set_at_ms: u64,
}

/// One registered snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotEntry {
    /// The snapshot's manifest.
    pub name: Name,
    pub taken_at_ms: u64,
    pub registered_at_ms: u64,
    /// The writer epoch and generation its head was signed at: the signed order of snapshots,
    /// which retention judges before any clock. 0 where the destination does not say.
    pub epoch: u64,
    pub generation: u64,
    /// While its manifest is held for deletion: when, and when it goes (E6).
    /// A held snapshot stays listed, and a restore may still choose it.
    pub held_at_ms: Option<u64>,
    pub purge_after_ms: Option<u64>,
}

/// One delete waiting out its hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeldEntry {
    pub name: Name,
    pub size: u64,
    pub digest: Digest,
    pub kind: HeldKind,
    pub held_at_ms: u64,
    pub purge_after_ms: u64,
}

/// One held object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectEntry {
    pub name: Name,
    pub size: u64,
    pub digest: Digest,
    pub stored_at_ms: u64,
}

/// What the gateway found when asked to check one name (decision 34).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameCheck {
    /// The stored bytes hash to the recorded digest; the gateway changed nothing.
    Intact,
    /// They do not: the gateway marked the name damaged, and a signed delete frees it at once.
    Damaged,
    /// The gateway holds no object of that name.
    Missing,
    /// This destination cannot check a name.
    Unsupported,
}

/// What a `delete` did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Deleted {
    /// Held now, held before, or never stored.
    pub deleted: Vec<Name>,
    /// Damaged objects freed at once, with no hold (decision 30).
    pub freed: Vec<Name>,
    pub refused: Vec<(Name, Refusal)>,
}

/// A refusal code the destination answered with. The spellings are
/// `centraid_gateway::rules::code::Code`'s; a code is never a sentence.
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
    /// The name is not free: the destination holds it under `held`, live,
    /// held for deletion or damaged. **An acknowledgement only if `held` is
    /// the digest that was sent** (decision 30); never otherwise.
    NameTaken {
        held: Digest,
        state: NameState,
    },
    /// The destination holds something newer or different than the signed
    /// record this device sent (E3).
    OutOfOrder,
    /// The person at the gateway machine paused the vault (E6).
    Frozen,
    /// The destination is asked too much just now (E5).
    Busy,
    /// A `taken_at_ms` ahead of the destination's clock (E14).
    ClockAhead,
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
    /// `NAME_TAKEN` is not among them: it travels with the recorded digest
    /// and the name's state, so a code alone cannot be read back into it.
    pub const NAMED: [&'static str; 14] = [
        WireCode::DigestMismatch.as_str(),
        WireCode::TooLarge.as_str(),
        WireCode::TooMany.as_str(),
        WireCode::DiskFull.as_str(),
        WireCode::Unauthorized.as_str(),
        WireCode::HeadInUse.as_str(),
        WireCode::BadRequest.as_str(),
        WireCode::BadRange.as_str(),
        WireCode::VaultKnown.as_str(),
        WireCode::EpochConflict.as_str(),
        WireCode::OutOfOrder.as_str(),
        WireCode::Frozen.as_str(),
        WireCode::Busy.as_str(),
        WireCode::ClockAhead.as_str(),
    ];

    /// The protocol's spelling.
    #[must_use]
    pub fn code(&self) -> &str {
        match self {
            Self::DigestMismatch => WireCode::DigestMismatch.as_str(),
            Self::NameTaken { .. } => WireCode::NameTaken.as_str(),
            Self::OutOfOrder => WireCode::OutOfOrder.as_str(),
            Self::Frozen => WireCode::Frozen.as_str(),
            Self::Busy => WireCode::Busy.as_str(),
            Self::ClockAhead => WireCode::ClockAhead.as_str(),
            Self::TooLarge => WireCode::TooLarge.as_str(),
            Self::TooMany => WireCode::TooMany.as_str(),
            Self::DiskFull => WireCode::DiskFull.as_str(),
            Self::Unauthorized => WireCode::Unauthorized.as_str(),
            Self::HeadInUse => WireCode::HeadInUse.as_str(),
            Self::BadRequest => WireCode::BadRequest.as_str(),
            Self::BadRange => WireCode::BadRange.as_str(),
            Self::VaultKnown => WireCode::VaultKnown.as_str(),
            Self::EpochConflict => WireCode::EpochConflict.as_str(),
            Self::Other(code) => code,
        }
    }

    /// Read a protocol [`WireCode`] into a plane [`Refusal`].
    #[must_use]
    pub fn from_wire_code(code: WireCode) -> Self {
        match code {
            WireCode::DigestMismatch => Self::DigestMismatch,
            WireCode::OutOfOrder => Self::OutOfOrder,
            WireCode::Frozen => Self::Frozen,
            WireCode::Busy => Self::Busy,
            WireCode::ClockAhead => Self::ClockAhead,
            WireCode::TooLarge => Self::TooLarge,
            WireCode::TooMany => Self::TooMany,
            WireCode::DiskFull => Self::DiskFull,
            WireCode::Unauthorized => Self::Unauthorized,
            WireCode::HeadInUse => Self::HeadInUse,
            WireCode::BadRequest => Self::BadRequest,
            WireCode::BadRange => Self::BadRange,
            WireCode::VaultKnown => Self::VaultKnown,
            WireCode::EpochConflict => Self::EpochConflict,
            other => Self::Other(other.as_str().to_owned()),
        }
    }

    /// Read a code back.
    #[must_use]
    pub fn from_code(code: &str) -> Self {
        WireCode::parse(code).map_or_else(|| Self::Other(code.to_owned()), Self::from_wire_code)
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
    /// The machine that answered is not the destination this device paired
    /// with: another certificate, or another id. Nothing is sent to it.
    #[error("the machine that answered is not the paired destination: {0}")]
    Untrusted(String),
    /// What the destination served does not hash to the digest it came with:
    /// the copy it holds, or the bytes on the way, are damaged.
    #[error("the copy on the destination did not open: {0}")]
    Damaged(String),
    /// A newer writer claimed this vault at `epoch`, **proved by a claim that
    /// verifies under this vault's key and is above the epoch this device
    /// holds** (E4); this one's writes are refused and its reads still answer.
    #[error("MOVED: a writer at epoch {epoch} superseded this one")]
    Moved { epoch: u64 },
    /// The gateway runs a protocol below the one this build requires.
    #[error("the gateway runs protocol {found}; this build needs {required}")]
    GatewayOld { found: u64, required: u64 },
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

// ─── Shared wire ↔ plane conversions ────────────────────────────────────────

/// Convert a plane [`Name`] to a protocol [`WireName`]. Both are the same 32 bytes.
#[must_use]
pub const fn wire_name(name: &Name) -> WireName {
    WireName::from_bytes(*name.as_bytes())
}

/// Convert a protocol [`WireName`] to a plane [`Name`].
#[must_use]
pub const fn plane_name(name: &WireName) -> Name {
    Name::from_bytes(*name.as_bytes())
}

/// Convert a plane [`Digest`] to a protocol [`WireDigest`].
#[must_use]
pub const fn wire_digest(digest: &Digest) -> WireDigest {
    WireDigest::from_bytes(*digest.as_bytes())
}

/// Convert a protocol [`WireDigest`] to a plane [`Digest`].
#[must_use]
pub const fn plane_digest(digest: &WireDigest) -> Digest {
    Digest::from_bytes(*digest.as_bytes())
}

fn unsigned(ms: i64) -> u64 {
    u64::try_from(ms).unwrap_or(0)
}

fn signed(ms: u64) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX)
}

/// Convert a protocol [`HeadView`] to a plane [`Head`].
#[must_use]
pub fn head_of_view(view: &HeadView) -> Head {
    Head {
        name: plane_name(&view.name),
        prev: view.prev.as_ref().map(plane_name),
        taken_at_ms: unsigned(view.taken_at_ms),
        epoch: view.epoch,
        generation: view.generation,
        writes: view.writes,
        set_at_ms: unsigned(view.set_at_ms),
    }
}

/// Convert a protocol [`SnapshotView`] to a plane [`SnapshotEntry`].
#[must_use]
pub fn snapshot_of_view(view: &SnapshotView) -> SnapshotEntry {
    SnapshotEntry {
        name: plane_name(&view.name),
        taken_at_ms: unsigned(view.taken_at_ms),
        registered_at_ms: unsigned(view.registered_at_ms),
        epoch: view.epoch,
        generation: view.generation,
        held_at_ms: view.held_at_ms.map(unsigned),
        purge_after_ms: view.purge_after_ms.map(unsigned),
    }
}

/// Convert a protocol [`WireObjectEntry`] to a plane [`ObjectEntry`].
#[must_use]
pub fn object_of_view(entry: &WireObjectEntry) -> ObjectEntry {
    ObjectEntry {
        name: plane_name(&entry.name),
        size: entry.size,
        digest: plane_digest(&entry.digest),
        stored_at_ms: unsigned(entry.stored_at_ms),
    }
}

/// Convert a protocol [`WireHeldEntry`] to a plane [`HeldEntry`].
#[must_use]
pub fn held_of_view(entry: &WireHeldEntry) -> HeldEntry {
    HeldEntry {
        name: plane_name(&entry.name),
        size: entry.size,
        digest: plane_digest(&entry.digest),
        kind: entry.kind,
        held_at_ms: unsigned(entry.held_at_ms),
        purge_after_ms: unsigned(entry.purge_after_ms),
    }
}

/// Convert a protocol [`CheckState`] to a plane [`NameCheck`].
#[must_use]
pub const fn check_of_state(state: CheckState) -> NameCheck {
    match state {
        CheckState::Intact => NameCheck::Intact,
        CheckState::Damaged => NameCheck::Damaged,
        CheckState::Missing => NameCheck::Missing,
    }
}

/// Convert a non-`Moved` protocol [`WireRefusal`] to a [`StoreError`].
/// (`Moved` requires signature verification by the caller that holds the vault
/// key; here it maps to `Refusal::Other("MOVED")`.)
#[must_use]
pub fn error_of_wire_refusal(refusal: &WireRefusal) -> StoreError {
    match refusal {
        WireRefusal::HeadConflict { head, .. } => StoreError::HeadConflict {
            current: head.as_deref().map(head_of_view),
        },
        WireRefusal::NotFound { name: Some(name) } => StoreError::Missing(plane_name(name)),
        WireRefusal::NameTaken { digest, state } => StoreError::Refused(Refusal::NameTaken {
            held: plane_digest(digest),
            state: *state,
        }),
        other => StoreError::Refused(Refusal::from_wire_code(other.code())),
    }
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
        out.freed.extend(deleted.freed);
        out.refused.extend(deleted.refused);
    }
    Ok(out)
}

// ─── MemoryStore (backed directly by centraid_gateway::rules::Gateway) ──────

struct Shared {
    gateway: Gateway<MemoryState>,
    bytes: BTreeMap<WireName, Vec<u8>>,
    identity: SigningKey,
    vault: VaultId,
    head_name: Option<WireName>,
    writer_epoch: u64,
    generation: u64,
    draws: u64,
    clock_ms: Option<u64>,
    puts: u64,
    bundles: u64,
    fetches: u64,
}

impl Shared {
    fn now_ms(&self) -> i64 {
        let ms = self.clock_ms.unwrap_or_else(|| {
            u64::try_from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis()),
            )
            .unwrap_or(u64::MAX)
        });
        signed(ms)
    }

    fn draw_bytes(&mut self) -> [u8; 32] {
        self.draws += 1;
        blake3::derive_key("centraid memory store draw", &self.draws.to_be_bytes())
    }

    fn draw_nonce(&mut self, now_ms: i64) -> centraid_gateway::rules::ids::Nonce {
        let raw = self.draw_bytes();
        let mut random = [0_u8; 16];
        random.copy_from_slice(&raw[..16]);
        self.gateway
            .issue_nonce(random, now_ms)
            .expect("memory store nonce")
            .nonce
    }

    fn next_generation(&self) -> u64 {
        self.generation.saturating_add(1)
    }
}

fn fault_error(fault: Fault, missing_name: Option<Name>) -> StoreError {
    match fault {
        Fault::Refused(WireRefusal::Moved { epoch, .. }) => StoreError::Moved { epoch },
        Fault::Refused(WireRefusal::NotFound { name: None }) => match missing_name {
            Some(name) => StoreError::Missing(name),
            None => StoreError::Refused(Refusal::from_wire_code(WireCode::NotFound)),
        },
        Fault::Refused(refusal) => error_of_wire_refusal(&refusal),
        Fault::Store(fault) => StoreError::Unreachable(fault.0),
    }
}

/// A destination in memory backed directly by [`Gateway<MemoryState>`]: one
/// vault, its objects, its head and its snapshots, shared by every handle
/// cloned from it.
///
/// Each handle writes (and reads) under the token minted at its epoch.
/// [`MemoryStore::claim`] executes a real signed takeover at the next epoch,
/// revoking every older token so superseded handles receive
/// [`StoreError::Moved`] — matching protocol v3 (E5).
#[derive(Clone)]
pub struct MemoryStore {
    shared: Arc<Mutex<Shared>>,
    gateway_id: String,
    token: Token,
    epoch: u64,
}

impl MemoryStore {
    /// An empty destination, its first writer paired at epoch 1.
    #[must_use]
    pub fn new(gateway_id: &str) -> Self {
        let mut gid_bytes = [0_u8; 16];
        gid_bytes.copy_from_slice(&blake3::hash(gateway_id.as_bytes()).as_bytes()[..16]);
        let gid = GatewayId::from_bytes(gid_bytes);
        let nonce_key = blake3::derive_key("centraid memory store nonce", gateway_id.as_bytes());
        let id_bytes = blake3::derive_key("centraid memory store identity", gateway_id.as_bytes());
        let identity = SigningKey::from_bytes(&id_bytes);
        let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
        let mut gateway = Gateway::new(MemoryState::default(), gid, nonce_key);

        let secret = Secret::from_bytes([0x11; 16]);
        gateway.mint_secret(&secret, 0).expect("mints secret");
        let nonce = gateway.issue_nonce([0x22; 16], 0).expect("nonce").nonce;
        let signature = sign_pair(&identity, &gid, &secret, &nonce);
        let token = Token::from_bytes(blake3::derive_key(
            "centraid memory store token",
            &1_u64.to_be_bytes(),
        ));
        gateway
            .pair(
                &PairRequest {
                    vault_id: vault,
                    label: "memory".to_owned(),
                    kind: PairKind::Secret,
                    nonce,
                    secret: Some(SecretBody { secret, signature }),
                    claim: None,
                    read: None,
                },
                &token,
                0,
            )
            .expect("pairs initial writer");

        Self {
            shared: Arc::new(Mutex::new(Shared {
                gateway,
                bytes: BTreeMap::new(),
                identity,
                vault,
                head_name: None,
                writer_epoch: 1,
                generation: 0,
                draws: 1,
                clock_ms: None,
                puts: 0,
                bundles: 0,
                fetches: 0,
            })),
            gateway_id: gateway_id.to_owned(),
            token,
            epoch: 1,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Take the vault over at the next writer epoch through the gateway's real
    /// signed claim rule, revoking all older tokens.
    #[must_use]
    pub fn claim(&self) -> Self {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let head_seen = match shared.gateway.head(&shared.vault, &self.token) {
            Ok(head) => Some(head.name),
            Err(Fault::Refused(WireRefusal::NoHead { .. })) => None,
            Err(_) => shared.head_name,
        };
        let next_epoch = shared.writer_epoch + 1;
        let nonce = shared.draw_nonce(now_ms);
        let gid = shared.gateway.id();
        let signature = sign_claim(
            &shared.identity,
            &gid,
            next_epoch,
            head_seen.as_ref(),
            &nonce,
        );
        let new_token = Token::from_bytes(shared.draw_bytes());
        let vault = shared.vault;
        shared
            .gateway
            .pair(
                &PairRequest {
                    vault_id: vault,
                    label: format!("memory-{next_epoch}"),
                    kind: PairKind::Claim,
                    nonce,
                    secret: None,
                    claim: Some(ClaimBody {
                        epoch: next_epoch,
                        head_seen,
                        signature,
                    }),
                    read: None,
                },
                &new_token,
                now_ms,
            )
            .expect("claims next writer epoch");
        shared.writer_epoch = next_epoch;
        shared.generation = 0;
        Self {
            shared: Arc::clone(&self.shared),
            gateway_id: self.gateway_id.clone(),
            token: new_token,
            epoch: next_epoch,
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

    /// Every held (live) object's name and sealed bytes — what a member's copy
    /// of the destination's folder would hold.
    #[must_use]
    pub fn contents(&self) -> Vec<(Name, Vec<u8>)> {
        let shared = self.lock();
        let mut out = Vec::new();
        let mut after = None;
        while let Ok(page) =
            shared
                .gateway
                .objects(&shared.vault, &self.token, after.as_ref(), LIST_PAGE)
        {
            let full = page.len() == LIST_PAGE;
            for entry in &page {
                if let Some(bytes) = shared.bytes.get(&entry.name) {
                    out.push((plane_name(&entry.name), bytes.clone()));
                }
            }
            if !full {
                break;
            }
            after = page.last().map(|entry| entry.name);
        }
        out
    }

    /// Drop the bytes of every tombstone past its grace.
    pub fn purge(&self) -> usize {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let mut purged = 0;
        loop {
            let due = shared
                .gateway
                .purgeable(None, now_ms, LIST_PAGE)
                .expect("purgeable");
            if due.is_empty() {
                return purged;
            }
            let mut progressed = false;
            for (_, vault, name) in due {
                let Shared { gateway, bytes, .. } = &mut *shared;
                if gateway
                    .purge(&vault, &name, now_ms, || {
                        bytes.remove(&name);
                        Ok(())
                    })
                    .expect("purges")
                {
                    purged += 1;
                    progressed = true;
                }
            }
            if !progressed {
                return purged;
            }
        }
    }
}

impl Store for MemoryStore {
    fn gateway_id(&self) -> &str {
        &self.gateway_id
    }

    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        let shared = self.lock();
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let missing = shared
            .gateway
            .exists(&shared.vault, &self.token, &asked)
            .map_err(|fault| fault_error(fault, None))?;
        Ok(missing.iter().map(plane_name).collect())
    }

    fn put(
        &self,
        name: &Name,
        digest: &Digest,
        len: u64,
        body: &mut dyn Read,
    ) -> Result<Put, StoreError> {
        let mut data = Vec::new();
        body.read_to_end(&mut data)?;
        if data.len() as u64 != len {
            return Err(StoreError::Refused(Refusal::DigestMismatch));
        }
        let wname = wire_name(name);
        let arrival = Arrival {
            name: wname,
            declared: wire_digest(digest),
            digest: WireDigest::of(&data),
            size: len,
        };
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let vault = shared.vault;
        let Shared { gateway, bytes, .. } = &mut *shared;
        let outcome = gateway
            .put(&vault, &self.token, &arrival, now_ms, || {
                bytes.insert(wname, data);
                Ok(())
            })
            .map_err(|fault| fault_error(fault, Some(*name)))?;
        match outcome {
            PutOutcome::Stored(_) => {
                shared.puts += 1;
                Ok(Put::Stored)
            }
            PutOutcome::AlreadyStored(_) => Ok(Put::AlreadyStored),
        }
    }

    /// A bundle as the gateway answers one: refused whole for a superseded
    /// writer or past [`BUNDLE_BYTES`], otherwise each part as its `put`.
    fn put_many(&self, parts: &[Outgoing]) -> Result<Vec<(Name, PartAnswer)>, StoreError> {
        let total = parts
            .iter()
            .map(Outgoing::bundle_bytes)
            .fold(0_u64, u64::saturating_add);
        if total > BUNDLE_BYTES {
            return Err(StoreError::Refused(Refusal::TooLarge));
        }
        let mut staged: Vec<(Arrival, Vec<u8>)> = Vec::with_capacity(parts.len());
        for part in parts {
            let mut data = Vec::new();
            File::open(&part.path)?.read_to_end(&mut data)?;
            let declared = wire_digest(&part.digest);
            // If file length disagrees with `part.len`, force a digest mismatch
            // so the gateway rules judge it uniformly as `DigestMismatch`.
            let digest = if data.len() as u64 == part.len {
                WireDigest::of(&data)
            } else {
                let mut bogus = *declared.as_bytes();
                bogus[0] ^= 0xff;
                WireDigest::from_bytes(bogus)
            };
            staged.push((
                Arrival {
                    name: wire_name(&part.name),
                    declared,
                    digest,
                    size: data.len() as u64,
                },
                data,
            ));
        }
        let arrivals: Vec<Arrival> = staged.iter().map(|(arrival, _)| *arrival).collect();
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let vault = shared.vault;
        let Shared { gateway, bytes, .. } = &mut *shared;
        let outcomes = gateway
            .put_bundle(&vault, &self.token, &arrivals, now_ms, |index| {
                let (arrival, data) = &mut staged[index];
                bytes.insert(arrival.name, std::mem::take(data));
                Ok(())
            })
            .map_err(|fault| fault_error(fault, None))?;
        shared.bundles += 1;
        let mut out = Vec::with_capacity(parts.len());
        for (part, outcome) in parts.iter().zip(outcomes) {
            let answer = match outcome {
                Ok(PutOutcome::Stored(_)) => {
                    shared.puts += 1;
                    Ok(Put::Stored)
                }
                Ok(PutOutcome::AlreadyStored(_)) => Ok(Put::AlreadyStored),
                Err(WireRefusal::NameTaken { digest, state }) => Err(Refusal::NameTaken {
                    held: plane_digest(&digest),
                    state,
                }),
                Err(refusal) => Err(Refusal::from_wire_code(refusal.code())),
            };
            out.push((part.name, answer));
        }
        Ok(out)
    }

    fn get(&self, name: &Name, sink: &mut dyn Write) -> Result<u64, StoreError> {
        let shared = self.lock();
        let wname = wire_name(name);
        shared
            .gateway
            .object(&shared.vault, &self.token, &wname)
            .map_err(|fault| fault_error(fault, Some(*name)))?;
        let held = shared.bytes.get(&wname).ok_or(StoreError::Missing(*name))?;
        sink.write_all(held)?;
        Ok(held.len() as u64)
    }

    fn check_name(&self, name: &Name) -> Result<NameCheck, StoreError> {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let generation = shared.next_generation();
        let wname = wire_name(name);
        let gid = shared.gateway.id();
        let request = CheckRequest {
            name: wname,
            generation,
            signature: sign_check(&shared.identity, &gid, self.epoch, generation, &wname),
        };
        let vault = shared.vault;
        let Shared { gateway, bytes, .. } = &mut *shared;
        let checked = gateway
            .check(&vault, &self.token, &request, now_ms, |name| {
                Ok(bytes.get(name).map(|data| WireDigest::of(data)))
            })
            .map_err(|fault| fault_error(fault, Some(*name)))?;
        shared.generation = generation;
        Ok(check_of_state(checked.state))
    }

    /// A fetch as the gateway answers one: refused past [`NAMES_PER_CALL`]
    /// names or [`BUNDLE_BYTES`], otherwise every served object asked for, in
    /// order, each once.
    fn get_many(
        &self,
        names: &[Name],
        each: &mut dyn FnMut(&Name, &[u8]) -> std::io::Result<()>,
    ) -> Result<usize, StoreError> {
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let answer: Vec<(Name, Vec<u8>)> = {
            let mut shared = self.lock();
            let plan = shared
                .gateway
                .fetch(&shared.vault, &self.token, &asked)
                .map_err(|fault| fault_error(fault, None))?;
            shared.fetches += 1;
            plan.iter()
                .filter_map(|record| {
                    shared
                        .bytes
                        .get(&record.name)
                        .map(|data| (plane_name(&record.name), data.clone()))
                })
                .collect()
        };
        for (name, bytes) in &answer {
            each(name, bytes)?;
        }
        Ok(answer.len())
    }

    fn head(&self) -> Result<Option<Head>, StoreError> {
        let shared = self.lock();
        match shared.gateway.head(&shared.vault, &self.token) {
            Ok(view) => Ok(Some(head_of_view(&view))),
            Err(Fault::Refused(WireRefusal::NoHead { .. })) => Ok(None),
            Err(fault) => Err(fault_error(fault, None)),
        }
    }

    fn generation(&self) -> u64 {
        self.lock().generation
    }

    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: u64,
        writes: u64,
    ) -> Result<Head, StoreError> {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let generation = shared.next_generation();
        let wname = wire_name(name);
        let wprev = prev.map(wire_name);
        let gid = shared.gateway.id();
        let fields = HeadFields {
            epoch: self.epoch,
            generation,
            writes,
            taken_at_ms: signed(taken_at_ms),
            manifest: wname,
            prev: wprev,
        };
        let request = SetHead {
            name: wname,
            prev: wprev,
            taken_at_ms: signed(taken_at_ms),
            generation,
            writes,
            signature: sign_head(&shared.identity, &gid, &fields),
        };
        let vault = shared.vault;
        let view = shared
            .gateway
            .set_head(&vault, &self.token, &request, now_ms)
            .map_err(|fault| fault_error(fault, Some(*name)))?;
        shared.generation = view.generation;
        shared.head_name = Some(view.name);
        Ok(head_of_view(&view))
    }

    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        let shared = self.lock();
        let mut entries = Vec::new();
        let mut after = None;
        loop {
            let page = shared
                .gateway
                .snapshots(&shared.vault, &self.token, after.as_ref(), LIST_PAGE)
                .map_err(|fault| fault_error(fault, None))?;
            let full = page.len() == LIST_PAGE;
            entries.extend(page.iter().map(snapshot_of_view));
            if !full {
                break;
            }
            after = page.last().map(|view| view.name);
        }
        entries.sort_by_key(|entry| (entry.taken_at_ms, entry.name));
        Ok(entries)
    }

    fn list(&self, after: Option<&Name>, limit: usize) -> Result<Vec<ObjectEntry>, StoreError> {
        let shared = self.lock();
        let after = after.map(wire_name);
        let entries = shared
            .gateway
            .objects(&shared.vault, &self.token, after.as_ref(), limit)
            .map_err(|fault| fault_error(fault, None))?;
        Ok(entries.iter().map(object_of_view).collect())
    }

    fn delete(&self, names: &[Name]) -> Result<Deleted, StoreError> {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let generation = shared.next_generation();
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let gid = shared.gateway.id();
        let request = DeleteRequest {
            names: asked.clone(),
            generation,
            signature: sign_delete(&shared.identity, &gid, self.epoch, generation, &asked),
        };
        let vault = shared.vault;
        let Shared { gateway, bytes, .. } = &mut *shared;
        let answer = gateway
            .delete(&vault, &self.token, &request, now_ms, |name| {
                bytes.remove(name);
                Ok(())
            })
            .map_err(|fault| fault_error(fault, None))?;
        shared.generation = generation;
        Ok(Deleted {
            deleted: answer.deleted.iter().map(plane_name).collect(),
            freed: answer.freed.iter().map(plane_name).collect(),
            refused: answer
                .refused
                .iter()
                .map(|refused| {
                    (
                        plane_name(&refused.name),
                        Refusal::from_wire_code(refused.code),
                    )
                })
                .collect(),
        })
    }

    fn held(&self, after: Option<&Name>, limit: usize) -> Result<Vec<HeldEntry>, StoreError> {
        let shared = self.lock();
        let after = after.map(wire_name);
        let entries = shared
            .gateway
            .held(&shared.vault, &self.token, after.as_ref(), limit)
            .map_err(|fault| fault_error(fault, None))?;
        Ok(entries.iter().map(held_of_view).collect())
    }

    fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError> {
        let mut shared = self.lock();
        let generation = shared.next_generation();
        let asked: Option<Vec<WireName>> = names.map(|names| names.iter().map(wire_name).collect());
        let gid = shared.gateway.id();
        let request = UndoRequest {
            names: asked.clone(),
            generation,
            signature: sign_undo(
                &shared.identity,
                &gid,
                self.epoch,
                generation,
                asked.as_deref(),
            ),
        };
        let vault = shared.vault;
        let undone = shared
            .gateway
            .undo(&vault, &self.token, &request)
            .map_err(|fault| fault_error(fault, None))?;
        shared.generation = generation;
        Ok(undone.undone)
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
            Err(StoreError::Refused(Refusal::NameTaken {
                state: NameState::Live,
                ..
            }))
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
            store.set_head(&first, None, 10, 0),
            Err(StoreError::Missing(_))
        ));
        put(&store, &first, b"one").expect("stores");
        put(&store, &second, b"two").expect("stores");
        let head = store.set_head(&first, None, 10, 0).expect("the first head");
        assert_eq!(head.name, first);
        assert_eq!(store.head().expect("reads"), Some(head));
        match store.set_head(&second, None, 20, 0) {
            Err(StoreError::HeadConflict { current }) => assert_eq!(current, Some(head)),
            other => panic!("expected a conflict, got {other:?}"),
        }
        store.set_head(&second, Some(&first), 20, 0).expect("moves");
        let registered: Vec<Name> = store
            .snapshots()
            .expect("lists")
            .iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(registered, vec![first, second]);
    }

    #[test]
    fn delete_holds_spares_the_head_and_keeps_a_held_snapshot_listed() {
        let store = MemoryStore::new("gw");
        store.set_clock_ms(1_000);
        let (first, second, range) = (name_of("m1"), name_of("m2"), name_of("r"));
        for (name, bytes) in [(&first, b"one"), (&second, b"two"), (&range, b"rng")] {
            put(&store, name, bytes).expect("stores");
        }
        store.set_head(&first, None, 1, 0).expect("heads");
        store.set_head(&second, Some(&first), 2, 0).expect("moves");
        let deleted = store.delete(&[first, second, range]).expect("deletes");
        assert_eq!(deleted.deleted, vec![first, range]);
        assert_eq!(deleted.refused, vec![(second, Refusal::HeadInUse)]);
        assert_eq!(
            store.exists(&[first, second, range]).expect("asks"),
            vec![first, range]
        );
        // A held manifest's snapshot stays listed, with its dates (E6).
        let listed = store.snapshots().expect("lists");
        assert_eq!(listed.len(), 2);
        assert_eq!(
            listed
                .iter()
                .map(|entry| (entry.name, entry.held_at_ms))
                .collect::<Vec<_>>(),
            vec![(first, Some(1_000)), (second, None)]
        );
        assert_eq!(store.list(None, 10).expect("lists").len(), 1);

        // Within the grace a re-upload resurrects; past it the bytes go.
        assert_eq!(put(&store, &range, b"rng").expect("stores"), Put::Stored);
        store.delete(&[range]).expect("deletes");
        assert_eq!(store.purge(), 0, "inside the grace");
        store.set_clock_ms(1_000 + TOMBSTONE_GRACE_MS);
        assert_eq!(store.purge(), 2, "past it");
        assert_eq!(
            store.snapshots().expect("lists").len(),
            1,
            "a purged manifest's snapshot goes with it"
        );
    }

    #[test]
    fn a_claim_fences_the_older_writer_and_revokes_its_token() {
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
            old.set_head(&name, None, 1, 0),
            Err(StoreError::Moved { .. })
        ));
        // Protocol v3 (E5): a takeover revokes all older tokens, so reads with
        // the superseded token hear MOVED too.
        assert!(matches!(
            old.exists(&[name]),
            Err(StoreError::Moved { epoch: 2 })
        ));
        assert!(matches!(old.head(), Err(StoreError::Moved { epoch: 2 })));
        new.set_head(&name, None, 1, 0)
            .expect("the new writer writes");
        assert_eq!(new.head().expect("reads").map(|head| head.epoch), Some(2));
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
            matches!(
                store.set_head(&name, None, 1, 0),
                Err(StoreError::Missing(_))
            ),
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
                (
                    taken.name,
                    Err(Refusal::NameTaken {
                        held: Digest::of(b"an earlier sealing"),
                        state: NameState::Live,
                    })
                ),
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
