//! axum over the rules (#1029 §3).
//!
//! **Every answer this module gives comes out of `centraid-gateway-core`.** A
//! handler decodes a request, hands it to [`Gateway`], and renders whatever
//! came back; the one mapping from a refusal to a wire code is
//! `Refusal::code()`, which lives beside the rules precisely so that an adapter
//! cannot choose its own. A phone cannot tell which deployment it is talking to
//! (§3), and this file is where that promise is either kept or quietly broken.
//!
//! # WHAT A HANDLER IS ALLOWED TO DECIDE
//!
//! Three things, and they are all about bytes on a wire:
//!
//! 1. how a certificate, a signature and a timestamp arrive in headers;
//! 2. how a typed request becomes JSON and back;
//! 3. which HTTP status carries which error code.
//!
//! It may not decide whether a commit is allowed, whether a name may be
//! presigned, whether a delete is inside the floor, or what a quota is. If a
//! handler here grows an `if`, the question to ask is whether that `if` belongs
//! in `gateway-core` — and the answer is almost always yes.
//!
//! # THE PROXY
//!
//! `PUT /v1/objects/{vault}/{name}` is the target a phone is handed by default
//! (see [`crate::bytes`]). The server streams the bytes into the store; it does
//! not open them, cannot open them, and does not record anything about them
//! beyond what the store already holds. It is also where **two-tenant
//! isolation** is enforced on the read side: the vault in the path must be the
//! vault the caller's certificate names, so one household member cannot read,
//! head or delete another's objects even though both are on this server.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use centraid_api_proto::core_v1::ErrorCode;
use centraid_gateway_core::checksum::{AttestedChecksum, ChecksumFault};
use centraid_gateway_core::engine::{Caller, CommitInput, Fault, Gateway};
use centraid_gateway_core::error::Refusal;
use centraid_gateway_core::ids::{Generation, Key32, ObjectKind, ObjectName, VaultId};
use centraid_gateway_core::store::ByteStore as _;
use centraid_gateway_core::upload::Declaration;
use centraid_gateway_core::{PROTOCOL_MAX, PROTOCOL_MIN, auth, version};
use centraid_identity::DeviceCertificate;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::bytes::ProxyWrite as _;
use crate::bytes::configured::ConfiguredBytes;
use crate::config::Config;
use crate::state::SqliteState;
use crate::tenancy;

/// The header a phone carries its device certificate in, hex-encoded.
pub const CERTIFICATE_HEADER: &str = "centraid-certificate";
/// The Ed25519 signature over [`auth::preimage`], hex-encoded.
pub const SIGNATURE_HEADER: &str = "centraid-signature";
/// The client's clock, in milliseconds since the Unix epoch.
pub const TIMESTAMP_HEADER: &str = "centraid-timestamp";
/// The protocol version, inside the signature so a middlebox cannot rewrite it.
pub const PROTOCOL_HEADER: &str = "centraid-protocol";
/// The checksum a client attests for the bytes it is uploading, hex.
///
/// Which digest that is, is `centraid_gateway_core::checksum`'s and is named
/// there and in `crates/gateway-server/src/bytes/sigv4.rs` — the two modules
/// the one-hash boundary allows — and deliberately not here.
///
/// **Optional, and its absence is a refusal one step later**: R2 records the
/// attestation only when the client sent it, so a commit fails on *no
/// checksum* and not only on *wrong checksum*. A client that omits it uploads
/// successfully and is then refused `GatewayChecksumMissing` at commit — which
/// is a 4xx and a CLIENT fault, not this server failing. See
/// [`status_for`] and `put_object`.
pub const ATTESTED_CHECKSUM_HEADER: &str = "centraid-attested-checksum";

/// Everything a running server holds.
pub struct Server {
    pub gateway: Gateway<SqliteState, ConfiguredBytes>,
    pub config: Config,
}

/// The shared handle the handlers take.
///
/// One mutex over the whole gateway, and that is not a performance oversight:
/// the compare-and-set is `BEGIN IMMEDIATE` and serialises anyway, a household
/// server has single-digit writers, and a lock held across the rules is what
/// makes this adapter's concurrency story one sentence long instead of a
/// chapter. If a household ever needs more, the answer is a connection pool
/// under `StateStore` — not a rule that has learned to be reentrant.
pub type Shared = Arc<Mutex<Server>>;

/// The routes.
pub fn router(server: Shared) -> Router {
    Router::new()
        .route("/v1/health", get(health))
        .route("/v1/vaults/{vault}/admit", post(admit))
        .route("/v1/vaults/{vault}/lease", post(lease))
        .route("/v1/vaults/{vault}/declare", post(declare))
        .route("/v1/vaults/{vault}/commit", post(commit))
        .route("/v1/vaults/{vault}/delete", post(delete))
        .route("/v1/objects/{vault}/{name}", put(put_object))
        .route("/v1/objects/{vault}/{name}", get(get_object))
        .with_state(server)
}

// --------------------------------------------------------------- rendering --

/// A refusal on the wire.
///
/// # THE CODE IS NOT THE WHOLE ANSWER
///
/// Almost every refusal a phone *acts* on also carries a value: the epoch that
/// superseded this device and **when**, the head as it stands now, the server's
/// protocol range, the bytes left in a quota. This body used to carry the code
/// and the clock and nothing else, so a phone learned THAT its vault moved and
/// never WHEN — and a shell that defaults the missing time draws "0 changes
/// since 1 January 1970" over a frozen vault, which is a fabricated fact rather
/// than a missing one.
///
/// The companions are `centraid_gateway_core::error::Companions` and this
/// renders them; it does not choose them. `gateway-core`'s conformance case
/// `errors/a-refusal-carries-its-companions-on-the-wire` drives this very
/// serializer and fails if a name or a value is lost, which is what stops the
/// two deployments from drifting apart on it again.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    /// The code from `Refusal::code()`. **Never a sentence**: the member-facing
    /// wording is derived from the code by the shell, which is the rule
    /// `error.proto` already states for every other refusal in this product.
    pub code: String,
    /// The server's clock, so a phone with a wrong one can re-sign **once**.
    ///
    /// Not a companion: every body carries it, after any refusal, because a
    /// phone with a wrong clock has to be able to re-sign after all of them.
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
    /// `GATEWAY_HEAD_CONFLICT`: the head as it stands now.
    ///
    /// **Present with an empty string when there is no head.** "There is no
    /// head" is an answer — re-read from nothing — and a phone that could not
    /// tell it from a dropped companion could not tell it from a broken server.
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
    /// **The only place this crate builds an error body with companions**, so
    /// there is one answer rather than one per handler.
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

    /// A body that carries no companions, for an internal error — which is not
    /// a refusal and has none.
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
/// behaves. A refusal is never a 500, and a store fault always is — the phone
/// retries the second and not the first.
const fn status_for(code: ErrorCode) -> StatusCode {
    match code {
        ErrorCode::Unauthorized
        | ErrorCode::GatewaySignatureInvalid
        | ErrorCode::GatewayNotLeaseHolder => StatusCode::UNAUTHORIZED,
        ErrorCode::GatewayClockSkew => StatusCode::UNAUTHORIZED,
        ErrorCode::VersionWindow => StatusCode::UPGRADE_REQUIRED,
        ErrorCode::GatewayHeadConflict
        | ErrorCode::GatewayAlreadyCommitted
        | ErrorCode::GatewayLeaseStale
        | ErrorCode::VaultMoved => StatusCode::CONFLICT,
        ErrorCode::GatewayQuotaExceeded | ErrorCode::GatewayPlanLapsed => {
            StatusCode::PAYMENT_REQUIRED
        }
        ErrorCode::GatewayObjectTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
        ErrorCode::GatewayObjectUnknown => StatusCode::NOT_FOUND,
        ErrorCode::GatewayDeleteRefused
        | ErrorCode::GatewayCapabilityScope
        | ErrorCode::GatewayMailboxRefused => StatusCode::FORBIDDEN,
        // WHICH SIDE IS AT FAULT, SAID IN THE STATUS. `GATEWAY_CHECKSUM_MISSING`
        // is the commonest refusal a new client meets — it uploaded every
        // object without an attestation header and the commit refused the lot —
        // and "checksum missing" from a server reads like the server lost
        // something. It did not: a 400 says the request was wrong, and the
        // request was wrong because it never attested. It is named here rather
        // than left to the catch-all so that the attribution is a decision
        // somebody made and not a default.
        ErrorCode::GatewayChecksumMissing | ErrorCode::GatewayChecksumMismatch => {
            StatusCode::BAD_REQUEST
        }
        _ => StatusCode::BAD_REQUEST,
    }
}

fn refused(refusal: &Refusal) -> Response {
    (
        status_for(refusal.code()),
        axum::Json(ErrorBody::of(refusal, crate::clock::now().millis())),
    )
        .into_response()
}

fn faulted(fault: &Fault) -> Response {
    match fault {
        Fault::Refused(refusal) => refused(refusal),
        Fault::Store(store) => {
            // THE DETAIL NEVER REACHES THE WIRE. A store fault's text is the
            // adapter's own and may name a path or a bucket; the phone gets an
            // internal error and retries, and the operator reads the log.
            tracing::error!(detail = %store, "a store failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                axum::Json(ErrorBody::internal(crate::clock::now().millis())),
            )
                .into_response()
        }
    }
}

// ------------------------------------------------------------------- auth ----

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn key_of(hex_text: &str) -> Option<Key32> {
    hex::decode(hex_text)
        .ok()
        .and_then(|bytes| Key32::from_slice(&bytes))
}

/// Authenticate one request and turn it into a [`Caller`].
///
/// The order is the rules': **decode the certificate, verify its own
/// signature, check it names this vault, then verify the request** — and the
/// request check does the clock before the signature, because a phone with a
/// wrong clock is the common case and its answer is actionable.
///
/// # Errors
///
/// A [`Refusal`], which the caller renders.
fn authenticate(
    headers: &HeaderMap,
    method: &str,
    path: &str,
    body: &[u8],
    vault: VaultId,
) -> Result<Caller, Refusal> {
    let protocol: u32 = header(headers, PROTOCOL_HEADER)
        .and_then(|text| text.parse().ok())
        .ok_or(Refusal::SignatureInvalid)?;
    version::admit(version::Range::new(PROTOCOL_MIN, PROTOCOL_MAX), protocol)?;

    let certificate_bytes = header(headers, CERTIFICATE_HEADER)
        .and_then(|text| hex::decode(text).ok())
        .ok_or(Refusal::SignatureInvalid)?;
    let signature = header(headers, SIGNATURE_HEADER)
        .and_then(|text| hex::decode(text).ok())
        .ok_or(Refusal::SignatureInvalid)?;
    let timestamp_ms: i64 = header(headers, TIMESTAMP_HEADER)
        .and_then(|text| text.parse().ok())
        .ok_or(Refusal::SignatureInvalid)?;

    let certificate =
        DeviceCertificate::from_bytes(&certificate_bytes).map_err(|_| Refusal::SignatureInvalid)?;
    certificate
        .verify()
        .map_err(|_| Refusal::SignatureInvalid)?;

    let identity = Key32::from_bytes(certificate.identity().to_bytes());
    // TWO-TENANT ISOLATION, AT ITS ONE CHOKE POINT. The certificate names a
    // vault; the path names a vault; a request where they differ is one
    // household member reaching for another's, and it is refused as a stranger
    // rather than as anything more specific.
    if identity != vault {
        return Err(Refusal::UnknownVault);
    }

    let device = Key32::from_bytes(certificate.device().to_bytes());
    let epoch = certificate.epoch().get();
    let now = crate::clock::now();
    auth::verify_request(
        &auth::SignedRequest {
            method,
            path,
            body_digest: *blake3::hash(body).as_bytes(),
            timestamp_ms,
            protocol,
            certificate_bytes: &certificate_bytes,
            signature: &signature,
        },
        &auth::CertifiedDevice::already_verified(identity, device, epoch),
        now,
        auth::DEFAULT_REPLAY_WINDOW,
    )?;

    Ok(Caller {
        vault,
        device,
        epoch,
        now,
    })
}

// --------------------------------------------------------------- handlers ----

#[derive(Debug, Serialize)]
struct Health {
    protocol_min: u32,
    protocol_max: u32,
    server_time_ms: i64,
}

async fn health() -> impl IntoResponse {
    axum::Json(Health {
        protocol_min: PROTOCOL_MIN,
        protocol_max: PROTOCOL_MAX,
        server_time_ms: crate::clock::now().millis(),
    })
}

#[derive(Debug, Deserialize)]
struct AdmitRequest {
    /// The invite the owner read out.
    invite: String,
    /// The account key the vault hangs off, hex.
    account: String,
}

/// Redeem an invite. **The one endpoint that is this deployment's own.**
async fn admit(
    State(server): State<Shared>,
    Path(vault): Path<String>,
    axum::Json(request): axum::Json<AdmitRequest>,
) -> Response {
    let (Some(vault), Some(account)) = (key_of(&vault), key_of(&request.account)) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let mut server = server.lock().await;
    let append_only = server.config.append_only;
    let outcome = tenancy::redeem(
        &mut server.gateway.state,
        &request.invite,
        vault,
        account,
        crate::clock::now(),
        append_only,
    )
    .await;
    match outcome {
        Err(fault) => faulted(&Fault::Store(fault)),
        Ok(Err(_)) => {
            // Every invite refusal is the same answer, so a caller cannot
            // enumerate which invites a household has minted.
            refused(&Refusal::UnknownVault)
        }
        Ok(Ok(plan)) => axum::Json(serde_json::json!({
            "quota_bytes": plan.quota_bytes,
            "append_only": append_only,
        }))
        .into_response(),
    }
}

async fn lease(
    State(server): State<Shared>,
    Path(vault): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(vault) = key_of(&vault) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let path = format!("/v1/vaults/{}/lease", vault.hex());
    let caller = match authenticate(&headers, "POST", &path, &body, vault) {
        Ok(caller) => caller,
        Err(refusal) => return refused(&refusal),
    };
    let mut server = server.lock().await;
    match server.gateway.claim_lease(caller).await {
        Ok(state) => axum::Json(serde_json::json!({
            "epoch": state.lease.epoch(),
            "head": state.head.map(|head| head.hex()),
        }))
        .into_response(),
        Err(fault) => faulted(&fault),
    }
}

#[derive(Debug, Deserialize)]
struct DeclareRequest {
    objects: Vec<DeclaredObject>,
}

#[derive(Debug, Deserialize)]
struct DeclaredObject {
    name: String,
    checksum: String,
    kind: String,
    padded_size: u64,
}

#[derive(Debug, Serialize)]
struct Target {
    name: String,
    url: String,
    expires_at_ms: i64,
    already_committed: bool,
}

fn kind_of(word: &str) -> Option<ObjectKind> {
    [
        ObjectKind::Base,
        ObjectKind::Segment,
        ObjectKind::Manifest,
        ObjectKind::Blob,
        ObjectKind::Pack,
        ObjectKind::ShareEntry,
    ]
    .into_iter()
    .find(|kind| kind.as_str() == word)
}

async fn declare(
    State(server): State<Shared>,
    Path(vault): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(vault) = key_of(&vault) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let path = format!("/v1/vaults/{}/declare", vault.hex());
    let caller = match authenticate(&headers, "POST", &path, &body, vault) {
        Ok(caller) => caller,
        Err(refusal) => return refused(&refusal),
    };
    let Ok(request) = serde_json::from_slice::<DeclareRequest>(&body) else {
        return refused(&Refusal::SignatureInvalid);
    };

    let mut declarations = Vec::with_capacity(request.objects.len());
    for object in &request.objects {
        let (Some(name), Some(checksum), Some(kind)) = (
            key_of(&object.name),
            hex::decode(&object.checksum)
                .ok()
                .and_then(|bytes| AttestedChecksum::from_slice(&bytes)),
            kind_of(&object.kind),
        ) else {
            return refused(&Refusal::SignatureInvalid);
        };
        declarations.push(Declaration {
            name,
            checksum,
            kind,
            padded_size: object.padded_size,
        });
    }

    let mut server = server.lock().await;
    match server.gateway.declare(caller, &declarations).await {
        Ok(targets) => axum::Json(
            targets
                .into_iter()
                .map(|target| Target {
                    name: target.name.hex(),
                    url: target.url,
                    expires_at_ms: target.expires_at.millis(),
                    already_committed: target.already_committed,
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(fault) => faulted(&fault),
    }
}

#[derive(Debug, Deserialize)]
struct CommitRequest {
    generation: String,
    objects: Vec<String>,
    manifest_head: String,
    prev_head: Option<String>,
    first_txid: u64,
    last_txid: u64,
}

async fn commit(
    State(server): State<Shared>,
    Path(vault): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(vault) = key_of(&vault) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let path = format!("/v1/vaults/{}/commit", vault.hex());
    let caller = match authenticate(&headers, "POST", &path, &body, vault) {
        Ok(caller) => caller,
        Err(refusal) => return refused(&refusal),
    };
    let Ok(request) = serde_json::from_slice::<CommitRequest>(&body) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let Some(generation) = Generation::parse(&request.generation) else {
        // A client does not get to choose the gateway's keyspace.
        return refused(&Refusal::MalformedGeneration);
    };
    let objects: Option<Vec<ObjectName>> =
        request.objects.iter().map(|name| key_of(name)).collect();
    let (Some(objects), Some(manifest_head)) = (objects, key_of(&request.manifest_head)) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let prev_head = match request.prev_head.as_deref().map(key_of) {
        // A malformed previous head is not the same claim as "no head yet",
        // and collapsing them would let a writer that never read the head
        // present itself as one that had (F7).
        Some(None) => return refused(&Refusal::SignatureInvalid),
        Some(Some(head)) => Some(head),
        None => None,
    };

    let mut server = server.lock().await;
    let outcome = server
        .gateway
        .commit(
            caller,
            &CommitInput {
                generation,
                objects,
                manifest_head,
                prev_head,
                first_txid: request.first_txid,
                last_txid: request.last_txid,
            },
        )
        .await;
    match outcome {
        Ok(outcome) => axum::Json(serde_json::json!({
            "head": outcome.head.hex(),
            "committed_at_ms": outcome.committed_at.millis(),
            "already_committed": outcome
                .already_committed
                .iter()
                .map(Key32::hex)
                .collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(fault) => faulted(&fault),
    }
}

#[derive(Debug, Deserialize)]
struct DeleteRequest {
    objects: Vec<String>,
    /// THE MEMBER SAW THE WARNING AND SAID YES (F4). Computed on the phone,
    /// because the row census is readable only there.
    #[serde(default)]
    member_confirmed_shrink: bool,
}

async fn delete(
    State(server): State<Shared>,
    Path(vault): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(vault) = key_of(&vault) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let path = format!("/v1/vaults/{}/delete", vault.hex());
    let caller = match authenticate(&headers, "POST", &path, &body, vault) {
        Ok(caller) => caller,
        Err(refusal) => return refused(&refusal),
    };
    let Ok(request) = serde_json::from_slice::<DeleteRequest>(&body) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let Some(names): Option<Vec<ObjectName>> =
        request.objects.iter().map(|name| key_of(name)).collect()
    else {
        return refused(&Refusal::SignatureInvalid);
    };

    let mut server = server.lock().await;
    match server
        .gateway
        .delete(caller, &names, request.member_confirmed_shrink)
        .await
    {
        Ok(outcomes) => axum::Json(
            outcomes
                .into_iter()
                .map(|outcome| {
                    serde_json::json!({
                        "name": outcome.name.hex(),
                        // THE REFUSAL REASON IS `gateway-core`'S MAPPING, not
                        // this file's: a phone branches on it and must get the
                        // same answer from both deployments.
                        "refusal": centraid_gateway_core::engine::refusal_reason(outcome.verdict)
                            .map(|reason| format!("{reason:?}")),
                    })
                })
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(fault) => faulted(&fault),
    }
}

/// Did the client attest a checksum for these bytes, and is it true?
///
/// # Errors
///
/// [`Refusal::Checksum`] with a mismatch when the header is present and either
/// is not a checksum at all or is one for some other bytes — both are the
/// client saying something untrue about what it is uploading, and the proxy is
/// holding the bytes, so this is the cheapest place in the whole path to find
/// out rather than one round trip later at the commit.
fn attestation(headers: &HeaderMap, body: &[u8]) -> Result<bool, Refusal> {
    let Some(text) = header(headers, ATTESTED_CHECKSUM_HEADER) else {
        // ABSENT IS ALLOWED THROUGH ON PURPOSE. That is exactly what R2
        // produces for a client that sent no checksum; the commit refuses it in
        // both deployments, and a proxy that refused it here instead would be a
        // proxy whose answer differs from the hosted adapter's (§3).
        return Ok(false);
    };
    let claimed = hex::decode(text.trim())
        .ok()
        .and_then(|bytes| AttestedChecksum::from_slice(&bytes));
    match claimed {
        Some(claimed) if claimed == AttestedChecksum::of(body) => Ok(true),
        _ => Err(Refusal::Checksum(ChecksumFault::Mismatch)),
    }
}

/// The proxy's write half: the `PUT` a phone makes to the target it was handed.
async fn put_object(
    State(server): State<Shared>,
    Path((vault, name)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (Some(vault), Some(name)) = (key_of(&vault), key_of(&name)) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let path = format!("/v1/objects/{}/{}", vault.hex(), name.hex());
    if let Err(refusal) = authenticate(&headers, "PUT", &path, &body, vault) {
        return refused(&refusal);
    }

    // A CLIENT THAT SENT NO CHECKSUM HEADER IS THE CASE R2 REALLY PRODUCES, and
    // the store must record that it attested nothing rather than inventing an
    // attestation — because "no attestation" is a REJECTION at commit, not a
    // shrug, and an adapter that filled one in would be an adapter that had
    // quietly turned write-once into a comment.
    //
    // **AND THE HEADER'S VALUE IS READ, not merely counted.** A presence check
    // makes the header a flag a client can set to any string at all, so an
    // operator debugging a commit that failed on the checksum finds a header
    // that means nothing and learns nothing from it. Here the value is compared
    // against the bytes that just arrived, and a lie is refused *at the upload*
    // rather than one round trip later at the commit — the proxy is holding the
    // bytes, so it is the cheapest place in the whole path to find out.
    //
    // An ABSENT header is still allowed through on purpose: that is exactly
    // what R2 produces for a client that sent no checksum, the commit refuses
    // it in both deployments, and a proxy that refused it here instead would be
    // a proxy whose answer differs from the hosted adapter's (§3).
    let attested = match attestation(&headers, &body) {
        Ok(attested) => attested,
        Err(refusal) => return refused(&refusal),
    };
    let server = server.lock().await;
    match server
        .gateway
        .bytes
        .write(&vault, &name, body.to_vec(), attested)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(fault) => faulted(&Fault::Store(fault)),
    }
}

/// The proxy's read half, and the other side of two-tenant isolation.
async fn get_object(
    State(server): State<Shared>,
    Path((vault, name)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    let (Some(vault), Some(name)) = (key_of(&vault), key_of(&name)) else {
        return refused(&Refusal::SignatureInvalid);
    };
    let path = format!("/v1/objects/{}/{}", vault.hex(), name.hex());
    if let Err(refusal) = authenticate(&headers, "GET", &path, &[], vault) {
        return refused(&refusal);
    }
    let server = server.lock().await;
    match server.gateway.bytes.read(&vault, &name).await {
        Ok(Some(bytes)) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response(),
        Ok(None) => refused(&Refusal::ObjectUnknown(name)),
        Err(fault) => faulted(&Fault::Store(fault)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE ATTESTATION HEADER'S VALUE MEANS SOMETHING.
    ///
    /// It used to be checked with `contains_key` alone, so any string at all
    /// counted as an attestation and an operator debugging a failed commit
    /// found a header that told them nothing. Now a header that is present and
    /// untrue is refused where the bytes are, one round trip earlier than the
    /// commit that would otherwise have caught it.
    #[test]
    fn an_attestation_is_believed_only_when_it_matches_the_bytes() {
        let body = b"the bytes a phone is uploading".to_vec();
        let mut headers = HeaderMap::new();
        assert_eq!(
            attestation(&headers, &body),
            Ok(false),
            "no header is not a refusal here: it is what R2 produces, and the \
             commit is where both deployments refuse it"
        );

        headers.insert(
            ATTESTED_CHECKSUM_HEADER,
            AttestedChecksum::of(&body)
                .hex()
                .parse()
                .expect("a header value"),
        );
        assert_eq!(attestation(&headers, &body), Ok(true));

        headers.insert(
            ATTESTED_CHECKSUM_HEADER,
            AttestedChecksum::of(b"quite different bytes")
                .hex()
                .parse()
                .expect("a header value"),
        );
        assert_eq!(
            attestation(&headers, &body),
            Err(Refusal::Checksum(ChecksumFault::Mismatch)),
            "an attestation for other bytes is a lie, not a shrug"
        );

        headers.insert(
            ATTESTED_CHECKSUM_HEADER,
            "not a checksum".parse().expect("a header value"),
        );
        assert_eq!(
            attestation(&headers, &body),
            Err(Refusal::Checksum(ChecksumFault::Mismatch)),
            "a header that is not a checksum at all is refused rather than \
             counted as an attestation"
        );
    }

    /// A MISSING ATTESTATION IS THE CLIENT'S FAULT, AND THE STATUS SAYS SO.
    ///
    /// It is the commonest refusal a new client meets — every object uploaded
    /// and the commit refused the lot — and "checksum missing" from a server
    /// reads like the server lost something. A 4xx says the request was wrong.
    #[test]
    fn a_missing_attestation_is_carried_by_a_client_error_status() {
        for code in [
            ErrorCode::GatewayChecksumMissing,
            ErrorCode::GatewayChecksumMismatch,
        ] {
            assert!(
                status_for(code).is_client_error(),
                "{code:?} must not read as a server fault"
            );
        }
    }

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
            ErrorCode::GatewayLeaseStale,
            ErrorCode::GatewayNotLeaseHolder,
            ErrorCode::VaultMoved,
            ErrorCode::GatewayQuotaExceeded,
            ErrorCode::GatewayPlanLapsed,
            ErrorCode::GatewayDeleteRefused,
            ErrorCode::GatewayObjectTooLarge,
            ErrorCode::GatewayObjectUnknown,
        ] {
            assert!(
                !status_for(code).is_server_error(),
                "{code:?} is a rule saying no, not a server failing"
            );
        }
    }

    /// A SUPERSEDED DEVICE AND A STRANGER GET DIFFERENT STATUSES, because the
    /// phone's behaviour differs: freeze the vault read-only and keep the
    /// spool, or show a refusal.
    #[test]
    fn a_moved_vault_is_not_an_unauthorized() {
        assert_ne!(
            status_for(ErrorCode::VaultMoved),
            status_for(ErrorCode::Unauthorized)
        );
    }

    /// The four header names are the signature's own inputs, and a rename here
    /// is a phone that cannot authenticate at all.
    #[test]
    fn the_signed_headers_are_named_once() {
        for name in [
            CERTIFICATE_HEADER,
            SIGNATURE_HEADER,
            TIMESTAMP_HEADER,
            PROTOCOL_HEADER,
        ] {
            assert!(name.starts_with("centraid-"));
            assert_eq!(name.to_ascii_lowercase(), name, "headers arrive lowercase");
        }
    }

    #[test]
    fn every_object_kind_survives_its_wire_word() {
        for kind in [
            ObjectKind::Base,
            ObjectKind::Segment,
            ObjectKind::Manifest,
            ObjectKind::Blob,
            ObjectKind::Pack,
            ObjectKind::ShareEntry,
        ] {
            assert_eq!(kind_of(kind.as_str()), Some(kind));
        }
        assert_eq!(kind_of("something-a-newer-phone-invented"), None);
    }
}
