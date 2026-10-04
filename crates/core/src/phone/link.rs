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
        }
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
        let info = self
            .runtime
            .block_on(self.client.info())
            .map_err(store_error)?;
        if info.gateway_id.hex() != self.gateway_id {
            return Err(StoreError::Untrusted(format!(
                "the gateway answered as {}, not as the paired {}",
                info.gateway_id, self.gateway_id
            )));
        }
        Ok(info)
    }

    /// The vault's writer epoch at this gateway, as its head answers it — a
    /// head or `NO_HEAD`, both carry it. A token minted below it is one
    /// another phone's claim superseded.
    ///
    /// # Errors
    /// As [`Self::info`], and a refusal by its code.
    pub fn writer_epoch(&self) -> std::result::Result<u64, StoreError> {
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
        let bytes = self
            .runtime
            .block_on(self.client.get(&self.vault, &wire_name(name), None))
            .map_err(missing_or(name))?;
        sink.write_all(&bytes)?;
        Ok(bytes.len() as u64)
    }

    fn get_many(
        &self,
        names: &[Name],
        each: &mut dyn FnMut(&Name, &[u8]) -> std::io::Result<()>,
    ) -> std::result::Result<usize, StoreError> {
        let asked: Vec<WireName> = names.iter().map(wire_name).collect();
        self.runtime
            .block_on(self.client.fetch_each(&self.vault, &asked, |frame| {
                each(&plane_name(&frame.name), &frame.bytes)
            }))
            .map_err(store_error)
    }

    fn head(&self) -> std::result::Result<Option<Head>, StoreError> {
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

/// The first of `destinations`, in the ledger's order, that answers `info`
/// as itself. A destination this phone was superseded at is skipped: its
/// writes are refused and its reads have nothing a pass needs. When none
/// does, whether any machine answered that is not the pinned gateway.
///
/// # Errors
/// The ledger's refusal, or a destination row whose token will not read.
pub fn reach(
    destinations: &[Destination],
    ledger: &Ledger,
    vault: VaultId,
    runtime: &tokio::runtime::Handle,
) -> Result<std::result::Result<Reached, Unreached>> {
    let mut unreached = Unreached::Silent;
    for destination in destinations {
        if ledger
            .moved(&destination.gateway_id)
            .map_err(super::plane_error)?
            .is_some()
        {
            continue;
        }
        let store = GatewayStore::for_destination(destination, vault, runtime)?;
        match store.info() {
            Ok(info) => {
                ledger
                    .touch_seen(&destination.gateway_id, super::now_ms())
                    .map_err(super::plane_error)?;
                return Ok(Ok(Reached {
                    destination: destination.clone(),
                    store,
                    gateway_ms: info.time_ms,
                }));
            }
            Err(error @ StoreError::Untrusted(_)) => {
                tracing::warn!(
                    gateway = %destination.gateway_id,
                    %error,
                    "a machine that is not the pinned gateway answered"
                );
                unreached = Unreached::Untrusted;
            }
            Err(error) => {
                tracing::debug!(
                    gateway = %destination.gateway_id,
                    %error,
                    "a paired gateway did not answer"
                );
            }
        }
    }
    Ok(Err(unreached))
}

#[cfg(test)]
mod tests {
    use super::*;

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
