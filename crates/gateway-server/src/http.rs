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
use centraid_gateway_core::checksum::AttestedChecksum;
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
/// # THE COMPANION TRAVELS WITH THE REFUSAL
///
/// Two codes are meaningless without one, and both companions exist in the
/// rules already — `Refusal::VaultMoved` carries the epoch and the moment, and
/// `Refusal::VersionWindow` carries the range that `version::admit`'s own
/// comment says is there "so the phone can render the typed state without a
/// second round trip". This body used to drop both, so a phone learned THAT its
/// vault had moved and never when — half of "N changes since `<date>`", and the
/// half a client would otherwise have to invent from its own clock.
///
/// They are `Option`s because a body-less code has neither, and
/// `centraid-gateway-client` treats a missing one as malformed rather than as a
/// default: a shell that drew "0 changes since 1 January 1970" over a frozen
/// vault would be showing a fabricated fact.
#[derive(Debug, Serialize)]
pub struct ErrorBody {
    /// The code from `Refusal::code()`. **Never a sentence**: the member-facing
    /// wording is derived from the code by the shell, which is the rule
    /// `error.proto` already states for every other refusal in this product.
    pub code: String,
    /// The server's clock, so a phone with a wrong one can re-sign **once**.
    pub server_time_ms: i64,
    /// `centraid.core.v1.VaultMoved`, for the moved code and nothing else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moved: Option<MovedBody>,
    /// The server's supported range, for the version code and nothing else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolBody>,
}

/// `centraid.core.v1.VaultMoved`'s two fields, on the HTTP wire.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct MovedBody {
    /// The lease epoch that holds the vault now.
    pub current_epoch: u64,
    /// When it took it, on this server's clock.
    pub moved_at_ms: i64,
}

/// The protocol range this server supports, inclusive.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ProtocolBody {
    /// Inclusive.
    pub min: u32,
    /// Inclusive.
    pub max: u32,
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
        _ => StatusCode::BAD_REQUEST,
    }
}

fn refused(refusal: &Refusal) -> Response {
    let code = refusal.code();
    (status_for(code), axum::Json(body_of(refusal, code))).into_response()
}

/// Render one refusal, companion and all.
///
/// A `match` over the two refusals that carry one, so a third minted later
/// fails to compile here rather than reaching a phone stripped of the field it
/// needs.
fn body_of(refusal: &Refusal, code: ErrorCode) -> ErrorBody {
    let (moved, protocol) = match refusal {
        Refusal::VaultMoved {
            current_epoch,
            moved_at,
        } => (
            Some(MovedBody {
                current_epoch: *current_epoch,
                moved_at_ms: moved_at.millis(),
            }),
            None,
        ),
        Refusal::VersionWindow { server, .. } => (
            None,
            Some(ProtocolBody {
                min: server.0,
                max: server.1,
            }),
        ),
        _ => (None, None),
    };
    ErrorBody {
        code: format!("{code:?}"),
        server_time_ms: crate::clock::now().millis(),
        moved,
        protocol,
    }
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
                axum::Json(ErrorBody {
                    code: format!("{:?}", ErrorCode::Internal),
                    server_time_ms: crate::clock::now().millis(),
                    moved: None,
                    protocol: None,
                }),
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
    let attested = headers.contains_key("centraid-attested-checksum");
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

    /// **A MOVED REFUSAL CARRIES WHEN IT MOVED.** Without this a phone knows
    /// THAT its vault moved and never when, which is half of "N changes since
    /// `<date>`" — and a client inferring the date from its own clock would be
    /// inventing the one fact the refusal exists to carry.
    #[test]
    fn a_moved_refusal_carries_its_epoch_and_its_moment() {
        let refusal = Refusal::VaultMoved {
            current_epoch: 4,
            moved_at: centraid_gateway_core::ServerTime::from_millis(1_770_000_000_000),
        };
        let body = body_of(&refusal, refusal.code());
        let moved = body.moved.expect("the companion rides with the code");
        assert_eq!(moved.current_epoch, 4);
        assert_eq!(moved.moved_at_ms, 1_770_000_000_000);
        assert!(body.protocol.is_none(), "one companion per refusal");
    }

    /// The range rides with the version refusal so the phone can render "this
    /// server needs an update" without a second round trip — which is what
    /// `version::admit`'s own comment promises.
    #[test]
    fn a_version_refusal_carries_the_range_this_server_supports() {
        let refusal = Refusal::VersionWindow {
            server: (PROTOCOL_MIN, PROTOCOL_MAX),
            client: 9,
        };
        let body = body_of(&refusal, refusal.code());
        let range = body.protocol.expect("the range rides with the code");
        assert_eq!((range.min, range.max), (PROTOCOL_MIN, PROTOCOL_MAX));
        assert!(body.moved.is_none());
    }

    /// A refusal with no companion carries neither, and the fields are skipped
    /// rather than serialised as nulls.
    #[test]
    fn a_refusal_with_no_companion_carries_neither() {
        let body = body_of(&Refusal::NotLeaseHolder, ErrorCode::GatewayNotLeaseHolder);
        assert!(body.moved.is_none() && body.protocol.is_none());
        let rendered = serde_json::to_string(&body).expect("serialises");
        assert!(!rendered.contains("moved"), "{rendered}");
        assert!(!rendered.contains("protocol"), "{rendered}");
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
