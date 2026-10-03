//! The rules, in the order they run (#1080).
//!
//! Each method is one route's whole decision, run inside
//! [`State::atomically`] so that what it read is still true when it writes.
//! **The order inside each is a rule of its own**: authorise before judging,
//! judge before touching bytes, move bytes before recording them. An adapter
//! that reordered them would answer the same on the happy path and
//! differently everywhere else, which is why the order lives here.
//!
//! # TIME AND RANDOMNESS ARE ARGUMENTS
//!
//! `now_ms` is the adapter's clock reading and a [`Token`] or [`Secret`] is
//! bytes the adapter drew from its generator. Nothing here reads a clock or
//! draws a number, so every rule can be replayed and every case pinned.
//!
//! # BYTES ARE THE ADAPTER'S, AND ARRIVE THROUGH A CALLBACK
//!
//! The rules never hold an object. A `PUT` is judged on an [`Arrival`] — the
//! digest and size the adapter measured while it staged the bytes — and the
//! adapter's `commit` runs only when the verdict is "store", between the
//! judgement and the row that records it. A purge's `remove` runs the same
//! way. Bytes land before the row that says they are there, so a crash
//! between the two leaves an unlisted file, never a listed name with no bytes.

use std::collections::BTreeSet;

use crate::rules::claim::{READ_EPOCH, verify_claim};
use crate::rules::code::{Code, Refusal};
use crate::rules::ids::{Digest, GatewayId, Name, Secret, Token, VaultId};
use crate::rules::limits::{
    GRACE_MS, LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_LABEL_BYTES, MAX_NAMES, MAX_OBJECT_BYTES, PROTOCOL,
    SECRET_TTL_MS,
};
use crate::rules::state::{
    Fault, HeadRecord, ObjectRecord, SecretRecord, State, TokenRecord, Tombstone, VaultRecord,
};
use crate::rules::wire::{
    DeleteAnswer, HeadView, Info, NameRefusal, ObjectEntry, PairKind, PairRequest, Paired, SetHead,
    SnapshotView,
};

/// What a request may do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Read,
    Write,
}

/// Who is asking, as the rules authorised them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Caller {
    pub vault: VaultId,
    /// The epoch the token was minted at.
    pub epoch: u64,
    /// The vault's writer epoch as of this request.
    pub writer_epoch: u64,
}

/// What a `PUT` or a bundle frame brought, as the adapter measured it while
/// staging the bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Arrival {
    pub name: Name,
    /// What the phone said the bytes hash to (`Content-Digest`).
    pub declared: Digest,
    /// What they do hash to.
    pub digest: Digest,
    pub size: u64,
}

/// A `PUT` that was admitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutOutcome {
    /// New bytes, now held: `201`.
    Stored(ObjectEntry),
    /// The name was already held with this digest; nothing moved: `200`.
    AlreadyStored(ObjectEntry),
}

impl PutOutcome {
    /// The object as the gateway now holds it.
    #[must_use]
    pub const fn entry(&self) -> ObjectEntry {
        match self {
            Self::Stored(entry) | Self::AlreadyStored(entry) => *entry,
        }
    }
}

/// What a scrub found at one name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finding {
    /// The bytes hash to the stored digest.
    Intact,
    /// They do not: bit rot, or a file somebody edited.
    Corrupt,
    /// There are no bytes at all.
    Missing,
}

/// What one scrub pass counted. Counts only: a gateway is blind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ScrubCounts {
    pub read: u64,
    pub corrupt: u64,
    pub missing: u64,
}

/// Judge one object's bytes against its digest. **No key is involved**: the
/// digest is a hash of the ciphertext, which is the whole reason a blind
/// gateway can scrub at all.
#[must_use]
pub fn examine(expected: &Digest, found: Option<&Digest>) -> Finding {
    match found {
        None => Finding::Missing,
        Some(found) if found == expected => Finding::Intact,
        Some(_) => Finding::Corrupt,
    }
}

/// One paired vault as `pairings` lists it. No token value: the gateway does
/// not have one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub vault: VaultRecord,
    pub head: Option<HeadRecord>,
    pub tokens: Vec<TokenRecord>,
}

/// The rules, over one adapter's state.
#[derive(Debug)]
pub struct Gateway<S> {
    pub state: S,
    id: GatewayId,
}

impl<S: State> Gateway<S> {
    /// The rules over `state`, for the gateway whose id is `id`.
    pub const fn new(state: S, id: GatewayId) -> Self {
        Self { state, id }
    }

    /// This gateway's id.
    #[must_use]
    pub const fn id(&self) -> GatewayId {
        self.id
    }

    /// `GET /v2/info`. Answers before anything is paired.
    #[must_use]
    pub const fn info(&self, now_ms: i64) -> Info {
        Info {
            gateway_id: self.id,
            protocol: PROTOCOL,
            time_ms: now_ms,
        }
    }

    /// The operator's `pair` verb: admit one new vault, once, for a day.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn mint_secret(&mut self, secret: &Secret, now_ms: i64) -> Result<SecretRecord, Fault> {
        let record = SecretRecord {
            hash: secret.hash(),
            created_at_ms: now_ms,
            expires_at_ms: now_ms.saturating_add(SECRET_TTL_MS),
            used_at_ms: None,
            used_by: None,
        };
        self.state.atomically(|state| {
            state.put_secret(&record)?;
            Ok(record)
        })
    }

    /// `POST /v2/pair`. `token` is the fresh token the adapter drew; it is
    /// handed back only if the pairing succeeds.
    ///
    /// The checks run shape, then credential, then state: a malformed request
    /// is `BAD_REQUEST` whoever sent it; a wrong secret or signature is
    /// `UNAUTHORIZED` before anything about the vault is revealed; only a
    /// caller who proved something learns `VAULT_KNOWN`, the epoch or the head.
    ///
    /// # Errors
    ///
    /// `BAD_REQUEST`, `UNAUTHORIZED`, `VAULT_KNOWN`, `EPOCH_CONFLICT`,
    /// `HEAD_CONFLICT`, or a store fault.
    pub fn pair(
        &mut self,
        request: &PairRequest,
        token: &Token,
        now_ms: i64,
    ) -> Result<Paired, Fault> {
        let shaped = match request.kind {
            PairKind::Secret => {
                request.secret.is_some() && request.claim.is_none() && request.read.is_none()
            }
            PairKind::Claim => {
                request.claim.is_some() && request.secret.is_none() && request.read.is_none()
            }
            PairKind::Read => {
                request.read.is_some() && request.secret.is_none() && request.claim.is_none()
            }
        };
        let label_fits =
            request.label.len() <= MAX_LABEL_BYTES && !request.label.chars().any(char::is_control);
        if !shaped || !label_fits || request.vault_id.verifying_key().is_none() {
            return Err(Refusal::BadRequest.into());
        }
        let gateway = self.id;
        self.state.atomically(|state| match request.kind {
            PairKind::Secret => pair_by_secret(state, gateway, request, token, now_ms),
            PairKind::Claim => pair_by_claim(state, gateway, request, token, now_ms),
            PairKind::Read => grant_read(state, gateway, request, token, now_ms),
        })
    }

    /// Authorise one request without doing anything else: what the adapter
    /// asks before it accepts an upload's bytes at all.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, or a store fault.
    pub fn authorize(
        &self,
        vault: &VaultId,
        token: &Token,
        access: Access,
    ) -> Result<Caller, Fault> {
        authorize(&self.state, vault, token, access)
    }

    /// `GET /v2/v/{vault}/head`.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `NO_HEAD` with the writer epoch, or a store fault.
    pub fn head(&self, vault: &VaultId, token: &Token) -> Result<HeadView, Fault> {
        let caller = authorize(&self.state, vault, token, Access::Read)?;
        let head = self.state.head(vault)?.ok_or(Refusal::NoHead {
            epoch: caller.writer_epoch,
        })?;
        Ok(view(&head, caller.writer_epoch))
    }

    /// `PUT /v2/v/{vault}/head`: compare-and-set on `prev`, and register the
    /// snapshot.
    ///
    /// Asking for the head that already stands succeeds unchanged, so a retry
    /// after a lost answer is not a conflict. The manifest must be held: a
    /// head a restore cannot follow is worse than none.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `HEAD_CONFLICT` with the head as it stands,
    /// `NOT_FOUND` for a manifest the gateway does not hold, or a store fault.
    pub fn set_head(
        &mut self,
        vault: &VaultId,
        token: &Token,
        request: &SetHead,
        now_ms: i64,
    ) -> Result<HeadView, Fault> {
        self.state.atomically(|state| {
            let caller = authorize(state, vault, token, Access::Write)?;
            let current = state.head(vault)?;
            if let Some(current) = current.filter(|head| head.name == request.name) {
                return Ok(view(&current, caller.writer_epoch));
            }
            if current.map(|head| head.name) != request.prev {
                return Err(Refusal::HeadConflict {
                    epoch: caller.writer_epoch,
                    head: current.map(|head| view(&head, caller.writer_epoch)),
                }
                .into());
            }
            if !state
                .object(vault, &request.name)?
                .is_some_and(|object| object.is_held())
            {
                return Err(Refusal::NotFound {
                    name: Some(request.name),
                }
                .into());
            }
            let head = HeadRecord {
                name: request.name,
                taken_at_ms: request.taken_at_ms,
                set_at_ms: now_ms,
            };
            state.put_head(vault, &head)?;
            state.put_snapshot(
                vault,
                &SnapshotView {
                    name: request.name,
                    taken_at_ms: request.taken_at_ms,
                    registered_at_ms: now_ms,
                },
            )?;
            Ok(view(&head, caller.writer_epoch))
        })
    }

    /// `GET /v2/v/{vault}/snapshots`.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, or a store fault.
    pub fn snapshots(&self, vault: &VaultId, token: &Token) -> Result<Vec<SnapshotView>, Fault> {
        authorize(&self.state, vault, token, Access::Read)?;
        Ok(self.state.snapshots(vault)?)
    }

    /// `POST /v2/v/{vault}/exists`: the names this gateway does not hold. A
    /// tombstoned or damaged name is not held — the phone must send it again.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `TOO_MANY`, or a store fault.
    pub fn exists(
        &self,
        vault: &VaultId,
        token: &Token,
        names: &[Name],
    ) -> Result<Vec<Name>, Fault> {
        authorize(&self.state, vault, token, Access::Read)?;
        within_count(names)?;
        let mut missing = Vec::new();
        for name in distinct(names) {
            if !self
                .state
                .object(vault, &name)?
                .is_some_and(|object| object.is_held())
            {
                missing.push(name);
            }
        }
        Ok(missing)
    }

    /// `PUT /v2/v/{vault}/o/{name}`, and one frame of a bundle.
    ///
    /// **Write-once by name and digest.** A held name with this digest is
    /// `AlreadyStored` and nothing moves; a held name with another digest is
    /// `NAME_TAKEN`; a name that is absent, tombstoned or damaged is stored,
    /// and `commit` — the adapter moving the staged bytes into place — runs
    /// before the row is written.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `TOO_LARGE`, `DIGEST_MISMATCH`, `NAME_TAKEN`,
    /// whatever `commit` returns (`DISK_FULL`, a store fault), or a store
    /// fault.
    pub fn put(
        &mut self,
        vault: &VaultId,
        token: &Token,
        arrival: &Arrival,
        now_ms: i64,
        commit: impl FnOnce() -> Result<(), Fault>,
    ) -> Result<PutOutcome, Fault> {
        self.state.atomically(|state| {
            authorize(state, vault, token, Access::Write)?;
            if arrival.size > MAX_OBJECT_BYTES {
                return Err(Refusal::TooLarge {
                    limit: MAX_OBJECT_BYTES,
                }
                .into());
            }
            if arrival.digest != arrival.declared {
                return Err(Refusal::DigestMismatch {
                    computed: arrival.digest,
                }
                .into());
            }
            if let Some(held) = state
                .object(vault, &arrival.name)?
                .filter(ObjectRecord::is_held)
            {
                return if held.digest == arrival.digest {
                    Ok(PutOutcome::AlreadyStored(held.entry()))
                } else {
                    Err(Refusal::NameTaken {
                        digest: held.digest,
                    }
                    .into())
                };
            }
            commit()?;
            let record = ObjectRecord {
                name: arrival.name,
                digest: arrival.digest,
                size: arrival.size,
                stored_at_ms: now_ms,
                tombstone: None,
                damaged_at_ms: None,
            };
            state.put_object(vault, &record)?;
            Ok(PutOutcome::Stored(record.entry()))
        })
    }

    /// `GET` and `HEAD /v2/v/{vault}/o/{name}`: the object to serve.
    ///
    /// A tombstoned object is still served until the purge takes its bytes:
    /// that is what the grace is for — a restore that began from a snapshot
    /// keeps reading it even when retention drops that snapshot meanwhile. A
    /// damaged object is not served: the scrub found its bytes are not its
    /// digest, and it reads as missing until the phone sends it again.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `NOT_FOUND`, or a store fault.
    pub fn object(
        &self,
        vault: &VaultId,
        token: &Token,
        name: &Name,
    ) -> Result<ObjectRecord, Fault> {
        authorize(&self.state, vault, token, Access::Read)?;
        Ok(self
            .state
            .object(vault, name)?
            .filter(|object| object.damaged_at_ms.is_none())
            .ok_or(Refusal::NotFound { name: Some(*name) })?)
    }

    /// `GET /v2/v/{vault}/objects?after=&limit=`: one page of what is not
    /// tombstoned, sorted by name. `limit` above [`LIST_LIMIT`] is clamped.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `BAD_REQUEST` for a limit of zero, or a store fault.
    pub fn objects(
        &self,
        vault: &VaultId,
        token: &Token,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectEntry>, Fault> {
        authorize(&self.state, vault, token, Access::Read)?;
        if limit == 0 {
            return Err(Refusal::BadRequest.into());
        }
        Ok(self
            .state
            .live_objects(vault, after, limit.min(LIST_LIMIT))?
            .iter()
            .map(ObjectRecord::entry)
            .collect())
    }

    /// `POST /v2/v/{vault}/fetch`: the objects to stream back, in the order
    /// asked, each once. A name [`Self::object`] would not serve is left out
    /// — the phone sees which came back — and the whole answer must fit one
    /// bundle.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `TOO_MANY`, `TOO_LARGE`, or a store fault.
    pub fn fetch(
        &self,
        vault: &VaultId,
        token: &Token,
        names: &[Name],
    ) -> Result<Vec<ObjectRecord>, Fault> {
        authorize(&self.state, vault, token, Access::Read)?;
        within_count(names)?;
        let mut plan = Vec::new();
        let mut total = 0_u64;
        for name in distinct(names) {
            if let Some(object) = self
                .state
                .object(vault, &name)?
                .filter(|object| object.damaged_at_ms.is_none())
            {
                total = total
                    .saturating_add(crate::rules::bundle::HEADER_LEN as u64)
                    .saturating_add(object.size);
                plan.push(object);
            }
        }
        if total > MAX_BUNDLE_BYTES {
            return Err(Refusal::TooLarge {
                limit: MAX_BUNDLE_BYTES,
            }
            .into());
        }
        Ok(plan)
    }

    /// `POST /v2/v/{vault}/delete`: tombstone each name with a grace of
    /// [`GRACE_MS`]. The head's manifest is refused `HEAD_IN_USE`; a
    /// tombstoned manifest deregisters its snapshot; a name already
    /// tombstoned is deleted again without moving its grace; a name the
    /// gateway does not hold — never stored, or purged — is deleted with
    /// nothing to do. Deleting is idempotent (#1080, the root's ruling A15):
    /// a phone retrying a delete whose answer it lost is never refused.
    ///
    /// A partial delete is reported, not rolled back: the honest answer to a
    /// batch is which names went and why the rest did not.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `TOO_MANY`, or a store fault. A refused name
    /// is in the answer, not an error.
    pub fn delete(
        &mut self,
        vault: &VaultId,
        token: &Token,
        names: &[Name],
        now_ms: i64,
    ) -> Result<DeleteAnswer, Fault> {
        self.state.atomically(|state| {
            authorize(state, vault, token, Access::Write)?;
            within_count(names)?;
            let head = state.head(vault)?.map(|head| head.name);
            let mut answer = DeleteAnswer::default();
            for name in distinct(names) {
                if head == Some(name) {
                    answer.refused.push(NameRefusal {
                        name,
                        code: Code::HeadInUse,
                    });
                    continue;
                }
                let Some(mut object) = state.object(vault, &name)? else {
                    answer.deleted.push(name);
                    continue;
                };
                if object.tombstone.is_none() {
                    object.tombstone = Some(Tombstone {
                        at_ms: now_ms,
                        purge_after_ms: now_ms.saturating_add(GRACE_MS),
                    });
                    state.put_object(vault, &object)?;
                    state.remove_snapshot(vault, &name)?;
                }
                answer.deleted.push(name);
            }
            Ok(answer)
        })
    }

    /// Tombstones whose grace has ended: the purge sweep's page.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn purgeable(&self, now_ms: i64, limit: usize) -> Result<Vec<(VaultId, Name)>, Fault> {
        Ok(self.state.purgeable(now_ms, limit)?)
    }

    /// Purge one tombstone if it is still past its grace. `remove` — the
    /// adapter unlinking the bytes — runs inside the same step, so a `PUT`
    /// that stored the name again in the meantime is never unlinked.
    ///
    /// # Errors
    ///
    /// Whatever `remove` returns, or a store fault.
    pub fn purge(
        &mut self,
        vault: &VaultId,
        name: &Name,
        now_ms: i64,
        remove: impl FnOnce() -> Result<(), Fault>,
    ) -> Result<bool, Fault> {
        self.state.atomically(|state| {
            let due = state.object(vault, name)?.is_some_and(|object| {
                object
                    .tombstone
                    .is_some_and(|tombstone| tombstone.purge_after_ms <= now_ms)
            });
            if !due {
                return Ok(false);
            }
            remove()?;
            state.remove_object(vault, name)?;
            Ok(true)
        })
    }

    /// One page of every object, for the scrub.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn scrub_page(
        &self,
        after: Option<(&VaultId, &Name)>,
        limit: usize,
    ) -> Result<Vec<(VaultId, ObjectRecord)>, Fault> {
        Ok(self.state.all_objects(after, limit)?)
    }

    /// Record what the scrub found at one object it read as `scrubbed`. If
    /// the row changed since — a `PUT` replaced it — the finding is about
    /// bytes that are gone and is dropped.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn record_scrub(
        &mut self,
        vault: &VaultId,
        scrubbed: &ObjectRecord,
        finding: Finding,
        now_ms: i64,
    ) -> Result<(), Fault> {
        self.state.atomically(|state| {
            let Some(mut object) = state.object(vault, &scrubbed.name)? else {
                return Ok(());
            };
            if object.digest != scrubbed.digest || object.stored_at_ms != scrubbed.stored_at_ms {
                return Ok(());
            }
            let damaged = match finding {
                Finding::Intact => None,
                Finding::Corrupt | Finding::Missing => Some(object.damaged_at_ms.unwrap_or(now_ms)),
            };
            if damaged != object.damaged_at_ms {
                object.damaged_at_ms = damaged;
                state.put_object(vault, &object)?;
            }
            Ok(())
        })
    }

    /// Every pairing secret, as hashes with their times, for `pairings` and
    /// for `serve` deciding whether to print a first QR.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn secrets(&self) -> Result<Vec<SecretRecord>, Fault> {
        Ok(self.state.secrets()?)
    }

    /// Every paired vault, its head and its tokens, for `pairings`.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn pairings(&self) -> Result<Vec<Pairing>, Fault> {
        let tokens = self.state.tokens()?;
        let mut out = Vec::new();
        for vault in self.state.vaults()? {
            out.push(Pairing {
                head: self.state.head(&vault.vault)?,
                tokens: tokens
                    .iter()
                    .filter(|token| token.vault == vault.vault)
                    .cloned()
                    .collect(),
                vault,
            });
        }
        Ok(out)
    }
}

/// The head as an answer carries it, with the writer epoch joined in.
const fn view(head: &HeadRecord, writer_epoch: u64) -> HeadView {
    HeadView {
        name: head.name,
        taken_at_ms: head.taken_at_ms,
        epoch: writer_epoch,
        set_at_ms: head.set_at_ms,
    }
}

/// The vault in the path must be the token's vault. An unknown token, a token
/// for another vault and an unknown vault are one answer, so none of them
/// tells a stranger which vaults this gateway holds. A write with a token
/// below the writer epoch is `MOVED`; a read with one is answered, so a
/// superseded phone can freeze read-only.
fn authorize<S: State>(
    state: &S,
    vault: &VaultId,
    token: &Token,
    access: Access,
) -> Result<Caller, Fault> {
    let record = state
        .token(&token.hash())?
        .filter(|record| record.vault == *vault)
        .ok_or(Refusal::Unauthorized)?;
    let writer_epoch = state
        .vault(vault)?
        .ok_or(Refusal::Unauthorized)?
        .writer_epoch;
    if access == Access::Write && record.epoch < writer_epoch {
        return Err(Refusal::Moved {
            epoch: writer_epoch,
        }
        .into());
    }
    Ok(Caller {
        vault: *vault,
        epoch: record.epoch,
        writer_epoch,
    })
}

/// A secret admits a vault the gateway has never seen, at epoch 1. A secret
/// that is unknown, spent or expired is `UNAUTHORIZED`; a good one offered
/// for a known vault is `VAULT_KNOWN` and is not spent.
fn pair_by_secret<S: State>(
    state: &mut S,
    gateway: GatewayId,
    request: &PairRequest,
    token: &Token,
    now_ms: i64,
) -> Result<Paired, Fault> {
    let secret = request.secret.ok_or(Refusal::BadRequest)?;
    let mut record = state
        .secret(&secret.hash())?
        .filter(|record| record.is_live(now_ms))
        .ok_or(Refusal::Unauthorized)?;
    if state.vault(&request.vault_id)?.is_some() {
        return Err(Refusal::VaultKnown.into());
    }
    record.used_at_ms = Some(now_ms);
    record.used_by = Some(request.vault_id);
    state.put_secret(&record)?;
    state.put_vault(&VaultRecord {
        vault: request.vault_id,
        writer_epoch: 1,
        paired_at_ms: now_ms,
        moved_at_ms: None,
    })?;
    mint(state, gateway, request, token, 1, now_ms)
}

/// A claim moves the writer to the next epoch, signed by the vault's
/// identity key, and only while the head is the one the claimer checked.
/// Signature first, so only the key's holder learns the epoch and the head.
fn pair_by_claim<S: State>(
    state: &mut S,
    gateway: GatewayId,
    request: &PairRequest,
    token: &Token,
    now_ms: i64,
) -> Result<Paired, Fault> {
    let claim = request.claim.ok_or(Refusal::BadRequest)?;
    let mut vault = state
        .vault(&request.vault_id)?
        .ok_or(Refusal::Unauthorized)?;
    if !verify_claim(
        &gateway,
        &request.vault_id,
        claim.epoch,
        claim.head_seen.as_ref(),
        &claim.signature,
    ) {
        return Err(Refusal::Unauthorized.into());
    }
    let head = state.head(&request.vault_id)?;
    let head_view = head.map(|head| view(&head, vault.writer_epoch));
    if vault.writer_epoch.checked_add(1) != Some(claim.epoch) {
        return Err(Refusal::EpochConflict {
            epoch: vault.writer_epoch,
            head: head_view,
        }
        .into());
    }
    if head.map(|head| head.name) != claim.head_seen {
        return Err(Refusal::HeadConflict {
            epoch: vault.writer_epoch,
            head: head_view,
        }
        .into());
    }
    vault.writer_epoch = claim.epoch;
    vault.moved_at_ms = Some(now_ms);
    state.put_vault(&vault)?;
    mint(state, gateway, request, token, claim.epoch, now_ms)
}

/// A read grant: a token at epoch 0, which reads and never writes.
fn grant_read<S: State>(
    state: &mut S,
    gateway: GatewayId,
    request: &PairRequest,
    token: &Token,
    now_ms: i64,
) -> Result<Paired, Fault> {
    let read = request.read.ok_or(Refusal::BadRequest)?;
    state
        .vault(&request.vault_id)?
        .ok_or(Refusal::Unauthorized)?;
    if !verify_claim(
        &gateway,
        &request.vault_id,
        READ_EPOCH,
        None,
        &read.signature,
    ) {
        return Err(Refusal::Unauthorized.into());
    }
    mint(state, gateway, request, token, READ_EPOCH, now_ms)
}

fn mint<S: State>(
    state: &mut S,
    gateway: GatewayId,
    request: &PairRequest,
    token: &Token,
    epoch: u64,
    now_ms: i64,
) -> Result<Paired, Fault> {
    state.put_token(&TokenRecord {
        hash: token.hash(),
        vault: request.vault_id,
        epoch,
        kind: request.kind,
        label: request.label.clone(),
        created_at_ms: now_ms,
    })?;
    Ok(Paired {
        token: *token,
        epoch,
        gateway_id: gateway,
    })
}

fn within_count(names: &[Name]) -> Result<(), Fault> {
    if names.len() > MAX_NAMES {
        return Err(Refusal::TooMany {
            limit: MAX_NAMES as u64,
        }
        .into());
    }
    Ok(())
}

/// Each name once, first occurrence first.
fn distinct(names: &[Name]) -> Vec<Name> {
    let mut seen = BTreeSet::new();
    names
        .iter()
        .copied()
        .filter(|name| seen.insert(*name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scrub_needs_no_key_and_tells_missing_from_corrupt() {
        let digest = Digest::of(b"sealed");
        assert_eq!(examine(&digest, Some(&digest)), Finding::Intact);
        assert_eq!(
            examine(&digest, Some(&Digest::of(b"rotted"))),
            Finding::Corrupt
        );
        assert_eq!(examine(&digest, None), Finding::Missing);
    }

    #[test]
    fn a_batch_names_each_name_once_in_the_order_asked() {
        let one = Name::from_bytes([1; 32]);
        let two = Name::from_bytes([2; 32]);
        assert_eq!(distinct(&[two, one, two, one]), vec![two, one]);
    }
}
