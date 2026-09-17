//! The two ports, and the one schema behind them (#1029 §3).
//!
//! Storage is behind two traits — [`StateStore`] (the SQL state) and
//! [`ByteStore`] (the objects) — and **every rule in this crate is above them**.
//! An adapter supplies storage; it does not supply policy.
//!
//! # Why the ports are `async` with no `Send` bound
//!
//! A Cloudflare Worker's futures are `!Send`: a Durable Object runs on one
//! isolate and its storage API hands back futures that never cross a thread. A
//! `Send` bound here would make this crate unimplementable in the deployment it
//! was written for. The standalone adapter's futures *are* `Send`, and nothing
//! stops it: a bound that is not required is not a bound that is missing.
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
//! calling it under whatever makes it atomic: a Durable Object runs one request
//! at a time, and the standalone adapter uses an immediate transaction.

use crate::checksum::{AttestedChecksum, ChecksumEvidence, ChecksumMode};
use crate::ids::{AccountId, Generation, ObjectKind, ObjectName, VaultId};
use crate::lease::LeaseState;
use crate::plan::Plan;
use crate::retention::BaseRecord;
use crate::time::ServerTime;

/// The one SQL schema both adapters apply. See [`crate::SCHEMA_SQL`].
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
/// checksum, a kind, a padded size, a state, a receipt time and a generation.
/// There is no plaintext, no plaintext hash, no table name, no exact size and
/// no key — and there is nowhere for one to arrive, because a field is the only
/// way it could.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredObject {
    pub name: ObjectName,
    pub checksum: AttestedChecksum,
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
    reason = "a `Send` bound here would make this crate unimplementable in a \
              Cloudflare Worker, whose Durable Object futures are !Send — and \
              that deployment is half of what the trait exists for (§3). The \
              standalone adapter's futures are Send and nothing here stops them."
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
    /// only one. Implement it with [`crate::commit::compare_and_set`] under a
    /// Durable Object's single-request execution, or under `BEGIN IMMEDIATE`.
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
}

/// The objects. **Bytes never pass through gateway code on the hosted
/// adapter**: they go straight to R2 by presigned URL, and the gateway learns
/// about them only through [`ByteStore::evidence`].
#[expect(
    async_fn_in_trait,
    reason = "see StateStore — a Worker's futures are !Send"
)]
pub trait ByteStore {
    /// What this store can be verified with. **A property of the store, not of
    /// the adapter**: B2 and MinIO differ on which checksum headers they
    /// attest, which is why this is an input and why the conformance suite runs
    /// both.
    fn checksum_mode(&self) -> ChecksumMode;

    /// Issue an upload target for a name that is not yet committed.
    async fn presign_put(
        &self,
        vault: &VaultId,
        name: &ObjectName,
        padded_size: u64,
        now: ServerTime,
    ) -> Result<UploadTarget, StoreFault>;

    /// What the store can say about the bytes at this name, in whichever mode
    /// it supports.
    ///
    /// An attest-only store answers [`ChecksumEvidence::Attested`] from a HEAD
    /// request; a store that cannot attest is **read and hashed**. A store that
    /// has nothing at all answers [`ChecksumEvidence::None`], which is a
    /// rejection — R2 records the checksum only when the client sent it, so
    /// silence has to be a refusal.
    async fn evidence(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<ChecksumEvidence, StoreFault>;

    /// The stored bytes, for the blind scrub. `None` when there are none.
    async fn read(&self, vault: &VaultId, name: &ObjectName)
    -> Result<Option<Vec<u8>>, StoreFault>;

    /// Remove an object's bytes. Called **only** after the grace period, by
    /// [`crate::engine::Gateway::purge`].
    async fn purge(&mut self, vault: &VaultId, name: &ObjectName) -> Result<(), StoreFault>;
}
