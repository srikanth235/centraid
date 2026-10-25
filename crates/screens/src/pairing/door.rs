//! The core's doors, as pairing uses them: `pair_phone` and
//! `refresh_destination` dial a gateway, so they run off the runtime's lock
//! (`Ctx::vault_async`) and answer the asking screen as `OffThreadDone`;
//! `pins` reads the device's ledger and is quick (`Ctx::vault`).

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;
use prost::Message;

use crate::screen::Ctx;

/// WHY A PAIRING DID NOT HAPPEN, by the core's code (`ErrorCode`) and never by
/// its logs-only detail (D-1025-S7-82).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `PEER_UNREACHABLE` and everything unrecognised: the gateway did not
    /// answer. The one refusal whose remedy, try again, is never harmful.
    Unreachable,
    /// `INVALID_REQUEST`: not a pairing code, a version this build cannot read,
    /// or expired.
    NotACode,
    /// `UNAUTHORIZED`: the gateway answered and did not take the code (spent,
    /// or never minted).
    NotTaken,
    /// `VAULT_MOVED`: another phone holds this vault now, and pairing would
    /// have taken it over with this phone's older copy. The way back is a
    /// restore from the words, never a pairing.
    Moved,
}

/// What a pairing answered: the gateway's label and address and the safety
/// number the core computed (A7). Nothing secret comes back; the bearer token
/// stays in the core's ledger.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Answer {
    pub safety_number: String,
    pub label: String,
    pub address: String,
}

pub enum Verdict {
    Paired(Answer),
    Refused(Refusal),
}

/// Ask the core to pair with the gateway the code names. Answered as
/// `OffThreadDone` under [`super::laptop::PAIR_TAG`].
pub fn pair(ctx: &Ctx, ticket: &str) {
    ctx.vault_async(
        super::laptop::PAIR_TAG,
        VaultRequest::PairPhone(wire::PairRequest {
            payload: ticket.to_owned(),
        }),
    );
}

/// The verdict in a pairing's off-thread answer. Anything this build does not
/// name, and an answer that does not decode, is silence.
pub fn verdict(done: &wire::OffThreadDone) -> Verdict {
    let Some(response) = response_of(done) else {
        return Verdict::Refused(refusal_of(done));
    };
    let Some(wire::response::Kind::PairPhone(paired)) = response.kind else {
        return Verdict::Refused(Refusal::Unreachable);
    };
    let destination = paired.destination.unwrap_or_default();
    Verdict::Paired(Answer {
        safety_number: paired.safety_number,
        label: destination.label,
        address: destination.addrs.into_iter().next().unwrap_or_default(),
    })
}

fn called(done: &wire::OffThreadDone) -> Option<wire::VaultCalled> {
    wire::VaultCalled::decode(done.bytes.as_slice()).ok()
}

fn response_of(done: &wire::OffThreadDone) -> Option<wire::Response> {
    let called = called(done)?;
    if called.error.is_some() {
        return None;
    }
    wire::Response::decode(called.response.as_slice()).ok()
}

fn refusal_of(done: &wire::OffThreadDone) -> Refusal {
    // THE CODE SAYS WHICH REFUSAL (#1047 E5); the detail stays in the logs.
    let Some(error) = called(done).and_then(|called| called.error) else {
        return Refusal::Unreachable;
    };
    match error.code() {
        wire::ErrorCode::InvalidRequest => Refusal::NotACode,
        wire::ErrorCode::Unauthorized => Refusal::NotTaken,
        wire::ErrorCode::VaultMoved => Refusal::Moved,
        _ => Refusal::Unreachable,
    }
}

/// A paired gateway as the ledger records it.
pub struct Recorded {
    pub gateway_id: String,
    pub addrs: Vec<String>,
}

/// Every gateway the device's ledger records. Nothing is dialled; a refusal is
/// no gateways.
pub fn recorded(ctx: &Ctx) -> Vec<Recorded> {
    match ctx.vault(VaultRequest::Pins(wire::PinsRequest {})) {
        Ok(wire::Response {
            kind: Some(wire::response::Kind::Pins(pins)),
        }) => pins
            .destinations
            .into_iter()
            .map(|destination| Recorded {
                gateway_id: destination.gateway_id,
                addrs: destination.addrs,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Offer the core `candidates` for one gateway; it dials each with the pinned
/// certificate and keeps only the ones that answer as that gateway. Answered
/// as `OffThreadDone` under `tag`.
pub fn refresh(ctx: &Ctx, tag: &str, gateway_id: &str, candidates: Vec<String>) {
    ctx.vault_async(
        tag,
        VaultRequest::RefreshDestination(wire::RefreshDestinationRequest {
            gateway_id: gateway_id.to_owned(),
            candidates,
        }),
    );
}

/// Whether a refresh kept at least one address.
pub fn refreshed(done: &wire::OffThreadDone) -> bool {
    matches!(
        response_of(done).and_then(|response| response.kind),
        Some(wire::response::Kind::RefreshDestination(answer)) if answer.refreshed
    )
}
