//! The store the plane writes to and restores from: one destination, through
//! one synchronous trait (#1080, gateway protocol 1, revised in #1209).
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
use std::io::Write;
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

/// The most bytes one `bundle` sends or one `get_many` answers, every part's
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

/// One object a bundle sends: its name, its digest and its bytes. Objects are rebuilt from their
/// source, so nothing here is a file on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outgoing {
    pub name: Name,
    /// BLAKE3 of `bytes`.
    pub digest: Digest,
    pub bytes: Vec<u8>,
}

impl Outgoing {
    /// An outgoing object for sealed bytes, its digest computed.
    #[must_use]
    pub fn of(name: Name, bytes: Vec<u8>) -> Self {
        Self {
            name,
            digest: Digest::of(&bytes),
            bytes,
        }
    }

    /// What this object costs a bundle: its bytes and its frame header.
    #[must_use]
    pub const fn bundle_bytes(&self) -> u64 {
        (self.bytes.len() as u64).saturating_add(FRAME_HEADER_BYTES)
    }
}

/// The destination's answer to one frame of a bundle (spec §4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameAnswer {
    /// New bytes, committed before the answer.
    Stored,
    /// The same digest, live: nothing moved.
    There,
    /// The same digest under a hold: the hold is lifted.
    Held,
    /// The name is not free under another digest. **Not an acknowledgement.**
    Taken { digest: Digest, state: NameState },
    /// The destination's disk is full.
    Full,
    /// The frame is over the largest object.
    TooLarge,
    /// Any other refusal of this one frame.
    Refused(Refusal),
}

impl FrameAnswer {
    /// Whether the destination now holds these bytes under this name.
    #[must_use]
    pub const fn acknowledged(&self) -> bool {
        matches!(self, Self::Stored | Self::There | Self::Held)
    }
}

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

    /// Store several objects in one request: the protocol's `bundle`. Each is
    /// answered on its own, in the order sent, and a connection that drops
    /// leaves every finished frame committed. The objects'
    /// [`Outgoing::bundle_bytes`] sum to at most [`BUNDLE_BYTES`].
    ///
    /// # Errors
    /// [`StoreError`] when the request as a whole was not answered: the
    /// destination unreachable, the writer [`StoreError::Moved`], or the
    /// bundle refused whole ([`Refusal::TooLarge`]). A refusal of one frame
    /// is in its answer.
    fn bundle(&self, parts: &[Outgoing]) -> Result<Vec<(Name, FrameAnswer)>, StoreError>;

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
    fn delete(&self, names: &[Name], head_root: Option<&Name>) -> Result<Deleted, StoreError>;

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
pub fn delete_all(
    store: &dyn Store,
    names: &[Name],
    head_root: Option<&Name>,
) -> Result<Deleted, StoreError> {
    let mut out = Deleted::default();
    for batch in names.chunks(NAMES_PER_CALL) {
        let deleted = store.delete(batch, head_root)?;
        out.deleted.extend(deleted.deleted);
        out.freed.extend(deleted.freed);
        out.refused.extend(deleted.refused);
    }
    Ok(out)
}

// ─── MemoryStore (backed directly by centraid_gateway::rules::Gateway) ──────

/// What this phone knows of one vault it writes to a gateway: the vault key it signs with, the
/// writer epoch it holds and the signed counter it last used.
struct VaultCtx {
    identity: SigningKey,
    writer_epoch: u64,
    generation: u64,
}

/// Calls and frames, counted: tests assert on counts, never on durations.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counts {
    /// Objects stored new through a bundle.
    pub stored: u64,
    /// Bundle requests answered.
    pub bundles: u64,
    /// Frames sent in them.
    pub frames: u64,
    /// `exists` calls.
    pub exists: u64,
    /// `fetch` calls.
    pub fetches: u64,
    /// Signed deletes accepted.
    pub deletes: u64,
    /// Head sets accepted.
    pub heads: u64,
}

struct Shared {
    gateway: Gateway<MemoryState>,
    gateway_id: GatewayId,
    nonce_key: [u8; 32],
    bytes: BTreeMap<(VaultId, WireName), Vec<u8>>,
    vaults: BTreeMap<VaultId, VaultCtx>,
    draws: u64,
    clock_ms: Option<u64>,
    counts: Counts,
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

    /// Pair a fresh vault by secret and return its token.
    fn pair_vault(&mut self, identity: &SigningKey, label: &str) -> (VaultId, Token) {
        let vault = VaultId::from_bytes(identity.verifying_key().to_bytes());
        let now_ms = self.now_ms();
        let secret = Secret::from_bytes({
            let mut bytes = [0_u8; 16];
            bytes.copy_from_slice(&self.draw_bytes()[..16]);
            bytes
        });
        self.gateway
            .mint_secret(&secret, now_ms)
            .expect("mints secret");
        let nonce = self.draw_nonce(now_ms);
        let gid = self.gateway_id;
        let signature = sign_pair(identity, &gid, &secret, &nonce);
        let token = Token::from_bytes(self.draw_bytes());
        self.gateway
            .pair(
                &PairRequest {
                    vault_id: vault,
                    label: label.to_owned(),
                    kind: PairKind::Secret,
                    nonce,
                    secret: Some(SecretBody { secret, signature }),
                    claim: None,
                    read: None,
                },
                &token,
                now_ms,
            )
            .expect("pairs initial writer");
        self.vaults.insert(
            vault,
            VaultCtx {
                identity: identity.clone(),
                writer_epoch: 1,
                generation: 0,
            },
        );
        (vault, token)
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

/// A gateway's data directory at one moment, to roll it back to.
#[derive(Clone)]
pub struct Checkpoint {
    state: MemoryState,
    bytes: BTreeMap<(VaultId, WireName), Vec<u8>>,
}

/// An in-memory destination: the real gateway rules over memory, under one
/// vault's key and token. Cloning shares the gateway.
#[derive(Clone)]
pub struct MemoryStore {
    shared: Arc<Mutex<Shared>>,
    gateway_id: String,
    vault: VaultId,
    token: Token,
    epoch: u64,
}

impl MemoryStore {
    /// A gateway named `gateway_id`, with one vault paired at writer epoch 1.
    #[must_use]
    pub fn new(gateway_id: &str) -> Self {
        let mut gid_bytes = [0_u8; 16];
        gid_bytes.copy_from_slice(&blake3::hash(gateway_id.as_bytes()).as_bytes()[..16]);
        let gid = GatewayId::from_bytes(gid_bytes);
        let nonce_key = blake3::derive_key("centraid memory store nonce", gateway_id.as_bytes());
        let id_bytes = blake3::derive_key("centraid memory store identity", gateway_id.as_bytes());
        let identity = SigningKey::from_bytes(&id_bytes);
        let mut shared = Shared {
            gateway: Gateway::new(MemoryState::default(), gid, nonce_key),
            gateway_id: gid,
            nonce_key,
            bytes: BTreeMap::new(),
            vaults: BTreeMap::new(),
            draws: 1,
            clock_ms: None,
            counts: Counts::default(),
        };
        let (vault, token) = shared.pair_vault(&identity, "memory");
        Self {
            shared: Arc::new(Mutex::new(shared)),
            gateway_id: gateway_id.to_owned(),
            vault,
            token,
            epoch: 1,
        }
    }

    /// Another vault on the same gateway, paired under a key seeded from `seed`: nothing of the
    /// one is visible to the other (R1).
    #[must_use]
    pub fn with_vault(&self, seed: &str) -> Self {
        let id_bytes = blake3::derive_key("centraid memory store vault", seed.as_bytes());
        let identity = SigningKey::from_bytes(&id_bytes);
        let (vault, token) = self.lock().pair_vault(&identity, seed);
        Self {
            shared: Arc::clone(&self.shared),
            gateway_id: self.gateway_id.clone(),
            vault,
            token,
            epoch: 1,
        }
    }

    fn lock(&self) -> MutexGuard<'_, Shared> {
        self.shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// A second phone takes the vault over: the next writer epoch, with a token of its own. The
    /// phone it replaces is `MOVED` from then on.
    ///
    /// # Panics
    /// If the gateway refuses its own claim, which is a bug in this double.
    #[must_use]
    pub fn claim(&self) -> Self {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let head_seen = match shared.gateway.head(&self.vault, &self.token) {
            Ok(head) => Some(head.name),
            Err(_) => None,
        };
        let ctx = shared.vaults.get(&self.vault).expect("a paired vault");
        let next_epoch = ctx.writer_epoch + 1;
        let identity = ctx.identity.clone();
        let nonce = shared.draw_nonce(now_ms);
        let gid = shared.gateway_id;
        let signature = sign_claim(&identity, &gid, next_epoch, head_seen.as_ref(), &nonce);
        let new_token = Token::from_bytes(shared.draw_bytes());
        shared
            .gateway
            .pair(
                &PairRequest {
                    vault_id: self.vault,
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
        let ctx = shared.vaults.get_mut(&self.vault).expect("a paired vault");
        ctx.writer_epoch = next_epoch;
        ctx.generation = 0;
        drop(shared);
        Self {
            shared: Arc::clone(&self.shared),
            gateway_id: self.gateway_id.clone(),
            vault: self.vault,
            token: new_token,
            epoch: next_epoch,
        }
    }

    /// The writer epoch this handle holds.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// This handle's vault, as the gateway names it.
    #[must_use]
    pub const fn vault_id(&self) -> VaultId {
        self.vault
    }

    /// Pin the gateway's clock.
    pub fn set_clock_ms(&self, now_ms: u64) {
        self.lock().clock_ms = Some(now_ms);
    }

    /// Calls and frames so far.
    #[must_use]
    pub fn counts(&self) -> Counts {
        self.lock().counts
    }

    /// Objects stored new through a bundle so far.
    #[must_use]
    pub fn stored_puts(&self) -> u64 {
        self.lock().counts.stored
    }

    /// Bundle requests so far.
    #[must_use]
    pub fn bundles(&self) -> u64 {
        self.lock().counts.bundles
    }

    /// `fetch` calls so far.
    #[must_use]
    pub fn fetches(&self) -> u64 {
        self.lock().counts.fetches
    }

    /// Every object this vault has on the gateway, live or held, with its bytes.
    #[must_use]
    pub fn contents(&self) -> Vec<(Name, Vec<u8>)> {
        let shared = self.lock();
        shared
            .bytes
            .iter()
            .filter(|((vault, _), _)| *vault == self.vault)
            .map(|((_, name), bytes)| (plane_name(name), bytes.clone()))
            .collect()
    }

    /// Whether the gateway holds bytes for `name` in any state (held, damaged or live).
    #[must_use]
    pub fn has_bytes(&self, name: &Name) -> bool {
        self.lock()
            .bytes
            .contains_key(&(self.vault, wire_name(name)))
    }

    /// Bit rot: flip one bit of a stored object's bytes. The gateway's record is untouched, as a
    /// disk's would be.
    pub fn flip_bit(&self, name: &Name) -> bool {
        let mut shared = self.lock();
        match shared
            .bytes
            .get_mut(&(self.vault, wire_name(name)))
            .and_then(|bytes| bytes.last_mut())
        {
            Some(byte) => {
                *byte ^= 1;
                true
            }
            None => false,
        }
    }

    /// Disk loss: the object's file is gone, its row is not.
    pub fn lose_bytes(&self, name: &Name) -> bool {
        self.lock()
            .bytes
            .remove(&(self.vault, wire_name(name)))
            .is_some()
    }

    /// The gateway's data directory now, to roll back to.
    #[must_use]
    pub fn checkpoint(&self) -> Checkpoint {
        let shared = self.lock();
        Checkpoint {
            state: shared.gateway.state.clone(),
            bytes: shared.bytes.clone(),
        }
    }

    /// The gateway comes back from a backup of its data directory: everything it accepted since
    /// `checkpoint` is forgotten. What the phone remembers is not.
    pub fn roll_back(&self, checkpoint: &Checkpoint) {
        let mut shared = self.lock();
        let (gid, key) = (shared.gateway_id, shared.nonce_key);
        shared.gateway = Gateway::new(checkpoint.state.clone(), gid, key);
        shared.bytes = checkpoint.bytes.clone();
    }

    /// Run the purge sweep: every hold past its week loses its bytes and row.
    ///
    /// # Panics
    /// If the in-memory state refuses, which it does not.
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
                        bytes.remove(&(vault, name));
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

    fn next_generation(shared: &Shared, vault: &VaultId) -> u64 {
        shared
            .vaults
            .get(vault)
            .map_or(1, |ctx| ctx.generation.saturating_add(1))
    }
}

impl Store for MemoryStore {
    fn gateway_id(&self) -> &str {
        &self.gateway_id
    }

    fn exists(&self, names: &[Name]) -> Result<Vec<Name>, StoreError> {
        let mut shared = self.lock();
        shared.counts.exists += 1;
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let missing = shared
            .gateway
            .exists(&self.vault, &self.token, &asked)
            .map_err(|fault| fault_error(fault, None))?;
        Ok(missing.iter().map(plane_name).collect())
    }

    fn bundle(&self, parts: &[Outgoing]) -> Result<Vec<(Name, FrameAnswer)>, StoreError> {
        let total = parts
            .iter()
            .map(Outgoing::bundle_bytes)
            .fold(0_u64, u64::saturating_add);
        if total > BUNDLE_BYTES {
            return Err(StoreError::Refused(Refusal::TooLarge));
        }
        let arrivals: Vec<Arrival> = parts
            .iter()
            .map(|part| Arrival {
                name: wire_name(&part.name),
                declared: wire_digest(&part.digest),
                digest: WireDigest::of(&part.bytes),
                size: part.bytes.len() as u64,
            })
            .collect();
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let vault = self.vault;
        let Shared { gateway, bytes, .. } = &mut *shared;
        let outcomes = gateway
            .put_bundle(&vault, &self.token, &arrivals, now_ms, |index| {
                bytes.insert((vault, arrivals[index].name), parts[index].bytes.clone());
                Ok(())
            })
            .map_err(|fault| fault_error(fault, None))?;
        shared.counts.bundles += 1;
        shared.counts.frames += parts.len() as u64;
        let mut out = Vec::with_capacity(parts.len());
        for (part, outcome) in parts.iter().zip(outcomes) {
            let answer = match outcome {
                Ok(PutOutcome::Stored(_)) => {
                    shared.counts.stored += 1;
                    FrameAnswer::Stored
                }
                Ok(PutOutcome::AlreadyStored(_)) => FrameAnswer::There,
                Ok(PutOutcome::Lifted(_)) => FrameAnswer::Held,
                Err(WireRefusal::NameTaken { digest, state }) => FrameAnswer::Taken {
                    digest: plane_digest(&digest),
                    state,
                },
                Err(WireRefusal::DiskFull) => FrameAnswer::Full,
                Err(WireRefusal::TooLarge { .. }) => FrameAnswer::TooLarge,
                Err(refusal) => FrameAnswer::Refused(Refusal::from_wire_code(refusal.code())),
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
            .object(&self.vault, &self.token, &wname)
            .map_err(|fault| fault_error(fault, Some(*name)))?;
        let held = shared
            .bytes
            .get(&(self.vault, wname))
            .ok_or(StoreError::Missing(*name))?;
        sink.write_all(held)?;
        Ok(held.len() as u64)
    }

    fn check_name(&self, name: &Name) -> Result<NameCheck, StoreError> {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let generation = Self::next_generation(&shared, &self.vault);
        let wname = wire_name(name);
        let gid = shared.gateway_id;
        let identity = shared.vaults[&self.vault].identity.clone();
        let request = CheckRequest {
            name: wname,
            generation,
            signature: sign_check(&identity, &gid, self.epoch, generation, &wname),
        };
        let vault = self.vault;
        let Shared { gateway, bytes, .. } = &mut *shared;
        let checked = gateway
            .check(&vault, &self.token, &request, now_ms, |name| {
                Ok(bytes.get(&(vault, *name)).map(|data| WireDigest::of(data)))
            })
            .map_err(|fault| fault_error(fault, Some(*name)))?;
        if let Some(ctx) = shared.vaults.get_mut(&vault) {
            ctx.generation = generation;
        }
        Ok(check_of_state(checked.state))
    }

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
                .fetch(&self.vault, &self.token, &asked)
                .map_err(|fault| fault_error(fault, None))?;
            shared.counts.fetches += 1;
            plan.iter()
                .filter_map(|record| {
                    shared
                        .bytes
                        .get(&(self.vault, record.name))
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
        match shared.gateway.head(&self.vault, &self.token) {
            Ok(view) => Ok(Some(head_of_view(&view))),
            Err(Fault::Refused(WireRefusal::NoHead { .. })) => Ok(None),
            Err(fault) => Err(fault_error(fault, None)),
        }
    }

    fn generation(&self) -> u64 {
        self.lock()
            .vaults
            .get(&self.vault)
            .map_or(0, |ctx| ctx.generation)
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
        let generation = Self::next_generation(&shared, &self.vault);
        let wname = wire_name(name);
        let wprev = prev.map(wire_name);
        let gid = shared.gateway_id;
        let identity = shared.vaults[&self.vault].identity.clone();
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
            signature: sign_head(&identity, &gid, &fields),
        };
        let view = shared
            .gateway
            .set_head(&self.vault, &self.token, &request, now_ms)
            .map_err(|fault| fault_error(fault, Some(*name)))?;
        if let Some(ctx) = shared.vaults.get_mut(&self.vault) {
            ctx.generation = view.generation;
        }
        shared.counts.heads += 1;
        Ok(head_of_view(&view))
    }

    fn snapshots(&self) -> Result<Vec<SnapshotEntry>, StoreError> {
        let shared = self.lock();
        let mut entries = Vec::new();
        let mut after = None;
        loop {
            let page = shared
                .gateway
                .snapshots(&self.vault, &self.token, after.as_ref(), LIST_PAGE)
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
            .objects(&self.vault, &self.token, after.as_ref(), limit)
            .map_err(|fault| fault_error(fault, None))?;
        Ok(entries.iter().map(object_of_view).collect())
    }

    fn delete(&self, names: &[Name], head_root: Option<&Name>) -> Result<Deleted, StoreError> {
        let mut shared = self.lock();
        let now_ms = shared.now_ms();
        let generation = Self::next_generation(&shared, &self.vault);
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let bound = head_root.map(wire_name);
        let gid = shared.gateway_id;
        let identity = shared.vaults[&self.vault].identity.clone();
        let request = DeleteRequest {
            names: asked.clone(),
            generation,
            head_root: bound,
            signature: sign_delete(
                &identity,
                &gid,
                self.epoch,
                generation,
                bound.as_ref(),
                &asked,
            ),
        };
        let vault = self.vault;
        let Shared { gateway, bytes, .. } = &mut *shared;
        let answer = gateway
            .delete(&vault, &self.token, &request, now_ms, |name| {
                bytes.remove(&(vault, *name));
                Ok(())
            })
            .map_err(|fault| fault_error(fault, None))?;
        if let Some(ctx) = shared.vaults.get_mut(&vault) {
            ctx.generation = generation;
        }
        shared.counts.deletes += 1;
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
            .held(&self.vault, &self.token, after.as_ref(), limit)
            .map_err(|fault| fault_error(fault, None))?;
        Ok(entries.iter().map(held_of_view).collect())
    }

    fn undo(&self, names: Option<&[Name]>) -> Result<u64, StoreError> {
        let mut shared = self.lock();
        let generation = Self::next_generation(&shared, &self.vault);
        let asked: Option<Vec<WireName>> = names.map(|names| names.iter().map(wire_name).collect());
        let gid = shared.gateway_id;
        let identity = shared.vaults[&self.vault].identity.clone();
        let request = UndoRequest {
            names: asked.clone(),
            generation,
            signature: sign_undo(&identity, &gid, self.epoch, generation, asked.as_deref()),
        };
        let undone = shared
            .gateway
            .undo(&self.vault, &self.token, &request)
            .map_err(|fault| fault_error(fault, None))?;
        if let Some(ctx) = shared.vaults.get_mut(&self.vault) {
            ctx.generation = generation;
        }
        Ok(undone.undone)
    }
}
