//! The bytes on the wire, and **nothing that decides anything** (#1029 §3).
//!
//! This module is the Worker's half of what `crates/gateway-server/src/http.rs`
//! is for the standalone adapter: headers in, JSON out, and one HTTP status per
//! error code. Every answer it renders came out of `centraid-gateway-core`.
//!
//! # THE COMPANIONS ARE RENDERED, NOT CHOSEN
//!
//! A refusal's code is [`Refusal::code`] and the values beside it are
//! [`Refusal::companions`], both in `gateway-core`, because a phone cannot tell
//! which deployment it is talking to and two adapters each deciding what to put
//! on the wire are two adapters that will disagree. The standalone adapter was
//! dropping them — a phone learned THAT its vault moved and never WHEN — and
//! `gateway-core`'s `errors/a-refusal-carries-its-companions-on-the-wire` case
//! drives [`ErrorBody::of`] here for exactly that reason.
//!
//! The field names and the nesting match the standalone adapter's body because
//! they are the same protocol. If one of them changes, the conformance case is
//! what fails.

use centraid_api_proto::core_v1::ErrorCode;
use centraid_gateway_core::error::Refusal;
use serde::Serialize;
#[cfg(target_arch = "wasm32")]
use worker::{Headers, Response, Result as WorkerResult};

/// The header a phone carries its device certificate in, hex-encoded.
pub const CERTIFICATE_HEADER: &str = "centraid-certificate";
/// The Ed25519 signature over `auth::preimage`, hex-encoded.
pub const SIGNATURE_HEADER: &str = "centraid-signature";
/// The client's clock, in milliseconds since the Unix epoch.
pub const TIMESTAMP_HEADER: &str = "centraid-timestamp";
/// The protocol version, inside the signature so a middlebox cannot rewrite it.
pub const PROTOCOL_HEADER: &str = "centraid-protocol";
/// The server's own supported range, on every response.
pub const PROTOCOL_RANGE_HEADER: &str = "centraid-protocol-range";

/// A refusal on the wire.
///
/// The same shape the standalone adapter sends. See the module docs for why
/// that is a requirement rather than a coincidence.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    /// The code from `Refusal::code()`. **Never a sentence**: the member-facing
    /// wording is derived from the code by the shell.
    pub code: String,
    /// The server's clock, so a phone with a wrong one can re-sign **once**.
    /// Not a companion: every body carries it, after any refusal.
    pub server_time_ms: i64,
    /// `VAULT_MOVED`: which epoch superseded this device, and when.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved: Option<MovedBody>,
    /// `VERSION_WINDOW`: both ends of the comparison.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolBody>,
    /// `GATEWAY_CLOCK_SKEW`: the replay window, beside the clock above.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skew_window_ms: Option<i64>,
    /// `GATEWAY_HEAD_CONFLICT`: the head as it stands now. **Present with an
    /// empty string when there is no head** — that is an answer, not an
    /// absence, and a phone that could not tell it from a dropped field could
    /// not tell it from a broken server.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_head: Option<String>,
    /// `GATEWAY_QUOTA_EXCEEDED`: the ceiling, the spend and the ask.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaBody>,
    /// `GATEWAY_LEASE_STALE`: the epoch held and the epoch claimed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lease: Option<LeaseBody>,
    /// `GATEWAY_OBJECT_TOO_LARGE`: what was declared and the cap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<SizeBody>,
    /// The object an unknown-object or already-committed refusal names, hex.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object: Option<String>,
}

/// See [`ErrorBody::moved`].
#[derive(Debug, Serialize)]
pub struct MovedBody {
    pub current_epoch: u64,
    pub moved_at_ms: i64,
}

/// See [`ErrorBody::protocol`].
#[derive(Debug, Serialize)]
pub struct ProtocolBody {
    pub server_protocol_min: u32,
    pub server_protocol_max: u32,
    pub client_protocol: u32,
}

/// See [`ErrorBody::quota`].
#[derive(Debug, Serialize)]
pub struct QuotaBody {
    pub quota_bytes: u64,
    pub used_bytes: u64,
    pub wanted_bytes: u64,
}

/// See [`ErrorBody::lease`].
#[derive(Debug, Serialize)]
pub struct LeaseBody {
    pub held_epoch: u64,
    pub claimed_epoch: u64,
}

/// See [`ErrorBody::size`].
#[derive(Debug, Serialize)]
pub struct SizeBody {
    pub declared_bytes: u64,
    pub cap_bytes: u64,
}

impl ErrorBody {
    /// The body for one refusal, companions and all.
    ///
    /// **The only place this crate builds a refusal body**, so there is one
    /// answer rather than one per route.
    #[must_use]
    pub fn of(refusal: &Refusal, server_time_ms: i64) -> Self {
        let companions = refusal.companions();
        Self {
            code: format!("{:?}", refusal.code()),
            server_time_ms,
            moved: companions.moved.map(|moved| MovedBody {
                current_epoch: moved.current_epoch,
                moved_at_ms: moved.moved_at_ms,
            }),
            protocol: companions.protocol.map(|protocol| ProtocolBody {
                server_protocol_min: protocol.server_min,
                server_protocol_max: protocol.server_max,
                client_protocol: protocol.client,
            }),
            skew_window_ms: companions.skew_window_ms,
            current_head: companions
                .head
                .map(|head| head.map(|name| name.hex()).unwrap_or_default()),
            quota: companions.quota.map(|quota| QuotaBody {
                quota_bytes: quota.quota_bytes,
                used_bytes: quota.used_bytes,
                wanted_bytes: quota.wanted_bytes,
            }),
            lease: companions.lease.map(|lease| LeaseBody {
                held_epoch: lease.held,
                claimed_epoch: lease.claimed,
            }),
            size: companions.size.map(|size| SizeBody {
                declared_bytes: size.declared_bytes,
                cap_bytes: size.cap_bytes,
            }),
            object: companions.object.map(|object| object.hex()),
        }
    }

    /// A body for an internal error, which is not a refusal and has no
    /// companions.
    #[must_use]
    pub fn internal(server_time_ms: i64) -> Self {
        Self {
            code: format!("{:?}", ErrorCode::Internal),
            server_time_ms,
            moved: None,
            protocol: None,
            skew_window_ms: None,
            current_head: None,
            quota: None,
            lease: None,
            size: None,
            object: None,
        }
    }
}

/// The HTTP status one error code is carried by.
///
/// The code is the answer; the status is only so that a proxy in between
/// behaves. **This table is the standalone adapter's, value for value**: a
/// phone that retried on one deployment and gave up on the other would be a
/// phone that can tell which one it is talking to.
///
/// A refusal is never a 500 and a store fault always is.
#[must_use]
pub const fn status_for(code: ErrorCode) -> u16 {
    match code {
        ErrorCode::Unauthorized
        | ErrorCode::GatewaySignatureInvalid
        | ErrorCode::GatewayNotLeaseHolder
        | ErrorCode::GatewayClockSkew => 401,
        ErrorCode::VersionWindow => 426,
        ErrorCode::GatewayHeadConflict
        | ErrorCode::GatewayAlreadyCommitted
        | ErrorCode::GatewayLeaseStale
        | ErrorCode::VaultMoved => 409,
        ErrorCode::GatewayQuotaExceeded | ErrorCode::GatewayPlanLapsed => 402,
        ErrorCode::GatewayObjectTooLarge => 413,
        ErrorCode::GatewayObjectUnknown => 404,
        ErrorCode::GatewayDeleteRefused
        | ErrorCode::GatewayCapabilityScope
        | ErrorCode::GatewayMailboxRefused => 403,
        // WHICH SIDE IS AT FAULT, SAID IN THE STATUS. `GATEWAY_CHECKSUM_MISSING`
        // is the commonest refusal a new client meets — it uploaded every
        // object without an attestation and the commit refused the lot — and
        // "checksum missing" from a server reads like the server lost
        // something. It did not: a 400 says the request was wrong, and it was
        // wrong because it never attested. Named rather than left to the
        // catch-all, so the attribution is a decision somebody made.
        ErrorCode::GatewayChecksumMissing | ErrorCode::GatewayChecksumMismatch => 400,
        _ => 400,
    }
}

// THE THREE BELOW TOUCH A `Response`, WHICH ONLY BUILDS FOR wasm32. Everything
// above is pure and is tested on the host — including `ErrorBody::of`, which is
// the thing the conformance case actually drives.

/// Render a refusal.
///
/// # Errors
///
/// A worker error if the response cannot be built.
#[cfg(target_arch = "wasm32")]
pub fn refused(refusal: &Refusal, now_ms: i64) -> WorkerResult<Response> {
    let status = status_for(refusal.code());
    Ok(Response::from_json(&ErrorBody::of(refusal, now_ms))?.with_status(status))
}

/// Render an internal error. **The detail never reaches the wire**: a store
/// fault's text is the adapter's own and may name a bucket; the phone gets an
/// internal error and retries, and the operator reads the log.
///
/// # Errors
///
/// A worker error if the response cannot be built.
#[cfg(target_arch = "wasm32")]
pub fn internal(detail: &str, now_ms: i64) -> WorkerResult<Response> {
    worker::console_error!("a store failed: {detail}");
    Ok(Response::from_json(&ErrorBody::internal(now_ms))?.with_status(500))
}

/// Put the server's protocol range on a response, in both directions.
///
/// Every response carries it, not only a refusal: a phone decides whether to
/// keep talking to this server from the range, and learning it only on failure
/// means learning it one failed backup late.
///
/// # Errors
///
/// A worker error if the header cannot be set.
#[cfg(target_arch = "wasm32")]
pub fn with_protocol_range(response: Response, min: u32, max: u32) -> WorkerResult<Response> {
    let headers = Headers::new();
    for (name, value) in response.headers().entries() {
        headers.set(&name, &value)?;
    }
    headers.set(PROTOCOL_RANGE_HEADER, &format!("{min}-{max}"))?;
    Ok(response.with_headers(headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_gateway_core::ids::{Key32, ObjectName};
    use centraid_gateway_core::time::{Duration, ServerTime};

    /// A REFUSAL IS NEVER A 500 AND A STORE FAULT ALWAYS IS. The phone retries
    /// one and not the other, and getting this backwards is a phone that either
    /// hammers a server or gives up on a transient failure.
    #[test]
    fn no_refusal_is_carried_by_a_server_error() {
        for code in [
            ErrorCode::Unauthorized,
            ErrorCode::GatewaySignatureInvalid,
            ErrorCode::GatewayClockSkew,
            ErrorCode::VersionWindow,
            ErrorCode::GatewayChecksumMissing,
            ErrorCode::GatewayChecksumMismatch,
            ErrorCode::GatewayHeadConflict,
            ErrorCode::GatewayAlreadyCommitted,
            ErrorCode::GatewayLeaseStale,
            ErrorCode::VaultMoved,
            ErrorCode::GatewayQuotaExceeded,
            ErrorCode::GatewayPlanLapsed,
            ErrorCode::GatewayObjectTooLarge,
            ErrorCode::GatewayObjectUnknown,
            ErrorCode::GatewayDeleteRefused,
            ErrorCode::GatewayCapabilityScope,
            ErrorCode::GatewayMailboxRefused,
        ] {
            assert!(
                status_for(code) < 500,
                "{code:?} is a refusal and must not read as this server failing"
            );
        }
    }

    /// THE COMPANIONS REACH THE BODY. `gateway-core`'s conformance case drives
    /// this same function inside a real Durable Object; this is the same claim
    /// where a failure prints a diff instead of a report line.
    #[test]
    fn a_moved_vault_carries_its_epoch_and_the_time_it_moved() {
        let body = ErrorBody::of(
            &Refusal::VaultMoved {
                current_epoch: 9,
                moved_at: ServerTime::from_millis(1_700_000_000_000),
            },
            7,
        );
        let moved = body.moved.expect("a moved companion");
        assert_eq!(moved.current_epoch, 9);
        assert_eq!(moved.moved_at_ms, 1_700_000_000_000);
        assert_eq!(body.server_time_ms, 7, "every body carries the clock");
    }

    /// "THERE IS NO HEAD" IS AN ANSWER, NOT AN ABSENCE. A phone that could not
    /// tell an empty head from a dropped field could not tell it from a broken
    /// server.
    #[test]
    fn a_head_conflict_with_no_head_still_sends_the_field() {
        let body = ErrorBody::of(&Refusal::HeadConflict { current: None }, 0);
        assert_eq!(body.current_head.as_deref(), Some(""));
        let body = ErrorBody::of(
            &Refusal::HeadConflict {
                current: Some(ObjectName::of(b"a head")),
            },
            0,
        );
        assert_eq!(
            body.current_head.as_deref(),
            Some(ObjectName::of(b"a head").hex().as_str())
        );
    }

    /// AN INTERNAL ERROR CARRIES NO COMPANIONS. It is not a refusal and has
    /// none, and a body that invented one would be a body asserting a state.
    #[test]
    fn an_internal_error_carries_the_clock_and_nothing_else() {
        let body = ErrorBody::internal(11);
        assert_eq!(body.server_time_ms, 11);
        assert!(body.moved.is_none());
        assert!(body.protocol.is_none());
        assert!(body.current_head.is_none());
        assert!(body.quota.is_none());
    }

    /// EVERY COMPANION `gateway-core` PRODUCES IS RENDERED BY THIS BODY.
    ///
    /// The failure this guards against is a new companion in the rules that
    /// nobody adds a field for here: it compiles, the phone gets a code with
    /// nothing attached, and the gap is found by a member.
    #[test]
    fn no_companion_the_rules_produce_is_dropped_by_this_body() {
        let refusals = [
            Refusal::ClockSkew {
                server_time: ServerTime::from_millis(1),
                window: Duration::from_secs(300),
            },
            Refusal::VersionWindow {
                server: (1, 1),
                client: 4,
            },
            Refusal::AlreadyCommitted(Key32::from_bytes([3; 32])),
            Refusal::ObjectUnknown(Key32::from_bytes([4; 32])),
            Refusal::ObjectTooLarge {
                declared: 20,
                cap: 16,
            },
            Refusal::HeadConflict {
                current: Some(Key32::from_bytes([5; 32])),
            },
            Refusal::LeaseStale { held: 2, claimed: 2 },
            Refusal::VaultMoved {
                current_epoch: 3,
                moved_at: ServerTime::from_millis(8),
            },
            Refusal::QuotaExceeded {
                quota_bytes: 10,
                used_bytes: 9,
                wanted_bytes: 5,
            },
        ];
        for refusal in refusals {
            let rendered = serde_json::to_string(&ErrorBody::of(&refusal, 0))
                .expect("the body serialises");
            for (field, value) in refusal.companions().fields() {
                assert!(
                    rendered.contains(value.as_str()),
                    "{refusal:?} dropped `{field}` = `{value}` on the way to the \
                     wire: {rendered}"
                );
            }
        }
    }
}
