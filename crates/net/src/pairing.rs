//! Mint and redeem (#1020, D-1020-C8; #1025 S3, D-1025-S3-4).
//!
//! The gateway side mints a ticket and prints its QR. The seat side decodes a
//! ticket, dials `centraid/v1` — THE plane, the only one — and sends its public
//! key on the first stream of that connection. Both halves are here so the two
//! cannot drift.
//!
//! ## The dial that pairs is the dial that bootstraps
//!
//! There is no `centraid/v1/pair` any more. A redeeming device's connection is
//! accepted PROVISIONAL (`Endpoint::accept`): one stream, a small frame, a
//! short deadline, and `pair` is the only request kind it may carry. A
//! successful redemption PROMOTES that same connection in place, so the phone
//! goes pair → snapshot_head → bootstrap → log without a second QUIC setup and
//! a second hole-punch in the middle of the one screen a member is watching.
//!
//! [`redeem`] therefore RETURNS its connection. A caller that drops it has
//! merely paid for a connection it did not use; a caller that keeps it has the
//! whole first-run sequence on one dial.

use centraid_api_proto::core_v1::envelope;
use centraid_api_proto::core_v1::{
    PairError, PairErrorCode, PairOk, PairRequest, PairResponse, PairTicket, Request, Response,
    pair_response, request, response,
};
use centraid_protocol::Connection as _;
use centraid_protocol::alpn;
use centraid_protocol::wire::{
    read_envelope, request as request_envelope, response as response_envelope,
};

use crate::allowlist::{AllowlistStore, Device, RedeemRefusal, Ticket, secret_hash};
use crate::endpoint::{Endpoint, IrohConnection};
use crate::error::ConnectError;
use crate::ticket::{TICKET_TTL_MS, TICKET_VERSION, fresh_secret};

/// What the gateway keeps after minting, plus what it prints.
pub struct Minted {
    pub ticket: PairTicket,
    /// The `base64url` form — the QR's payload and the string a member can
    /// paste into `centraid seat pair <ticket>`.
    pub encoded: String,
}

/// Mint a ticket for this gateway and record its hash.
///
/// The secret is in the returned ticket and **only its hash** reaches the
/// store, so a gateway's own state cannot mint the same pairing twice.
/// This gateway's own dialling hints, as a ticket and a `PairOk` both carry
/// them (D-1020-C15).
///
/// One place, because the two answers must agree: a device that paired off a
/// ticket and then persisted a `PairOk` with different addresses would have two
/// records of one gateway.
pub async fn dialling_hints(endpoint: &Endpoint) -> (String, Vec<String>) {
    let addr = endpoint.addr().await;
    let relay_url = addr
        .as_ref()
        .and_then(|addr| addr.relay_urls().next().map(ToString::to_string))
        .unwrap_or_default();
    // D-1020-C15: a relay-less deployment has nothing else to be reached
    // through.
    let direct_addrs: Vec<String> = addr
        .as_ref()
        .map(|addr| addr.ip_addrs().map(ToString::to_string).collect())
        .unwrap_or_default();
    (relay_url, direct_addrs)
}

pub async fn mint<S>(
    endpoint: &Endpoint,
    allowlist: &S,
    vault_name: &str,
    now_ms: u64,
) -> Result<Minted, ConnectError>
where
    S: AllowlistStore,
{
    let secret = fresh_secret().map_err(|error| ConnectError::Endpoint(error.to_string()))?;
    let ticket_id = format!("tkt_{}", crate::allowlist::hex_lower(&secret[..8]));
    let (relay_url, direct_addrs) = dialling_hints(endpoint).await;

    let ticket = PairTicket {
        v: TICKET_VERSION,
        gateway_endpoint: endpoint.id().to_vec(),
        relay_url,
        ticket_id: ticket_id.clone(),
        secret: secret.clone(),
        vault_name: vault_name.to_owned(),
        expires_at_ms: now_ms + TICKET_TTL_MS,
        direct_addrs,
    };
    allowlist
        .mint(Ticket {
            ticket_id,
            secret_hash: secret_hash(&secret),
            expires_at_ms: ticket.expires_at_ms,
            redeemed_at_ms: None,
        })
        .await;
    let encoded = crate::ticket::encode(&ticket);
    Ok(Minted { ticket, encoded })
}

/// What a gateway tells a redeeming device about ITSELF.
///
/// Three facts that travel together and are read together, so they are one
/// value rather than three positional strings: a `vault_id` and a
/// `gateway_address` transposed at a call site is a seat that keys its whole
/// replica on an address (#1025 S1's bug, in one argument swap).
pub struct VaultIdentity<'a> {
    /// THE VAULT'S OWN ID, not the literal "vault". A seat keys its replica on
    /// what it is told here: `SeatIdentity` IS the vault id since #1025 S1, it
    /// names the replica file, and the bootstrap artifact's own `core_vault`
    /// row is checked against it before the destination is touched.
    pub vault_id: &'a str,
    /// What a member sees on the confirm screen.
    pub vault_name: &'a str,
    /// This gateway's endpoint, hex. An ADDRESS and never a name.
    pub gateway_address: &'a str,
    /// Where this gateway is reachable through, when it uses a relay. Empty is
    /// a LAN-only deployment.
    pub relay_url: &'a str,
    /// `<ip>:<port>` shortcuts. HINTS with no authority.
    pub direct_addrs: Vec<String>,
    /// THE BOOTSTRAP BLOB THIS PAIRING ANSWERS WITH (#1025 S7, item 5).
    ///
    /// `None` when the gateway could not build or find one. The pairing still
    /// succeeds: the ticket is burned and the device is enrolled either way,
    /// and telling a member their code failed would send them to mint one they
    /// no longer need. The seat is then a paired device with no file, which is
    /// a real state ("Copying your vault"), and the next window asks again.
    pub snapshot: Option<SnapshotOffer>,
}

/// The three values a device needs to take a copy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotOffer {
    /// The blob's BLAKE3 content address, lowercase hex.
    pub hash: String,
    /// The log position it stands at, and the seat's cursor after it lands.
    pub seq: i64,
    /// THE SIZE, WHICH IS THE ROOM CHECK'S INPUT. A phone that cannot fit the
    /// artifact is told so by name before the first byte moves, rather than
    /// filling its disk and failing somewhere further in.
    pub bytes: u64,
}

/// What the gateway answers a redemption with, beside the response itself.
pub struct Redeemed {
    pub response: PairResponse,
    /// `Some` on success. The enrolled device, for the gateway's log line.
    pub device: Option<Device>,
}

/// Answer ONE redemption whose request frame the lane has already read.
///
/// The lane reads the first frame because it is the lane that decides a
/// provisional connection may carry `pair` and nothing else; this function is
/// what the answer to a `pair` frame IS. Splitting it that way keeps one
/// question in one place: what a connection may carry is the lane's, what a
/// redemption means is this module's.
///
/// `proved` is the device's public key **as iroh's handshake proved it**, taken
/// from the connection and never from the request: a request field would let a
/// redeeming device enrol somebody else's key.
///
/// The answer is written and flushed here, so the caller cannot forget to.
pub async fn answer_redemption<S, W>(
    send: &mut W,
    request_id: u64,
    asked: &PairRequest,
    proved: [u8; 32],
    allowlist: &S,
    gateway: &VaultIdentity<'_>,
    now_ms: u64,
) -> Result<Redeemed, ConnectError>
where
    S: AllowlistStore,
    W: tokio::io::AsyncWrite + Unpin,
{
    if !asked.device_public_key.is_empty() && asked.device_public_key != proved {
        // A device that names a key other than the one it just proved is
        // refused as a bad request rather than silently corrected: the only
        // reason to send a different key is to enrol someone else's.
        let refused = refusal(PairErrorCode::BadRequest);
        answer(send, request_id, &refused).await?;
        return Ok(Redeemed {
            response: refused,
            device: None,
        });
    }

    let device = Device {
        endpoint_id: proved,
        device_id: format!("dev_{}", crate::allowlist::hex_lower(&proved[..8])),
        label: asked.device_name.clone(),
        platform: asked.platform.clone(),
        enrolled_at_ms: now_ms,
        revoked_at_ms: None,
    };

    let outcome = allowlist
        .redeem(&asked.ticket_id, &asked.code, device, now_ms)
        .await;
    let (response, enrolled) = match outcome {
        Ok(device) => (
            PairResponse {
                result: Some(pair_response::Result::Ok(PairOk {
                    gateway_address: gateway.gateway_address.to_owned(),
                    device_id: device.device_id.clone(),
                    vault_id: gateway.vault_id.to_owned(),
                    vault_name: gateway.vault_name.to_owned(),
                    // THE HEAD, IN THE ANSWER THAT CREATES THE PAIRING
                    // (#1025 S7, item 5). A seat that is told where its copy
                    // is in the same message that enrols it has no state in
                    // which it is paired and does not know what to fetch.
                    snapshot_hash: gateway
                        .snapshot
                        .as_ref()
                        .map(|offer| offer.hash.clone())
                        .unwrap_or_default(),
                    snapshot_seq: gateway
                        .snapshot
                        .as_ref()
                        .map_or(0, |offer| u64::try_from(offer.seq).unwrap_or(0)),
                    snapshot_bytes: gateway.snapshot.as_ref().map_or(0, |offer| offer.bytes),
                    relay_url: gateway.relay_url.to_owned(),
                    direct_addrs: gateway.direct_addrs.clone(),
                    // THE KEY THIS GATEWAY JUST ENROLLED (#1025 S7-13), which
                    // is `proved` — the one iroh's TLS established on this
                    // connection, and the one that went into the allowlist row
                    // above. Never `asked.device_public_key`: a device may not
                    // be told back a key it asserted, or the check it performs
                    // at every later open would be a check against its own
                    // claim rather than against the row that decides.
                    enrolled_public_key: device.endpoint_id.to_vec(),
                })),
            },
            Some(device),
        ),
        Err(RedeemRefusal::InvalidCode) => (refusal(PairErrorCode::InvalidCode), None),
        Err(RedeemRefusal::ExpiredCode) => (refusal(PairErrorCode::ExpiredCode), None),
    };
    answer(send, request_id, &response).await?;
    Ok(Redeemed {
        response,
        device: enrolled,
    })
}

/// The seat side: redeem `ticket` against its gateway.
///
/// **Returns the connection it redeemed on** (#1025 S3, D-1025-S3-4). A
/// successful redemption promoted it in place, so it is the connection the
/// bootstrap and the first log pass should ride — the whole first run on one
/// dial. A caller with no use for it may drop it.
pub async fn redeem(
    endpoint: &Endpoint,
    ticket: &PairTicket,
    device_name: &str,
    platform: &str,
) -> Result<(IrohConnection, PairResponse), ConnectError> {
    let mut gateway = [0u8; 32];
    if ticket.gateway_endpoint.len() != 32 {
        return Err(ConnectError::Endpoint(
            "the ticket's gateway endpoint is not 32 bytes".to_owned(),
        ));
    }
    gateway.copy_from_slice(&ticket.gateway_endpoint);

    let connection = endpoint
        .connect(
            gateway,
            Some(&ticket.relay_url),
            &ticket.direct_addrs,
            alpn::PLANE,
        )
        .await?;
    let (mut send, mut recv) = connection.open_bi().await?;

    centraid_protocol::wire::write_envelope(
        &mut send,
        &request_envelope(
            1,
            Request {
                kind: Some(request::Kind::Pair(PairRequest {
                    code: ticket.secret.clone(),
                    ticket_id: ticket.ticket_id.clone(),
                    device_name: device_name.to_owned(),
                    platform: platform.to_owned(),
                    device_public_key: endpoint.id().to_vec(),
                })),
            },
        ),
    )
    .await?;
    // A QUIC stream is not flushed by dropping it; the peer waits for the
    // finish frame before it sees the end of our half.
    use tokio::io::AsyncWriteExt as _;
    send.flush().await?;

    let envelope = read_envelope(&mut recv)
        .await?
        .ok_or(ConnectError::PeerUnreachable)?;
    match envelope.body {
        Some(envelope::Body::Response(Response {
            kind: Some(response::Kind::Pair(pair)),
        })) => Ok((connection, pair)),
        _ => Err(ConnectError::Endpoint(
            "the gateway answered a pair stream with something other than a PairResponse"
                .to_owned(),
        )),
    }
}

fn refusal(code: PairErrorCode) -> PairResponse {
    PairResponse {
        result: Some(pair_response::Result::Error(PairError {
            code: code as i32,
        })),
    }
}

async fn answer<W>(
    writer: &mut W,
    request_id: u64,
    response: &PairResponse,
) -> Result<(), ConnectError>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    centraid_protocol::wire::write_envelope(
        writer,
        &response_envelope(
            request_id,
            Response {
                kind: Some(response::Kind::Pair(response.clone())),
            },
        ),
    )
    .await?;
    use tokio::io::AsyncWriteExt as _;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::allowlist::MemoryAllowlist;
    use crate::endpoint::EndpointConfig;

    /// Minting records the HASH and hands back the secret. The assertion is
    /// over what the store holds, because that is the fact a stolen backup
    /// would expose.
    #[tokio::test]
    async fn minting_stores_only_the_hash_and_sets_a_fifteen_minute_ttl() {
        let endpoint = Endpoint::spawn(EndpointConfig::loopback())
            .await
            .expect("bind");
        let allowlist = MemoryAllowlist::new();
        let minted = mint(&endpoint, &allowlist, "Home", 1_000)
            .await
            .expect("minted");

        assert_eq!(minted.ticket.expires_at_ms, 1_000 + TICKET_TTL_MS);
        assert_eq!(minted.ticket.gateway_endpoint, endpoint.id().to_vec());
        assert_eq!(minted.ticket.secret.len(), crate::ticket::SECRET_BYTES);
        assert_eq!(
            crate::ticket::decode(&minted.encoded).expect("round-trips"),
            minted.ticket
        );
        // Two mints are two different secrets and two different ticket ids.
        let again = mint(&endpoint, &allowlist, "Home", 1_000)
            .await
            .expect("minted");
        assert_ne!(again.ticket.secret, minted.ticket.secret);
        assert_ne!(again.ticket.ticket_id, minted.ticket.ticket_id);
        endpoint.close().await;
    }

    /// A relay-less gateway mints a ticket with no relay url, and the seat's
    /// dial therefore has only direct addresses to work with. This is the
    /// no-relay case's ticket shape, asserted where it is cheap.
    #[tokio::test]
    async fn a_relay_less_gateway_mints_a_ticket_with_no_relay() {
        let endpoint = Endpoint::spawn(EndpointConfig::loopback())
            .await
            .expect("bind");
        let minted = mint(&endpoint, &MemoryAllowlist::new(), "Home", 0)
            .await
            .expect("minted");
        assert!(minted.ticket.relay_url.is_empty());
        endpoint.close().await;
    }
}
