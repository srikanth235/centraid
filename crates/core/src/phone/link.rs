//! THE LINK TO A GATEWAY (#1080 rulings 1, 7): the phone's pinned HTTPS
//! client, and the backup plane's [`Store`] over it.
//!
//! `centraid_vault::backup` is written against one synchronous trait so the
//! snapshot, the mover, retention and restore run unchanged against the real
//! gateway and against `MemoryStore`. [`GatewayStore`] is that trait over
//! `centraid_gateway::client::Client`, driven on the core's own runtime
//! (`Handle::runtime_handle`): every call is one `block_on` from the thread
//! the shell called the core on, which is never a runtime worker.
//!
//! # WHAT A REFUSAL BECOMES
//!
//! The plane acts on five answers by shape, not by code: `MOVED` is
//! [`StoreError::Moved`] (this phone is no longer the vault's writer) **only
//! with a claim that verifies under the vault key and is above the epoch this
//! phone holds** (#1191, E4) — otherwise it is a refusal like any other,
//! `HEAD_CONFLICT` is [`StoreError::HeadConflict`], `NOT_FOUND` is
//! [`StoreError::Missing`], `NO_HEAD` is a `head()` of `None`, and the
//! gateway's own fault (`INTERNAL`) is [`StoreError::Unreachable`], retried
//! later. `NAME_TAKEN` carries the digest the gateway holds and the name's
//! state, and is an acknowledgement only when that digest is the one sent
//! (decision 30). Every other code is a [`Refusal`] by its spelling.
//!
//! # EVERY HEAD, DELETE AND UNDO IS SIGNED
//!
//! By the vault's identity key, at the next generation after everything this
//! store sent or saw standing (E1, E3). One `OUT_OF_ORDER` takes the standing
//! generation as the floor and signs once more; one `CLOCK_AHEAD` signs the
//! head again at the gateway's clock. The token lives in the shell's device
//! secret store and reaches the core in memory (E12).
//!
//! Two failures are not an absent gateway, and are kept apart from one (#1080,
//! the audit's finding 5): a certificate that is not the pinned one, or a
//! gateway that answers as another, is [`StoreError::Untrusted`] — the machine
//! that answered is not the gateway the member paired, and nothing is sent to
//! it; bytes that do not hash to the digest they came with are
//! [`StoreError::Damaged`] — the copy on the gateway did not open. A phone
//! away from home waits; these two are the member's to hear about.
//!
//! # A PART IS SENT FROM MEMORY OR FROM ITS SPOOL FILE
//!
//! A bundle — ranges and derivatives, up to 256 MiB — streams from the spool
//! files the mover names, never held whole. A single part arrives as a reader,
//! which this store reads whole before the `PUT`: a part is at most 64 MiB of
//! plaintext sealed, the protocol caps an object at 80 MiB, and one part in
//! memory at a time is what a phone can afford where a whole film is not.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use centraid_gateway::client::{Client, ClientError, Destination as Pinned, Part, Source};
use centraid_gateway::rules::code::Refusal as WireRefusal;
use centraid_gateway::rules::ids::{
    Digest as WireDigest, GatewayId, Name as WireName, Token, VaultId,
};
use centraid_gateway::rules::limits::MAX_OBJECT_BYTES;
use centraid_gateway::rules::signing::{
    HeadFields, sign_check, sign_delete, sign_head, sign_undo, verify_claim,
};
use centraid_gateway::rules::wire::{
    CheckRequest, CheckState, ClaimView, DeleteRequest, HeadView, HeldKind as WireHeldKind, Info,
    NameState as WireState, SetHead, UndoRequest,
};
use centraid_vault::backup::naming::{Digest, Name};
use centraid_vault::backup::state::{DeviceState, Gateway, Reach};
use centraid_vault::backup::store::{
    Deleted, Head, HeldEntry, HeldKind, NameCheck, NameState, ObjectEntry, Outgoing, PartAnswer,
    Put, Refusal, SnapshotEntry, Store, StoreError,
};

use crate::error::{CoreError, Result};

/// The plane's name as the protocol's: both are the same 32 bytes.
pub(crate) fn wire_name(name: &Name) -> WireName {
    WireName::from_bytes(*name.as_bytes())
}

fn plane_name(name: &WireName) -> Name {
    Name::from_bytes(*name.as_bytes())
}

fn wire_digest(digest: &Digest) -> WireDigest {
    WireDigest::from_bytes(*digest.as_bytes())
}

fn plane_digest(digest: &WireDigest) -> Digest {
    Digest::from_bytes(*digest.as_bytes())
}

fn unsigned(ms: i64) -> u64 {
    u64::try_from(ms).unwrap_or(0)
}

fn signed(ms: u64) -> i64 {
    i64::try_from(ms).unwrap_or(i64::MAX)
}

const fn plane_state(state: WireState) -> NameState {
    match state {
        WireState::Live => NameState::Live,
        WireState::Held => NameState::Held,
        WireState::Damaged => NameState::Damaged,
    }
}

fn head_of(view: &HeadView) -> Head {
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

/// A gateway id in its one spelling, 32 lower-case hex, as the protocol's.
///
/// # Errors
/// [`CoreError::Invariant`] for a row whose id will not read.
pub(crate) fn gateway_of(gateway_id: &str) -> Result<GatewayId> {
    let bytes: [u8; 16] = hex::decode(gateway_id)
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or_else(|| CoreError::Invariant {
            context: format!("gateway id {gateway_id} is not 32 hex characters"),
        })?;
    Ok(GatewayId::from_bytes(bytes))
}

/// The client's failures that need no key to judge. `MOVED` is judged by
/// [`GatewayStore::store_error`], which holds the key; here it is a refusal
/// by its code, never a takeover.
fn plain_error(error: ClientError) -> StoreError {
    match error {
        ClientError::Refused(WireRefusal::HeadConflict { head, .. }) => StoreError::HeadConflict {
            current: head.as_deref().map(head_of),
        },
        ClientError::Refused(WireRefusal::NotFound { name: Some(name) }) => {
            StoreError::Missing(plane_name(&name))
        }
        ClientError::Refused(WireRefusal::NameTaken { digest, state }) => {
            StoreError::Refused(Refusal::NameTaken {
                held: plane_digest(&digest),
                state: plane_state(state),
            })
        }
        ClientError::Refused(refusal) => {
            StoreError::Refused(Refusal::from_code(refusal.code().as_str()))
        }
        ClientError::GatewayFault => {
            StoreError::Unreachable("INTERNAL: the gateway's own store failed".to_owned())
        }
        ClientError::Unreachable(detail) => StoreError::Unreachable(detail),
        ClientError::Untrusted => {
            StoreError::Untrusted("the machine that answered is not the pinned gateway".to_owned())
        }
        // AN ANSWER THE VAULT KEY DID NOT SIGN is a gateway that lies: the
        // pass to it stops as refused, and nothing it said is believed (E4).
        ClientError::Unverified(what) => {
            StoreError::Refused(Refusal::Other(format!("UNVERIFIED {what}")))
        }
        ClientError::GatewayTooOld { found, required } => StoreError::GatewayOld {
            found: u64::from(found),
            required: u64::from(required),
        },
        ClientError::Damaged(detail) => StoreError::Damaged(detail),
        ClientError::Protocol(detail) => {
            StoreError::Unreachable(format!("the gateway's answer broke the protocol: {detail}"))
        }
        ClientError::NoToken => StoreError::Refused(Refusal::Unauthorized),
        ClientError::Io(error) => StoreError::Io(error),
    }
}

/// One paired gateway's object and head routes, for one vault, under the
/// token the shell keeps for it, **signing every head, delete and undo with
/// the vault's identity key** (E1) and believing a `MOVED` only with a claim
/// that verifies and is above the epoch held (E4).
pub struct GatewayStore {
    client: Client,
    vault: VaultId,
    gateway_id: String,
    gateway: GatewayId,
    identity: ed25519_dalek::SigningKey,
    /// The writer epoch this phone's token there was minted at.
    epoch: u64,
    /// The last generation sent or seen standing (E3).
    generation: AtomicU64,
    runtime: tokio::runtime::Handle,
    cancellation: Option<crate::handle::Cancellation>,
}

impl GatewayStore {
    /// The store for a paired gateway row, trusting its certificate by its
    /// exact bytes and writing under `token`.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] for a row whose id will not read.
    pub fn for_gateway(
        row: &Gateway,
        token: Token,
        identity: &ed25519_dalek::SigningKey,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self> {
        Self::over(
            Client::new(&Pinned {
                addrs: row.addrs.clone(),
                cert_der: row.cert_der.clone(),
                token,
            }),
            identity,
            row.gateway_id.clone(),
            row.epoch,
            row.generation,
            runtime,
        )
    }

    /// The store over a client already made: a restore's, which reads under a
    /// read grant before it claims, or a claim's, which writes at `epoch`.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] for an id that will not read.
    pub fn over(
        client: Client,
        identity: &ed25519_dalek::SigningKey,
        gateway_id: String,
        epoch: u64,
        generation: u64,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self> {
        Ok(Self {
            client,
            vault: VaultId::from_bytes(identity.verifying_key().to_bytes()),
            gateway: gateway_of(&gateway_id)?,
            gateway_id,
            identity: identity.clone(),
            epoch,
            generation: AtomicU64::new(generation),
            runtime: runtime.clone(),
            cancellation: None,
        })
    }

    pub(crate) fn set_cancellation(&mut self, cancellation: Option<crate::handle::Cancellation>) {
        // A STOP IS OBSERVED WHILE A CALL WAITS, not only between calls: the client looks at it
        // every quarter second of a stalled transfer.
        self.client.set_stop(
            cancellation.clone().map(|held| {
                Arc::new(move || held.check().is_err()) as centraid_gateway::client::Stop
            }),
        );
        self.cancellation = cancellation;
    }

    pub(crate) fn checkpoint(&self) -> Result<()> {
        self.cancellation
            .as_ref()
            .map_or(Ok(()), crate::handle::Cancellation::check)
    }

    fn check_transfer(&self) -> std::result::Result<(), StoreError> {
        self.checkpoint().map_err(|error| {
            StoreError::Io(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                error.to_string(),
            ))
        })
    }

    /// The client underneath, for the routes the plane's trait does not name:
    /// a handoff's presigned `PUT`.
    #[must_use]
    pub const fn client(&self) -> &Client {
        &self.client
    }

    /// The vault this store writes.
    #[must_use]
    pub const fn vault(&self) -> &VaultId {
        &self.vault
    }

    /// A claim made this phone the writer here: write at `epoch` under the
    /// token it minted, from generation zero (E3).
    pub(crate) fn claimed(&mut self, token: Token, epoch: u64) {
        self.client.set_token(token);
        self.epoch = epoch;
        self.generation.store(0, Ordering::SeqCst);
    }

    /// The epoch this store writes at.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// **A `MOVED` IS BELIEVED ONLY WITH PROOF** (E4): its claim must verify
    /// under this vault's key for this gateway, and be above the epoch this
    /// phone holds. Anything less is the gateway refusing for another reason
    /// (`refused_other`), and nothing is recorded as a takeover.
    fn store_error(&self, error: ClientError) -> StoreError {
        match error {
            ClientError::Refused(WireRefusal::Moved { claim, .. }) => {
                if self.believes(&claim) {
                    StoreError::Moved { epoch: claim.epoch }
                } else {
                    StoreError::Refused(Refusal::Other("MOVED".to_owned()))
                }
            }
            other => plain_error(other),
        }
    }

    fn believes(&self, claim: &ClaimView) -> bool {
        claim.epoch > self.epoch
            && verify_claim(
                &self.gateway,
                &self.vault,
                claim.epoch,
                claim.head_seen.as_ref(),
                &claim.nonce,
                &claim.signature,
            )
    }

    /// `NOT_FOUND` naming nothing, from a call about `name`, is `name` missing.
    fn missing_or(&self, name: &Name, error: ClientError) -> StoreError {
        match error {
            ClientError::Refused(WireRefusal::NotFound { name: None }) => {
                StoreError::Missing(*name)
            }
            other => self.store_error(other),
        }
    }

    /// The next generation to sign at, after everything sent or seen.
    fn next_generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst).saturating_add(1)
    }

    /// A signed record went through at `generation`, or the gateway said one
    /// stands there: never sign at or below it again.
    fn saw_generation(&self, generation: u64) {
        self.generation.fetch_max(generation, Ordering::SeqCst);
    }

    /// `OUT_OF_ORDER` told what stands: take it as the floor, so the one
    /// retry signs above it (E3).
    fn absorb_out_of_order(&self, error: &ClientError) -> bool {
        if let ClientError::Refused(WireRefusal::OutOfOrder {
            epoch, generation, ..
        }) = error
            && *epoch == self.epoch
        {
            self.saw_generation(*generation);
            return true;
        }
        false
    }

    /// `GET /v3/info`: whether the gateway answers at all, and its clock.
    ///
    /// # Errors
    /// [`StoreError::Unreachable`] when it does not;
    /// [`StoreError::Untrusted`] when the machine that answered is not the
    /// pinned one, or answers as another gateway than the one paired;
    /// [`StoreError::GatewayOld`] below the required protocol.
    pub fn info(&self) -> std::result::Result<Info, StoreError> {
        self.check_transfer()?;
        self.runtime.block_on(self.probe())
    }

    /// [`Self::info`] as a future, for a fleet asked all at once.
    pub(crate) async fn probe(&self) -> std::result::Result<Info, StoreError> {
        let info = self.client.info().await.map_err(plain_error)?;
        if info.gateway_id.hex() != self.gateway_id {
            return Err(StoreError::Untrusted(format!(
                "the gateway answered as {}, not as the paired {}",
                info.gateway_id, self.gateway_id
            )));
        }
        Ok(info)
    }

    /// The writer epoch and the head this gateway holds, **both verified**
    /// under the vault key (E2, E4): the epoch is the greater of the head's
    /// and the standing claim's. What a pass asks first.
    ///
    /// # Errors
    /// [`StoreError`] by the client's failure; an unsigned answer is refused.
    pub fn head_and_epoch(&self) -> std::result::Result<(u64, Option<Head>), StoreError> {
        self.check_transfer()?;
        let state = self
            .runtime
            .block_on(self.client.head_state(&self.vault, &self.gateway))
            .map_err(|error| self.store_error(error))?;
        let head = state.head.as_ref().map(head_of);
        if let Some(head) = &head
            && head.epoch == self.epoch
        {
            self.saw_generation(head.generation);
        }
        Ok((state.epoch, head))
    }

    fn signed_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: i64,
        writes: u64,
    ) -> SetHead {
        let generation = self.next_generation();
        let fields = HeadFields {
            epoch: self.epoch,
            generation,
            writes,
            taken_at_ms,
            manifest: wire_name(name),
            prev: prev.map(wire_name),
        };
        SetHead {
            name: wire_name(name),
            prev: prev.map(wire_name),
            taken_at_ms,
            generation,
            writes,
            signature: sign_head(&self.identity, &self.gateway, &fields),
        }
    }
}

impl Store for GatewayStore {
    fn gateway_id(&self) -> &str {
        &self.gateway_id
    }

    fn exists(&self, names: &[Name]) -> std::result::Result<Vec<Name>, StoreError> {
        self.check_transfer()?;
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let missing = self
            .runtime
            .block_on(self.client.exists(&self.vault, &asked))
            .map_err(|error| self.store_error(error))?;
        Ok(missing.iter().map(plane_name).collect())
    }

    fn put(
        &self,
        name: &Name,
        digest: &Digest,
        len: u64,
        body: &mut dyn Read,
    ) -> std::result::Result<Put, StoreError> {
        self.check_transfer()?;
        if len > MAX_OBJECT_BYTES {
            return Err(StoreError::Refused(Refusal::TooLarge));
        }
        let mut bytes = Vec::with_capacity(usize::try_from(len).unwrap_or(0));
        body.take(len.saturating_add(1)).read_to_end(&mut bytes)?;
        if bytes.len() as u64 != len {
            return Err(StoreError::Refused(Refusal::DigestMismatch));
        }
        let answer = self.runtime.block_on(self.client.put(
            &self.vault,
            &wire_name(name),
            &wire_digest(digest),
            bytes,
        ));
        match answer {
            Ok(centraid_gateway::client::Put::Stored(_)) => Ok(Put::Stored),
            Ok(centraid_gateway::client::Put::AlreadyStored(_)) => Ok(Put::AlreadyStored),
            // THE PHONE'S OWN BYTES UNDER THE NAME are stored; anything else
            // is not, and the caller is told what holds the name (decision 30).
            Ok(taken @ centraid_gateway::client::Put::NameTaken { held, state, .. }) => {
                if taken.acknowledged() {
                    Ok(Put::AlreadyStored)
                } else {
                    Err(StoreError::Refused(Refusal::NameTaken {
                        held: plane_digest(&held),
                        state: plane_state(state),
                    }))
                }
            }
            Err(error) => Err(self.store_error(error)),
        }
    }

    fn put_many(
        &self,
        parts: &[Outgoing],
    ) -> std::result::Result<Vec<(Name, PartAnswer)>, StoreError> {
        self.check_transfer()?;
        let sent: Vec<Part> = parts
            .iter()
            .map(|part| Part {
                name: wire_name(&part.name),
                digest: wire_digest(&part.digest),
                source: Source::File(part.path.clone()),
            })
            .collect();
        let answer = self
            .runtime
            .block_on(self.client.bundle_parts(&self.vault, sent))
            .map_err(|error| self.store_error(error))?;
        let sent_digest: BTreeMap<Name, Digest> =
            parts.iter().map(|part| (part.name, part.digest)).collect();
        let mut out: Vec<(Name, PartAnswer)> = Vec::with_capacity(parts.len());
        out.extend(
            answer
                .stored
                .iter()
                .map(|name| (plane_name(name), Ok(Put::Stored))),
        );
        out.extend(
            answer
                .already
                .iter()
                .map(|name| (plane_name(name), Ok(Put::AlreadyStored))),
        );
        out.extend(answer.refused.iter().map(|refused| {
            let name = plane_name(&refused.name);
            let refusal = match (refused.digest, refused.state) {
                (Some(held), state) if refused.code.as_str() == "NAME_TAKEN" => {
                    let held = plane_digest(&held);
                    if sent_digest.get(&name) == Some(&held) {
                        return (name, Ok(Put::AlreadyStored));
                    }
                    Refusal::NameTaken {
                        held,
                        state: plane_state(state.unwrap_or(WireState::Live)),
                    }
                }
                _ => Refusal::from_code(refused.code.as_str()),
            };
            (name, Err(refusal))
        }));
        // IN THE ORDER SENT, as the trait promises: the answer groups by
        // outcome, and a caller pairing answers with parts reads them in order.
        let order: BTreeMap<Name, usize> = parts
            .iter()
            .enumerate()
            .map(|(index, part)| (part.name, index))
            .collect();
        out.sort_by_key(|(name, _)| order.get(name).copied().unwrap_or(usize::MAX));
        Ok(out)
    }

    fn get(&self, name: &Name, sink: &mut dyn Write) -> std::result::Result<u64, StoreError> {
        self.check_transfer()?;
        let bytes = self
            .runtime
            .block_on(self.client.get(&self.vault, &wire_name(name), None))
            .map_err(|error| self.missing_or(name, error))?;
        self.check_transfer()?;
        sink.write_all(&bytes)?;
        Ok(bytes.len() as u64)
    }

    fn get_range(
        &self,
        name: &Name,
        offset: u64,
        len: Option<u64>,
        sink: &mut dyn Write,
    ) -> std::result::Result<u64, StoreError> {
        self.check_transfer()?;
        let range = centraid_gateway::rules::range::ByteRange {
            first: offset,
            last: len.map(|len| offset.saturating_add(len).saturating_sub(1)),
        };
        let bytes = self
            .runtime
            .block_on(self.client.get(&self.vault, &wire_name(name), Some(range)))
            .map_err(|error| match error {
                ClientError::Refused(WireRefusal::BadRange { .. }) => {
                    StoreError::Io(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "the object is shorter than the range asked",
                    ))
                }
                other => self.missing_or(name, other),
            })?;
        self.check_transfer()?;
        sink.write_all(&bytes)?;
        Ok(bytes.len() as u64)
    }

    fn get_many(
        &self,
        names: &[Name],
        each: &mut dyn FnMut(&Name, &[u8]) -> std::io::Result<()>,
    ) -> std::result::Result<usize, StoreError> {
        self.check_transfer()?;
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        self.runtime
            .block_on(self.client.fetch_each(&self.vault, &asked, |frame| {
                self.checkpoint().map_err(std::io::Error::other)?;
                each(&plane_name(&frame.name), &frame.bytes)
            }))
            .map_err(|error| self.store_error(error))
    }

    fn head(&self) -> std::result::Result<Option<Head>, StoreError> {
        Ok(self.head_and_epoch()?.1)
    }

    fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    /// Signed at the next generation. One `OUT_OF_ORDER` takes the standing
    /// generation as the floor and signs again; one `CLOCK_AHEAD` signs
    /// again at the gateway's clock (E3, E14). A second of either is the
    /// refusal.
    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: u64,
        writes: u64,
    ) -> std::result::Result<Head, StoreError> {
        self.check_transfer()?;
        let mut taken_at = signed(taken_at_ms);
        let mut retried = false;
        loop {
            let request = self.signed_head(name, prev, taken_at, writes);
            match self
                .runtime
                .block_on(self.client.set_head(&self.vault, &request))
            {
                Ok(view) => {
                    self.saw_generation(view.generation);
                    return Ok(head_of(&view));
                }
                Err(error) if !retried && self.absorb_out_of_order(&error) => retried = true,
                Err(ClientError::Refused(WireRefusal::ClockAhead { skew_ms })) if !retried => {
                    taken_at = taken_at.saturating_sub(skew_ms);
                    retried = true;
                }
                Err(error) => return Err(self.missing_or(name, error)),
            }
        }
    }

    fn snapshots(&self) -> std::result::Result<Vec<SnapshotEntry>, StoreError> {
        self.check_transfer()?;
        let views = self
            .runtime
            .block_on(self.client.snapshots_all(&self.vault))
            .map_err(|error| self.store_error(error))?;
        let mut entries: Vec<SnapshotEntry> = views
            .iter()
            .map(|view| SnapshotEntry {
                name: plane_name(&view.name),
                taken_at_ms: unsigned(view.taken_at_ms),
                registered_at_ms: unsigned(view.registered_at_ms),
                held_at_ms: view.held_at_ms.map(unsigned),
                purge_after_ms: view.purge_after_ms.map(unsigned),
            })
            .collect();
        entries.sort_by_key(|entry| (entry.taken_at_ms, entry.name));
        Ok(entries)
    }

    fn list(
        &self,
        after: Option<&Name>,
        limit: usize,
    ) -> std::result::Result<Vec<ObjectEntry>, StoreError> {
        self.check_transfer()?;
        let after = after.map(wire_name);
        let entries = self
            .runtime
            .block_on(self.client.objects(&self.vault, after.as_ref(), limit))
            .map_err(|error| self.store_error(error))?;
        Ok(entries
            .iter()
            .map(|entry| ObjectEntry {
                name: plane_name(&entry.name),
                size: entry.size,
                digest: plane_digest(&entry.digest),
                stored_at_ms: unsigned(entry.stored_at_ms),
            })
            .collect())
    }

    /// Signed at the next generation, retried once above an `OUT_OF_ORDER`.
    fn delete(&self, names: &[Name]) -> std::result::Result<Deleted, StoreError> {
        self.check_transfer()?;
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let mut retried = false;
        let answer = loop {
            let generation = self.next_generation();
            let request = DeleteRequest {
                names: asked.clone(),
                generation,
                signature: sign_delete(
                    &self.identity,
                    &self.gateway,
                    self.epoch,
                    generation,
                    &asked,
                ),
            };
            match self
                .runtime
                .block_on(self.client.delete(&self.vault, &request))
            {
                Ok(answer) => {
                    self.saw_generation(generation);
                    break answer;
                }
                Err(error) if !retried && self.absorb_out_of_order(&error) => retried = true,
                Err(error) => return Err(self.store_error(error)),
            }
        };
        Ok(Deleted {
            deleted: answer.deleted.iter().map(plane_name).collect(),
            freed: answer.freed.iter().map(plane_name).collect(),
            refused: answer
                .refused
                .iter()
                .map(|refused| {
                    (
                        plane_name(&refused.name),
                        Refusal::from_code(refused.code.as_str()),
                    )
                })
                .collect(),
        })
    }

    fn check_name(&self, name: &Name) -> std::result::Result<NameCheck, StoreError> {
        self.check_transfer()?;
        let asked = wire_name(name);
        let mut retried = false;
        let answer = loop {
            let generation = self.next_generation();
            let request = CheckRequest {
                name: asked,
                generation,
                signature: sign_check(
                    &self.identity,
                    &self.gateway,
                    self.epoch,
                    generation,
                    &asked,
                ),
            };
            match self
                .runtime
                .block_on(self.client.check(&self.vault, &request))
            {
                Ok(answer) => {
                    self.saw_generation(generation);
                    break answer;
                }
                Err(error) if !retried && self.absorb_out_of_order(&error) => retried = true,
                Err(error) => return Err(self.store_error(error)),
            }
        };
        Ok(match answer.state {
            CheckState::Intact => NameCheck::Intact,
            CheckState::Damaged => NameCheck::Damaged,
            CheckState::Missing => NameCheck::Missing,
        })
    }

    fn held(
        &self,
        after: Option<&Name>,
        limit: usize,
    ) -> std::result::Result<Vec<HeldEntry>, StoreError> {
        self.check_transfer()?;
        let after = after.map(wire_name);
        let entries = self
            .runtime
            .block_on(self.client.held(&self.vault, after.as_ref(), limit))
            .map_err(|error| self.store_error(error))?;
        Ok(entries
            .iter()
            .map(|entry| HeldEntry {
                name: plane_name(&entry.name),
                size: entry.size,
                digest: plane_digest(&entry.digest),
                kind: match entry.kind {
                    WireHeldKind::Object => HeldKind::Object,
                    WireHeldKind::Snapshot => HeldKind::Snapshot,
                },
                held_at_ms: unsigned(entry.held_at_ms),
                purge_after_ms: unsigned(entry.purge_after_ms),
            })
            .collect())
    }

    /// Signed at the next generation, retried once above an `OUT_OF_ORDER`.
    fn undo(&self, names: Option<&[Name]>) -> std::result::Result<u64, StoreError> {
        self.check_transfer()?;
        let asked: Option<Vec<WireName>> = names.map(|names| names.iter().map(wire_name).collect());
        let mut retried = false;
        loop {
            let generation = self.next_generation();
            let request = UndoRequest {
                names: asked.clone(),
                generation,
                signature: sign_undo(
                    &self.identity,
                    &self.gateway,
                    self.epoch,
                    generation,
                    asked.as_deref(),
                ),
            };
            match self
                .runtime
                .block_on(self.client.undo(&self.vault, &request))
            {
                Ok(undone) => {
                    self.saw_generation(generation);
                    return Ok(undone.undone);
                }
                Err(error) if !retried && self.absorb_out_of_order(&error) => retried = true,
                Err(error) => return Err(self.store_error(error)),
            }
        }
    }
}

/// The gateway tokens the shell handed the core, by gateway id (#1191, E12):
/// kept in memory, never written.
pub type Tokens = BTreeMap<String, Token>;

/// A gateway that answered, and the store to it.
pub struct Reached {
    pub gateway: Gateway,
    pub store: GatewayStore,
    /// The gateway's clock when it answered: what a `MOVED` heard in this pass
    /// is dated by, since the refusal itself carries no time a client reads.
    pub gateway_ms: i64,
}

/// Why no gateway was reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unreached {
    /// None answered, or none is paired.
    Silent,
    /// None that answered is the gateway this phone pinned: a machine with
    /// another certificate, or a gateway answering as another.
    Untrusted,
}

/// The first of `gateways`, in pairing order, that answers `info` as itself: the head of
/// [`reach_all`]'s fleet. When none does, whether any machine answered that is not the pinned
/// gateway.
///
/// # Errors
/// The device state's refusal.
pub fn reach(
    gateways: &[Gateway],
    state: &DeviceState,
    tokens: &Tokens,
    identity: &ed25519_dalek::SigningKey,
    runtime: &tokio::runtime::Handle,
) -> Result<std::result::Result<Reached, Unreached>> {
    let fleet = reach_all(gateways, state, tokens, identity, runtime)?;
    let unreached = if fleet.untrusted.is_empty() {
        Unreached::Silent
    } else {
        Unreached::Untrusted
    };
    Ok(fleet.reached.into_iter().next().ok_or(unreached))
}

/// Every paired gateway a pass found: those that answered as themselves, and for the rest
/// whether they were silent or another machine answered. Every paired gateway is fed in a pass
/// (#1188, B1), so none is skipped for another having answered.
pub struct Fleet {
    /// Pairing order, a gateway that refused this phone's token last.
    pub reached: Vec<Reached>,
    pub silent: Vec<String>,
    pub untrusted: Vec<String>,
    /// Gateways the shell handed no token for (E12): they are marked to pair again and left out.
    pub pair_again: Vec<String>,
}

/// The one cap on asking a fleet whether it is there: a dead gateway costs this much of a pass
/// and no more, whatever its addresses and however many gateways are paired.
pub const REACH_CAP: std::time::Duration = std::time::Duration::from_secs(12);

/// How one gateway answered a probe.
enum Probe {
    Answered(i64),
    Untrusted,
    Old,
    Silent,
}

/// Ask every gateway `info` **at once**, under one overall cap ([`REACH_CAP`]): a gateway
/// that is asleep costs the cap, not a turn in a queue the healthy one waits in. A gateway
/// this phone was superseded at is left out (its writes are refused and its reads have nothing
/// a pass needs), and so is one the shell holds no token for (it is marked to pair again).
///
/// # Errors
/// The device state's refusal.
pub fn reach_all(
    gateways: &[Gateway],
    state: &DeviceState,
    tokens: &Tokens,
    identity: &ed25519_dalek::SigningKey,
    runtime: &tokio::runtime::Handle,
) -> Result<Fleet> {
    reach_all_capped(gateways, state, tokens, identity, runtime, REACH_CAP)
}

/// [`reach_all`] under `cap`, for a test that does not wait for the product's.
///
/// # Errors
/// As [`reach_all`].
pub fn reach_all_capped(
    gateways: &[Gateway],
    state: &DeviceState,
    tokens: &Tokens,
    identity: &ed25519_dalek::SigningKey,
    runtime: &tokio::runtime::Handle,
    cap: std::time::Duration,
) -> Result<Fleet> {
    let mut fleet = Fleet {
        reached: Vec::new(),
        silent: Vec::new(),
        untrusted: Vec::new(),
        pair_again: Vec::new(),
    };
    let mut ordered: Vec<&Gateway> = gateways
        .iter()
        .filter(|gateway| gateway.reach != Reach::Moved)
        .collect();
    ordered.sort_by_key(|gateway| gateway.reach == Reach::PairAgain);
    let mut asking: Vec<(&Gateway, GatewayStore)> = Vec::new();
    for gateway in ordered {
        let Some(token) = tokens.get(&gateway.gateway_id) else {
            // NO TOKEN HELD (E12): the shell's secret store lost it, or never had it. The row says to
            // pair again; opening and every other door go on.
            state
                .set_reach(&gateway.gateway_id, Reach::PairAgain, super::now_ms())
                .map_err(super::plane_error)?;
            fleet.pair_again.push(gateway.gateway_id.clone());
            continue;
        };
        asking.push((
            gateway,
            GatewayStore::for_gateway(gateway, *token, identity, runtime)?,
        ));
    }
    let answers = runtime.block_on(probe_all(
        asking.iter().map(|(_, store)| store.probe()),
        cap,
    ));
    for ((gateway, store), answer) in asking.into_iter().zip(answers) {
        match answer {
            Probe::Answered(time_ms) => {
                state
                    .touch_seen(&gateway.gateway_id, super::now_ms())
                    .map_err(super::plane_error)?;
                fleet.reached.push(Reached {
                    gateway: gateway.clone(),
                    store,
                    gateway_ms: time_ms,
                });
            }
            Probe::Untrusted => {
                tracing::warn!(
                    gateway = %gateway.gateway_id,
                    "a machine that is not the pinned gateway answered"
                );
                fleet.untrusted.push(gateway.gateway_id.clone());
            }
            Probe::Old | Probe::Silent => {
                tracing::debug!(gateway = %gateway.gateway_id, "a paired gateway did not answer, or is older than this build");
                fleet.silent.push(gateway.gateway_id.clone());
            }
        }
    }
    Ok(fleet)
}

/// Run every probe together, each under `cap`, and answer in the order given. A probe that
/// has not answered when the cap passes is silent.
async fn probe_all<F>(probes: impl IntoIterator<Item = F>, cap: std::time::Duration) -> Vec<Probe>
where
    F: std::future::Future<Output = std::result::Result<Info, StoreError>>,
{
    type Running<'a> = std::pin::Pin<Box<dyn std::future::Future<Output = Probe> + 'a>>;
    let mut running: Vec<(Running<'_>, Option<Probe>)> = probes
        .into_iter()
        .map(|probe| {
            let capped: Running<'_> = Box::pin(async move {
                match tokio::time::timeout(cap, probe).await {
                    Ok(Ok(info)) => Probe::Answered(info.time_ms),
                    Ok(Err(StoreError::Untrusted(_))) => Probe::Untrusted,
                    Ok(Err(StoreError::GatewayOld { .. })) => Probe::Old,
                    Ok(Err(_)) | Err(_) => Probe::Silent,
                }
            });
            (capped, None)
        })
        .collect();
    std::future::poll_fn(|context| {
        let mut all = true;
        for (probe, answer) in &mut running {
            if answer.is_none() {
                match probe.as_mut().poll(context) {
                    std::task::Poll::Ready(done) => *answer = Some(done),
                    std::task::Poll::Pending => all = false,
                }
            }
        }
        if all {
            std::task::Poll::Ready(())
        } else {
            std::task::Poll::Pending
        }
    })
    .await;
    running
        .into_iter()
        .map(|(_, answer)| answer.unwrap_or(Probe::Silent))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(time_ms: i64) -> std::result::Result<Info, StoreError> {
        Ok(Info {
            gateway_id: centraid_gateway::rules::ids::GatewayId::from_bytes([1; 16]),
            protocol: 3,
            time_ms,
        })
    }

    /// **A DEAD GATEWAY COSTS A PASS THE CAP, NOT A TURN THE HEALTHY ONES WAIT IN** (#1188,
    /// item 15). The two healthy probes finish only when both are running at once (a barrier of
    /// two), so asking one after another can never answer them; the dead one waits for ever and
    /// is capped. The clock is tokio's paused one: nothing sleeps and no number of seconds is
    /// asserted.
    #[tokio::test(start_paused = true)]
    async fn a_dead_gateway_does_not_hold_the_healthy_ones_behind_it() {
        let both = std::sync::Arc::new(tokio::sync::Barrier::new(2));
        let healthy = |time: i64| {
            let both = std::sync::Arc::clone(&both);
            async move {
                both.wait().await;
                answer(time)
            }
        };
        let dead = std::future::pending::<std::result::Result<Info, StoreError>>();
        let answers = probe_all(
            vec![
                Box::pin(dead)
                    as std::pin::Pin<
                        Box<
                            dyn std::future::Future<Output = std::result::Result<Info, StoreError>>,
                        >,
                    >,
                Box::pin(healthy(10)),
                Box::pin(healthy(20)),
            ],
            REACH_CAP,
        )
        .await;
        let shape: Vec<_> = answers
            .iter()
            .map(|probe| match probe {
                Probe::Answered(time) => format!("answered {time}"),
                Probe::Untrusted => "untrusted".to_owned(),
                Probe::Old => "old".to_owned(),
                Probe::Silent => "silent".to_owned(),
            })
            .collect();
        assert_eq!(shape, ["silent", "answered 10", "answered 20"]);
    }

    /// **A `MOVED` IS BELIEVED ONLY WITH PROOF** (#1191, E4, B3): a claim the vault key signed
    /// for this gateway, above the epoch this phone holds there. A genuine claim at or below
    /// it, one signed by another key, or one made for another gateway is a refusal like any
    /// other, never a takeover.
    #[test]
    fn a_moved_is_believed_only_with_a_signed_claim_above_the_epoch_held() {
        use centraid_gateway::rules::ids::Nonce;
        use centraid_gateway::rules::signing::sign_claim;
        let runtime = tokio::runtime::Runtime::new().expect("a runtime");
        let mine = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        let stranger = ed25519_dalek::SigningKey::from_bytes(&[8; 32]);
        let gateway = GatewayId::from_bytes([3; 16]);
        let elsewhere = GatewayId::from_bytes([4; 16]);
        let store = GatewayStore::over(
            Client::trusting(vec!["127.0.0.1:1".to_owned()], vec![1]),
            &mine,
            gateway.hex(),
            2,
            0,
            runtime.handle(),
        )
        .expect("a store");
        let nonce = Nonce::from_bytes([5; 40]);
        let moved = |key: &ed25519_dalek::SigningKey, at: &GatewayId, epoch: u64| {
            ClientError::Refused(WireRefusal::Moved {
                epoch,
                claim: Box::new(ClaimView {
                    epoch,
                    head_seen: None,
                    nonce,
                    signature: sign_claim(key, at, epoch, None, &nonce),
                }),
            })
        };
        assert!(matches!(
            store.store_error(moved(&mine, &gateway, 3)),
            StoreError::Moved { epoch: 3 }
        ));
        for (what, error) in [
            ("at the epoch held", moved(&mine, &gateway, 2)),
            ("below it", moved(&mine, &gateway, 1)),
            ("signed by another key", moved(&stranger, &gateway, 3)),
            ("made for another gateway", moved(&mine, &elsewhere, 3)),
        ] {
            assert!(
                matches!(
                    store.store_error(error),
                    StoreError::Refused(Refusal::Other(ref code)) if code == "MOVED"
                ),
                "a claim {what} moved the phone"
            );
        }
    }

    /// **A WRONG CERTIFICATE AND A DAMAGED COPY ARE NOT AN ABSENT GATEWAY**
    /// (#1080, the audit's finding 5): a phone away from home waits it out,
    /// and these two are the member's to hear about.
    #[test]
    fn a_wrong_certificate_is_untrusted_and_bytes_off_their_digest_are_damaged() {
        assert!(matches!(
            plain_error(ClientError::Untrusted),
            StoreError::Untrusted(_)
        ));
        assert!(matches!(
            plain_error(ClientError::Damaged("a flipped bit".to_owned())),
            StoreError::Damaged(_)
        ));
        assert!(matches!(
            plain_error(ClientError::Unreachable("away".to_owned())),
            StoreError::Unreachable(_)
        ));
    }
}
