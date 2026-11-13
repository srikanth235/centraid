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
//! [`StoreError::Moved`] (this phone is no longer the vault's writer),
//! `HEAD_CONFLICT` is [`StoreError::HeadConflict`], `NOT_FOUND` is
//! [`StoreError::Missing`], `NO_HEAD` is a `head()` of `None`, and the
//! gateway's own fault (`INTERNAL`) is [`StoreError::Unreachable`], retried
//! later. Every other code is a [`Refusal`] by its spelling.
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

use std::io::{Read, Write};

use std::sync::Arc;

use centraid_gateway::client::{Client, ClientError, Destination as Pinned, Part, Source};
use centraid_gateway::rules::code::Refusal as WireRefusal;
use centraid_gateway::rules::ids::{Digest as WireDigest, Name as WireName, Token, VaultId};
use centraid_gateway::rules::limits::MAX_OBJECT_BYTES;
use centraid_gateway::rules::wire::{HeadView, Info, SetHead};
use centraid_vault::backup::ledger::{Destination, Ledger};
use centraid_vault::backup::naming::{Digest, Name};
use centraid_vault::backup::store::{
    Deleted, Head, ObjectEntry, Outgoing, PartAnswer, Put, Refusal, SnapshotEntry, Store,
    StoreError,
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

fn head_of(view: &HeadView) -> Head {
    Head {
        name: plane_name(&view.name),
        taken_at_ms: unsigned(view.taken_at_ms),
        epoch: view.epoch,
        set_at_ms: unsigned(view.set_at_ms),
    }
}

/// What a client's failure is to the plane. See the module header.
fn store_error(error: ClientError) -> StoreError {
    match error {
        ClientError::Refused(WireRefusal::Moved { epoch }) => StoreError::Moved { epoch },
        ClientError::Refused(WireRefusal::HeadConflict { head, .. }) => StoreError::HeadConflict {
            current: head.as_ref().map(head_of),
        },
        ClientError::Refused(WireRefusal::NotFound { name: Some(name) }) => {
            StoreError::Missing(plane_name(&name))
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
        ClientError::Damaged(detail) => StoreError::Damaged(detail),
        ClientError::Protocol(detail) => {
            StoreError::Unreachable(format!("the gateway's answer broke the protocol: {detail}"))
        }
        ClientError::NoToken => StoreError::Refused(Refusal::Unauthorized),
        ClientError::Io(error) => StoreError::Io(error),
    }
}

/// `NOT_FOUND` naming nothing, from a call about `name`, is `name` missing.
fn missing_or(name: &Name) -> impl FnOnce(ClientError) -> StoreError + '_ {
    move |error| match error {
        ClientError::Refused(WireRefusal::NotFound { name: None }) => StoreError::Missing(*name),
        other => store_error(other),
    }
}

/// One paired destination's object and head routes, for one vault, under the
/// token the ledger keeps for it.
pub struct GatewayStore {
    client: Client,
    vault: VaultId,
    gateway_id: String,
    runtime: tokio::runtime::Handle,
    cancellation: Option<crate::handle::Cancellation>,
}

impl GatewayStore {
    /// The store for `destination`, trusting its certificate by its exact
    /// bytes and writing under its token.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] for a ledger row whose token is not 64 hex
    /// characters.
    pub fn for_destination(
        destination: &Destination,
        vault: VaultId,
        runtime: &tokio::runtime::Handle,
    ) -> Result<Self> {
        let token: Token = destination
            .token
            .parse()
            .map_err(|error| CoreError::Invariant {
                context: format!(
                    "the ledger's token for gateway {} will not read: {error}",
                    destination.gateway_id
                ),
            })?;
        Ok(Self::over(
            Client::new(&Pinned {
                addrs: destination.addrs.clone(),
                cert_der: destination.cert_der.clone(),
                token,
            }),
            vault,
            destination.gateway_id.clone(),
            runtime,
        ))
    }

    /// The store over a client already made: a restore's, which reads under a
    /// read grant before it claims.
    #[must_use]
    pub fn over(
        client: Client,
        vault: VaultId,
        gateway_id: String,
        runtime: &tokio::runtime::Handle,
    ) -> Self {
        Self {
            client,
            vault,
            gateway_id,
            runtime: runtime.clone(),
            cancellation: None,
        }
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
    /// a pairing's claim, and a handoff's presigned `PUT`.
    #[must_use]
    pub const fn client(&self) -> &Client {
        &self.client
    }

    /// The vault this store writes.
    #[must_use]
    pub const fn vault(&self) -> &VaultId {
        &self.vault
    }

    /// `GET /v2/info`: whether the gateway answers at all, and its clock.
    ///
    /// # Errors
    /// [`StoreError::Unreachable`] when it does not;
    /// [`StoreError::Untrusted`] when the machine that answered is not the
    /// pinned one, or answers as another gateway than the one paired.
    pub fn info(&self) -> std::result::Result<Info, StoreError> {
        self.check_transfer()?;
        self.runtime.block_on(self.probe())
    }

    /// [`Self::info`] as a future, for a fleet asked all at once.
    pub(crate) async fn probe(&self) -> std::result::Result<Info, StoreError> {
        let info = self.client.info().await.map_err(store_error)?;
        if info.gateway_id.hex() != self.gateway_id {
            return Err(StoreError::Untrusted(format!(
                "the gateway answered as {}, not as the paired {}",
                info.gateway_id, self.gateway_id
            )));
        }
        Ok(info)
    }

    /// The writer epoch and the head this gateway holds, in one answer: what a pass asks first
    /// (the epoch is a supersession check; the head is the rollback check).
    ///
    /// # Errors
    /// As [`Self::writer_epoch`].
    pub fn head_and_epoch(&self) -> std::result::Result<(u64, Option<Head>), StoreError> {
        self.check_transfer()?;
        self.runtime
            .block_on(self.client.head_state(&self.vault))
            .map(|state| (state.epoch, state.head.as_ref().map(head_of)))
            .map_err(store_error)
    }

    /// The vault's writer epoch at this gateway, as its head answers it — a
    /// head or `NO_HEAD`, both carry it. A token minted below it is one
    /// another phone's claim superseded.
    ///
    /// # Errors
    /// As [`Self::info`], and a refusal by its code.
    pub fn writer_epoch(&self) -> std::result::Result<u64, StoreError> {
        self.check_transfer()?;
        self.runtime
            .block_on(self.client.head_state(&self.vault))
            .map(|state| state.epoch)
            .map_err(store_error)
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
            .map_err(store_error)?;
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
            // A NAME IS A FUNCTION OF THE PLAINTEXT and sealing is salted, so
            // another digest under it is these bytes sealed again: the mover
            // records it as acknowledged (R-1080-B4).
            Ok(centraid_gateway::client::Put::NameTaken { .. }) => {
                Err(StoreError::Refused(Refusal::NameTaken))
            }
            Err(error) => Err(store_error(error)),
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
            .map_err(store_error)?;
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
            (
                plane_name(&refused.name),
                Err(Refusal::from_code(refused.code.as_str())),
            )
        }));
        // IN THE ORDER SENT, as the trait promises: the answer groups by
        // outcome, and a caller pairing answers with parts reads them in order.
        let order: std::collections::BTreeMap<Name, usize> = parts
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
            .map_err(missing_or(name))?;
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
            .map_err(store_error)
    }

    fn head(&self) -> std::result::Result<Option<Head>, StoreError> {
        self.check_transfer()?;
        let state = self
            .runtime
            .block_on(self.client.head_state(&self.vault))
            .map_err(store_error)?;
        Ok(state.head.as_ref().map(head_of))
    }

    fn set_head(
        &self,
        name: &Name,
        prev: Option<&Name>,
        taken_at_ms: u64,
    ) -> std::result::Result<Head, StoreError> {
        self.check_transfer()?;
        let request = SetHead {
            name: wire_name(name),
            prev: prev.map(wire_name),
            taken_at_ms: i64::try_from(taken_at_ms).unwrap_or(i64::MAX),
        };
        let view = self
            .runtime
            .block_on(self.client.set_head(&self.vault, &request))
            .map_err(missing_or(name))?;
        Ok(head_of(&view))
    }

    fn snapshots(&self) -> std::result::Result<Vec<SnapshotEntry>, StoreError> {
        self.check_transfer()?;
        let views = self
            .runtime
            .block_on(self.client.snapshots(&self.vault))
            .map_err(store_error)?;
        Ok(views
            .iter()
            .map(|view| SnapshotEntry {
                name: plane_name(&view.name),
                taken_at_ms: unsigned(view.taken_at_ms),
                registered_at_ms: unsigned(view.registered_at_ms),
            })
            .collect())
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
            .map_err(store_error)?;
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

    fn delete(&self, names: &[Name]) -> std::result::Result<Deleted, StoreError> {
        self.check_transfer()?;
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        let answer = self
            .runtime
            .block_on(self.client.delete(&self.vault, &asked))
            .map_err(store_error)?;
        Ok(Deleted {
            deleted: answer.deleted.iter().map(plane_name).collect(),
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
}

/// A destination that answered, and the store to it.
pub struct Reached {
    pub destination: Destination,
    pub store: GatewayStore,
    /// The gateway's clock when it answered: what a `MOVED` heard in this pass
    /// is dated by, since the refusal itself carries no time a client reads.
    pub gateway_ms: i64,
}

/// Why no destination was reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unreached {
    /// None answered, or none is paired.
    Silent,
    /// None that answered is the gateway this phone pinned: a machine with
    /// another certificate, or a gateway answering as another.
    Untrusted,
}

/// The first of `destinations`, in the ledger's order, that answers `info` as itself: the
/// head of [`reach_all`]'s fleet. When none does, whether any machine answered that is not the
/// pinned gateway.
///
/// # Errors
/// The ledger's refusal, or a destination row whose token will not read.
pub fn reach(
    destinations: &[Destination],
    ledger: &Ledger,
    vault: VaultId,
    runtime: &tokio::runtime::Handle,
) -> Result<std::result::Result<Reached, Unreached>> {
    let fleet = reach_all(destinations, ledger, vault, runtime)?;
    let unreached = if fleet.untrusted.is_empty() {
        Unreached::Silent
    } else {
        Unreached::Untrusted
    };
    Ok(fleet.reached.into_iter().next().ok_or(unreached))
}

/// Every paired destination a pass found: those that answered as themselves, and for the rest
/// whether they were silent or another machine answered. Every paired gateway is fed in a pass
/// (#1188, B1), so none is skipped for another having answered.
pub struct Fleet {
    /// The ledger's order, a gateway that refused this phone's token last.
    pub reached: Vec<Reached>,
    pub silent: Vec<String>,
    pub untrusted: Vec<String>,
}

/// The one cap on asking a fleet whether it is there: a dead gateway costs this much of a pass
/// and no more, whatever its addresses and however many gateways are paired.
pub const REACH_CAP: std::time::Duration = std::time::Duration::from_secs(12);

/// How one gateway answered a probe.
enum Probe {
    Answered(i64),
    Untrusted,
    Silent,
}

/// Ask every destination `info` **at once**, under one overall cap ([`REACH_CAP`]): a gateway
/// that is asleep costs the cap, not a turn in a queue the healthy one waits in. A destination
/// this phone was superseded at is left out (its writes are refused and its reads have nothing
/// a pass needs).
///
/// # Errors
/// The ledger's refusal, or a destination row whose token will not read.
pub fn reach_all(
    destinations: &[Destination],
    ledger: &Ledger,
    vault: VaultId,
    runtime: &tokio::runtime::Handle,
) -> Result<Fleet> {
    reach_all_capped(destinations, ledger, vault, runtime, REACH_CAP)
}

/// [`reach_all`] under `cap`, for a test that does not wait for the product's.
///
/// # Errors
/// As [`reach_all`].
pub fn reach_all_capped(
    destinations: &[Destination],
    ledger: &Ledger,
    vault: VaultId,
    runtime: &tokio::runtime::Handle,
    cap: std::time::Duration,
) -> Result<Fleet> {
    let mut ordered: Vec<(bool, &Destination)> = Vec::with_capacity(destinations.len());
    for destination in destinations {
        let refused = ledger
            .unauthorized(&destination.gateway_id)
            .map_err(super::plane_error)?;
        ordered.push((refused, destination));
    }
    ordered.sort_by_key(|(refused, _)| *refused);
    let mut asking: Vec<(&Destination, GatewayStore)> = Vec::new();
    for (_, destination) in ordered {
        if ledger
            .moved(&destination.gateway_id)
            .map_err(super::plane_error)?
            .is_some()
        {
            continue;
        }
        asking.push((
            destination,
            GatewayStore::for_destination(destination, vault, runtime)?,
        ));
    }
    let answers = runtime.block_on(probe_all(
        asking.iter().map(|(_, store)| store.probe()),
        cap,
    ));
    let mut fleet = Fleet {
        reached: Vec::new(),
        silent: Vec::new(),
        untrusted: Vec::new(),
    };
    for ((destination, store), answer) in asking.into_iter().zip(answers) {
        match answer {
            Probe::Answered(time_ms) => {
                ledger
                    .touch_seen(&destination.gateway_id, super::now_ms())
                    .map_err(super::plane_error)?;
                fleet.reached.push(Reached {
                    destination: destination.clone(),
                    store,
                    gateway_ms: time_ms,
                });
            }
            Probe::Untrusted => {
                tracing::warn!(
                    gateway = %destination.gateway_id,
                    "a machine that is not the pinned gateway answered"
                );
                fleet.untrusted.push(destination.gateway_id.clone());
            }
            Probe::Silent => {
                tracing::debug!(gateway = %destination.gateway_id, "a paired gateway did not answer");
                fleet.silent.push(destination.gateway_id.clone());
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
            protocol: 2,
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
                Probe::Silent => "silent".to_owned(),
            })
            .collect();
        assert_eq!(shape, ["silent", "answered 10", "answered 20"]);
    }

    /// **A WRONG CERTIFICATE AND A DAMAGED COPY ARE NOT AN ABSENT GATEWAY**
    /// (#1080, the audit's finding 5): a phone away from home waits it out,
    /// and these two are the member's to hear about.
    #[test]
    fn a_wrong_certificate_is_untrusted_and_bytes_off_their_digest_are_damaged() {
        assert!(matches!(
            store_error(ClientError::Untrusted),
            StoreError::Untrusted(_)
        ));
        assert!(matches!(
            store_error(ClientError::Damaged("a flipped bit".to_owned())),
            StoreError::Damaged(_)
        ));
        assert!(matches!(
            store_error(ClientError::Unreachable("away".to_owned())),
            StoreError::Unreachable(_)
        ));
    }
}
