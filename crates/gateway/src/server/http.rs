//! axum over the rules: the routes of protocol v2 (#1080).
//!
//! **Every answer comes out of [`crate::rules`].** A handler parses what
//! arrived, hands it to [`Shared::rules`], and renders what came back; the one
//! mapping from a refusal to a body and a status is
//! [`crate::rules::code::RefusalBody`] and [`crate::rules::code::Code::status`].
//!
//! # WHAT A HANDLER DECIDES
//!
//! How a token, a digest and a range arrive in headers; how a body becomes a
//! typed request; how bytes stream to and from a file. Never whether something
//! is allowed.
//!
//! # BYTES NEVER SIT IN MEMORY WHOLE
//!
//! An object `PUT` streams into a staged file while it is hashed; a bundle is
//! cut into frames by [`crate::rules::bundle::Decoder`] as it arrives, each
//! frame into its own staged file; a `GET` and a `fetch` stream from the files.
//! The bytes are authorised before they are read, and admitted only after
//! they are on disk and hashed.
//!
//! # A REFUSAL A PHONE CAN READ IS ONE SENT AFTER ITS BODY
//!
//! An HTTP/1.1 client still writing a body when the answer arrives sees a
//! broken pipe, not the answer — and `MOVED` lost that way is a superseded
//! phone that retries instead of freezing. So once a request's token is known,
//! a refusal decided before its body was consumed (`MOVED`, `TOO_LARGE`,
//! `DISK_FULL`, a malformed frame) first reads and discards what is left of
//! the body, up to a bound. A stranger's body is never read: `UNAUTHORIZED`
//! is answered at once.

use std::path::PathBuf;

use axum::Router;
use axum::body::{Body, BodyDataStream, Bytes};
use axum::extract::rejection::{PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use futures::StreamExt as _;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};

use crate::rules::bundle::{Decoder, FrameHeader, HEADER_LEN, Step, header as frame_header};
use crate::rules::code::{Code, Refusal, RefusalBody};
use crate::rules::engine::{Access, Arrival, PutOutcome};
use crate::rules::ids::{Digest, Name, Token, VaultId};
use crate::rules::limits::{LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_JSON_BYTES, MAX_OBJECT_BYTES};
use crate::rules::range::resolve;
use crate::rules::state::{Fault, ObjectRecord};
use crate::rules::wire::{
    BundleAnswer, CODE_HEADER, DIGEST_HEADER, Missing, NameRefusal, Names, PairRequest, SetHead,
};
use crate::server::store::{Staged, StagedFile};
use crate::server::{Event, Handle, Shared};

/// The routes.
pub fn router(shared: Handle) -> Router {
    Router::new()
        .route("/v2/info", get(info))
        .route("/v2/pair", post(pair))
        .route("/v2/v/{vault}/head", get(get_head).put(put_head))
        .route("/v2/v/{vault}/snapshots", get(snapshots))
        .route("/v2/v/{vault}/exists", post(exists))
        .route(
            "/v2/v/{vault}/o/{name}",
            put(put_object).get(get_object).head(head_object),
        )
        .route("/v2/v/{vault}/bundle", post(bundle))
        .route("/v2/v/{vault}/fetch", post(fetch))
        .route("/v2/v/{vault}/objects", get(objects))
        .route("/v2/v/{vault}/delete", post(delete))
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
    answer(
        &shared,
        StatusCode::OK,
        shared.rules(|gateway| Ok(gateway.info(now))),
    )
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
    let outcome = shared.rules(|gateway| gateway.pair(&request, &token, now));
    if let Ok(paired) = &outcome {
        shared.announce(&Event::Paired {
            vault: request.vault_id,
            kind: request.kind,
            epoch: paired.epoch,
            label: request.label.clone(),
        });
    }
    answer(&shared, StatusCode::OK, outcome)
}

async fn get_head(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let outcome = (|| {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        shared.rules(|gateway| gateway.head(&vault, &token))
    })();
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
    answer(
        &shared,
        StatusCode::OK,
        shared.rules(|gateway| gateway.set_head(&vault, &token, &request, now)),
    )
}

async fn snapshots(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let outcome = (|| {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        shared.rules(|gateway| gateway.snapshots(&vault, &token))
    })();
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
    let outcome = shared
        .rules(|gateway| gateway.exists(&vault, &token, &names.names))
        .map(|missing| Missing { missing });
    answer(&shared, StatusCode::OK, outcome)
}

/// `PUT o/{name}`: authorise, stage while hashing, then let the rules admit.
async fn put_object(
    State(shared): State<Handle>,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    match receive_object(&shared, path, &headers, body).await {
        Ok(PutOutcome::Stored(entry)) => json(StatusCode::CREATED, &entry),
        Ok(PutOutcome::AlreadyStored(entry)) => json(StatusCode::OK, &entry),
        Err(fault) => faulted(&fault, shared.now()),
    }
}

async fn receive_object(
    shared: &Shared,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: &HeaderMap,
    body: Body,
) -> Result<PutOutcome, Fault> {
    let (vault, name) = object_of(path)?;
    let token = bearer(headers)?;
    // A stranger is answered before a byte of the body is read.
    shared.rules(|gateway| gateway.authorize(&vault, &token, Access::Read))?;
    let mut stream = body.into_data_stream();
    let (file, declared) = match stage_object(shared, &vault, &token, headers, &mut stream).await {
        Ok(staged) => staged,
        Err(fault) => {
            drain(&mut stream, DRAIN_OBJECT_BYTES).await;
            return Err(fault);
        }
    };
    let arrival = Arrival {
        name,
        declared,
        digest: file.digest,
        size: file.size,
    };
    let now = shared.now();
    let store = shared.store();
    shared.rules(|gateway| {
        gateway.put(&vault, &token, &arrival, now, || {
            store.commit(file, &vault, &name)
        })
    })
}

/// What a `PUT` must pass before the rules judge it — write authority, its
/// headers, its size — and its bytes staged on disk.
async fn stage_object(
    shared: &Shared,
    vault: &VaultId,
    token: &Token,
    headers: &HeaderMap,
    stream: &mut BodyDataStream,
) -> Result<(StagedFile, Digest), Fault> {
    shared.rules(|gateway| gateway.authorize(vault, token, Access::Write))?;
    let declared = headers
        .get(DIGEST_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Digest::from_header(value).ok())
        .ok_or(Refusal::BadRequest)?;
    let length = content_length(headers).ok_or(Refusal::BadRequest)?;
    if length > MAX_OBJECT_BYTES {
        return Err(Refusal::TooLarge {
            limit: MAX_OBJECT_BYTES,
        }
        .into());
    }
    let mut staged = shared.store().stage(length).await?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Refusal::BadRequest)?;
        staged.write(&chunk).await?;
    }
    Ok((staged.finish().await?, declared))
}

/// The most of an object's body read and discarded so its refusal is heard.
const DRAIN_OBJECT_BYTES: u64 = 2 * MAX_OBJECT_BYTES;

/// The most of a bundle's body read and discarded so its refusal is heard.
const DRAIN_BUNDLE_BYTES: u64 = MAX_BUNDLE_BYTES;

/// Read and discard what is left of a body, up to `limit` bytes. See the
/// module header.
async fn drain(stream: &mut BodyDataStream, limit: u64) {
    let mut read = 0_u64;
    while read <= limit {
        match stream.next().await {
            Some(Ok(chunk)) => read = read.saturating_add(chunk.len() as u64),
            _ => return,
        }
    }
}

/// The object a `GET` or `HEAD` serves, and where its bytes are.
fn served(
    shared: &Shared,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: &HeaderMap,
) -> Result<(ObjectRecord, PathBuf), Fault> {
    let (vault, name) = object_of(path)?;
    let token = bearer(headers)?;
    let record = shared.rules(|gateway| gateway.object(&vault, &token, &name))?;
    let file = shared.store().path(&vault, &name);
    if !file.is_file() {
        // A row whose bytes are gone: the scrub will mark it, and the phone
        // that asks is told the truth now.
        return Err(Refusal::NotFound { name: Some(name) }.into());
    }
    Ok((record, file))
}

async fn get_object(
    State(shared): State<Handle>,
    path: Result<Path<(String, String)>, PathRejection>,
    headers: HeaderMap,
) -> Response {
    let (record, file) = match served(&shared, path, &headers) {
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
    let mut handle = match tokio::fs::File::open(&file).await {
        Ok(handle) => handle,
        Err(_) => {
            return refused(
                &Refusal::NotFound {
                    name: Some(record.name),
                },
                shared.now(),
            );
        }
    };
    if first > 0 && handle.seek(std::io::SeekFrom::Start(first)).await.is_err() {
        return faulted(
            &crate::rules::state::StoreFault::new("seeking an object").into(),
            shared.now(),
        );
    }
    let mut response = Response::new(Body::from_stream(file_stream(handle, length)));
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
    let (record, _) = match served(&shared, path, &headers) {
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

/// `length` bytes of an open file, in pieces of at most 256 KiB. A file that
/// ends early ends the stream with an error, which ends the connection: a
/// short body is never passed off as a whole one.
fn file_stream(
    handle: tokio::fs::File,
    length: u64,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    futures::stream::unfold((Some(handle), length), |(handle, remaining)| async move {
        let mut handle = handle?;
        if remaining == 0 {
            return None;
        }
        let want = usize::try_from(remaining.min(256 * 1024)).unwrap_or(256 * 1024);
        let mut buffer = vec![0_u8; want];
        match handle.read(&mut buffer).await {
            Ok(0) => Some((
                Err(std::io::Error::from(std::io::ErrorKind::UnexpectedEof)),
                (None, 0),
            )),
            Ok(read) => {
                buffer.truncate(read);
                Some((
                    Ok(Bytes::from(buffer)),
                    (Some(handle), remaining - read as u64),
                ))
            }
            Err(error) => Some((Err(error), (None, 0))),
        }
    })
}

/// `POST bundle`: authorise once, then each frame is staged, judged and
/// admitted on its own as it arrives, and answered as its own `PUT` would be:
/// `stored`, `already`, or in `refused` with its code. A body that is
/// malformed or over the cap is refused whole, and the frames admitted before
/// it stay admitted — each was verified on its own.
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
        shared.rules(|gateway| gateway.authorize(&vault, &token, Access::Read))?;
        let mut stream = body.into_data_stream();
        let received = async {
            shared.rules(|gateway| gateway.authorize(&vault, &token, Access::Write))?;
            if content_length(&headers).is_some_and(|length| length > MAX_BUNDLE_BYTES) {
                return Err(Refusal::TooLarge {
                    limit: MAX_BUNDLE_BYTES,
                }
                .into());
            }
            receive_bundle(&shared, &vault, &token, &mut stream).await
        }
        .await;
        if received.is_err() {
            drain(&mut stream, DRAIN_BUNDLE_BYTES).await;
        }
        received
    }
    .await;
    answer(&shared, StatusCode::OK, outcome)
}

async fn receive_bundle(
    shared: &Shared,
    vault: &VaultId,
    token: &Token,
    stream: &mut BodyDataStream,
) -> Result<BundleAnswer, Fault> {
    let mut decoder = Decoder::new();
    let mut answer = BundleAnswer::default();
    let mut frame: Option<(FrameHeader, Option<Staged>)> = None;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| Refusal::BadRequest)?;
        let mut rest: &[u8] = &chunk;
        loop {
            let (step, used) = decoder.step(rest)?;
            rest = &rest[used..];
            match step {
                None => break,
                Some(step) => advance(shared, vault, token, &mut frame, &mut answer, step).await?,
            }
        }
    }
    while let (Some(step), _) = decoder.step(&[])? {
        advance(shared, vault, token, &mut frame, &mut answer, step).await?;
    }
    decoder.finish()?;
    Ok(answer)
}

async fn advance(
    shared: &Shared,
    vault: &VaultId,
    token: &Token,
    frame: &mut Option<(FrameHeader, Option<Staged>)>,
    answer: &mut BundleAnswer,
    step: Step<'_>,
) -> Result<(), Fault> {
    match step {
        Step::Header(header) => {
            // A frame over the object cap is read past, not staged, and
            // refused on its own; the frames around it are unaffected.
            let staged = if header.len > MAX_OBJECT_BYTES {
                None
            } else {
                Some(shared.store().stage(header.len).await?)
            };
            *frame = Some((header, staged));
        }
        Step::Body(bytes) => {
            if let Some((_, Some(staged))) = frame {
                staged.write(bytes).await?;
            }
        }
        Step::End => {
            let Some((header, staged)) = frame.take() else {
                return Ok(());
            };
            let Some(staged) = staged else {
                answer.refused.push(NameRefusal {
                    name: header.name,
                    code: Code::TooLarge,
                });
                return Ok(());
            };
            let file = staged.finish().await?;
            let arrival = Arrival {
                name: header.name,
                declared: header.digest,
                digest: file.digest,
                size: file.size,
            };
            let now = shared.now();
            let store = shared.store();
            let outcome = shared.rules(|gateway| {
                gateway.put(vault, token, &arrival, now, || {
                    store.commit(file, vault, &header.name)
                })
            });
            match outcome {
                Ok(PutOutcome::Stored(_)) => answer.stored.push(header.name),
                Ok(PutOutcome::AlreadyStored(_)) => answer.already.push(header.name),
                Err(Fault::Refused(refusal)) => answer.refused.push(NameRefusal {
                    name: header.name,
                    code: refusal.code(),
                }),
                Err(fault @ Fault::Store(_)) => return Err(fault),
            }
        }
    }
    Ok(())
}

/// `POST fetch`: the rules plan which objects, in which order; the answer
/// streams them in the bundle framing. An object whose file is gone or the
/// wrong length is left out like an unknown name, rather than promised in a
/// header and cut short.
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
    let plan = match shared.rules(|gateway| gateway.fetch(&vault, &token, &names.names)) {
        Ok(plan) => plan,
        Err(fault) => return faulted(&fault, shared.now()),
    };
    let entries: Vec<(ObjectRecord, PathBuf)> = plan
        .into_iter()
        .filter_map(|record| {
            let file = shared.store().path(&vault, &record.name);
            let length = std::fs::metadata(&file).ok()?.len();
            (length == record.size).then_some((record, file))
        })
        .collect();
    let total: u64 = entries
        .iter()
        .map(|(record, _)| HEADER_LEN as u64 + record.size)
        .sum();
    let mut response = Response::new(Body::from_stream(fetch_stream(entries)));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(total));
    response
}

/// Each planned object's header, then its bytes, one after the other.
fn fetch_stream(
    entries: Vec<(ObjectRecord, PathBuf)>,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    futures::stream::iter(entries)
        .then(|(record, file)| async move {
            let header =
                Bytes::copy_from_slice(&frame_header(&record.name, &record.digest, record.size));
            let body = match tokio::fs::File::open(&file).await {
                Ok(handle) => file_stream(handle, record.size).left_stream(),
                Err(error) => futures::stream::once(async move { Err(error) }).right_stream(),
            };
            futures::stream::once(async move { Ok(header) }).chain(body)
        })
        .flatten()
}

/// `GET objects?after=&limit=`.
#[derive(Debug, serde::Deserialize)]
struct Page {
    after: Option<String>,
    limit: Option<usize>,
}

async fn objects(
    State(shared): State<Handle>,
    path: Result<Path<String>, PathRejection>,
    query: Result<Query<Page>, QueryRejection>,
    headers: HeaderMap,
) -> Response {
    let outcome = (|| {
        let vault = vault_of(path)?;
        let token = bearer(&headers)?;
        let Query(page) = query.map_err(|_| Refusal::BadRequest)?;
        let after = page
            .after
            .map(|after| after.parse::<Name>().map_err(|_| Refusal::BadRequest))
            .transpose()?;
        let limit = page.limit.unwrap_or(LIST_LIMIT);
        shared.rules(|gateway| gateway.objects(&vault, &token, after.as_ref(), limit))
    })();
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
    let names: Names = match read_json(body).await {
        Ok(names) => names,
        Err(refusal) => return refused(&refusal, shared.now()),
    };
    let now = shared.now();
    answer(
        &shared,
        StatusCode::OK,
        shared.rules(|gateway| gateway.delete(&vault, &token, &names.names, now)),
    )
}

async fn no_route(State(shared): State<Handle>) -> Response {
    refused(&Refusal::NotFound { name: None }, shared.now())
}

async fn wrong_method(State(shared): State<Handle>) -> Response {
    refused(&Refusal::BadRequest, shared.now())
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
        let response = refused(&Refusal::Moved { epoch: 3 }, 1);
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
