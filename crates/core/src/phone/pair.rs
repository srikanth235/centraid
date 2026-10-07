//! PAIR WITH A GATEWAY FROM ITS QR (#1080 rulings 1, 8).
//!
//! The gateway's `pair` verb prints `{v: 2, gw, addrs, pin, secret, exp_ms}`.
//! The phone parses it with the gateway's own parser, dials the addresses
//! trusting only the certificate whose BLAKE3 is `pin`, checks the gateway
//! answers as `gw`, and pairs this vault with the one-use secret. What the
//! ledger keeps is everything a later contact needs and nothing it does not:
//! the addresses, the certificate's exact DER — pinned by byte equality from
//! now on, and handed to a shell whose own TLS pins it — and the bearer token.
//!
//! **The gateway is asked before anything is kept.** A destination written for
//! a gateway that never answered is a phone that believes it is paired.
//!
//! # A GATEWAY THAT ALREADY HOLDS THIS VAULT IS TAKEN OVER BY A CLAIM
//!
//! A secret admits only a vault the gateway has never seen; one it holds
//! answers `VAULT_KNOWN`. That is this phone pairing again after its ledger was
//! lost, or a vault another phone holds. Either way the phone holding the
//! vault's identity key may claim it — the claim a restore makes: read the
//! head under a read-only grant, then claim the writer epoch one past it,
//! naming that head. Any other phone writing the vault there is then refused
//! `MOVED` and freezes, which is what pairing a phone to its vault means.
//!
//! # A SUPERSEDED PHONE TAKES NOTHING OVER
//!
//! A claim makes the claiming phone's own copy the vault: its next pass sets
//! that copy's snapshot as the head, and retention then collects every file
//! the copy does not name. So a phone another phone superseded — its ledger
//! carries a `MOVED` mark, or records this gateway at a writer epoch below
//! the one the gateway answers — is refused `VAULT_MOVED` before anything is
//! claimed or cleared, and a pairing that finds the higher epoch freezes it as
//! a pass would. Its copy is older than the head by definition; claimed, it
//! would put the vault back where it was and delete what the newer phone
//! backed up (the root's simulator repro, #1080). The way back is a restore
//! from the 24 words, which starts from the gateway's head.
//!
//! # THE NUMBER THE MEMBER READS ALOUD (#1029 W15-D5, the root's ruling A17)
//!
//! `safety_number_of_bytes` over the vault's identity key and the pin, both 32
//! bytes, sorted — the function the gateway's `serve` prints its digits with
//! when the pairing lands, so the two screens agree.

use centraid_api_proto::core_v1 as wire;
use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::claim::{sign_claim, sign_read};
use centraid_gateway::rules::code::Refusal;
use centraid_gateway::rules::ids::{GatewayId, Pin, Token};
use centraid_gateway::rules::payload::{PairPayload, PayloadError};
use centraid_gateway::rules::wire::{ClaimBody, PairKind, PairRequest, Paired, ReadBody};
use centraid_vault::backup::ledger::Destination;

use super::{Keyring, Plane, now_ms, plane_error, wire_destination};
use crate::error::{CoreError, Result};

/// What this phone calls itself to a gateway, which `pairings` prints.
pub const DEVICE_LABEL: &str = "phone";

/// How many times a takeover re-reads a head that moved under it.
const CLAIM_ATTEMPTS: u32 = 3;

/// Read a scanned payload, refusing what is not one before anything dials.
/// Its day is not judged here: a restore spends no secret.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for text that is not a version-2 pairing
/// payload with an address to reach.
pub fn parse(text: &str) -> Result<PairPayload> {
    PairPayload::parse(text).map_err(|error| CoreError::InvalidRequest {
        detail: match error {
            PayloadError::Version(version) => format!(
                "this pairing code is version {version}; this build reads the gateway's version 2"
            ),
            PayloadError::Addresses => "the pairing code names no address to reach".to_owned(),
            PayloadError::Malformed(_) => "that is not a Centraid pairing code".to_owned(),
        },
    })
}

/// [`parse`], and refuse a payload whose day has passed: its secret is spent
/// by a pairing, and the gateway refuses an expired one.
///
/// # Errors
/// As [`parse`], and [`CoreError::InvalidRequest`] for an expired payload.
pub fn payload_of(text: &str) -> Result<PairPayload> {
    let payload = parse(text)?;
    if payload.is_expired(i64::try_from(now_ms()).unwrap_or(i64::MAX)) {
        return Err(CoreError::InvalidRequest {
            detail: "that pairing code has expired; show a new one with `centraid-gateway pair`"
                .to_owned(),
        });
    }
    Ok(payload)
}

/// What a client failure is to a pairing or a restore: a gateway that did not
/// answer wants waking; one that answered and refused wants a new code; and
/// a machine that answered with another certificate is not the gateway the
/// code names.
pub(crate) fn pairing_error(error: ClientError) -> CoreError {
    match error {
        ClientError::Unreachable(reason) => CoreError::Unavailable {
            reason: format!("the gateway did not answer: {reason}"),
        },
        ClientError::GatewayFault => CoreError::Unavailable {
            reason: "the gateway's own store failed; try again".to_owned(),
        },
        ClientError::Untrusted => CoreError::GatewayRefused {
            reason: "the machine at that address is not the gateway that printed this code"
                .to_owned(),
        },
        ClientError::Refused(refusal) => CoreError::GatewayRefused {
            reason: refusal.code().as_str().to_owned(),
        },
        other => CoreError::Unavailable {
            reason: format!("the gateway's answer: {other}"),
        },
    }
}

/// Dial the payload's addresses trusting its pin, and check the gateway that
/// answered is the one it names.
pub(crate) fn first_contact(
    payload: &PairPayload,
    runtime: &tokio::runtime::Handle,
) -> Result<Client> {
    let client = Client::first_contact(payload.addrs.clone(), payload.pin);
    let info = runtime.block_on(client.info()).map_err(pairing_error)?;
    if info.gateway_id != payload.gw {
        return Err(CoreError::GatewayRefused {
            reason: format!(
                "the gateway at that address is {}, and the code names {}",
                info.gateway_id, payload.gw
            ),
        });
    }
    Ok(client)
}

/// A read-only grant for this vault: a token at epoch 0 that reads the head
/// and never writes. `None` for a vault the gateway does not hold.
pub(crate) fn read_grant(
    client: &Client,
    keyring: &Keyring,
    gateway: &GatewayId,
    runtime: &tokio::runtime::Handle,
) -> Result<Option<Paired>> {
    let request = PairRequest {
        vault_id: keyring.vault_id(),
        label: DEVICE_LABEL.to_owned(),
        kind: PairKind::Read,
        secret: None,
        claim: None,
        read: Some(ReadBody {
            signature: sign_read(keyring.vault.identity.signing(), gateway),
        }),
    };
    match runtime.block_on(client.pair(&request)) {
        Ok(paired) => Ok(Some(paired)),
        // A VAULT THE GATEWAY HAS NEVER SEEN answers as a stranger does.
        Err(ClientError::Refused(Refusal::Unauthorized)) => Ok(None),
        Err(error) => Err(pairing_error(error)),
    }
}

/// What one claim came to.
pub(crate) enum ClaimAnswer {
    /// The writer epoch moved to this phone; the token writes at it.
    Claimed(Paired),
    /// The epoch or the head is not what the claim named: here is where they
    /// stand. Nothing moved.
    Conflict {
        epoch: u64,
        head: Option<centraid_gateway::rules::ids::Name>,
    },
}

/// Claim this vault's writer epoch at `gateway` at `epoch`, naming `head_seen`
/// — the head the claimer checked — signed by the vault's identity key.
pub(crate) fn try_claim(
    client: &Client,
    keyring: &Keyring,
    gateway: &GatewayId,
    epoch: u64,
    head_seen: Option<centraid_gateway::rules::ids::Name>,
    runtime: &tokio::runtime::Handle,
) -> Result<ClaimAnswer> {
    let request = PairRequest {
        vault_id: keyring.vault_id(),
        label: DEVICE_LABEL.to_owned(),
        kind: PairKind::Claim,
        secret: None,
        claim: Some(ClaimBody {
            epoch,
            head_seen,
            signature: sign_claim(
                keyring.vault.identity.signing(),
                gateway,
                epoch,
                head_seen.as_ref(),
            ),
        }),
        read: None,
    };
    match runtime.block_on(client.pair(&request)) {
        Ok(paired) => Ok(ClaimAnswer::Claimed(paired)),
        Err(ClientError::Refused(
            Refusal::EpochConflict { epoch, head } | Refusal::HeadConflict { epoch, head },
        )) => Ok(ClaimAnswer::Conflict {
            epoch,
            head: head.map(|view| view.name),
        }),
        Err(error) => Err(pairing_error(error)),
    }
}

/// The refusal a superseded phone's pairing answers: another phone holds the
/// vault at `current_epoch`, and this phone's copy is older than its head.
const fn superseded(current_epoch: u64) -> CoreError {
    CoreError::VaultMoved {
        current_epoch,
        moved_at_ms: 0,
    }
}

/// Take this vault over at `gateway`: read its head under a read-only grant,
/// then claim the writer epoch one past it, naming that head — retried when
/// either moved under the claim. Answers the pairing and the head the claim
/// named, which is the head the gateway holds as this phone becomes its
/// writer.
///
/// `held` is the writer epoch this phone's token at `gateway` was minted at,
/// when its ledger records the gateway. A writer epoch above it is another
/// phone's claim since — a restore, or a takeover — and this phone's copy is
/// older than the head that phone set, so it is refused
/// [`CoreError::VaultMoved`] and nothing is claimed.
pub(crate) fn take_over(
    client: &Client,
    keyring: &Keyring,
    gateway: &GatewayId,
    held: Option<u64>,
    runtime: &tokio::runtime::Handle,
) -> Result<(Paired, Option<centraid_gateway::rules::ids::Name>)> {
    let Some(grant) = read_grant(client, keyring, gateway, runtime)? else {
        return Err(CoreError::GatewayRefused {
            reason: "the gateway does not hold this vault".to_owned(),
        });
    };
    client.set_token(grant.token);
    let state = runtime
        .block_on(client.head_state(&keyring.vault_id()))
        .map_err(pairing_error)?;
    let (mut epoch, mut head) = (state.epoch, state.head.map(|head| head.name));
    for _ in 0..CLAIM_ATTEMPTS {
        if held.is_some_and(|mine| epoch > mine) {
            return Err(superseded(epoch));
        }
        match try_claim(
            client,
            keyring,
            gateway,
            epoch.saturating_add(1),
            head,
            runtime,
        )? {
            ClaimAnswer::Claimed(paired) => return Ok((paired, head)),
            ClaimAnswer::Conflict {
                epoch: now,
                head: seen,
            } => {
                epoch = now;
                head = seen;
            }
        }
    }
    Err(CoreError::GatewayRefused {
        reason: "the vault's head kept moving at the gateway; pair again".to_owned(),
    })
}

/// **Redeem the pairing payload the member scanned** (`pair_phone`).
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a payload that is not one or has
/// expired; [`CoreError::Unavailable`] for a core with no vault keys, or a
/// gateway that did not answer; [`CoreError::GatewayRefused`] for a gateway
/// that answered and refused, or a machine that is not the gateway the code
/// names.
pub fn pair(
    plane: &Plane,
    keyring: Option<&Keyring>,
    request: &wire::PairRequest,
    runtime: &tokio::runtime::Handle,
) -> Result<wire::PairResponse> {
    let payload = payload_of(&request.payload)?;
    let Some(keyring) = keyring else {
        return Err(CoreError::Unavailable {
            reason: "this core holds no vault keys, so it cannot pair a vault; open it with a seed"
                .to_owned(),
        });
    };
    // A SUPERSEDED PHONE PAIRS NOTHING (the module header's "superseded").
    // Asked of the ledger before anything is dialled, claimed or cleared:
    // clearing this gateway's row below would clear the mark that freezes it.
    let ledger = plane.ledger()?;
    if let Some((_, epoch)) = super::moved(&ledger)? {
        return Err(superseded(epoch));
    }
    let gateway_hex = payload.gw.hex();
    let held = ledger
        .destination(&gateway_hex)
        .map_err(plane_error)?
        .map(|destination| destination.epoch);
    let client = first_contact(&payload, runtime)?;
    let secret = PairRequest {
        vault_id: keyring.vault_id(),
        label: DEVICE_LABEL.to_owned(),
        kind: PairKind::Secret,
        secret: Some(payload.secret),
        claim: None,
        read: None,
    };
    let (paired, head) = match runtime.block_on(client.pair(&secret)) {
        // A SECRET ADMITS ONLY A VAULT THE GATEWAY HOLDS NOTHING OF: no head.
        Ok(paired) => (paired, None),
        Err(ClientError::Refused(Refusal::VaultKnown)) => {
            match take_over(&client, keyring, &payload.gw, held, runtime) {
                // LEARNED HERE, AS A PASS WOULD HAVE: the phone freezes.
                Err(CoreError::VaultMoved { current_epoch, .. }) => {
                    ledger
                        .set_moved(&gateway_hex, current_epoch)
                        .map_err(plane_error)?;
                    return Err(superseded(current_epoch));
                }
                taken => taken?,
            }
        }
        Err(error) => return Err(pairing_error(error)),
    };
    let cert_der = client.cert_der().ok_or_else(|| CoreError::Invariant {
        context: "a gateway answered and its certificate was not kept".to_owned(),
    })?;
    let token: Token = paired.token;
    let gateway_id = paired.gateway_id.hex();
    let now = now_ms();
    let destination = Destination {
        gateway_id: gateway_id.clone(),
        addrs: payload.addrs.clone(),
        cert_der,
        token: token.hex(),
        epoch: paired.epoch,
        label: label_of(&payload),
        paired_at_ms: now,
        last_seen_ms: Some(now),
        last_ack_ms: None,
    };
    // A PAIRING STARTS THIS GATEWAY'S RECORD OVER (#1080, the sweep's B3 and
    // R-1080-C17). Whatever the ledger kept under this gateway's id from an
    // earlier pairing — every acknowledgement, the head this phone last set
    // there, when one was acknowledged — describes a gateway state this
    // pairing replaced: a secret admits only a vault the gateway holds
    // nothing of (its disk was replaced, or it was reinstalled with its
    // identity kept), and a claim makes this phone the writer over a head
    // another phone may have set. A phone the gateway superseded never gets
    // here (refused above), so this never clears the mark that freezes one.
    // Kept, the old acknowledgements would stop
    // every file being sent again, and the old head would be the `prev` of a
    // compare-and-set the gateway refuses on every pass, so the records would
    // never be backed up again. So the row goes, and its acknowledgements and
    // its meta with it; the head is the one the claim named. Nothing is sent
    // again blindly: a pass asks `exists` about every name before it seals
    // one, which moves no bytes.
    ledger
        .remove_destination(&gateway_id)
        .map_err(plane_error)?;
    ledger.put_destination(&destination).map_err(plane_error)?;
    if let Some(head) = head {
        ledger
            .set_head(
                &gateway_id,
                &centraid_vault::backup::naming::Name::from_bytes(*head.as_bytes()),
            )
            .map_err(plane_error)?;
    }
    Ok(wire::PairResponse {
        safety_number: safety_number(keyring, &payload.pin),
        destination: Some(wire_destination(&destination)),
    })
}

/// The digits a member compares with the gateway's terminal.
pub(crate) fn safety_number(keyring: &Keyring, pin: &Pin) -> String {
    centraid_identity::safety_number_of_bytes(
        keyring.vault.identity.public().as_bytes(),
        pin.as_bytes(),
    )
    .grouped()
}

/// What a destination is called on this phone: the host of the first address
/// the code names — `laptop.local`, `192.168.1.20` — which is what a member
/// recognises. The payload carries no name of its own.
pub(crate) fn label_of(payload: &PairPayload) -> String {
    payload
        .addrs
        .first()
        .map(|addr| {
            addr.rsplit_once(':')
                .map_or(addr.as_str(), |(host, _)| host)
                .trim_start_matches('[')
                .trim_end_matches(']')
                .to_owned()
        })
        .unwrap_or_default()
}
