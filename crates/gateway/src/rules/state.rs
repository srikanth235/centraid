//! The port the rules keep their state behind, and what that state is
//! (#1080).
//!
//! # READ THE RECORDS AS THE ANSWER TO "WHAT DOES A GATEWAY KNOW?"
//!
//! Vault ids (public keys), epochs, the BLAKE3 of tokens and pairing secrets,
//! device labels, object names (keyed hashes the gateway cannot invert),
//! digests (hashes of ciphertext), sizes, and times. There is no plaintext, no
//! plaintext hash and no key, and there is nowhere for one to arrive: a field
//! is the only way it could. A rule that wants one is a wrong rule.
//!
//! # ATOMICITY IS THE ADAPTER'S, AND ONLY THAT
//!
//! [`State::atomically`] is the one thing a pure function cannot supply: that
//! the reads and writes of one operation land together or not at all, so a
//! compare-and-set and a claim are single steps. The SQLite adapter runs it
//! under `BEGIN IMMEDIATE`; the in-memory one restores a copy on error. Every
//! decision is still made by the rules inside it.

use crate::rules::code::Refusal;
use crate::rules::ids::{Digest, Name, SecretHash, TokenHash, VaultId};
use crate::rules::wire::{ObjectEntry, PairKind, SnapshotView};

/// Something went wrong inside the adapter's storage. Not a refusal: the
/// gateway answers `INTERNAL` and the phone retries. The text is for the
/// operator's log and never reaches the wire.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("gateway store: {0}")]
pub struct StoreFault(pub String);

impl StoreFault {
    /// Wrap an adapter's own error text.
    #[must_use]
    pub fn new(detail: impl Into<String>) -> Self {
        Self(detail.into())
    }
}

/// An operation that did not succeed, and which half failed.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Fault {
    /// A rule said no.
    #[error(transparent)]
    Refused(#[from] Refusal),
    /// The store failed.
    #[error(transparent)]
    Store(#[from] StoreFault),
}

/// One paired vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VaultRecord {
    pub vault: VaultId,
    /// Only a token at this epoch writes. Starts at 1; a claim moves it on.
    pub writer_epoch: u64,
    pub paired_at_ms: i64,
    /// When a claim last moved the writer.
    pub moved_at_ms: Option<i64>,
}

/// One token, as the gateway keeps it: its hash and what it may do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenRecord {
    pub hash: TokenHash,
    pub vault: VaultId,
    /// The epoch it was minted at; 0 for a read grant.
    pub epoch: u64,
    pub kind: PairKind,
    pub label: String,
    pub created_at_ms: i64,
}

/// One pairing secret, as the gateway keeps it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretRecord {
    pub hash: SecretHash,
    pub created_at_ms: i64,
    pub expires_at_ms: i64,
    pub used_at_ms: Option<i64>,
    pub used_by: Option<VaultId>,
}

impl SecretRecord {
    /// Unspent and unexpired.
    #[must_use]
    pub const fn is_live(&self, now_ms: i64) -> bool {
        self.used_at_ms.is_none() && now_ms < self.expires_at_ms
    }
}

/// The head, as the gateway keeps it. The writer epoch is the vault's and is
/// joined in when the head is answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeadRecord {
    pub name: Name,
    pub taken_at_ms: i64,
    pub set_at_ms: i64,
}

/// A tombstone: deleted, with its bytes kept until the grace ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tombstone {
    pub at_ms: i64,
    pub purge_after_ms: i64,
}

/// One object in the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectRecord {
    pub name: Name,
    pub digest: Digest,
    pub size: u64,
    /// The gateway's own receipt time.
    pub stored_at_ms: i64,
    pub tombstone: Option<Tombstone>,
    /// When a scrub last found the bytes corrupt or gone. Cleared when a scrub
    /// finds them whole or a `PUT` replaces them.
    pub damaged_at_ms: Option<i64>,
}

impl ObjectRecord {
    /// **HELD**: not tombstoned and not damaged. What `exists` and
    /// write-once answer about: a name that is tombstoned or damaged is one
    /// the phone must send again, and a `PUT` of it is admitted whatever its
    /// digest.
    #[must_use]
    pub const fn is_held(&self) -> bool {
        self.tombstone.is_none() && self.damaged_at_ms.is_none()
    }

    /// What `PUT` and `GET objects` say about it.
    #[must_use]
    pub const fn entry(&self) -> ObjectEntry {
        ObjectEntry {
            name: self.name,
            size: self.size,
            digest: self.digest,
            stored_at_ms: self.stored_at_ms,
        }
    }
}

/// The gateway's state. Every method is one read or one write; the rules
/// compose them inside [`State::atomically`].
pub trait State {
    /// Run `op` so that either every write it makes lands or none does. An
    /// `Err` from `op` — a refusal included — undoes its writes.
    ///
    /// # Errors
    ///
    /// Whatever `op` returns, or a store fault from beginning or committing.
    fn atomically<T>(&mut self, op: impl FnOnce(&mut Self) -> Result<T, Fault>)
    -> Result<T, Fault>;

    /// One vault, or `None`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn vault(&self, vault: &VaultId) -> Result<Option<VaultRecord>, StoreFault>;

    /// Insert or replace a vault.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_vault(&mut self, record: &VaultRecord) -> Result<(), StoreFault>;

    /// Every vault, ordered by id.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn vaults(&self) -> Result<Vec<VaultRecord>, StoreFault>;

    /// One token by its hash.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn token(&self, hash: &TokenHash) -> Result<Option<TokenRecord>, StoreFault>;

    /// Insert a token.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_token(&mut self, record: &TokenRecord) -> Result<(), StoreFault>;

    /// Every token, ordered by vault then creation.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn tokens(&self) -> Result<Vec<TokenRecord>, StoreFault>;

    /// One pairing secret by its hash.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn secret(&self, hash: &SecretHash) -> Result<Option<SecretRecord>, StoreFault>;

    /// Insert or replace a pairing secret.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_secret(&mut self, record: &SecretRecord) -> Result<(), StoreFault>;

    /// Every pairing secret, ordered by creation.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn secrets(&self) -> Result<Vec<SecretRecord>, StoreFault>;

    /// A vault's head, or `None`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn head(&self, vault: &VaultId) -> Result<Option<HeadRecord>, StoreFault>;

    /// Set a vault's head.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_head(&mut self, vault: &VaultId, head: &HeadRecord) -> Result<(), StoreFault>;

    /// A vault's registered snapshots, ordered by `taken_at_ms` then name.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn snapshots(&self, vault: &VaultId) -> Result<Vec<SnapshotView>, StoreFault>;

    /// Register a snapshot; one already registered keeps its first record.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_snapshot(&mut self, vault: &VaultId, snapshot: &SnapshotView) -> Result<(), StoreFault>;

    /// Deregister a snapshot, if it is registered.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn remove_snapshot(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault>;

    /// One object, in any state, or `None`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn object(&self, vault: &VaultId, name: &Name) -> Result<Option<ObjectRecord>, StoreFault>;

    /// Insert or replace an object.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_object(&mut self, vault: &VaultId, record: &ObjectRecord) -> Result<(), StoreFault>;

    /// Forget an object's row.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn remove_object(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault>;

    /// Up to `limit` objects that are not tombstoned, named after `after`,
    /// ordered by name.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn live_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault>;

    /// Up to `limit` objects of every vault and state, after `after`, ordered
    /// by vault then name: the scrub's page.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn all_objects(
        &self,
        after: Option<(&VaultId, &Name)>,
        limit: usize,
    ) -> Result<Vec<(VaultId, ObjectRecord)>, StoreFault>;

    /// Up to `limit` tombstones whose grace ended at or before `now_ms`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn purgeable(&self, now_ms: i64, limit: usize) -> Result<Vec<(VaultId, Name)>, StoreFault>;
}
