//! axum over the rules: the routes of protocol 1 (`CGW4`, #1080, #1212).
//!
//! **Every answer comes out of [`crate::rules`].** A handler parses what
//! arrived, hands it to [`Shared::rules`], and renders what came back; the one
//! mapping from a refusal to a body and a status is
//! [`crate::rules::code::RefusalBody`] and [`crate::rules::code::Code::status`].
//!
//! # WHAT A HANDLER DECIDES
//!
//! How a token, a digest and a range arrive in headers; how a body becomes a
//! typed request; how bytes stream into a staged packfile and out of committed
//! packfiles by `(pack_id, pack_offset, size)`. Never whether something is
//! allowed.
//!
//! # BYTES NEVER SIT IN MEMORY WHOLE
//!
//! A bundle is cut into frames by [`crate::rules::bundle::Decoder`] as it
//! arrives, streaming valid frames sequentially into one staged packfile
//! (`staging/<pack>.pack`) while hashing each frame incrementally. When the
//! stream completes — or cuts off mid-frame — partial trailing bytes are
//! truncated back to the end of the last complete valid frame, the packfile is
//! `fsync`ed once, renamed into `packs/<vault>/<pack>.pack`, and all completed
//! frames commit in one `BEGIN IMMEDIATE … COMMIT` transaction. `GET` and
//! `fetch` serve slices directly via positioned reads (`pread`) without loading
//! whole packfiles into memory or reopening a packfile per object.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::{Body, BodyDataStream, Bytes};
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures::StreamExt as _;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::rules::bundle::{Decoder, FrameHeader, HEADER_LEN, Step, header as frame_header};
use crate::rules::code::{Code, Refusal, RefusalBody};
use crate::rules::engine::{Access, Arrival, Finding, Gateway, PutOutcome};
use crate::rules::ids::{Name, Token, VaultId};
use crate::rules::limits::{
    LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_JSON_BYTES, MAX_NAMES, MAX_OBJECT_BYTES,
};
use crate::rules::range::resolve;
use crate::rules::state::{Fault, ObjectRecord, StoreFault};
use crate::rules::wire::{
    BundleAnswer, CODE_HEADER, CheckRequest, DIGEST_HEADER, DeleteRequest, FrameResult, Missing,
    Names, PairRequest, Revoked, SetHead, UndoRequest,
};
use crate::server::state::SqliteState;
use crate::server::store::{ObjectStore, PackId, PackLocation, PackStaging, StagedPack};
use crate::server::{Event, Handle, Shared};

/// Chunk size for positioned packfile streaming reads (256 KiB).
const STREAM_CHUNK_BYTES: u64 = 256 * 1024;

/// **Every call into the rules and every file it touches runs on the blocking
/// pool**, never on an async worker: a transaction with `synchronous = FULL`
/// and an `fsync`ed rename wait on the disk, and a worker that waits is a
/// worker no other connection is served on (#1191, R2).
async fn blocking<T: Send + 'static>(
    shared: &Handle,
    op: impl FnOnce(&mut Gateway<SqliteState>) -> Result<T, Fault> + Send + 'static,
) -> Result<T, Fault> {
    let shared = Arc::clone(shared);
    match tokio::task::spawn_blocking(move || shared.rules(op)).await {
        Ok(outcome) => outcome,
        Err(error) => Err(StoreFault::new(format!("a blocking task failed: {error}")).into()),
    }
}

/// Mark `name` as the scrub marks a slice it cannot find, when the index holds
/// it and its packfile is missing or truncated shorter than `pack_offset + size`.
/// Answers whether it did.
fn mark_if_gone(
    gateway: &mut Gateway<SqliteState>,
    store: &ObjectStore,
    vault: &VaultId,
    name: &Name,
    now_ms: i64,
) -> Result<bool, Fault> {
    let Some((record, loc)) = gateway.state.object_with_location(vault, name)? else {
        return Ok(false);
    };
    if record.damaged_at_ms.is_some() || store.has_slice(vault, loc, record.size) {
        return Ok(false);
    }
    gateway.record_scrub(vault, &record, Finding::Missing, now_ms)?;
    Ok(true)
}

/// The routes.
pub fn router(shared: Handle) -> Router {
    Router::new()
        .route("/v1/info", get(info))
        .route("/v1/nonce", post(nonce))
        .route("/v1/pair", post(pair))
        .route("/v1/v/{vault}/head", get(get_head).put(put_head))
        .route("/v1/v/{vault}/snapshots", get(snapshots))
        .route("/v1/v/{vault}/exists", post(exists))
        .route("/v1/v/{vault}/o/{name}", get(get_object).head(head_object))
        .route("/v1/v/{vault}/bundle", post(bundle))
        .route("/v1/v/{vault}/fetch", post(fetch))
        .route("/v1/v/{vault}/objects", get(objects))
        .route("/v1/v/{vault}/held", get(held))
        .route("/v1/v/{vault}/delete", post(delete))
        .route("/v1/v/{vault}/check", post(check))
        .route("/v1/v/{vault}/undo", post(undo))
        .route("/v1/v/{vault}/revoke", post(revoke))
        .fallback(no_route)
        .method_not_allowed_fallback(wrong_method)
        .with_state(shared)
}

// ─── rendering ───────────────────────────────────────────────────────────────

fn status(code: Code) -> StatusCode {
    StatusCode::from_u16(code.status()).unwrap_or(StatusCode::BAD_REQUEST)
}

fn json<T: Serialize>(code: StatusCode, value: &T) -> Response {
    (code, axum::Json(value)).into_response()
}

/// A refusal: its status, its code in a header, and its body.
fn refused(refusal: &Refusal, now_ms: i64) -> Response {
    let code = refusal.code();
    let mut response = json(status(code), &RefusalBody::of(refusal, now_ms));
    response
        .headers_mut()
        .insert(CODE_HEADER, HeaderValue::from_static(code.as_str()));
    response
}

/// A fault: a refusal is rendered as one; a store fault is a 500 whose detail
/// goes to the operator's log and never to the wire, where it could name a
/// path.
fn faulted(fault: &Fault, now_ms: i64) -> Response {
    match fault {
        Fault::Refused(refusal) => refused(refusal, now_ms),
        Fault::Store(store) => {
            tracing::error!(detail = %store, "a store failed");
            let mut response = json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &RefusalBody::internal(now_ms),
            );
            response.headers_mut().insert(
                CODE_HEADER,
                HeaderValue::from_static(Code::Internal.as_str()),
            );
            response
        }
    }
}

/// Render an outcome: the value on success, the fault otherwise.
fn answer<T: Serialize>(shared: &Shared, code: StatusCode, outcome: Result<T, Fault>) -> Response {
    match outcome {
        Ok(value) => json(code, &value),
        Err(fault) => faulted(&fault, shared.now()),
    }
}

// ─── parsing ─────────────────────────────────────────────────────────────────

/// `Authorization: Bearer <64 hex>`. Anything else is `UNAUTHORIZED`.
fn bearer(headers: &HeaderMap) -> Result<Token, Refusal> {
    let value = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .ok_or(Refusal::Unauthorized)?;
    let (scheme, token) = value.split_once(' ').ok_or(Refusal::Unauthorized)?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return Err(Refusal::Unauthorized);
    }
    token.trim().parse().map_err(|_| Refusal::Unauthorized)
}

fn vault_of(path: Result<Path<String>, PathRejection>) -> Result<VaultId, Refusal> {
    let Path(vault) = path.map_err(|_| Refusal::BadRequest)?;
    vault.parse().map_err(|_| Refusal::BadRequest)
}

fn object_of(
    path: Result<Path<(String, String)>, PathRejection>,
) -> Result<(VaultId, Name), Refusal> {
    let Path((vault, name)) = path.map_err(|_| Refusal::BadRequest)?;
    Ok((
        vault.parse().map_err(|_| Refusal::BadRequest)?,
        name.parse().map_err(|_| Refusal::BadRequest)?,
    ))
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

/// A JSON body of at most [`MAX_JSON_BYTES`].
async fn read_json<T: DeserializeOwned>(body: Body) -> Result<T, Refusal> {
    let mut stream = body.into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Refusal::BadRequest)?;
        if bytes.len() + chunk.len() > MAX_JSON_BYTES {
            return Err(Refusal::TooLarge {
                limit: MAX_JSON_BYTES as u64,
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| Refusal::BadRequest)
}

// ─── routes ──────────────────────────────────────────────────────────────────

async fn info(State(shared): State<Handle>) -> Response {
    let now = shared.now();
    let outcome = blocking(&shared, move |gateway| Ok(gateway.info(now))).await;
    answer(&shared, StatusCode::OK, outcome)
}

/// `POST nonce`: no auth, no body, no vault, and **no write**. The random part
/// is drawn here, from the OS; the rules MAC it under the gateway's key.
async fn nonce(State(shared): State<Handle>) -> Response {
    let now = shared.now();
    let drawn = shared.fresh_nonce_id();
    let outcome = match drawn {
        Ok(random) => blocking(&shared, move |gateway| gateway.issue_nonce(random, now)).await,
        Err(fault) => Err(fault),
    };
    answer(&shared, StatusCode::OK, outcome)
}

async fn pair(State(shared): State<Handle>, body: Body) -> Response {
    let request: PairRequest = match read_json(body).await {
        Ok(request) => request,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let token = match shared.fresh_token() {
        Ok(token) => token,
        Err(fault) => return faulted(&fault, shared.now()),
    };
    let now = shared.now();
    let (vault_id, kind, label) = (request.vault_id, request.kind, request.label.clone());
    let outcome = blocking(&shared, move |gateway| gateway.pair(&request, &token, now)).await;
    if let Ok(paired) = &outcome {
        shared.announce(&Event::Paired {
            vault: vault_id,
            kind,
            epoch: paired.epoch,
            label,
        });
    }
    answer(&shared, StatusCode::OK, outcome)
}

async fn get_head(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let outcome = async {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        blocking(&shared, move |gateway| gateway.head(&vault, &token)).await
    }
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

async fn put_head(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let parsed = (|| Ok::<_, Refusal>((vault_of(path)?, bearer(&headers)?)))();
    let (vault, token) = match parsed {
        Ok(parsed) => parsed,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let request: SetHead = match read_json(body).await {
        Ok(request) => request,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let now = shared.now();
    let outcome = blocking(&shared, move |gateway| {
        gateway.set_head(&vault, &token, &request, now)
    })
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

async fn snapshots(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Page>, QueryRejection>,
    headers: HeaderMap,
) -> Response {
    let outcome = async {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        let (after, limit) = page_of(query)?;
        blocking(&shared, move |gateway| {
            gateway.snapshots(&vault, &token, after.as_ref(), limit)
        })
        .await
    }
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

async fn exists(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let parsed = (|| Ok::<_, Refusal>((vault_of(path)?, bearer(&headers)?)))();
    let (vault, token) = match parsed {
        Ok(parsed) => parsed,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let names: Names = match read_json(body).await {
        Ok(names) => names,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    // A TEST'S LYING GATEWAY says it holds every name (#1188, B13).
    #[cfg(feature = "test-harness")]
    {
        shared.store().knobs().note_exists(names.names.len());
        if shared.store().knobs().lies() {
            return answer(
                &shared,
                StatusCode::OK,
                Ok::<_, Fault>(Missing {
                    missing: Vec::new(),
                }),
            );
        }
    }
    let worker = Arc::clone(&shared);
    let outcome = blocking(&shared, move |gateway| {
        let missing = gateway.exists(&vault, &token, &names.names)?;
        if names.names.len() > MAX_NAMES {
            return Ok(missing);
        }
        let missing_set: BTreeSet<Name> = missing.iter().copied().collect();
        let store = worker.store();
        let mut pack_lens: BTreeMap<PackId, Option<u64>> = BTreeMap::new();
        let mut gone = Vec::new();
        for name in &names.names {
            if missing_set.contains(name) {
                continue;
            }
            if let Some((record, loc)) = gateway.state.object_with_location(&vault, name)? {
                let pack_len = *pack_lens
                    .entry(loc.pack_id)
                    .or_insert_with(|| store.pack_len(&vault, &loc.pack_id));
                let present = loc
                    .pack_offset
                    .checked_add(record.size)
                    .is_some_and(|end| pack_len.is_some_and(|len| len >= end));
                if !present {
                    gone.push(*name);
                }
            }
        }
        if gone.is_empty() {
            return Ok(missing);
        }
        let now = worker.now();
        for name in &gone {
            mark_if_gone(gateway, store, &vault, name, now)?;
        }
        gateway.exists(&vault, &token, &names.names)
    })
    .await;
    answer(
        &shared,
        StatusCode::OK,
        outcome.map(|missing| Missing { missing }),
    )
}

/// The most of a bundle's body read and discarded so its refusal is heard.
const DRAIN_BUNDLE_BYTES: u64 = MAX_BUNDLE_BYTES;

/// Read and discard what is left of a body, up to `limit` bytes.
async fn drain(stream: &mut BodyDataStream, limit: u64) {
    let mut read = 0_u64;
    while read <= limit {
        match stream.next().await {
            Some(Ok(chunk)) => read = read.saturating_add(chunk.len() as u64),
            _ => return,
        }
    }
}

/// The object a `GET` or `HEAD` serves, and its packfile path and offset.
async fn served(
    shared: &Handle,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: &HeaderMap,
) -> Result<(ObjectRecord, PathBuf, u64), Fault> {
    let (vault, name) = object_of(path)?;
    let token = bearer(headers)?;
    let worker = Arc::clone(shared);
    blocking(shared, move |gateway| {
        let record = gateway.object(&vault, &token, &name)?;
        let Some((_, loc)) = gateway.state.object_with_location(&vault, &name)? else {
            return Err(Refusal::NotFound { name: Some(name) }.into());
        };
        if !worker.store().has_slice(&vault, loc, record.size) {
            return Err(Refusal::NotFound { name: Some(name) }.into());
        }
        let pack_file = worker.store().pack_path(&vault, &loc.pack_id);
        Ok((record, pack_file, loc.pack_offset))
    })
    .await
}

async fn get_object(
    State(shared): State<Handle>,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let (record, pack_file, pack_offset) = match served(&shared, path, &headers).await {
        Ok(served) => served,
        Err(fault) => return faulted(&fault, shared.now()),
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let span = match resolve(range, record.size) {
        Ok(span) => span,
        Err(refusal) => {
            let mut response = refused(&refusal, shared.now());
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{}", record.size)) {
                response.headers_mut().insert(header::CONTENT_RANGE, value);
            }
            return response;
        }
    };
    let (first, length) = span.map_or((0, record.size), |span| (span.first, span.len()));
    let Some(start_offset) = pack_offset.checked_add(first) else {
        return faulted(
            &StoreFault::new("pack slice offset overflow").into(),
            shared.now(),
        );
    };
    let opened = tokio::task::spawn_blocking(move || std::fs::File::open(pack_file)).await;
    let file = match opened {
        Ok(Ok(file)) => Arc::new(file),
        _ => {
            return refused(
                &Refusal::NotFound {
                    name: Some(record.name),
                },
                shared.now(),
            );
        }
    };
    let mut response = Response::new(Body::from_stream(slice_stream(file, start_offset, length)));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
    match span {
        None => {
            if let Ok(value) = HeaderValue::from_str(&record.digest.header()) {
                headers.insert(DIGEST_HEADER, value);
            }
        }
        Some(span) => {
            if let Ok(value) = HeaderValue::from_str(&span.content_range(record.size)) {
                headers.insert(header::CONTENT_RANGE, value);
            }
            *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        }
    }
    response
}

async fn head_object(
    State(shared): State<Handle>,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let (record, _, _) = match served(&shared, path, &headers).await {
        Ok(served) => served,
        Err(fault) => return faulted(&fault, shared.now()),
    };
    let mut response = Response::new(Body::empty());
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(record.size));
    if let Ok(value) = HeaderValue::from_str(&record.digest.header()) {
        headers.insert(DIGEST_HEADER, value);
    }
    response
}

/// Stream exactly `length` bytes starting at `offset` in `file` via positioned
/// reads in pieces of at most 256 KiB.
fn slice_stream(
    file: Arc<std::fs::File>,
    offset: u64,
    length: u64,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    futures::stream::unfold(
        (Some(file), offset, length),
        |(file, pos, remaining)| async move {
            let file = file?;
            if remaining == 0 {
                return None;
            }
            let want = usize::try_from(remaining.min(STREAM_CHUNK_BYTES)).unwrap_or(256 * 1024);
            let reader = Arc::clone(&file);
            let outcome = tokio::task::spawn_blocking(move || {
                let mut buffer = vec![0_u8; want];
                ObjectStore::read_at(&reader, pos, &mut buffer)?;
                Ok::<Bytes, std::io::Error>(Bytes::from(buffer))
            })
            .await;
            match outcome {
                Ok(Ok(bytes)) => {
                    let read = bytes.len() as u64;
                    Some((Ok(bytes), (Some(file), pos + read, remaining - read)))
                }
                Ok(Err(error)) => Some((Err(error), (None, pos, 0))),
                Err(join_err) => Some((
                    Err(std::io::Error::other(join_err.to_string())),
                    (None, pos, 0),
                )),
            }
        },
    )
}

/// `POST bundle`: authorise once, stream frames into one staged packfile, and
/// commit all completed valid frames in one `BEGIN IMMEDIATE … COMMIT`
/// transaction — both on clean EOF and if the stream cuts off mid-frame.
async fn bundle(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let outcome = async {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        // A stranger is answered before a byte of the body is read.
        blocking(&shared, move |gateway| {
            gateway.authorize(&vault, &token, Access::Read)
        })
        .await?;
        let (_drop_tx, mut drop_rx) = tokio::sync::oneshot::channel::<()>();
        let task_shared = Arc::clone(&shared);
        let worker = tokio::spawn(async move {
            let _active = task_shared.bundle_guard();
            let mut stream = body.into_data_stream();
            let mut stream_dead = false;
            let received = async {
                blocking(&task_shared, move |gateway| {
                    gateway.authorize(&vault, &token, Access::Write)
                })
                .await?;
                if content_length(&headers).is_some_and(|length| length > MAX_BUNDLE_BYTES) {
                    return Err(Refusal::TooLarge {
                        limit: MAX_BUNDLE_BYTES,
                    }
                    .into());
                }
                receive_bundle(
                    &task_shared,
                    &vault,
                    &token,
                    &mut stream,
                    &mut drop_rx,
                    &mut stream_dead,
                )
                .await
            }
            .await;
            if received.is_err() && !stream_dead {
                drain(&mut stream, DRAIN_BUNDLE_BYTES).await;
            }
            received
        });
        worker
            .await
            .map_err(|err| Fault::from(StoreFault::new(err.to_string())))?
    }
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

struct ValidFrame {
    slot: usize,
    arrival: Arrival,
    pack_offset: u64,
}

enum CurrentFrame {
    /// Writing bytes into the staged packfile.
    Writing { slot: usize, header: FrameHeader },
    /// Reading past an oversize or disk-full frame whose result is already recorded.
    Skipping,
}

async fn receive_bundle(
    shared: &Handle,
    vault: &VaultId,
    token: &Token,
    stream: &mut BodyDataStream,
    aborted: &mut tokio::sync::oneshot::Receiver<()>,
    stream_dead: &mut bool,
) -> Result<BundleAnswer, Fault> {
    let mut slots: Vec<Option<FrameResult>> = Vec::new();
    let mut valid: Vec<ValidFrame> = Vec::new();
    let mut staging = shared.store().stage_pack();
    let mut decoder = Decoder::new();
    let mut current: Option<CurrentFrame> = None;

    let decode_outcome: Result<(), Fault> = async {
        loop {
            let next = tokio::select! {
                biased;
                chunk = stream.next() => chunk,
                _ = &mut *aborted => {
                    *stream_dead = true;
                    return Err(Refusal::BadRequest.into());
                }
                () = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                    *stream_dead = true;
                    return Err(Refusal::BadRequest.into());
                }
            };
            let Some(chunk) = next else {
                break;
            };
            let chunk = chunk.map_err(|_| {
                *stream_dead = true;
                Refusal::BadRequest
            })?;
            let mut rest: &[u8] = &chunk;
            loop {
                let (step, used) = decoder.step(rest)?;
                rest = &rest[used..];
                match step {
                    None => break,
                    Some(step) => {
                        advance_pack(&mut staging, &mut slots, &mut valid, &mut current, step)
                            .await?;
                    }
                }
            }
        }
        while let (Some(step), _) = decoder.step(&[])? {
            advance_pack(&mut staging, &mut slots, &mut valid, &mut current, step).await?;
        }
        decoder.finish()?;
        Ok(())
    }
    .await;

    if !valid.is_empty() {
        match staging.finish_pack().await {
            Ok(Some(staged_pack)) => {
                let outcomes =
                    commit_pack_bundle(shared, vault, token, staged_pack, &valid).await?;
                for (frame, outcome) in valid.iter().zip(outcomes) {
                    let name = frame.arrival.name;
                    slots[frame.slot] = Some(match outcome {
                        Ok(PutOutcome::Stored(_)) => FrameResult::Stored { name },
                        Ok(PutOutcome::AlreadyStored(_)) => FrameResult::There { name },
                        Ok(PutOutcome::Lifted(_)) => FrameResult::Held { name },
                        Err(refusal) => FrameResult::of_refusal(name, &refusal),
                    });
                }
            }
            Ok(None) => {
                return Err(StoreFault::new("staged frames had no staged packfile").into());
            }
            Err(error) => match Fault::from(error) {
                Fault::Refused(Refusal::DiskFull) if decode_outcome.is_ok() => {
                    for frame in &valid {
                        slots[frame.slot] = Some(FrameResult::Full {
                            name: frame.arrival.name,
                        });
                    }
                }
                other => return Err(other),
            },
        }
    }

    decode_outcome?;

    let mut results = Vec::with_capacity(slots.len());
    for slot in slots {
        results.push(slot.ok_or_else(|| StoreFault::new("a bundle frame had no result"))?);
    }
    Ok(BundleAnswer { results })
}

async fn advance_pack(
    staging: &mut PackStaging,
    slots: &mut Vec<Option<FrameResult>>,
    valid: &mut Vec<ValidFrame>,
    current: &mut Option<CurrentFrame>,
    step: Step<'_>,
) -> Result<(), Fault> {
    match step {
        Step::Header(header) => {
            let slot = slots.len();
            slots.push(None);
            if header.len > MAX_OBJECT_BYTES {
                slots[slot] = Some(FrameResult::TooLarge { name: header.name });
                *current = Some(CurrentFrame::Skipping);
                return Ok(());
            }
            match staging.begin_frame(header.len).await {
                Ok(_) => {
                    *current = Some(CurrentFrame::Writing { slot, header });
                }
                Err(error) => match Fault::from(error) {
                    Fault::Refused(Refusal::DiskFull) => {
                        slots[slot] = Some(FrameResult::Full { name: header.name });
                        *current = Some(CurrentFrame::Skipping);
                    }
                    Fault::Refused(Refusal::TooLarge { .. }) => {
                        slots[slot] = Some(FrameResult::TooLarge { name: header.name });
                        *current = Some(CurrentFrame::Skipping);
                    }
                    other => return Err(other),
                },
            }
        }
        Step::Body(bytes) => {
            if let Some(CurrentFrame::Writing { slot, header }) = current {
                let (slot_idx, name) = (*slot, header.name);
                if let Err(error) = staging.write_frame(bytes).await {
                    match Fault::from(error) {
                        Fault::Refused(Refusal::DiskFull) => {
                            slots[slot_idx] = Some(FrameResult::Full { name });
                            *current = Some(CurrentFrame::Skipping);
                        }
                        Fault::Refused(Refusal::TooLarge { .. }) => {
                            slots[slot_idx] = Some(FrameResult::TooLarge { name });
                            *current = Some(CurrentFrame::Skipping);
                        }
                        other => return Err(other),
                    }
                }
            }
        }
        Step::End => {
            let Some(finished) = current.take() else {
                return Ok(());
            };
            if let CurrentFrame::Writing { slot, header } = finished {
                match staging.finish_frame(&header.digest).await {
                    Ok(Some((computed, size, pack_offset))) => {
                        valid.push(ValidFrame {
                            slot,
                            arrival: Arrival {
                                name: header.name,
                                declared: header.digest,
                                digest: computed,
                                size,
                            },
                            pack_offset,
                        });
                    }
                    Ok(None) => {
                        slots[slot] = Some(FrameResult::Refused {
                            name: header.name,
                            code: Code::DigestMismatch,
                        });
                    }
                    Err(error) => match Fault::from(error) {
                        Fault::Refused(Refusal::DiskFull) => {
                            slots[slot] = Some(FrameResult::Full { name: header.name });
                        }
                        other => return Err(other),
                    },
                }
            }
        }
    }
    Ok(())
}

/// Promote `staged_pack` into `packs/<vault>/` and admit all `valid` frames in
/// **one** SQLite transaction (`BEGIN IMMEDIATE … COMMIT`). If zero frames end
/// up `Stored`, unlink the packfile.
async fn commit_pack_bundle(
    shared: &Handle,
    vault: &VaultId,
    token: &Token,
    staged_pack: StagedPack,
    valid: &[ValidFrame],
) -> Result<Vec<Result<PutOutcome, Refusal>>, Fault> {
    let now = shared.now();
    let (vault, token, worker) = (*vault, *token, Arc::clone(shared));
    let arrivals: Vec<Arrival> = valid.iter().map(|frame| frame.arrival).collect();
    let offsets: Vec<u64> = valid.iter().map(|frame| frame.pack_offset).collect();
    let outcomes = blocking(shared, move |gateway| {
        let store = worker.store();
        let _committing = worker.commit_guard();
        let pack_id = store.promote_pack(staged_pack, &vault)?;
        let result = (|| -> Result<Vec<Result<PutOutcome, Refusal>>, Fault> {
            let mut checked = BTreeSet::new();
            for arrival in &arrivals {
                if checked.insert(arrival.name) {
                    mark_if_gone(gateway, store, &vault, &arrival.name, now)?;
                }
            }
            let slot = gateway.state.pack_slot();
            let outcomes = gateway.put_bundle(&vault, &token, &arrivals, now, |index| {
                #[cfg(feature = "test-harness")]
                if store.knobs().commit_fails() {
                    return Err(StoreFault::new("a commit the test made fail").into());
                }
                *slot
                    .lock()
                    .map_err(|_| StoreFault::new("the pack slot lock was poisoned"))? =
                    Some(PackLocation {
                        pack_id,
                        pack_offset: offsets[index],
                    });
                #[cfg(feature = "test-harness")]
                store.knobs().object_committed();
                Ok(())
            })?;
            let any_stored = outcomes
                .iter()
                .any(|outcome| matches!(outcome, Ok(PutOutcome::Stored(_))));
            if !any_stored {
                store.remove_pack(&vault, &pack_id)?;
            }
            Ok(outcomes)
        })();
        if result.is_err() {
            let _ = store.remove_pack(&vault, &pack_id);
        }
        result
    })
    .await?;
    #[cfg(feature = "test-harness")]
    for _ in 0..outcomes.len() {
        shared.store().knobs().frame_done();
    }
    Ok(outcomes)
}

/// `POST fetch`: the rules plan which objects, in which order; the answer
/// streams them in the bundle framing using positioned reads over cached
/// packfile handles. An object whose packfile slice is missing or truncated is
/// left out like an unknown name, rather than promised in a header and cut short.
async fn fetch(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let parsed = (|| Ok::<_, Refusal>((vault_of(path)?, bearer(&headers)?)))();
    let (vault, token) = match parsed {
        Ok(parsed) => parsed,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let names: Names = match read_json(body).await {
        Ok(names) => names,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let worker = Arc::clone(&shared);
    let planned = blocking(&shared, move |gateway| {
        let plan = gateway.fetch(&vault, &token, &names.names)?;
        let store = worker.store();
        let mut pack_lens: BTreeMap<PackId, Option<u64>> = BTreeMap::new();
        let mut entries = Vec::with_capacity(plan.len());
        for record in plan {
            let Some((_, loc)) = gateway.state.object_with_location(&vault, &record.name)? else {
                continue;
            };
            let pack_len = *pack_lens
                .entry(loc.pack_id)
                .or_insert_with(|| store.pack_len(&vault, &loc.pack_id));
            let ok_slice = loc
                .pack_offset
                .checked_add(record.size)
                .is_some_and(|end| pack_len.is_some_and(|len| len >= end));
            if ok_slice {
                entries.push((record, loc));
            }
        }
        Ok((store.vault_packs_dir(&vault), entries))
    })
    .await;
    let (vault_packs_dir, entries) = match planned {
        Ok(planned) => planned,
        Err(fault) => return faulted(&fault, shared.now()),
    };
    let total: u64 = entries
        .iter()
        .map(|(record, _)| HEADER_LEN as u64 + record.size)
        .sum();
    let mut response = Response::new(Body::from_stream(fetch_stream(vault_packs_dir, entries)));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(total));
    response
}

struct FetchState {
    vault_packs_dir: PathBuf,
    entries: std::vec::IntoIter<(ObjectRecord, PackLocation)>,
    handles: BTreeMap<PackId, Arc<std::fs::File>>,
    active: Option<(Arc<std::fs::File>, u64, u64)>,
}

/// Stream each planned object's 68-byte header followed by its positioned slice
/// `[pack_offset .. pack_offset + size]`, opening each referenced `.pack` file
/// at most once for the entire `fetch` response.
fn fetch_stream(
    vault_packs_dir: PathBuf,
    entries: Vec<(ObjectRecord, PackLocation)>,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    let state = FetchState {
        vault_packs_dir,
        entries: entries.into_iter(),
        handles: BTreeMap::new(),
        active: None,
    };
    futures::stream::unfold(Some(state), |state| async move {
        let mut state = state?;
        loop {
            if let Some((file, pos, remaining)) = state.active.take() {
                if remaining == 0 {
                    continue;
                }
                let want = usize::try_from(remaining.min(STREAM_CHUNK_BYTES)).unwrap_or(256 * 1024);
                let reader = Arc::clone(&file);
                let outcome = tokio::task::spawn_blocking(move || {
                    let mut buffer = vec![0_u8; want];
                    ObjectStore::read_at(&reader, pos, &mut buffer)?;
                    Ok::<Bytes, std::io::Error>(Bytes::from(buffer))
                })
                .await;
                return match outcome {
                    Ok(Ok(bytes)) => {
                        let read = bytes.len() as u64;
                        if remaining > read {
                            state.active = Some((file, pos + read, remaining - read));
                        }
                        Some((Ok(bytes), Some(state)))
                    }
                    Ok(Err(error)) => Some((Err(error), None)),
                    Err(join_err) => Some((Err(std::io::Error::other(join_err.to_string())), None)),
                };
            }

            let (record, loc) = state.entries.next()?;
            let file = if let Some(cached) = state.handles.get(&loc.pack_id) {
                Arc::clone(cached)
            } else {
                let path = state
                    .vault_packs_dir
                    .join(format!("{}.pack", loc.pack_id.hex()));
                let opened = tokio::task::spawn_blocking(move || std::fs::File::open(path)).await;
                match opened {
                    Ok(Ok(opened)) => {
                        let shared_file = Arc::new(opened);
                        state.handles.insert(loc.pack_id, Arc::clone(&shared_file));
                        shared_file
                    }
                    Ok(Err(error)) => return Some((Err(error), None)),
                    Err(join_err) => {
                        return Some((Err(std::io::Error::other(join_err.to_string())), None));
                    }
                }
            };
            let header =
                Bytes::copy_from_slice(&frame_header(&record.name, &record.digest, record.size));
            if record.size > 0 {
                state.active = Some((file, loc.pack_offset, record.size));
            }
            return Some((Ok(header), Some(state)));
        }
    })
}

/// `?after=&limit=` of a listing.
#[derive(Debug, serde::Deserialize)]
struct Page {
    after: Option<String>,
    limit: Option<usize>,
}

fn page_of(query: Result<Query<Page>, QueryRejection>) -> Result<(Option<Name>, usize), Refusal> {
    let Query(page) = query.map_err(|_| Refusal::BadRequest)?;
    let after = page
        .after
        .map(|after| after.parse::<Name>().map_err(|_| Refusal::BadRequest))
        .transpose()?;
    Ok((after, page.limit.unwrap_or(LIST_LIMIT)))
}

async fn objects(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Page>, QueryRejection>,
    headers: HeaderMap,
) -> Response {
    let outcome = async {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        let (after, limit) = page_of(query)?;
        blocking(&shared, move |gateway| {
            gateway.objects(&vault, &token, after.as_ref(), limit)
        })
        .await
    }
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

/// `GET held?after=&limit=`: what the vault key has asked to delete and the
/// gateway is holding for a week.
async fn held(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Page>, QueryRejection>,
    headers: HeaderMap,
) -> Response {
    let outcome = async {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        let (after, limit) = page_of(query)?;
        blocking(&shared, move |gateway| {
            gateway.held(&vault, &token, after.as_ref(), limit)
        })
        .await
    }
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

async fn delete(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let parsed = (|| Ok::<_, Refusal>((vault_of(path)?, bearer(&headers)?)))();
    let (vault, token) = match parsed {
        Ok(parsed) => parsed,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let request: DeleteRequest = match read_json(body).await {
        Ok(request) => request,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let now = shared.now();
    let worker = Arc::clone(&shared);
    let outcome = blocking(&shared, move |gateway| {
        let mut damaged_packs: BTreeMap<Name, PackId> = BTreeMap::new();
        if request.names.len() <= MAX_NAMES {
            for name in &request.names {
                if let Some((record, loc)) = gateway.state.object_with_location(&vault, name)?
                    && record.damaged_at_ms.is_some()
                {
                    damaged_packs.insert(*name, loc.pack_id);
                }
            }
        }
        let deleted = gateway.delete(&vault, &token, &request, now, |_name| Ok(()))?;
        let mut candidate_packs = BTreeSet::new();
        for freed_name in &deleted.freed {
            if let Some(pack_id) = damaged_packs.get(freed_name) {
                candidate_packs.insert(*pack_id);
            }
        }
        for pack_id in candidate_packs {
            if !gateway.state.pack_has_objects(&vault, &pack_id)? {
                worker.store().remove_pack(&vault, &pack_id)?;
            }
        }
        Ok(deleted)
    })
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

async fn check(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let parsed = (|| Ok::<_, Refusal>((vault_of(path)?, bearer(&headers)?)))();
    let (vault, token) = match parsed {
        Ok(parsed) => parsed,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let request: CheckRequest = match read_json(body).await {
        Ok(request) => request,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let now = shared.now();
    let worker = Arc::clone(&shared);
    let outcome = blocking(&shared, move |gateway| {
        let target = gateway.state.object_with_location(&vault, &request.name)?;
        gateway.check(&vault, &token, &request, now, |_name| {
            let Some((record, loc)) = target else {
                return Ok(None);
            };
            worker
                .store()
                .read_slice_digest(&vault, loc, record.size)
                .map_err(|error| StoreFault::new(error.to_string()).into())
        })
    })
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

async fn undo(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let parsed = (|| Ok::<_, Refusal>((vault_of(path)?, bearer(&headers)?)))();
    let (vault, token) = match parsed {
        Ok(parsed) => parsed,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let request: UndoRequest = match read_json(body).await {
        Ok(request) => request,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let outcome = blocking(&shared, move |gateway| {
        gateway.undo(&vault, &token, &request)
    })
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

/// `POST revoke`: the bearer token revokes itself. No body.
async fn revoke(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let parsed = (|| Ok::<_, Refusal>((vault_of(path)?, bearer(&headers)?)))();
    let (vault, token) = match parsed {
        Ok(parsed) => parsed,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let outcome = blocking(&shared, move |gateway| gateway.revoke(&vault, &token))
        .await
        .map(|()| Revoked { revoked: true });
    answer(&shared, StatusCode::OK, outcome)
}

async fn no_route(State(shared): State<Handle>) -> Response {
    refused(&Refusal::NotFound { name: None }, shared.now())
}

/// A method no route takes at a path that exists — an upload straight to an object, which
/// is no longer a route — is no route: `NOT_FOUND`, as a path with none.
async fn wrong_method(State(shared): State<Handle>) -> Response {
    refused(&Refusal::NotFound { name: None }, shared.now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, HeaderValue::from_str(value).expect("a header value"));
        }
        map
    }

    #[test]
    fn a_bearer_token_is_read_and_anything_else_is_unauthorized() {
        let token = Token::from_bytes([0xab; 32]);
        let good = format!("Bearer {token}");
        assert_eq!(bearer(&headers(&[("authorization", &good)])), Ok(token));
        let lower = format!("bearer {token}");
        assert_eq!(bearer(&headers(&[("authorization", &lower)])), Ok(token));
        for bad in [
            format!("Basic {token}"),
            token.to_string(),
            "Bearer short".to_owned(),
            format!("Bearer {}", token.to_string().to_uppercase()),
        ] {
            assert_eq!(
                bearer(&headers(&[("authorization", &bad)])),
                Err(Refusal::Unauthorized),
                "{bad}"
            );
        }
        assert_eq!(bearer(&HeaderMap::new()), Err(Refusal::Unauthorized));
    }

    /// Every refusal carries its code twice: in the body, and in a header a
    /// `HEAD` can read.
    #[test]
    fn a_refusal_names_its_code_in_a_header_and_its_status() {
        let claim = crate::rules::wire::ClaimView {
            epoch: 3,
            head_seen: None,
            nonce: crate::rules::ids::Nonce::from_bytes([1; 40]),
            signature: crate::rules::ids::Signature::from_bytes([2; 64]),
        };
        let response = refused(
            &Refusal::Moved {
                epoch: 3,
                claim: Box::new(claim),
            },
            1,
        );
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response
                .headers()
                .get(CODE_HEADER)
                .map(HeaderValue::as_bytes),
            Some(&b"MOVED"[..])
        );
    }
}
