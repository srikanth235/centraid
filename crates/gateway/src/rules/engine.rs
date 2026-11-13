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

use crate::rules::code::{Code, Refusal};
use crate::rules::ids::{Digest, GatewayId, Name, Secret, Token, TokenHash, VaultId};
use crate::rules::limits::{
    BUSY_RETRY_MS, GRACE_MS, LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_CLOCK_AHEAD_MS, MAX_GENERATION_JUMP,
    MAX_LABEL_BYTES, MAX_LIVE_NONCES, MAX_LIVE_SECRETS, MAX_NAMES, MAX_OBJECT_BYTES,
    MAX_REVOKED_PER_VAULT, NONCE_TTL_MS, ORPHAN_MIN_AGE_MS, PROTOCOL, PURGE_GAP_INTERVALS,
    PURGE_INTERVAL_MS, REVOKED_TOKEN_KEEP_MS, SECRET_KEEP_MS, SECRET_TTL_MS,
};
use crate::rules::nonce;
use crate::rules::signing::{
    HeadFields, READ_EPOCH, verify_claim, verify_delete, verify_head, verify_pair, verify_undo,
};
use crate::rules::state::{
    ClaimRecord, Fault, HeadRecord, Hold, ObjectRecord, RevokedToken, SecretRecord, SnapshotRecord,
    State, TokenRecord, VaultRecord,
};
use crate::rules::wire::{
    ClaimView, DeleteAnswer, DeleteRequest, HeadView, HeldEntry, HeldKind, Info, NameRefusal,
    NameState, NonceAnswer, ObjectEntry, PairKind, PairRequest, Paired, SetHead, SnapshotView,
    UndoRequest, Undone,
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

/// What an operator verb found. The verbs are local and unsigned; a vault
/// that is not there, or in the wrong state for the verb, is an answer and
/// not a fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operated<T> {
    /// It was done.
    Done(T),
    /// No such vault.
    NoSuchVault,
    /// The verb needs an unfrozen vault, and this one has been frozen since.
    Frozen { since_ms: i64 },
    /// The verb needs a frozen vault.
    NotFrozen,
}

/// What `delete-vault` removed. Counts only: a blind gateway logs no name.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct VaultDeleted {
    pub objects: u64,
    pub tokens: u64,
}

/// What the hourly sweep pruned.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Pruned {
    pub nonces: u64,
    pub secrets: u64,
    pub revoked_tokens: u64,
}

/// One paired vault as `pairings` lists it. No token value: the gateway does
/// not have one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pairing {
    pub vault: VaultRecord,
    pub head: Option<HeadRecord>,
    pub tokens: Vec<TokenRecord>,
    /// When the vault's last claim landed, if one has.
    pub claimed_at_ms: Option<i64>,
}

/// The rules, over one adapter's state.
#[derive(Debug)]
pub struct Gateway<S> {
    pub state: S,
    id: GatewayId,
    /// The key nonces are MAC'd under: gateway-local, kept with the identity,
    /// handed to the rules as an argument like a clock.
    nonce_key: [u8; 32],
}

impl<S: State> Gateway<S> {
    /// The rules over `state`, for the gateway whose id is `id`.
    pub const fn new(state: S, id: GatewayId, nonce_key: [u8; 32]) -> Self {
        Self {
            state,
            id,
            nonce_key,
        }
    }

    /// This gateway's id.
    #[must_use]
    pub const fn id(&self) -> GatewayId {
        self.id
    }

    /// `GET /v3/info`. Answers before anything is paired.
    #[must_use]
    pub const fn info(&self, now_ms: i64) -> Info {
        Info {
            gateway_id: self.id,
            protocol: PROTOCOL,
            time_ms: now_ms,
        }
    }

    /// The operator's `pair` verb: admit one new vault, once, for a day. At
    /// most [`MAX_LIVE_SECRETS`] are live; minting one more drops the oldest.
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
            while state.live_secrets(now_ms)? >= MAX_LIVE_SECRETS {
                let Some(oldest) = state.oldest_live_secret(now_ms)? else {
                    break;
                };
                state.remove_secret(&oldest.hash)?;
            }
            state.put_secret(&record)?;
            Ok(record)
        })
    }

    /// `POST /v3/nonce`: a nonce for `random`, **written nowhere** (R2): the
    /// gateway recognises it later by its MAC. The only state it reads is the
    /// spent table's live size, and at [`MAX_LIVE_NONCES`] spent in the last
    /// five minutes the answer is `BUSY`. The route names no vault, so a
    /// gateway learns nothing of who is about to restore.
    ///
    /// # Errors
    ///
    /// `BUSY`, or a store fault.
    pub fn issue_nonce(&self, random: [u8; 16], now_ms: i64) -> Result<NonceAnswer, Fault> {
        let not_before = now_ms.saturating_sub(NONCE_TTL_MS);
        if self.state.live_nonces(not_before)? >= MAX_LIVE_NONCES {
            return Err(Refusal::Busy {
                retry_after_ms: BUSY_RETRY_MS,
            }
            .into());
        }
        Ok(NonceAnswer {
            nonce: nonce::mint(&self.nonce_key, &self.id, random, now_ms),
            ttl_ms: NONCE_TTL_MS,
        })
    }

    /// `POST /v3/pair`. `token` is the fresh token the adapter drew; it is
    /// handed back only if the pairing succeeds.
    ///
    /// The checks run shape, then the nonce's MAC and age, then the credential
    /// (the live secret, the vault, the signature over the nonce), and only
    /// then **the nonce is spent, in a step of its own, so a refusal below
    /// does not give it back**; a malformed request is `BAD_REQUEST` whoever
    /// sent it; a wrong secret or signature is `UNAUTHORIZED` before anything
    /// about the vault is revealed; only a caller who proved something learns
    /// `VAULT_KNOWN`, `FROZEN`, the epoch or the head.
    ///
    /// # Errors
    ///
    /// `BAD_REQUEST`, `UNAUTHORIZED`, `VAULT_KNOWN`, `FROZEN`,
    /// `EPOCH_CONFLICT`, `HEAD_CONFLICT`, or a store fault.
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
        // The nonce must be this gateway's own and young: a pure check.
        let opened = nonce::open(&self.nonce_key, &gateway, &request.nonce, now_ms)
            .ok_or(Refusal::Unauthorized)?;
        // Authenticate, then spend the nonce, in a step of its own: only a
        // request that proved something writes a row, and a refusal below
        // does not give the nonce back.
        self.state.atomically(|state| {
            authenticate(state, gateway, request, now_ms)?;
            if !state.spend_nonce(&opened.id, opened.issued_at_ms)? {
                return Err(Refusal::Unauthorized.into());
            }
            Ok(())
        })?;
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
    /// `UNAUTHORIZED`, `MOVED`, `FROZEN`, or a store fault.
    pub fn authorize(
        &self,
        vault: &VaultId,
        token: &Token,
        access: Access,
    ) -> Result<Caller, Fault> {
        authorize(&self.state, vault, token, access)
    }

    /// `GET /v3/v/{vault}/head`: the record as the phone signed it.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `NO_HEAD` with the writer epoch, or a store
    /// fault.
    pub fn head(&self, vault: &VaultId, token: &Token) -> Result<HeadView, Fault> {
        let caller = authorize(&self.state, vault, token, Access::Read)?;
        let claim = self.state.claim(vault)?.map(|claim| claim_view(&claim));
        let head = self.state.head(vault)?.ok_or(Refusal::NoHead {
            epoch: caller.writer_epoch,
            claim: claim.map(Box::new),
        })?;
        Ok(view(&head, claim))
    }

    /// `PUT /v3/v/{vault}/head`: the signed record, judged in the order of
    /// E3 — signature, clock, generation, writes, compare-and-set on `prev`,
    /// and a manifest the gateway holds — then stored as signed and
    /// registered as a snapshot.
    ///
    /// Asking for the head that already stands, with the same signature,
    /// succeeds unchanged, so a retry after a lost answer is not a conflict.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `FROZEN`, `CLOCK_AHEAD`, `OUT_OF_ORDER`,
    /// `HEAD_CONFLICT` with the head as it stands, `NOT_FOUND` for a
    /// manifest the gateway does not hold, or a store fault.
    pub fn set_head(
        &mut self,
        vault: &VaultId,
        token: &Token,
        request: &SetHead,
        now_ms: i64,
    ) -> Result<HeadView, Fault> {
        let gateway = self.id;
        self.state.atomically(|state| {
            let caller = authorize(state, vault, token, Access::Write)?;
            let mut record = state.vault(vault)?.ok_or(Refusal::Unauthorized)?;
            let current = state.head(vault)?;
            let fields = HeadFields {
                epoch: caller.epoch,
                generation: request.generation,
                writes: request.writes,
                taken_at_ms: request.taken_at_ms,
                manifest: request.name,
                prev: request.prev,
            };
            if !verify_head(&gateway, vault, &fields, &request.signature) {
                return Err(Refusal::Unauthorized.into());
            }
            if let Some(current) = current
                .filter(|head| head.name == request.name && head.signature == request.signature)
            {
                return Ok(view(&current, standing_claim(state, vault)?));
            }
            let skew = request.taken_at_ms.saturating_sub(now_ms);
            if skew > MAX_CLOCK_AHEAD_MS {
                return Err(Refusal::ClockAhead { skew_ms: skew }.into());
            }
            ordered(&record, request.generation)?;
            if request.writes < record.writes || i64::try_from(request.writes).is_err() {
                return Err(out_of_order(&record).into());
            }
            if current.map(|head| head.name) != request.prev {
                let claim = standing_claim(state, vault)?;
                return Err(Refusal::HeadConflict {
                    epoch: caller.writer_epoch,
                    head: current.map(|head| Box::new(view(&head, claim))),
                }
                .into());
            }
            if !state
                .object(vault, &request.name)?
                .is_some_and(|object| object.is_live())
            {
                return Err(Refusal::NotFound {
                    name: Some(request.name),
                }
                .into());
            }
            state.put_snapshot(
                vault,
                &SnapshotRecord {
                    name: request.name,
                    taken_at_ms: request.taken_at_ms,
                    registered_at_ms: now_ms,
                    epoch: caller.epoch,
                    generation: request.generation,
                    writes: request.writes,
                    prev: request.prev,
                    signature: request.signature,
                    hold: None,
                },
            )?;
            let head = HeadRecord {
                name: request.name,
                prev: request.prev,
                taken_at_ms: request.taken_at_ms,
                epoch: caller.epoch,
                generation: request.generation,
                writes: request.writes,
                set_at_ms: now_ms,
                signature: request.signature,
            };
            state.put_head(vault, &head)?;
            record.generation = request.generation;
            record.writes = request.writes;
            state.put_vault(&record)?;
            Ok(view(&head, standing_claim(state, vault)?))
        })
    }

    /// `GET /v3/v/{vault}/snapshots?after=&limit=`: one page, by name. A
    /// snapshot whose manifest is held for deletion stays in the list.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `BAD_REQUEST` for a limit of zero, or a store
    /// fault.
    pub fn snapshots(
        &self,
        vault: &VaultId,
        token: &Token,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<SnapshotView>, Fault> {
        authorize(&self.state, vault, token, Access::Read)?;
        if limit == 0 {
            return Err(Refusal::BadRequest.into());
        }
        Ok(self
            .state
            .snapshots(vault, after, limit.min(LIST_LIMIT))?
            .iter()
            .map(|snapshot| SnapshotView {
                name: snapshot.name,
                taken_at_ms: snapshot.taken_at_ms,
                registered_at_ms: snapshot.registered_at_ms,
                held_at_ms: snapshot.hold.map(|hold| hold.at_ms),
                purge_after_ms: snapshot.hold.map(|hold| hold.purge_after_ms),
            })
            .collect())
    }

    /// `POST /v3/v/{vault}/exists`: the names this gateway does not hold. A
    /// held or damaged name is not live — the phone must send it again.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `TOO_MANY`, or a store fault.
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
                .is_some_and(|object| object.is_live())
            {
                missing.push(name);
            }
        }
        Ok(missing)
    }

    /// `PUT /v3/v/{vault}/o/{name}`.
    ///
    /// **Write-once by name and digest.** A live name with this digest is
    /// `AlreadyStored` and nothing moves; a live name with another digest is
    /// `NAME_TAKEN`; a name that is absent, held for deletion or damaged is
    /// stored — **replacing the held bytes and lifting the hold** — and
    /// `commit` (the adapter moving the staged bytes into place) runs before
    /// the row is written.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `FROZEN`, `TOO_LARGE`, `DIGEST_MISMATCH`,
    /// `NAME_TAKEN`, whatever `commit` returns (`DISK_FULL`, a store fault),
    /// or a store fault.
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
            put_one(state, vault, arrival, now_ms, commit)
        })
    }

    /// `POST /v3/v/{vault}/bundle`: every frame judged as its own `PUT`
    /// would be, **in one transaction**: the rows of the frames that were
    /// stored land together or not at all. `commit(i)` moves frame `i`'s
    /// staged bytes into place just before its row is written, so a crash
    /// leaves unlisted files (the orphan sweep takes them), never a row
    /// without bytes.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `FROZEN`, or a store fault. A refused frame
    /// is in the answer, not an error.
    pub fn put_bundle(
        &mut self,
        vault: &VaultId,
        token: &Token,
        arrivals: &[Arrival],
        now_ms: i64,
        mut commit: impl FnMut(usize) -> Result<(), Fault>,
    ) -> Result<Vec<Result<PutOutcome, Refusal>>, Fault> {
        self.state.atomically(|state| {
            authorize(state, vault, token, Access::Write)?;
            let mut answers = Vec::with_capacity(arrivals.len());
            for (index, arrival) in arrivals.iter().enumerate() {
                match put_one(state, vault, arrival, now_ms, || commit(index)) {
                    Ok(outcome) => answers.push(Ok(outcome)),
                    Err(Fault::Refused(refusal)) => answers.push(Err(refusal)),
                    Err(fault @ Fault::Store(_)) => return Err(fault),
                }
            }
            Ok(answers)
        })
    }

    /// `GET` and `HEAD /v3/v/{vault}/o/{name}`: the object to serve.
    ///
    /// A held object is still served until the purge takes its bytes: that
    /// is what the hold is for — a restore that began from a snapshot keeps
    /// reading it even when retention drops that snapshot meanwhile. A
    /// damaged object is not served: the scrub found its bytes are not its
    /// digest, and it reads as missing until the phone sends it again.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `NOT_FOUND`, or a store fault.
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

    /// `GET /v3/v/{vault}/objects?after=&limit=`: one page of what is not
    /// held for deletion, sorted by name. `limit` above [`LIST_LIMIT`] is
    /// clamped.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `BAD_REQUEST` for a limit of zero, or a store
    /// fault.
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

    /// `GET /v3/v/{vault}/held?after=&limit=`: one page of what is held for
    /// deletion, by name, with the dates the phone shows.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `BAD_REQUEST` for a limit of zero, or a store
    /// fault.
    pub fn held(
        &self,
        vault: &VaultId,
        token: &Token,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<HeldEntry>, Fault> {
        authorize(&self.state, vault, token, Access::Read)?;
        if limit == 0 {
            return Err(Refusal::BadRequest.into());
        }
        let mut out = Vec::new();
        for object in self
            .state
            .held_objects(vault, after, limit.min(LIST_LIMIT))?
        {
            let Some(hold) = object.hold else { continue };
            out.push(HeldEntry {
                name: object.name,
                size: object.size,
                digest: object.digest,
                kind: if self.state.snapshot(vault, &object.name)?.is_some() {
                    HeldKind::Snapshot
                } else {
                    HeldKind::Object
                },
                held_at_ms: hold.at_ms,
                purge_after_ms: hold.purge_after_ms,
            });
        }
        Ok(out)
    }

    /// `POST /v3/v/{vault}/fetch`: the objects to stream back, in the order
    /// asked, each once. A name [`Self::object`] would not serve is left out
    /// — the phone sees which came back — and the whole answer must fit one
    /// bundle.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED`, `MOVED`, `TOO_MANY`, `TOO_LARGE`, or a store fault.
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

    /// `POST /v3/v/{vault}/delete`: the vault key's signed request to hold
    /// each name for [`GRACE_MS`]. Nothing is removed: the bytes are served,
    /// the name is listed in `held` and a snapshot stays in its list, until
    /// the purge sweep passes the date. The head's manifest is refused
    /// `HEAD_IN_USE`; a name already held keeps its date; a name never
    /// stored is deleted with nothing to do. Deleting is idempotent.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED` (an unsigned or wrongly signed delete included),
    /// `MOVED`, `FROZEN`, `OUT_OF_ORDER`, `TOO_MANY`, or a store fault. A
    /// refused name is in the answer, not an error.
    pub fn delete(
        &mut self,
        vault: &VaultId,
        token: &Token,
        request: &DeleteRequest,
        now_ms: i64,
        mut remove: impl FnMut(&Name) -> Result<(), Fault>,
    ) -> Result<DeleteAnswer, Fault> {
        let gateway = self.id;
        self.state.atomically(|state| {
            let caller = authorize(state, vault, token, Access::Write)?;
            within_count(&request.names)?;
            if !verify_delete(
                &gateway,
                vault,
                caller.epoch,
                request.generation,
                &request.names,
                &request.signature,
            ) {
                return Err(Refusal::Unauthorized.into());
            }
            let mut record = state.vault(vault)?.ok_or(Refusal::Unauthorized)?;
            ordered(&record, request.generation)?;
            let head = state.head(vault)?.map(|head| head.name);
            let mut answer = DeleteAnswer::default();
            for name in distinct(&request.names) {
                if head == Some(name) {
                    answer
                        .refused
                        .push(NameRefusal::code(name, Code::HeadInUse));
                    continue;
                }
                let Some(object) = state.object(vault, &name)? else {
                    answer.deleted.push(name);
                    continue;
                };
                // A DAMAGED OBJECT IS NOT HELD, IT IS FREED (#1191, decision
                // 30): its bytes are already bad, so an undo would restore
                // nothing, and the name stays taken until it is freed. Only
                // the vault key's signature gets here. A damaged manifest a
                // snapshot row still names takes the held path below.
                if object.damaged_at_ms.is_some() && state.snapshot(vault, &name)?.is_none() {
                    remove(&name)?;
                    state.remove_object(vault, &name)?;
                    answer.freed.push(name);
                    continue;
                }
                if object.hold.is_none() {
                    state.set_hold(
                        vault,
                        &name,
                        Some(Hold {
                            at_ms: now_ms,
                            purge_after_ms: now_ms.saturating_add(GRACE_MS),
                        }),
                    )?;
                }
                answer.deleted.push(name);
            }
            record.generation = request.generation;
            state.put_vault(&record)?;
            Ok(answer)
        })
    }

    /// `POST /v3/v/{vault}/undo`: the vault key's signed request to lift the
    /// holds of `names`, or of every hold when `names` is null. The objects
    /// are live again. Undo never moves the head and never reverses a
    /// takeover.
    ///
    /// # Errors
    ///
    /// As [`Self::delete`].
    pub fn undo(
        &mut self,
        vault: &VaultId,
        token: &Token,
        request: &UndoRequest,
    ) -> Result<Undone, Fault> {
        let gateway = self.id;
        self.state.atomically(|state| {
            let caller = authorize(state, vault, token, Access::Write)?;
            if let Some(names) = &request.names {
                within_count(names)?;
            }
            if !verify_undo(
                &gateway,
                vault,
                caller.epoch,
                request.generation,
                request.names.as_deref(),
                &request.signature,
            ) {
                return Err(Refusal::Unauthorized.into());
            }
            let mut record = state.vault(vault)?.ok_or(Refusal::Unauthorized)?;
            ordered(&record, request.generation)?;
            let undone = match &request.names {
                None => state.clear_holds(vault)?,
                Some(names) => {
                    let mut lifted = 0;
                    for name in distinct(names) {
                        if state
                            .object(vault, &name)?
                            .is_some_and(|object| object.hold.is_some())
                        {
                            state.set_hold(vault, &name, None)?;
                            lifted += 1;
                        }
                    }
                    lifted
                }
            };
            record.generation = request.generation;
            state.put_vault(&record)?;
            Ok(Undone { undone })
        })
    }

    /// Holds that are due: the purge sweep's page, after the cursor
    /// `(purge_after_ms, vault, name)`.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn purgeable(
        &self,
        after: Option<(i64, &VaultId, &Name)>,
        now_ms: i64,
        limit: usize,
    ) -> Result<Vec<(i64, VaultId, Name)>, Fault> {
        Ok(self.state.purgeable(after, now_ms, limit)?)
    }

    /// **A hold counts only the time the gateway was watching** (#1191, R1).
    /// If more than [`PURGE_GAP_INTERVALS`] purge intervals passed since the
    /// last sweep — a clock step, a night asleep, a spoofed time — the whole
    /// gap is time nobody saw, and every hold moves later by it, in one
    /// transaction, before anything is purged. The same operation as
    /// `unfreeze`. A gap within three intervals, or a clock that stepped
    /// back, moves nothing: holds are never shortened. Answers the shift.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn account_for_gap(&mut self, last_purge_ms: i64, now_ms: i64) -> Result<i64, Fault> {
        let gap = now_ms.saturating_sub(last_purge_ms);
        if gap <= PURGE_GAP_INTERVALS * PURGE_INTERVAL_MS {
            return Ok(0);
        }
        self.state.atomically(|state| {
            state.shift_all_holds(gap)?;
            Ok(gap)
        })
    }

    /// Purge one hold if it is still due. `remove` — the adapter unlinking
    /// the bytes — runs inside the same step, so a `PUT` that stored the name
    /// again in the meantime is never unlinked. A frozen vault is skipped,
    /// and the head's manifest is never purged.
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
            if state
                .vault(vault)?
                .is_some_and(|record| record.frozen_at_ms.is_some())
            {
                return Ok(false);
            }
            let due = state.object(vault, name)?.is_some_and(|object| {
                object
                    .hold
                    .is_some_and(|hold| hold.purge_after_ms <= now_ms)
            });
            if !due || state.head(vault)?.is_some_and(|head| head.name == *name) {
                return Ok(false);
            }
            remove()?;
            state.remove_snapshot(vault, name)?;
            state.remove_object(vault, name)?;
            Ok(true)
        })
    }

    /// The hourly sweep's housekeeping: spent and expired nonces, old pairing
    /// secrets and old revoked-token tombstones go.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn prune(&mut self, now_ms: i64) -> Result<Pruned, Fault> {
        self.state.atomically(|state| {
            Ok(Pruned {
                nonces: state.prune_nonces(now_ms.saturating_sub(NONCE_TTL_MS))?,
                secrets: state.prune_secrets(
                    now_ms.saturating_sub(SECRET_KEEP_MS),
                    now_ms.saturating_sub(SECRET_KEEP_MS),
                )?,
                revoked_tokens: state
                    .prune_revoked(now_ms.saturating_sub(REVOKED_TOKEN_KEEP_MS))?,
            })
        })
    }

    /// Remove an orphan: a file in `objects/` with no row, older than
    /// [`ORPHAN_MIN_AGE_MS`] by the gateway's clock. **The check and the
    /// removal are one step** — `remove` runs inside the same transaction as
    /// the look at the index, and the adapter holds its one lock across both —
    /// so a `PUT` of the same name cannot slip in between and lose its file
    /// (#1191, R5). Answers whether it removed.
    ///
    /// # Errors
    ///
    /// Whatever `remove` returns, or a store fault.
    pub fn remove_orphan(
        &mut self,
        vault: &VaultId,
        name: &Name,
        modified_ms: i64,
        now_ms: i64,
        remove: impl FnOnce() -> Result<(), Fault>,
    ) -> Result<bool, Fault> {
        if now_ms.saturating_sub(modified_ms) <= ORPHAN_MIN_AGE_MS {
            return Ok(false);
        }
        self.state.atomically(|state| {
            if state.object(vault, name)?.is_some() {
                return Ok(false);
            }
            remove()?;
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
        let mut out = Vec::new();
        loop {
            let page = self.state.secrets(
                out.last()
                    .map(|last: &SecretRecord| (last.created_at_ms, &last.hash)),
                LIST_LIMIT,
            )?;
            let done = page.len() < LIST_LIMIT;
            out.extend(page);
            if done {
                return Ok(out);
            }
        }
    }

    /// `POST /v3/v/{vault}/revoke`: the calling token revokes ITSELF.
    ///
    /// A phone that forgets a gateway, or a member who forgets one on the
    /// phone, ends the token's life at the gateway too. Any token of the
    /// vault may revoke itself. The token is forgotten, with **no tombstone**
    /// — no claim backs it — so every route after answers it `UNAUTHORIZED`,
    /// as it answers a stranger.
    ///
    /// # Errors
    ///
    /// `UNAUTHORIZED` (a token already revoked included), `MOVED`, or a store
    /// fault.
    pub fn revoke(&mut self, vault: &VaultId, token: &Token) -> Result<(), Fault> {
        let vault = *vault;
        let token = *token;
        self.state.atomically(|state| {
            authorize(state, &vault, &token, Access::Read)?;
            state.remove_token(&token.hash())?;
            Ok(())
        })
    }

    /// The operator's `pairings revoke`: revoke a token by its hash, for the
    /// phone that is lost and cannot revoke itself. No tombstone. Answers
    /// whether a token was held under that hash.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn revoke_hash(&mut self, hash: &TokenHash) -> Result<bool, Fault> {
        let hash = *hash;
        self.state
            .atomically(|state| Ok(state.remove_token(&hash)?))
    }

    /// Every paired vault, its head and its tokens, for `pairings`.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn pairings(&self) -> Result<Vec<Pairing>, Fault> {
        let mut out = Vec::new();
        let mut after: Option<VaultId> = None;
        loop {
            let page = self.state.vaults(after.as_ref(), LIST_LIMIT)?;
            let done = page.len() < LIST_LIMIT;
            for vault in page {
                after = Some(vault.vault);
                let mut tokens = Vec::new();
                loop {
                    let page = self.state.tokens_of(
                        &vault.vault,
                        tokens
                            .last()
                            .map(|last: &TokenRecord| (last.created_at_ms, &last.hash)),
                        LIST_LIMIT,
                    )?;
                    let more = page.len() == LIST_LIMIT;
                    tokens.extend(page);
                    if !more {
                        break;
                    }
                }
                out.push(Pairing {
                    head: self.state.head(&vault.vault)?,
                    claimed_at_ms: self
                        .state
                        .claim(&vault.vault)?
                        .map(|claim| claim.claimed_at_ms),
                    tokens,
                    vault,
                });
            }
            if done {
                return Ok(out);
            }
        }
    }

    // ─── the operator's verbs: local, unsigned, through the same rules ───────

    /// `freeze`: refuse every state-changing route for the vault and skip it
    /// in the purge. Reads, nonces and read grants still answer. Freezing a
    /// frozen vault keeps the first date.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn freeze(&mut self, vault: &VaultId, now_ms: i64) -> Result<Operated<()>, Fault> {
        self.state.atomically(|state| {
            let Some(mut record) = state.vault(vault)? else {
                return Ok(Operated::NoSuchVault);
            };
            if record.frozen_at_ms.is_none() {
                record.frozen_at_ms = Some(now_ms);
                state.put_vault(&record)?;
            }
            Ok(Operated::Done(()))
        })
    }

    /// `unfreeze`: lift the freeze and add the time it lasted to every hold,
    /// so freezing does not burn the week.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn unfreeze(&mut self, vault: &VaultId, now_ms: i64) -> Result<Operated<i64>, Fault> {
        self.state.atomically(|state| {
            let Some(mut record) = state.vault(vault)? else {
                return Ok(Operated::NoSuchVault);
            };
            let Some(since) = record.frozen_at_ms else {
                return Ok(Operated::NotFrozen);
            };
            let lasted = now_ms.saturating_sub(since).max(0);
            state.shift_holds(vault, lasted)?;
            record.frozen_at_ms = None;
            state.put_vault(&record)?;
            Ok(Operated::Done(lasted))
        })
    }

    /// The operator's `undo`: lift every hold of the vault, no signature —
    /// the person at the machine has the last word. Works while frozen.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn operator_undo(&mut self, vault: &VaultId) -> Result<Operated<u64>, Fault> {
        self.state.atomically(|state| {
            if state.vault(vault)?.is_none() {
                return Ok(Operated::NoSuchVault);
            }
            Ok(Operated::Done(state.clear_holds(vault)?))
        })
    }

    /// `purge-now`: make every hold of an unfrozen vault due. The adapter
    /// then runs the purge sweep once.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn purge_now(&mut self, vault: &VaultId, now_ms: i64) -> Result<Operated<u64>, Fault> {
        self.state.atomically(|state| {
            let Some(record) = state.vault(vault)? else {
                return Ok(Operated::NoSuchVault);
            };
            if let Some(since_ms) = record.frozen_at_ms {
                return Ok(Operated::Frozen { since_ms });
            }
            Ok(Operated::Done(state.make_holds_due(vault, now_ms)?))
        })
    }

    /// `delete-vault`, on a frozen vault only: tokens, tombstones, head,
    /// snapshots and claim go in one step, the objects in pages of
    /// [`LIST_LIMIT`] by name (`remove` unlinks one object's bytes), and
    /// last the vault. Not held: it is the operator's explicit act.
    ///
    /// # Errors
    ///
    /// Whatever `remove` returns, or a store fault.
    pub fn delete_vault(
        &mut self,
        vault: &VaultId,
        mut remove: impl FnMut(&Name) -> Result<(), Fault>,
    ) -> Result<Operated<VaultDeleted>, Fault> {
        let tokens = self.state.atomically(|state| {
            let Some(record) = state.vault(vault)? else {
                return Ok(None);
            };
            if record.frozen_at_ms.is_none() {
                return Ok(Some(None));
            }
            let tokens = state.take_tokens(vault)?;
            state.remove_heads_and_snapshots(vault)?;
            Ok(Some(Some(tokens.len() as u64)))
        })?;
        let tokens = match tokens {
            None => return Ok(Operated::NoSuchVault),
            Some(None) => return Ok(Operated::NotFrozen),
            Some(Some(tokens)) => tokens,
        };
        let mut objects = 0_u64;
        let mut after: Option<Name> = None;
        loop {
            let page = self
                .state
                .vault_objects(vault, after.as_ref(), LIST_LIMIT)?;
            let done = page.len() < LIST_LIMIT;
            for object in &page {
                remove(&object.name)?;
            }
            self.state.atomically(|state| {
                for object in &page {
                    state.remove_object(vault, &object.name)?;
                }
                Ok(())
            })?;
            objects += page.len() as u64;
            after = page.last().map(|object| object.name);
            if done {
                break;
            }
        }
        self.state.atomically(|state| {
            state.remove_vault(vault)?;
            Ok(())
        })?;
        Ok(Operated::Done(VaultDeleted { objects, tokens }))
    }
}

/// The head as an answer carries it: the record as signed, and the writer
/// epoch joined in.
const fn view(head: &HeadRecord, claim: Option<ClaimView>) -> HeadView {
    HeadView {
        name: head.name,
        prev: head.prev,
        taken_at_ms: head.taken_at_ms,
        epoch: head.epoch,
        claim,
        generation: head.generation,
        writes: head.writes,
        set_at_ms: head.set_at_ms,
        signature: head.signature,
    }
}

/// The vault's standing claim, as an answer carries it.
fn standing_claim<S: State>(state: &S, vault: &VaultId) -> Result<Option<ClaimView>, Fault> {
    Ok(state.claim(vault)?.map(|claim| claim_view(&claim)))
}

const fn claim_view(claim: &ClaimRecord) -> ClaimView {
    ClaimView {
        epoch: claim.epoch,
        head_seen: claim.head_seen,
        nonce: claim.nonce,
        signature: claim.signature,
    }
}

/// `OUT_OF_ORDER` with the standing record's counters.
const fn out_of_order(record: &VaultRecord) -> Refusal {
    Refusal::OutOfOrder {
        epoch: record.writer_epoch,
        generation: record.generation,
        writes: record.writes,
    }
}

/// E3 rule 3: a signed record is newer than the standing one, by at most
/// [`MAX_GENERATION_JUMP`].
fn ordered(record: &VaultRecord, generation: u64) -> Result<(), Fault> {
    if generation <= record.generation
        || generation - record.generation > MAX_GENERATION_JUMP
        || i64::try_from(generation).is_err()
    {
        return Err(out_of_order(record).into());
    }
    Ok(())
}

/// One `PUT`'s whole decision, inside a transaction the caller opened and
/// authorised.
fn put_one<S: State>(
    state: &mut S,
    vault: &VaultId,
    arrival: &Arrival,
    now_ms: i64,
    commit: impl FnOnce() -> Result<(), Fault>,
) -> Result<PutOutcome, Fault> {
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
    let existing = state.object(vault, &arrival.name)?;
    if let Some(row) = existing {
        if row.is_live() {
            return if row.digest == arrival.digest {
                Ok(PutOutcome::AlreadyStored(row.entry()))
            } else {
                Err(Refusal::NameTaken {
                    digest: row.digest,
                    state: NameState::Live,
                }
                .into())
            };
        }
        // HELD OR DAMAGED (R3): only the bytes the row records come back. A
        // writer token that swaps garbage over a held manifest, or over a
        // damaged part, is refused and nothing changes.
        if row.digest != arrival.digest {
            return Err(Refusal::NameTaken {
                digest: row.digest,
                state: if row.damaged_at_ms.is_some() {
                    NameState::Damaged
                } else {
                    NameState::Held
                },
            }
            .into());
        }
        if row.damaged_at_ms.is_none() {
            // Held, and its file is not known to be damaged: the name is
            // live again, and the file is not replaced.
            state.set_hold(vault, &arrival.name, None)?;
            return Ok(PutOutcome::Stored(row.entry()));
        }
    }
    commit()?;
    let record = ObjectRecord {
        name: arrival.name,
        digest: arrival.digest,
        size: arrival.size,
        stored_at_ms: now_ms,
        hold: None,
        damaged_at_ms: None,
    };
    state.put_object(vault, &record)?;
    if existing.is_some_and(|object| object.hold.is_some()) {
        // The bytes just written replace the held ones: the hold, on the
        // object and on its snapshot row, is lifted with them.
        state.set_hold(vault, &arrival.name, None)?;
    }
    Ok(PutOutcome::Stored(record.entry()))
}

/// The vault in the path must be the token's vault. An unknown token, a token
/// for another vault and an unknown vault are one answer, so none of them
/// tells a stranger which vaults this gateway holds. **A token a takeover
/// revoked is `MOVED`**, carrying the signed claim, on every route, reads
/// included, for as long as its tombstone is kept. A write by a read grant is
/// `UNAUTHORIZED`: it was never a writer. A write to a frozen vault is
/// `FROZEN`.
fn authorize<S: State>(
    state: &S,
    vault: &VaultId,
    token: &Token,
    access: Access,
) -> Result<Caller, Fault> {
    let hash = token.hash();
    let Some(record) = state.token(&hash)?.filter(|record| record.vault == *vault) else {
        if state
            .revoked_token(&hash)?
            .is_some_and(|revoked| revoked.vault == *vault)
            && let Some(claim) = state.claim(vault)?
        {
            return Err(Refusal::Moved {
                epoch: claim.epoch,
                claim: Box::new(claim_view(&claim)),
            }
            .into());
        }
        return Err(Refusal::Unauthorized.into());
    };
    let vault_record = state.vault(vault)?.ok_or(Refusal::Unauthorized)?;
    if access == Access::Write {
        if record.kind == PairKind::Read {
            return Err(Refusal::Unauthorized.into());
        }
        if record.epoch < vault_record.writer_epoch {
            return match state.claim(vault)? {
                Some(claim) => Err(Refusal::Moved {
                    epoch: claim.epoch,
                    claim: Box::new(claim_view(&claim)),
                }
                .into()),
                None => Err(Refusal::Unauthorized.into()),
            };
        }
        if let Some(since_ms) = vault_record.frozen_at_ms {
            return Err(Refusal::Frozen { since_ms }.into());
        }
    }
    Ok(Caller {
        vault: *vault,
        epoch: record.epoch,
        writer_epoch: vault_record.writer_epoch,
    })
}

/// Prove the request is the vault key holder's, before anything is written:
/// the secret is live and the signature over it and the nonce verifies (a
/// pairing by secret); the vault is known and the signature over the claim or
/// the grant verifies. `UNAUTHORIZED` for any failure.
fn authenticate<S: State>(
    state: &S,
    gateway: GatewayId,
    request: &PairRequest,
    now_ms: i64,
) -> Result<(), Fault> {
    let verified = match request.kind {
        PairKind::Secret => {
            let body = request.secret.ok_or(Refusal::BadRequest)?;
            state
                .secret(&body.secret.hash())?
                .is_some_and(|record| record.is_live(now_ms))
                && verify_pair(
                    &gateway,
                    &request.vault_id,
                    &body.secret,
                    &request.nonce,
                    &body.signature,
                )
        }
        PairKind::Claim => {
            let claim = request.claim.ok_or(Refusal::BadRequest)?;
            state.vault(&request.vault_id)?.is_some()
                && verify_claim(
                    &gateway,
                    &request.vault_id,
                    claim.epoch,
                    claim.head_seen.as_ref(),
                    &request.nonce,
                    &claim.signature,
                )
        }
        PairKind::Read => {
            let read = request.read.ok_or(Refusal::BadRequest)?;
            state.vault(&request.vault_id)?.is_some()
                && verify_claim(
                    &gateway,
                    &request.vault_id,
                    READ_EPOCH,
                    None,
                    &request.nonce,
                    &read.signature,
                )
        }
    };
    if verified {
        Ok(())
    } else {
        Err(Refusal::Unauthorized.into())
    }
}

/// A secret admits a vault the gateway has never seen, at epoch 1, **to a
/// phone that proves it holds the vault key**: the nonce is spent (by the
/// caller), then the secret is checked, then the signature over the secret's
/// hash and the nonce. Any failure is `UNAUTHORIZED` and spends nothing; a
/// good secret offered for a known vault is `VAULT_KNOWN` (or `FROZEN`) and
/// is not spent.
fn pair_by_secret<S: State>(
    state: &mut S,
    gateway: GatewayId,
    request: &PairRequest,
    token: &Token,
    now_ms: i64,
) -> Result<Paired, Fault> {
    let body = request.secret.ok_or(Refusal::BadRequest)?;
    let mut record = state
        .secret(&body.secret.hash())?
        .filter(|record| record.is_live(now_ms))
        .ok_or(Refusal::Unauthorized)?;
    if let Some(known) = state.vault(&request.vault_id)? {
        return Err(match known.frozen_at_ms {
            Some(since_ms) => Refusal::Frozen { since_ms },
            None => Refusal::VaultKnown,
        }
        .into());
    }
    record.used_at_ms = Some(now_ms);
    record.used_by = Some(request.vault_id);
    state.put_secret(&record)?;
    state.put_vault(&VaultRecord::founded(request.vault_id, now_ms))?;
    mint(state, gateway, request, token, 1, now_ms)
}

/// A claim moves the writer to the next epoch, signed by the vault's
/// identity key over a fresh nonce, and only while the head is the one the
/// claimer checked. Signature first, so only the key's holder learns the
/// epoch and the head. **A takeover leaves no live older token**: every
/// token of the vault, reads included, is deleted and leaves a tombstone;
/// every held delete is lifted; the claim is kept to be carried by `MOVED`;
/// the counters start again.
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
    if let Some(since_ms) = vault.frozen_at_ms {
        return Err(Refusal::Frozen { since_ms }.into());
    }
    let head = state.head(&request.vault_id)?;
    let claim_now = standing_claim(state, &request.vault_id)?;
    let head_view = head.map(|head| Box::new(view(&head, claim_now)));
    if vault.writer_epoch.checked_add(1) != Some(claim.epoch) {
        return Err(Refusal::EpochConflict {
            epoch: vault.writer_epoch,
            head: head_view.clone(),
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
    for old in state.take_tokens(&request.vault_id)? {
        state.put_revoked(&RevokedToken {
            hash: old.hash,
            vault: old.vault,
            epoch: old.epoch,
            revoked_at_ms: now_ms,
        })?;
    }
    state.trim_revoked(&request.vault_id, MAX_REVOKED_PER_VAULT)?;
    state.clear_holds(&request.vault_id)?;
    state.put_claim(&ClaimRecord {
        vault: request.vault_id,
        epoch: claim.epoch,
        head_seen: claim.head_seen,
        nonce: request.nonce,
        signature: claim.signature,
        claimed_at_ms: now_ms,
    })?;
    vault.writer_epoch = claim.epoch;
    vault.moved_at_ms = Some(now_ms);
    vault.generation = 0;
    vault.writes = 0;
    state.put_vault(&vault)?;
    mint(state, gateway, request, token, claim.epoch, now_ms)
}

/// A read grant: a token at epoch 0, which reads and never writes. It
/// answers while a vault is frozen.
fn grant_read<S: State>(
    state: &mut S,
    gateway: GatewayId,
    request: &PairRequest,
    token: &Token,
    now_ms: i64,
) -> Result<Paired, Fault> {
    state
        .vault(&request.vault_id)?
        .ok_or(Refusal::Unauthorized)?;
    mint(state, gateway, request, token, READ_EPOCH, now_ms)
}

/// Mint a token. Its kind and its epoch must agree — a read at 0, a secret
/// at 1, a claim at 2 or more — and a rule that would mint otherwise has a
/// bug, which is a fault and never a token.
fn mint<S: State>(
    state: &mut S,
    gateway: GatewayId,
    request: &PairRequest,
    token: &Token,
    epoch: u64,
    now_ms: i64,
) -> Result<Paired, Fault> {
    let agrees = match request.kind {
        PairKind::Read => epoch == READ_EPOCH,
        PairKind::Secret => epoch == 1,
        PairKind::Claim => epoch >= 2,
    };
    if !agrees {
        return Err(crate::rules::state::StoreFault::new("a token kind and epoch disagree").into());
    }
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
