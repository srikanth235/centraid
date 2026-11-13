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
use crate::rules::ids::{Digest, Name, Nonce, SecretHash, Signature, TokenHash, VaultId};
use crate::rules::wire::{ObjectEntry, PairKind};

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
    /// The generation of the last accepted signed record (head, delete or
    /// undo). One counter, never falling inside an epoch; a claim resets it
    /// to 0 (E3).
    pub generation: u64,
    /// The `writes` of the last accepted head; a claim resets it to 0.
    pub writes: u64,
    /// When the operator froze the vault, if it is frozen (E6).
    pub frozen_at_ms: Option<i64>,
}

impl VaultRecord {
    /// A vault just admitted by a pairing secret, at writer epoch 1.
    #[must_use]
    pub const fn founded(vault: VaultId, now_ms: i64) -> Self {
        Self {
            vault,
            writer_epoch: 1,
            paired_at_ms: now_ms,
            moved_at_ms: None,
            generation: 0,
            writes: 0,
            frozen_at_ms: None,
        }
    }
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

/// What a claim left of a token it revoked: its hash, so the old phone still
/// hears "moved" (E5). Never the token.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RevokedToken {
    pub hash: TokenHash,
    pub vault: VaultId,
    pub epoch: u64,
    pub revoked_at_ms: i64,
}

/// The last claim a vault accepted, kept signed so every `MOVED` can carry it
/// (E4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimRecord {
    pub vault: VaultId,
    pub epoch: u64,
    pub head_seen: Option<Name>,
    pub nonce: Nonce,
    pub signature: Signature,
    pub claimed_at_ms: i64,
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

/// The head, as the phone signed it and the gateway stores it: served
/// unchanged, so a restoring phone verifies the signature before it believes
/// a field (E2). The writer epoch is the vault's and is joined in when the
/// head is answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeadRecord {
    pub name: Name,
    pub prev: Option<Name>,
    pub taken_at_ms: i64,
    /// The writer epoch the phone held when it signed.
    pub epoch: u64,
    pub generation: u64,
    pub writes: u64,
    pub set_at_ms: i64,
    pub signature: Signature,
}

/// A delete the vault's key signed, held for a week (E6): the bytes stay and
/// are served until `purge_after_ms`, and an undo or a takeover lifts it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Hold {
    pub at_ms: i64,
    pub purge_after_ms: i64,
}

/// One signed head ever accepted that is still kept: a copy of the record,
/// with the hold of its manifest when that is held (E2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SnapshotRecord {
    pub name: Name,
    pub taken_at_ms: i64,
    pub registered_at_ms: i64,
    pub epoch: u64,
    pub generation: u64,
    pub writes: u64,
    pub prev: Option<Name>,
    pub signature: Signature,
    pub hold: Option<Hold>,
}

/// One object in the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectRecord {
    pub name: Name,
    pub digest: Digest,
    pub size: u64,
    /// The gateway's own receipt time.
    pub stored_at_ms: i64,
    pub hold: Option<Hold>,
    /// When a scrub last found the bytes corrupt or gone. Cleared when a scrub
    /// finds them whole or a `PUT` replaces them.
    pub damaged_at_ms: Option<i64>,
}

impl ObjectRecord {
    /// **LIVE**: not held for deletion and not damaged. What `exists` and
    /// write-once answer about: a name that is held or damaged is one the
    /// phone must send again, and a `PUT` of it is taken only with the digest
    /// recorded (decision 28); a signed delete frees a damaged one (30).
    #[must_use]
    pub const fn is_live(&self) -> bool {
        self.hold.is_none() && self.damaged_at_ms.is_none()
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
/// compose them inside [`State::atomically`]. **Every listing is a seek**:
/// it takes the last row's key and a limit, never an offset (E14).
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

    /// Up to `limit` vaults after `after`, ordered by id.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn vaults(&self, after: Option<&VaultId>, limit: usize)
    -> Result<Vec<VaultRecord>, StoreFault>;

    /// Forget a vault and, with it, anything of it still stored.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn remove_vault(&mut self, vault: &VaultId) -> Result<(), StoreFault>;

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

    /// Forget a token: a revoked token is an unknown one, so it is
    /// `UNAUTHORIZED` everywhere after. Answers whether it was held.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn remove_token(&mut self, hash: &TokenHash) -> Result<bool, StoreFault>;

    /// Up to `limit` of a vault's tokens after `(created_at_ms, hash)`,
    /// ordered by creation then hash.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn tokens_of(
        &self,
        vault: &VaultId,
        after: Option<(i64, &TokenHash)>,
        limit: usize,
    ) -> Result<Vec<TokenRecord>, StoreFault>;

    /// Remove and return every token of a vault: a claim's first step.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn take_tokens(&mut self, vault: &VaultId) -> Result<Vec<TokenRecord>, StoreFault>;

    /// A revoked token's tombstone, or `None`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn revoked_token(&self, hash: &TokenHash) -> Result<Option<RevokedToken>, StoreFault>;

    /// Record a tombstone.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_revoked(&mut self, record: &RevokedToken) -> Result<(), StoreFault>;

    /// Keep only the newest `keep` tombstones of a vault.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn trim_revoked(&mut self, vault: &VaultId, keep: u64) -> Result<(), StoreFault>;

    /// Drop tombstones revoked at or before `before_ms`; how many.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn prune_revoked(&mut self, before_ms: i64) -> Result<u64, StoreFault>;

    /// The last claim a vault accepted.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn claim(&self, vault: &VaultId) -> Result<Option<ClaimRecord>, StoreFault>;

    /// Store a vault's last claim, replacing the one before.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_claim(&mut self, record: &ClaimRecord) -> Result<(), StoreFault>;

    /// Record a nonce as spent: `true` the first time, `false` if it was
    /// already (a replay). Only a request that proved it holds the vault key
    /// reaches this.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn spend_nonce(&mut self, id: &[u8; 16], issued_at_ms: i64) -> Result<bool, StoreFault>;

    /// How many spent nonces were issued after `not_before_ms`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn live_nonces(&self, not_before_ms: i64) -> Result<u64, StoreFault>;

    /// Drop spent nonces issued at or before `before_ms`; how many.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn prune_nonces(&mut self, before_ms: i64) -> Result<u64, StoreFault>;

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

    /// Up to `limit` secrets after `(created_at_ms, hash)`, by creation.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn secrets(
        &self,
        after: Option<(i64, &SecretHash)>,
        limit: usize,
    ) -> Result<Vec<SecretRecord>, StoreFault>;

    /// How many secrets are unspent and unexpired at `now_ms`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn live_secrets(&self, now_ms: i64) -> Result<u64, StoreFault>;

    /// The oldest unspent, unexpired secret.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn oldest_live_secret(&self, now_ms: i64) -> Result<Option<SecretRecord>, StoreFault>;

    /// Forget a secret.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn remove_secret(&mut self, hash: &SecretHash) -> Result<(), StoreFault>;

    /// Drop secrets used at or before `used_before_ms` and unused ones that
    /// expired at or before `expired_before_ms`; how many.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn prune_secrets(
        &mut self,
        used_before_ms: i64,
        expired_before_ms: i64,
    ) -> Result<u64, StoreFault>;

    /// A vault's head, or `None`.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn head(&self, vault: &VaultId) -> Result<Option<HeadRecord>, StoreFault>;

    /// Set a vault's head. Its snapshot row must exist.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_head(&mut self, vault: &VaultId, head: &HeadRecord) -> Result<(), StoreFault>;

    /// One registered snapshot.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn snapshot(&self, vault: &VaultId, name: &Name) -> Result<Option<SnapshotRecord>, StoreFault>;

    /// Up to `limit` of a vault's snapshots after `after`, ordered by name.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn snapshots(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<SnapshotRecord>, StoreFault>;

    /// Register a snapshot; one already registered keeps its first record.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn put_snapshot(
        &mut self,
        vault: &VaultId,
        snapshot: &SnapshotRecord,
    ) -> Result<(), StoreFault>;

    /// Deregister a snapshot, if it is registered.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn remove_snapshot(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault>;

    /// Forget a vault's head and every snapshot row: `delete-vault`'s step.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn remove_heads_and_snapshots(&mut self, vault: &VaultId) -> Result<(), StoreFault>;

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

    /// Set or lift the hold of a name, on its object row and on its snapshot
    /// row when it has one.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn set_hold(
        &mut self,
        vault: &VaultId,
        name: &Name,
        hold: Option<Hold>,
    ) -> Result<(), StoreFault>;

    /// Up to `limit` objects that are not held, named after `after`, ordered
    /// by name.
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

    /// Up to `limit` held objects of a vault after `after`, by name.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn held_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault>;

    /// Up to `limit` objects of a vault in any state after `after`, by name:
    /// `delete-vault`'s page.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn vault_objects(
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

    /// Up to `limit` holds due at or before `now_ms`, after the cursor
    /// `(purge_after_ms, vault, name)`, in that order.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn purgeable(
        &self,
        after: Option<(i64, &VaultId, &Name)>,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<(i64, VaultId, Name)>, StoreFault>;

    /// Lift every hold of a vault; how many objects were held.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn clear_holds(&mut self, vault: &VaultId) -> Result<u64, StoreFault>;

    /// Move every hold of a vault `delta_ms` later.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn shift_holds(&mut self, vault: &VaultId, delta_ms: i64) -> Result<(), StoreFault>;

    /// Make every hold of a vault due at `due_ms`; how many.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn make_holds_due(&mut self, vault: &VaultId, due_ms: i64) -> Result<u64, StoreFault>;

    /// Move every hold of every vault `delta_ms` later.
    ///
    /// # Errors
    ///
    /// A store fault.
    fn shift_all_holds(&mut self, delta_ms: i64) -> Result<(), StoreFault>;
}
