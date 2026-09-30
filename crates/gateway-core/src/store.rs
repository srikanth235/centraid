//! The two ports, and the one schema behind them (#1029 §3).
//!
//! Storage is behind two traits — [`StateStore`] (the SQL state) and
//! [`ByteStore`] (the objects) — and **every rule in this crate is above them**.
//! An adapter supplies storage; it does not supply policy.
//!
//! # Why the ports are `async` with no `Send` bound
//!
//! The bound is absent because nothing here needs it, and a bound that is not
//! required is not a bound that is missing. It was first left off because the
//! struck hosted adapter's futures were `!Send` and a `Send` bound would have
//! made the crate unimplementable there (scope amendment 2026-09-21). The
//! server's own futures *are* `Send` and
//! nothing here stops them, so adding the bound back is a decision W17 may take
//! with the transport rather than one this seam forces.
//!
//! # Why one error type instead of two associated ones
//!
//! Every store failure has the same answer — the gateway reports an internal
//! error and the phone retries later — so the rules have nothing to branch on.
//! Two associated error types would put two generic parameters in every
//! signature in [`crate::engine`] to carry a distinction no rule reads.
//! [`StoreFault`] is the whole of what the rules need to know: it went wrong,
//! and here is what to put in the log.
//!
//! # THE COMPARE-AND-SET IS A PORT OPERATION ON PURPOSE
//!
//! [`StateStore::compare_and_set_head`] is the one place the rules hand
//! *atomicity* to the adapter, because atomicity is the one thing a pure
//! function cannot provide. The rule itself is still written once —
//! [`crate::commit::compare_and_set`] — and an adapter implements the port by
//! calling it under whatever makes it atomic; the server uses an immediate
//! transaction.

use crate::ids::{AccountId, Generation, ObjectKind, ObjectName, VaultId};
use crate::lease::LeaseState;
use crate::plan::Plan;
use crate::retention::BaseRecord;
use crate::time::ServerTime;

/// The one SQL schema an adapter applies. See [`crate::SCHEMA_SQL`].
pub use crate::SCHEMA_SQL;

/// Something went wrong inside the adapter's storage.
///
/// Not a refusal: a refusal is a rule saying no, and this is a store failing.
/// The gateway answers it with an internal error and the phone retries.
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

/// Where one object stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectState {
    /// Declared, and its target issued. The bytes may or may not be up.
    Declared,
    /// Committed: verified, recorded and acked. **Nothing may be written over
    /// it.**
    Committed,
    /// Tombstoned. The bytes are still there until the grace period ends, so a
    /// restored phone can undelete or restore an older generation.
    Tombstoned { purge_after: ServerTime },
}

/// One object as the gateway holds it.
///
/// **Read this list as the answer to "what does the gateway see?"** A name, a
/// kind, a padded size, a state, a receipt time and a generation.
/// There is no plaintext, no plaintext hash, no table name, no exact size and
/// no key — and there is nowhere for one to arrive, because a field is the only
/// way it could.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredObject {
    pub name: ObjectName,
    pub kind: ObjectKind,
    pub padded_size: u64,
    pub state: ObjectState,
    /// The **gateway's own** receipt time.
    pub received_at: ServerTime,
    pub generation: Generation,
}

/// A vault as the gateway holds it. Same reading: keys, counters and times.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultState {
    pub vault: VaultId,
    pub account: AccountId,
    pub lease: LeaseState,
    /// The manifest head. Moves only by compare-and-set (F7).
    pub head: Option<ObjectName>,
    /// The server owner's flag: deletes disabled for devices entirely.
    pub append_only: bool,
    pub plan: Plan,
}

/// An upload target for one object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadTarget {
    pub name: ObjectName,
    /// A presigned store URL, or a URL on the server itself. Empty when the
    /// name is already committed.
    pub url: String,
    /// Must exceed the longest background deferral a phone can be put through;
    /// SigV4 caps it at 7 days.
    pub expires_at: ServerTime,
    /// The name was already committed and nothing was presigned.
    pub already_committed: bool,
}

/// The gateway's own state: accounts, vaults, leases, the object index and the
/// delete ledger. **Never a vault's contents.**
#[expect(
    async_fn_in_trait,
    reason = "these ports carry no `Send` bound because nothing here needs \
              one; see the module header. The server's own futures are Send \
              and nothing here stops them."
)]
pub trait StateStore {
    /// The vault, or `None` if this gateway does not hold it. A stranger and an
    /// unregistered vault are the same answer.
    async fn vault(&self, vault: &VaultId) -> Result<Option<VaultState>, StoreFault>;

    /// Record a vault's state. Used for registration, lease claims and quota.
    async fn put_vault(&mut self, state: &VaultState) -> Result<(), StoreFault>;

    async fn object(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredObject>, StoreFault>;

    async fn put_object(
        &mut self,
        vault: &VaultId,
        object: &StoredObject,
    ) -> Result<(), StoreFault>;

    /// Every object this vault holds, in any state.
    async fn objects(&self, vault: &VaultId) -> Result<Vec<StoredObject>, StoreFault>;

    /// The bases, which are what retention is defined over (F10).
    async fn bases(&self, vault: &VaultId) -> Result<Vec<BaseRecord>, StoreFault>;

    async fn put_base(&mut self, vault: &VaultId, base: &BaseRecord) -> Result<(), StoreFault>;

    /// **ATOMICALLY**: if the head is `expected`, make it `next`. Return the
    /// head as it stands afterwards, whichever branch was taken.
    ///
    /// This is the one operation whose correctness is the adapter's, and the
    /// only one. Implement it with [`crate::commit::compare_and_set`] under
    /// `BEGIN IMMEDIATE` or whatever else makes it atomic.
    /// An implementation that reads, decides in application code and then
    /// writes without a transaction is the bug this port exists to prevent.
    async fn compare_and_set_head(
        &mut self,
        vault: &VaultId,
        expected: Option<ObjectName>,
        next: ObjectName,
    ) -> Result<Option<ObjectName>, StoreFault>;

    /// When the most recent **client-directed base tombstone** happened in this
    /// vault. The rate limit's only memory.
    async fn last_client_base_delete(
        &self,
        vault: &VaultId,
    ) -> Result<Option<ServerTime>, StoreFault>;

    async fn record_client_base_delete(
        &mut self,
        vault: &VaultId,
        at: ServerTime,
    ) -> Result<(), StoreFault>;

    /// **THE PER-OBJECT AUDIT LEDGER**: this device asked for this object to be
    /// tombstoned, and the gateway agreed, at this time.
    ///
    /// It is a different row from [`Self::record_client_base_delete`] and for a
    /// different reader. That one is the rate limit's own memory — one row per
    /// vault, no object name, because the rule asks only *when did this vault
    /// last tombstone a base*. This is `client_delete` in
    /// `contracts/gateway/schema.sql`, keyed by name, and it is what an owner
    /// reads when asked what a device deleted and when. Folding them would mean
    /// inventing a name the rate limit never sends, or making the rule scan a
    /// growing table for a `MAX` on every delete.
    ///
    /// # IT RECORDS ONLY WHAT A BLIND GATEWAY ALREADY HOLDS
    ///
    /// A vault key, an object name, an object kind and the gateway's own clock
    /// — every one of them already a column on `object` for the same object.
    /// The ledger adds no new visibility; it adds *durability*, because the
    /// object row is what a purge eventually removes and this is what outlives
    /// it. If a field ever wanted to arrive here that is not on that list, the
    /// answer is no: this is a ledger a blind gateway keeps about its own acts,
    /// not about a member's content.
    ///
    /// Called by [`crate::engine::Gateway::delete`] for **every** tombstone it
    /// grants, of every kind — not only bases, which are merely the kind the
    /// rate limit counts.
    async fn record_client_delete(
        &mut self,
        vault: &VaultId,
        name: &ObjectName,
        kind: ObjectKind,
        at: ServerTime,
    ) -> Result<(), StoreFault>;
}

/// The objects. **Bytes never pass through gateway code on the hosted
/// adapter**: they go straight to R2 by presigned URL, and the gateway learns
/// about them only through [`ByteStore::evidence`].
/// What a store found at one name: the BLAKE3 of the bytes it is holding, and
/// how many of them.
///
/// The name is computed from the bytes, never read from a header — a header is
/// something a client wrote, and the whole point of the check is not to take
/// the client's word for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoredBytes {
    /// `ObjectName::of(bytes)`.
    pub name: ObjectName,
    /// How many bytes are there.
    pub size: u64,
}

#[expect(
    async_fn_in_trait,
    reason = "see StateStore — a Worker's futures are !Send"
)]
pub trait ByteStore {
    /// Issue an upload target for a name that is not yet committed.
    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault>;

    /// WHAT THE GATEWAY FINDS WHEN IT READS BACK WHAT IT STORED.
    ///
    /// `None` when this name has no bytes at all, which is a commit of
    /// something nobody uploaded.
    ///
    /// # THE ONE RULE, AND WHY THERE IS NO LONGER A MODE
    ///
    /// This port used to be `checksum_mode` plus `evidence`, and an adapter
    /// answered in one of two shapes: the digest its *store* attested, or the
    /// hashes it computed itself. Two modes existed because R2 and S3 attest
    /// that one digest and the hosted adapter never saw the bytes. The
    /// [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)
    /// strikes that adapter and its store, so **the gateway holds the bytes and
    /// hashes them**: one mode, one answer, and no `ChecksumEvidence::None`
    /// that an adapter could hand back for an object it simply had not looked
    /// at.
    ///
    /// The implementation reads and hashes. That costs a full read per commit,
    /// which is the price of the only check that was ever worth making — that
    /// the bytes at this name really are the bytes this name means.
    async fn stored(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredBytes>, StoreFault>;

    /// The stored bytes, for the blind scrub. `None` when there are none.
    async fn read(&self, vault: &VaultId, name: &ObjectName)
    -> Result<Option<Vec<u8>>, StoreFault>;

    /// Remove an object's bytes. Called **only** after the grace period, by
    /// [`crate::engine::Gateway::purge`].
    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault>;
}
