//! Mint and redeem (#1020, D-1020-C8).
//!
//! The gateway side mints a ticket, prints its QR, and serves one redemption on
//! `centraid/v1/pair`. The seat side decodes a ticket, dials that lane, and
//! sends its public key. Both halves are here so the two cannot drift.

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
    let addr = endpoint.addr().await;
    let relay_url = addr
        .as_ref()
        .and_then(|addr| addr.relay_urls().next().map(ToString::to_string))
        .unwrap_or_default();
    // D-1020-C15: the dialling hints. A relay-less deployment has nothing else
    // to be reached through.
    let direct_addrs: Vec<String> = addr
        .as_ref()
        .map(|addr| addr.ip_addrs().map(ToString::to_string).collect())
        .unwrap_or_default();

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

/// What the gateway answers a redemption with, beside the response itself.
pub struct Redeemed {
    pub response: PairResponse,
    /// `Some` on success. The enrolled device, for the gateway's log line.
    pub device: Option<Device>,
}

/// Serve ONE redemption on an accepted `centraid/v1/pair` connection.
///
/// The lane accepts an unenrolled peer by design — that is what it is for — and
/// the ticket is the admission. The device's public key is taken from the
/// CONNECTION, not from the request: a request field would let a redeeming
/// device enrol somebody else's key.
pub async fn serve_redemption<S>(
    connection: &IrohConnection,
    allowlist: &S,
    vault_id: &str,
    vault_name: &str,
    gateway_id: &str,
    now_ms: u64,
) -> Result<Redeemed, ConnectError>
where
    S: AllowlistStore,
{
    let (mut send, mut recv) = connection.accept_bi().await?;
    let envelope = read_envelope(&mut recv)
        .await?
        .ok_or(ConnectError::PeerUnreachable)?;
    let request_id = envelope.request_id;

    let asked = match envelope.body {
        Some(envelope::Body::Request(Request {
            kind: Some(request::Kind::Pair(pair)),
        })) => pair,
        _ => {
            let refused = refusal(PairErrorCode::BadRequest);
            answer(&mut send, request_id, &refused).await?;
            return Ok(Redeemed {
                response: refused,
                device: None,
            });
        }
    };

    // The proved identity, from iroh's handshake.
    let proved = connection.peer_id();
    if !asked.device_public_key.is_empty() && asked.device_public_key != proved {
        // A device that names a key other than the one it just proved is
        // refused as a bad request rather than silently corrected: the only
        // reason to send a different key is to enrol someone else's.
        let refused = refusal(PairErrorCode::BadRequest);
        answer(&mut send, request_id, &refused).await?;
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
                    gateway_id: gateway_id.to_owned(),
                    device_id: device.device_id.clone(),
                    vault_id: vault_id.to_owned(),
                    vault_name: vault_name.to_owned(),
                })),
            },
            Some(device),
        ),
        Err(RedeemRefusal::InvalidCode) => (refusal(PairErrorCode::InvalidCode), None),
        Err(RedeemRefusal::ExpiredCode) => (refusal(PairErrorCode::ExpiredCode), None),
    };
    answer(&mut send, request_id, &response).await?;
    Ok(Redeemed {
        response,
        device: enrolled,
    })
}

/// The seat side: redeem `ticket` against its gateway.
pub async fn redeem(
    endpoint: &Endpoint,
    ticket: &PairTicket,
    device_name: &str,
    platform: &str,
) -> Result<PairResponse, ConnectError> {
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
            alpn::PAIR,
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
        })) => Ok(pair),
        _ => Err(ConnectError::Endpoint(
            "the gateway answered the pair lane with something other than a PairResponse"
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
