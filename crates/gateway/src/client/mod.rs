//! THE PHONE'S CLIENT (#1080).
//!
//! HTTP/1.1 over TLS over TCP to one gateway, trusting exactly one
//! certificate ([`tls`]). Every route of protocol v3 is a method here; the
//! bodies and refusals are [`crate::rules`]' own types, so the client reads
//! back exactly what the server rendered.
//!
//! # ADDRESSES ARE TRIED IN ORDER
//!
//! A [`Destination`] carries the addresses the pairing QR or the last
//! Bonjour browse listed. The client tries them in order, starting with the
//! one that answered last; a connect failure on every one is
//! [`ClientError::Unreachable`] — a phone away from home, not a refusal. An
//! address that answers with the wrong certificate is
//! [`ClientError::Untrusted`], which outranks "unreachable": it is a
//! different machine where the gateway should be.
//!
//! # ONE CONNECTION, KEPT
//!
//! Requests on one client share one connection, re-dialled when the gateway
//! closed it. A request is sent again on a fresh connection only when hyper
//! hands it back unsent; a request that may have reached the gateway is
//! never repeated here — `PUT`s, deletes and the head's compare-and-set are
//! idempotent by the rules, and the caller decides about the rest.
//!
//! # NO WAIT IS UNBOUNDED
//!
//! A gateway that went to sleep, or a network that changed, leaves the connection open and
//! silent. Connect and handshake have their own limits; after that a request is given
//! [`HEADER_TIMEOUT`] without progress to answer its headers (a body frame handed to the socket is
//! progress) and a body read [`IDLE_TIMEOUT`] between chunks, both [`Limits`]. A call also looks at
//! its [`Stop`] every [`Limits::poll`] while it waits, so a Cancel ends a transfer in flight.
//! A call that gives up drops the connection; the next one dials fresh, and a request that may
//! have reached the gateway is not repeated here.
//!
//! # BUNDLES AND FETCHES STREAM
//!
//! [`Client::bundle_parts`] sends parts from memory or straight from spool
//! files, and [`Client::fetch_each`] hands the answer over one frame at a
//! time, so a body of [`MAX_BUNDLE_BYTES`] never sits in memory at either end
//! (#1080, the root's ruling A14). `tests/store_client.rs` holds a process
//! sending a quarter-gibibyte up and back to a few MiB of growth.
//!
//! # WHAT THIS CLIENT NEVER SAYS
//!
//! That something is backed up. It returns what the gateway acknowledged —
//! a [`Put`], whose every variant is one, and
//! [`BundleAnswer::acknowledged`] — and nothing more; "backed up" is a word
//! the phone may use only over an acknowledgement it recorded.

pub mod tls;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::{StreamExt as _, TryStreamExt as _};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt as _, Full, StreamBody};
use hyper::body::{Frame as BodyFrame, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::AsyncReadExt as _;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::ClientConfig;
use tokio_rustls::rustls::pki_types::ServerName;

use crate::client::tls::{Trust, client_config, is_untrusted};
use crate::rules::bundle::{Decoder, Frame, HEADER_LEN, Step, header as frame_header};
use crate::rules::code::{Code, Refusal, RefusalBody};
use crate::rules::ids::{Digest, Name, Pin, Token, VaultId};
use crate::rules::limits::{LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_OBJECT_BYTES, REQUIRED_PROTOCOL};
use crate::rules::range::ByteRange;
use crate::rules::wire::{
    BundleAnswer, CODE_HEADER, DIGEST_HEADER, DeleteAnswer, DeleteRequest, HeadView, HeldEntry,
    Info, Missing, Names, NonceAnswer, ObjectEntry, PairRequest, Paired, Revoked, SetHead,
    SnapshotView, UndoRequest, Undone,
};

/// How long one address gets to accept a TCP connection.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a TLS handshake gets.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a request may go without the gateway answering its headers, measured from the last
/// byte of progress (a body frame handed to the socket, or the request's end): a gateway that is
/// asleep, or a network that changed under the connection, ends here and not at the kernel's
/// TCP timeout.
pub const HEADER_TIMEOUT: Duration = Duration::from_secs(60);

/// How long a body read may go without one more byte arriving.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30);

/// How often a waiting call looks at the stop it was given, so a Cancel is observed during a
/// transfer and not only between calls ([`Limits::poll`]).
const STOP_POLL: Duration = Duration::from_millis(250);

/// TCP keepalive on the dial: idle time before the first probe and between probes, so a dead
/// peer under an otherwise silent connection is found by the kernel too.
const KEEPALIVE: Duration = Duration::from_secs(20);

/// The largest JSON answer read: a page of a thousand objects is far less.
const MAX_ANSWER_BYTES: u64 = 16 * 1024 * 1024;

/// How much of a file is read for one piece of a body.
const FILE_CHUNK: u64 = 256 * 1024;

/// Where a paired gateway is and how to talk to it: what the phone's ledger
/// keeps per destination.
#[derive(Clone, PartialEq, Eq)]
pub struct Destination {
    /// `host:port`, in order of preference.
    pub addrs: Vec<String>,
    /// The certificate the first contact pinned, DER: trusted by exact bytes.
    pub cert_der: Vec<u8>,
    /// The bearer token pairing answered.
    pub token: Token,
}

impl core::fmt::Debug for Destination {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Destination")
            .field("addrs", &self.addrs)
            .field("pin", &Pin::of(&self.cert_der))
            .finish_non_exhaustive()
    }
}

/// Why a call did not succeed.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    /// The gateway said no, with this code and these companions.
    #[error("refused: {0}")]
    Refused(Refusal),
    /// The gateway's store failed (`INTERNAL`). Retry later.
    #[error("the gateway failed internally")]
    GatewayFault,
    /// No address answered. A phone away from the gateway's network.
    #[error("the gateway could not be reached: {0}")]
    Unreachable(String),
    /// An address answered with a certificate that is not the pinned one,
    /// or could not prove it holds its key.
    #[error("the gateway's certificate is not the pinned one")]
    Untrusted,
    /// An answer that does not parse or breaks the protocol.
    #[error("the gateway's answer broke the protocol: {0}")]
    Protocol(String),
    /// Bytes that do not hash to the digest they came with: the copy the
    /// gateway holds, or the bytes on the way, are damaged.
    #[error("the gateway's copy is damaged: {0}")]
    Damaged(String),
    /// The gateway speaks an older protocol than this phone requires: the
    /// member updates the gateway and pairs again. There is no fallback to
    /// the older dialect (#1191, E13).
    #[error("the gateway runs protocol {found}, and this phone needs {required}")]
    GatewayTooOld {
        /// What the gateway answered.
        found: u32,
        /// [`REQUIRED_PROTOCOL`].
        required: u32,
    },
    /// A route that needs a token, on a client that has none.
    #[error("this client has no token")]
    NoToken,
    /// A local file could not be read.
    #[error("a local file: {0}")]
    Io(#[from] std::io::Error),
}

impl From<Refusal> for ClientError {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

/// An object's size and digest, as `HEAD` answers them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectStat {
    pub size: u64,
    pub digest: Digest,
}

/// The head as a restoring phone needs it: the writer epoch always, the head
/// when there is one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HeadState {
    pub epoch: u64,
    pub head: Option<HeadView>,
}

/// What the gateway answered a `PUT` with. **Every variant is an
/// acknowledgement**: the gateway holds a sealing of these bytes under this
/// name, durably. Anything else is a [`ClientError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Put {
    /// `201`: new bytes, now held.
    Stored(ObjectEntry),
    /// `200`: held already with this digest; nothing moved.
    AlreadyStored(ObjectEntry),
    /// `409 NAME_TAKEN`: held already under another digest. A name is a
    /// function of the plaintext and sealing is salted, so this is the same
    /// bytes sealed again — an acknowledgement, not a refusal (#1080, the
    /// root's ruling A15).
    NameTaken {
        /// The digest the gateway holds.
        held: Digest,
    },
}

/// Where a bundled part's bytes come from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// Bytes already in memory: a sealed range, a thumbnail.
    Bytes(Bytes),
    /// A spool file, opened when its turn comes and read as the body is
    /// sent, never held whole.
    File(PathBuf),
}

/// One part of a bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Part {
    pub name: Name,
    /// BLAKE3 of the part's bytes.
    pub digest: Digest,
    pub source: Source,
}

/// A `PUT` prepared for someone else to perform: the iPhone's background
/// `URLSession`, which uploads a spool file while the app is suspended. The
/// shell adds the file as the body and pins the destination's certificate in
/// its own trust challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handoff {
    /// `https://<preferred address>/v3/v/<vault>/o/<name>`.
    pub url: String,
    /// `PUT`.
    pub method: String,
    /// `authorization`, `content-digest`, `content-length` and
    /// `content-type`, lowercase. The `authorization` value is the bearer
    /// token: the shell holds it as a credential.
    pub headers: Vec<(String, String)>,
}

/// A stop the caller can raise while a call waits: true means give up now.
pub type Stop = Arc<dyn Fn() -> bool + Send + Sync>;

/// How long a call may wait without progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Until the answer's headers, from the last progress of the request.
    pub header: Duration,
    /// Between two chunks of an answer's body.
    pub idle: Duration,
    /// How often a waiting call looks at its stop.
    pub poll: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            header: HEADER_TIMEOUT,
            idle: IDLE_TIMEOUT,
            poll: STOP_POLL,
        }
    }
}

type Body = UnsyncBoxBody<Bytes, std::io::Error>;
type Sender = hyper::client::conn::http1::SendRequest<Body>;

/// The client for one gateway. See the module header.
pub struct Client {
    addrs: Vec<String>,
    trust: Trust,
    config: Arc<ClientConfig>,
    token: Mutex<Option<Token>>,
    preferred: Arc<AtomicUsize>,
    seen: Arc<Mutex<Option<Vec<u8>>>>,
    live: Arc<tokio::sync::Mutex<Option<(Sender, String)>>>,
    /// TCP connections this client and its [siblings](Self::sibling) have opened.
    dials: Arc<AtomicUsize>,
    limits: Mutex<Limits>,
    stop: Mutex<Option<Stop>>,
    /// Counts the body frames handed to the socket, so an upload that is moving is not a stall.
    progress: Arc<std::sync::atomic::AtomicU64>,
}

impl core::fmt::Debug for Client {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Client")
            .field("addrs", &self.addrs)
            .field("trust", &self.trust)
            .finish_non_exhaustive()
    }
}

impl Client {
    fn with_trust(addrs: Vec<String>, trust: Trust, token: Option<Token>) -> Self {
        Self {
            config: client_config(trust.clone()),
            addrs,
            trust,
            token: Mutex::new(token),
            preferred: Arc::new(AtomicUsize::new(0)),
            seen: Arc::new(Mutex::new(None)),
            live: Arc::new(tokio::sync::Mutex::new(None)),
            dials: Arc::new(AtomicUsize::new(0)),
            limits: Mutex::new(Limits::default()),
            stop: Mutex::new(None),
            progress: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        }
    }

    /// A client for the same gateway with **its own token** and the same connection: what a
    /// scan that asks about many vaults uses, so that it handshakes once and not once per
    /// question. It starts with this client's trust, limits and stop.
    #[must_use]
    pub fn sibling(&self) -> Self {
        Self {
            addrs: self.addrs.clone(),
            trust: self.trust.clone(),
            config: Arc::clone(&self.config),
            token: Mutex::new(None),
            preferred: Arc::clone(&self.preferred),
            seen: Arc::clone(&self.seen),
            live: Arc::clone(&self.live),
            dials: Arc::clone(&self.dials),
            limits: Mutex::new(self.limits()),
            stop: Mutex::new(self.stop.lock().ok().and_then(|held| held.clone())),
            progress: Arc::clone(&self.progress),
        }
    }

    /// How many TCP connections this client, and every [sibling](Self::sibling), has opened.
    #[must_use]
    pub fn dials(&self) -> usize {
        self.dials.load(Ordering::Relaxed)
    }

    /// Replace the header and idle limits. The product keeps the defaults; a test with a
    /// stalled transport shortens them.
    pub fn set_limits(&self, limits: Limits) {
        if let Ok(mut held) = self.limits.lock() {
            *held = limits;
        }
    }

    /// Give calls a stop to watch: while one waits on the gateway it looks at `stop` every
    /// [`Limits::poll`] and ends with an interrupted [`ClientError::Io`] when it is true.
    pub fn set_stop(&self, stop: Option<Stop>) {
        if let Ok(mut held) = self.stop.lock() {
            *held = stop;
        }
    }

    fn limits(&self) -> Limits {
        self.limits.lock().map(|held| *held).unwrap_or_default()
    }

    fn stopped(&self) -> bool {
        self.stop
            .lock()
            .ok()
            .and_then(|held| held.clone())
            .is_some_and(|stop| stop())
    }

    /// Wait for `future`, ending it when the stop is raised or when `limit` passes with no
    /// progress. Progress is a body frame handed to the socket since the wait began.
    async fn guarded<T>(
        &self,
        limit: Duration,
        what: &str,
        future: impl std::future::Future<Output = T>,
    ) -> Result<T, ClientError> {
        let poll = self.limits().poll;
        let mut future = Box::pin(future);
        let mut seen = self.progress.load(Ordering::Relaxed);
        let mut since = tokio::time::Instant::now();
        loop {
            if self.stopped() {
                return Err(ClientError::Io(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "stopped by the caller",
                )));
            }
            match tokio::time::timeout(poll.min(limit), &mut future).await {
                Ok(value) => return Ok(value),
                Err(_) => {
                    let now = self.progress.load(Ordering::Relaxed);
                    if now != seen {
                        seen = now;
                        since = tokio::time::Instant::now();
                    } else if since.elapsed() >= limit {
                        return Err(ClientError::Unreachable(format!(
                            "the gateway stopped answering ({what}: no progress for {}s)",
                            limit.as_secs()
                        )));
                    }
                }
            }
        }
    }

    /// A body stream that counts each chunk it hands on.
    fn counting<S>(
        &self,
        stream: S,
    ) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static
    where
        S: futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
    {
        let progress = Arc::clone(&self.progress);
        stream.inspect(move |_| {
            progress.fetch_add(1, Ordering::Relaxed);
        })
    }

    /// First contact, from a scanned pairing payload: trust the certificate
    /// whose BLAKE3 is `pin`. Its DER is [`Self::cert_der`] after the first
    /// connection, for the caller to keep.
    #[must_use]
    pub fn first_contact(addrs: Vec<String>, pin: Pin) -> Self {
        Self::with_trust(addrs, Trust::Pin(pin), None)
    }

    /// Trust `cert_der` by exact bytes, with no token yet: what the
    /// gateway's own `health` verb uses, reading its certificate from disk.
    #[must_use]
    pub fn trusting(addrs: Vec<String>, cert_der: Vec<u8>) -> Self {
        Self::with_trust(addrs, Trust::Certificate(cert_der), None)
    }

    /// A paired destination: trust its stored certificate by exact bytes.
    #[must_use]
    pub fn new(destination: &Destination) -> Self {
        Self::with_trust(
            destination.addrs.clone(),
            Trust::Certificate(destination.cert_der.clone()),
            Some(destination.token),
        )
    }

    /// Use `token` from now on.
    pub fn set_token(&self, token: Token) {
        if let Ok(mut held) = self.token.lock() {
            *held = Some(token);
        }
    }

    /// The certificate this client trusts by bytes, or saw on first contact.
    #[must_use]
    pub fn cert_der(&self) -> Option<Vec<u8>> {
        match &self.trust {
            Trust::Certificate(der) => Some(der.clone()),
            Trust::Pin(_) => self.seen.lock().ok().and_then(|seen| seen.clone()),
        }
    }

    /// Everything a ledger keeps for this gateway, once both the certificate
    /// and a token are known.
    #[must_use]
    pub fn destination(&self) -> Option<Destination> {
        Some(Destination {
            addrs: self.addrs.clone(),
            cert_der: self.cert_der()?,
            token: self.token()?,
        })
    }

    fn token(&self) -> Option<Token> {
        self.token.lock().ok().and_then(|token| *token)
    }

    fn preferred_addr(&self) -> Option<&String> {
        self.addrs
            .get(self.preferred.load(Ordering::Relaxed))
            .or_else(|| self.addrs.first())
    }

    // ─── the routes ──────────────────────────────────────────────────────────

    /// `GET /v3/info`. Needs no token. **The handshake**: a gateway that
    /// answers with a protocol below [`REQUIRED_PROTOCOL`], or that does not
    /// know `/v3/info` but answers `/v2/info`, is refused as
    /// [`ClientError::GatewayTooOld`]; the older dialect is never spoken.
    ///
    /// # Errors
    ///
    /// [`ClientError`], [`ClientError::GatewayTooOld`] included.
    pub async fn info(&self) -> Result<Info, ClientError> {
        let answer: Result<Info, ClientError> =
            self.call(Method::GET, "/v3/info", None::<&()>, false).await;
        if let Err(ClientError::Refused(Refusal::NotFound { .. } | Refusal::BadRequest)) = &answer {
            // A gateway that has never heard of `/v3/info`: an older one, or
            // not a gateway at all.
            let older: Option<Info> = self
                .call(Method::GET, "/v2/info", None::<&()>, false)
                .await
                .ok();
            return handshake(answer, older.map(|info| info.protocol));
        }
        handshake(answer, None)
    }

    /// `POST /v3/pair`. On success the client keeps the token.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn pair(&self, request: &PairRequest) -> Result<Paired, ClientError> {
        let paired: Paired = self
            .call(Method::POST, "/v3/pair", Some(request), false)
            .await?;
        self.set_token(paired.token);
        Ok(paired)
    }

    /// `GET head`. `NO_HEAD` is a refusal carrying the writer epoch.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn head(&self, vault: &VaultId) -> Result<HeadView, ClientError> {
        self.call(Method::GET, &route(vault, "head"), None::<&()>, true)
            .await
    }

    /// `GET head`, with `NO_HEAD` folded into an answer: what a restore reads
    /// before it claims one past the epoch.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn head_state(&self, vault: &VaultId) -> Result<HeadState, ClientError> {
        match self.head(vault).await {
            Ok(head) => Ok(HeadState {
                epoch: head.epoch.max(head.claim.map_or(0, |claim| claim.epoch)),
                head: Some(head),
            }),
            Err(ClientError::Refused(Refusal::NoHead { epoch, .. })) => {
                Ok(HeadState { epoch, head: None })
            }
            Err(error) => Err(error),
        }
    }

    /// `PUT head`: compare-and-set on `prev`.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn set_head(
        &self,
        vault: &VaultId,
        request: &SetHead,
    ) -> Result<HeadView, ClientError> {
        self.call(Method::PUT, &route(vault, "head"), Some(request), true)
            .await
    }

    /// `GET snapshots?after=&limit=`: one page, by name. The phone sorts by
    /// `taken_at_ms`.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn snapshots(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<SnapshotView>, ClientError> {
        let path = page_path(&route(vault, "snapshots"), after, limit);
        self.call(Method::GET, &path, None::<&()>, true).await
    }

    /// Every snapshot, paged by name and then sorted by `taken_at_ms`.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn snapshots_all(&self, vault: &VaultId) -> Result<Vec<SnapshotView>, ClientError> {
        let mut all: Vec<SnapshotView> = Vec::new();
        loop {
            let after = all.last().map(|last| last.name);
            let page = self.snapshots(vault, after.as_ref(), LIST_LIMIT).await?;
            let done = page.len() < LIST_LIMIT;
            all.extend(page);
            if done {
                all.sort_by_key(|snapshot| (snapshot.taken_at_ms, snapshot.name));
                return Ok(all);
            }
        }
    }

    /// `GET held?after=&limit=`: what the vault key has asked to delete and
    /// the gateway holds for a week.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn held(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<HeldEntry>, ClientError> {
        let path = page_path(&route(vault, "held"), after, limit);
        self.call(Method::GET, &path, None::<&()>, true).await
    }

    /// `POST /v3/nonce`: a nonce for one pair request. No token, no vault.
    ///
    /// # Errors
    ///
    /// [`ClientError`]; `BUSY` as a refusal carrying when to ask again.
    pub async fn nonce(&self) -> Result<NonceAnswer, ClientError> {
        self.call(Method::POST, "/v3/nonce", None::<&()>, false)
            .await
    }

    /// `POST exists`: which of `names` the gateway does not hold.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn exists(&self, vault: &VaultId, names: &[Name]) -> Result<Vec<Name>, ClientError> {
        let missing: Missing = self
            .call(
                Method::POST,
                &route(vault, "exists"),
                Some(&Names {
                    names: names.to_vec(),
                }),
                true,
            )
            .await?;
        Ok(missing.missing)
    }

    /// `PUT o/{name}` from memory.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn put(
        &self,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        bytes: impl Into<Bytes>,
    ) -> Result<Put, ClientError> {
        let bytes = bytes.into();
        let length = bytes.len() as u64;
        let body = Full::new(bytes)
            .map_err(|never| match never {})
            .boxed_unsync();
        self.put_body(vault, name, digest, length, body).await
    }

    /// `PUT o/{name}` streamed from a spool file, never held whole.
    ///
    /// # Errors
    ///
    /// [`ClientError`], [`ClientError::Io`] for the file.
    pub async fn put_file(
        &self,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        path: &Path,
    ) -> Result<Put, ClientError> {
        let length = tokio::fs::metadata(path).await?.len();
        let chunks = self
            .counting(file_chunks(path.to_path_buf(), length))
            .map_ok(BodyFrame::data);
        let body = StreamBody::new(chunks).boxed_unsync();
        self.put_body(vault, name, digest, length, body).await
    }

    async fn put_body(
        &self,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        length: u64,
        body: Body,
    ) -> Result<Put, ClientError> {
        let mut request = self.request(Method::PUT, &object_route(vault, name), body, true)?;
        let headers = request.headers_mut();
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        headers.insert(DIGEST_HEADER, header_value(&digest.header())?);
        let response = self.send(request).await?;
        let status = response.status();
        match self.read_answer::<ObjectEntry>(response).await {
            Ok(entry) if status == StatusCode::CREATED => Ok(Put::Stored(entry)),
            Ok(entry) if status == StatusCode::OK => Ok(Put::AlreadyStored(entry)),
            Ok(_) => Err(ClientError::Protocol(format!(
                "a PUT answered {status}, which is neither 201 nor 200"
            ))),
            Err(ClientError::Refused(Refusal::NameTaken { digest })) => {
                Ok(Put::NameTaken { held: digest })
            }
            Err(error) => Err(error),
        }
    }

    /// `GET o/{name}`, whole or one range. A whole object is checked against
    /// the digest the gateway sends with it.
    ///
    /// # Errors
    ///
    /// [`ClientError`]; [`ClientError::Damaged`] when the bytes do not hash
    /// to their digest.
    pub async fn get(
        &self,
        vault: &VaultId,
        name: &Name,
        range: Option<ByteRange>,
    ) -> Result<Vec<u8>, ClientError> {
        let mut request = self.request(Method::GET, &object_route(vault, name), empty(), true)?;
        if let Some(range) = range {
            request
                .headers_mut()
                .insert(header::RANGE, header_value(&range.header())?);
        }
        let response = self.send(request).await?;
        let status = response.status();
        if !status.is_success() {
            let headers = response.headers().clone();
            let body = self.read_capped(response, MAX_ANSWER_BYTES).await?;
            return Err(refusal_of(status, &headers, &body));
        }
        let declared = response
            .headers()
            .get(DIGEST_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| Digest::from_header(value).ok());
        let bytes = self
            .read_capped(response, crate::rules::limits::MAX_OBJECT_BYTES)
            .await?;
        if status == StatusCode::OK
            && let Some(declared) = declared
            && Digest::of(&bytes) != declared
        {
            return Err(ClientError::Damaged(format!(
                "{name} does not hash to the digest it came with"
            )));
        }
        Ok(bytes)
    }

    /// `HEAD o/{name}`.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn stat(&self, vault: &VaultId, name: &Name) -> Result<ObjectStat, ClientError> {
        let request = self.request(Method::HEAD, &object_route(vault, name), empty(), true)?;
        let response = self.send(request).await?;
        let status = response.status();
        if !status.is_success() {
            // A `HEAD` answer has no body, so a `MOVED` arrives without the
            // signed claim it must carry. Ask a route that can say it.
            let moved = response
                .headers()
                .get(CODE_HEADER)
                .and_then(|value| value.to_str().ok())
                == Some(Code::Moved.as_str());
            if moved && let Err(error) = self.head(vault).await {
                return Err(error);
            }
            return Err(refusal_of(status, response.headers(), &[]));
        }
        let headers = response.headers();
        let size = headers
            .get(header::CONTENT_LENGTH)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        let digest = headers
            .get(DIGEST_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| Digest::from_header(value).ok());
        match (size, digest) {
            (Some(size), Some(digest)) => Ok(ObjectStat { size, digest }),
            _ => Err(ClientError::Protocol(
                "a HEAD without its size or digest".to_owned(),
            )),
        }
    }

    /// `POST bundle` of frames already in memory: [`Self::bundle_parts`].
    ///
    /// # Errors
    ///
    /// As [`Self::bundle_parts`].
    pub async fn bundle(
        &self,
        vault: &VaultId,
        frames: &[Frame],
    ) -> Result<BundleAnswer, ClientError> {
        let parts = frames
            .iter()
            .map(|frame| Part {
                name: frame.name,
                digest: frame.digest,
                source: Source::Bytes(Bytes::copy_from_slice(&frame.bytes)),
            })
            .collect();
        self.bundle_parts(vault, parts).await
    }

    /// `POST bundle`: many parts in one body, each answered as its own `PUT`
    /// would be ([`BundleAnswer`]; [`BundleAnswer::acknowledged`] is what a
    /// phone may record).
    ///
    /// **The body streams.** Each part's header is written as its turn
    /// comes, and a [`Source::File`] is read 256 KiB at a time as the body
    /// is sent, so a bundle of [`MAX_BUNDLE_BYTES`] never sits in memory
    /// (#1080, the root's ruling A14). The gateway stages each frame to its
    /// own file as it arrives in the same way.
    ///
    /// # Errors
    ///
    /// [`ClientError`]. `TOO_LARGE`, before a byte is sent, for parts whose
    /// frames pass [`MAX_BUNDLE_BYTES`] — the answer the gateway would give,
    /// given here so the bundle is not sent to be refused. [`ClientError::Io`]
    /// for a file that cannot be read, or ends before the length it had when
    /// the bundle was measured: the request fails rather than send a short
    /// frame.
    pub async fn bundle_parts(
        &self,
        vault: &VaultId,
        parts: Vec<Part>,
    ) -> Result<BundleAnswer, ClientError> {
        let mut measured = Vec::with_capacity(parts.len());
        let mut length = 0_u64;
        for part in parts {
            let len = match &part.source {
                Source::Bytes(bytes) => bytes.len() as u64,
                Source::File(path) => tokio::fs::metadata(path).await?.len(),
            };
            length = length.saturating_add(HEADER_LEN as u64).saturating_add(len);
            measured.push((part, len));
        }
        if length > MAX_BUNDLE_BYTES {
            return Err(Refusal::TooLarge {
                limit: MAX_BUNDLE_BYTES,
            }
            .into());
        }
        let body = StreamBody::new(
            self.counting(parts_stream(measured))
                .map_ok(BodyFrame::data),
        )
        .boxed_unsync();
        let mut request = self.request(Method::POST, &route(vault, "bundle"), body, true)?;
        let headers = request.headers_mut();
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        let response = self.send(request).await?;
        self.read_answer(response).await
    }

    /// `POST fetch`, collected: every frame [`Self::fetch_each`] hands over,
    /// in order. The whole answer is in memory at the end; a restore reading
    /// a large one uses [`Self::fetch_each`].
    ///
    /// # Errors
    ///
    /// As [`Self::fetch_each`].
    pub async fn fetch(&self, vault: &VaultId, names: &[Name]) -> Result<Vec<Frame>, ClientError> {
        let mut frames = Vec::new();
        self.fetch_each(vault, names, |frame| {
            frames.push(frame);
            Ok(())
        })
        .await?;
        Ok(frames)
    }

    /// `POST fetch`, frame by frame: `each` is handed every object the
    /// gateway holds of `names`, in the order asked, as soon as its bytes are
    /// complete and hash to its digest. One frame is in memory at a time,
    /// never the answer (#1080, the root's ruling A14). Answers how many
    /// frames came; a name that did not come is one the gateway does not
    /// hold.
    ///
    /// While this runs the client's connection is busy with the answer;
    /// `each` is synchronous and cannot use the client.
    ///
    /// # Errors
    ///
    /// [`ClientError`]; [`ClientError::Protocol`] for an answer that is not a
    /// bundle or a frame over [`MAX_OBJECT_BYTES`]; [`ClientError::Damaged`]
    /// for a frame that does not hash to its digest; [`ClientError::Io`] for
    /// an error `each` returns, which ends the fetch.
    pub async fn fetch_each(
        &self,
        vault: &VaultId,
        names: &[Name],
        mut each: impl FnMut(Frame) -> std::io::Result<()>,
    ) -> Result<usize, ClientError> {
        let body = json_body(&Names {
            names: names.to_vec(),
        })?;
        let request = self.request(Method::POST, &route(vault, "fetch"), body, true)?;
        let response = self.send(request).await?;
        let status = response.status();
        if !status.is_success() {
            let headers = response.headers().clone();
            let body = self.read_capped(response, MAX_ANSWER_BYTES).await?;
            return Err(refusal_of(status, &headers, &body));
        }
        let mut stream = response.into_body().into_data_stream();
        let mut decoder = Decoder::new();
        let mut current = None;
        let mut count = 0;
        while let Some(chunk) = self.next_chunk(&mut stream).await? {
            let mut rest: &[u8] = &chunk;
            loop {
                let (step, used) = decoder.step(rest).map_err(not_a_bundle)?;
                rest = &rest[used..];
                let Some(step) = step else { break };
                count += usize::from(take(step, &mut current, &mut each)?);
            }
        }
        while let (Some(step), _) = decoder.step(&[]).map_err(not_a_bundle)? {
            count += usize::from(take(step, &mut current, &mut each)?);
        }
        decoder.finish().map_err(not_a_bundle)?;
        Ok(count)
    }

    /// `GET objects`: one page, sorted by name.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        limit: usize,
    ) -> Result<Vec<ObjectEntry>, ClientError> {
        let path = page_path(&route(vault, "objects"), after, limit);
        self.call(Method::GET, &path, None::<&()>, true).await
    }

    /// `POST delete`: the vault key's signed request to hold `names` for a
    /// week.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn delete(
        &self,
        vault: &VaultId,
        request: &DeleteRequest,
    ) -> Result<DeleteAnswer, ClientError> {
        self.call(Method::POST, &route(vault, "delete"), Some(request), true)
            .await
    }

    /// `POST undo`: the vault key's signed request to lift holds.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn undo(
        &self,
        vault: &VaultId,
        request: &UndoRequest,
    ) -> Result<Undone, ClientError> {
        self.call(Method::POST, &route(vault, "undo"), Some(request), true)
            .await
    }

    /// `POST revoke`: this client's token revokes itself, and every route
    /// answers it `UNAUTHORIZED` after.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn revoke(&self, vault: &VaultId) -> Result<Revoked, ClientError> {
        self.call(Method::POST, &route(vault, "revoke"), None::<&()>, true)
            .await
    }

    /// A `PUT` for the platform to perform: no network here, only the URL and
    /// headers the shell's background upload needs, built for the address
    /// that answered last.
    ///
    /// # Errors
    ///
    /// [`ClientError::NoToken`] without a token, [`ClientError::Unreachable`]
    /// with no address.
    pub fn presign_put(
        &self,
        vault: &VaultId,
        name: &Name,
        digest: &Digest,
        size: u64,
    ) -> Result<Handoff, ClientError> {
        let token = self.token().ok_or(ClientError::NoToken)?;
        let addr = self
            .preferred_addr()
            .ok_or_else(|| ClientError::Unreachable("no address".to_owned()))?;
        Ok(Handoff {
            url: format!("https://{addr}{}", object_route(vault, name)),
            method: "PUT".to_owned(),
            headers: vec![
                ("authorization".to_owned(), format!("Bearer {token}")),
                (DIGEST_HEADER.to_owned(), digest.header()),
                ("content-length".to_owned(), size.to_string()),
                (
                    "content-type".to_owned(),
                    "application/octet-stream".to_owned(),
                ),
            ],
        })
    }

    // ─── the plumbing ────────────────────────────────────────────────────────

    /// The next chunk of a response body, within the idle limit.
    async fn next_chunk(
        &self,
        body: &mut http_body_util::BodyDataStream<Incoming>,
    ) -> Result<Option<Bytes>, ClientError> {
        self.guarded(self.limits().idle, "reading the answer", body.try_next())
            .await?
            .map_err(|error| ClientError::Unreachable(error.to_string()))
    }

    /// A response body, refusing one longer than `cap`.
    async fn read_capped(
        &self,
        response: Response<Incoming>,
        cap: u64,
    ) -> Result<Vec<u8>, ClientError> {
        let mut body = response.into_body().into_data_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = self.next_chunk(&mut body).await? {
            if (bytes.len() + chunk.len()) as u64 > cap {
                return Err(ClientError::Protocol(format!("an answer over {cap} bytes")));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }

    /// A JSON answer, or the refusal it is.
    async fn read_answer<T: DeserializeOwned>(
        &self,
        response: Response<Incoming>,
    ) -> Result<T, ClientError> {
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = self.read_capped(response, MAX_ANSWER_BYTES).await?;
        if status.is_success() {
            serde_json::from_slice(&bytes).map_err(|error| ClientError::Protocol(error.to_string()))
        } else {
            Err(refusal_of(status, &headers, &bytes))
        }
    }

    async fn call<T: DeserializeOwned, B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        authorized: bool,
    ) -> Result<T, ClientError> {
        let body = match body {
            Some(body) => json_body(body)?,
            None => empty(),
        };
        let request = self.request(method, path, body, authorized)?;
        let response = self.send(request).await?;
        self.read_answer(response).await
    }

    fn request(
        &self,
        method: Method,
        path: &str,
        body: Body,
        authorized: bool,
    ) -> Result<Request<Body>, ClientError> {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .body(body)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        if authorized {
            let token = self.token().ok_or(ClientError::NoToken)?;
            request.headers_mut().insert(
                header::AUTHORIZATION,
                header_value(&format!("Bearer {token}"))?,
            );
        }
        Ok(request)
    }

    /// Send on the kept connection, dialling one when there is none. Every wait is bounded and
    /// watches the stop (the module header's "no timeout once connected" is gone).
    async fn send(&self, mut request: Request<Body>) -> Result<Response<Incoming>, ClientError> {
        let limits = self.limits();
        let dial = (CONNECT_TIMEOUT + HANDSHAKE_TIMEOUT * 2)
            .saturating_mul(u32::try_from(self.addrs.len().max(1)).unwrap_or(u32::MAX));
        let mut live = self.live.lock().await;
        for attempt in 0..2 {
            if live.as_ref().is_none_or(|(sender, _)| sender.is_closed()) {
                *live = Some(self.guarded(dial, "dialling", self.connect()).await??);
            }
            let Some((sender, host)) = live.as_mut() else {
                continue;
            };
            request
                .headers_mut()
                .insert(header::HOST, header_value(host)?);
            let ready = self
                .guarded(limits.header, "waiting for the connection", sender.ready())
                .await;
            match ready {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    *live = None;
                    continue;
                }
                Err(error) => {
                    *live = None;
                    return Err(error);
                }
            }
            // A request whose answer never came may have reached the gateway: the connection is
            // dropped so the next call dials fresh, and the request is not repeated here.
            let sent = self
                .guarded(
                    limits.header,
                    "waiting for the answer",
                    sender.try_send_request(request),
                )
                .await;
            let sent = match sent {
                Ok(sent) => sent,
                Err(error) => {
                    *live = None;
                    return Err(error);
                }
            };
            match sent {
                Ok(response) => return Ok(response),
                Err(mut failed) => {
                    *live = None;
                    match failed.take_message() {
                        Some(unsent) if attempt == 0 => request = unsent,
                        _ => return Err(ClientError::Unreachable(failed.error().to_string())),
                    }
                }
            }
        }
        Err(ClientError::Unreachable(
            "the connection closed before the request was sent".to_owned(),
        ))
    }

    /// Dial the addresses in order, from the one that answered last.
    async fn connect(&self) -> Result<(Sender, String), ClientError> {
        if self.addrs.is_empty() {
            return Err(ClientError::Unreachable("no address".to_owned()));
        }
        let start = self.preferred.load(Ordering::Relaxed);
        let mut untrusted = false;
        let mut last = String::new();
        for offset in 0..self.addrs.len() {
            let index = (start + offset) % self.addrs.len();
            let addr = &self.addrs[index];
            let socket = match tokio::time::timeout(
                CONNECT_TIMEOUT,
                tokio::net::TcpStream::connect(addr.as_str()),
            )
            .await
            {
                Ok(Ok(socket)) => socket,
                Ok(Err(error)) => {
                    last = format!("{addr}: {error}");
                    continue;
                }
                Err(_) => {
                    last = format!("{addr}: timed out");
                    continue;
                }
            };
            self.dials.fetch_add(1, Ordering::Relaxed);
            let _ = socket.set_nodelay(true);
            // A peer that vanishes under a silent connection is found by the kernel as well.
            let keepalive = socket2::TcpKeepalive::new()
                .with_time(KEEPALIVE)
                .with_interval(KEEPALIVE);
            let _ = socket2::SockRef::from(&socket).set_tcp_keepalive(&keepalive);
            let connector = TlsConnector::from(Arc::clone(&self.config));
            // The name is not the trust — the verifier compares bytes — but a
            // handshake needs one, and the certificate carries `localhost`.
            let server_name = ServerName::try_from("localhost")
                .map_err(|error| ClientError::Protocol(error.to_string()))?;
            let stream = match tokio::time::timeout(
                HANDSHAKE_TIMEOUT,
                connector.connect(server_name, socket),
            )
            .await
            {
                Ok(Ok(stream)) => stream,
                Ok(Err(error)) => {
                    untrusted |= is_untrusted(&error);
                    last = format!("{addr}: {error}");
                    continue;
                }
                Err(_) => {
                    last = format!("{addr}: the handshake timed out");
                    continue;
                }
            };
            if let Some(der) = stream
                .get_ref()
                .1
                .peer_certificates()
                .and_then(<[_]>::first)
                && let Ok(mut seen) = self.seen.lock()
            {
                *seen = Some(der.to_vec());
            }
            let (sender, connection) = tokio::time::timeout(
                HANDSHAKE_TIMEOUT,
                hyper::client::conn::http1::handshake(TokioIo::new(stream)),
            )
            .await
            .map_err(|_| ClientError::Unreachable(format!("{addr}: the HTTP handshake timed out")))?
            .map_err(|error| ClientError::Unreachable(format!("{addr}: {error}")))?;
            // The connection task drives the stream and ends with it; its
            // error is the one the next request reports.
            tokio::spawn(async move {
                let _ = connection.await;
            });
            self.preferred.store(index, Ordering::Relaxed);
            return Ok((sender, addr.clone()));
        }
        if untrusted {
            Err(ClientError::Untrusted)
        } else {
            Err(ClientError::Unreachable(last))
        }
    }
}

/// What the handshake decides, as a pure function of the two answers: the
/// `/v3/info` answer, and the protocol an `/v2/info` answered with, when it
/// was asked.
fn handshake(v3: Result<Info, ClientError>, older: Option<u32>) -> Result<Info, ClientError> {
    match (v3, older) {
        (Ok(info), _) if info.protocol < REQUIRED_PROTOCOL => Err(ClientError::GatewayTooOld {
            found: info.protocol,
            required: REQUIRED_PROTOCOL,
        }),
        (
            Err(ClientError::Refused(Refusal::NotFound { .. } | Refusal::BadRequest)),
            Some(found),
        ) => Err(ClientError::GatewayTooOld {
            found,
            required: REQUIRED_PROTOCOL,
        }),
        (answer, _) => answer,
    }
}

/// `route?limit=&after=`.
fn page_path(route: &str, after: Option<&Name>, limit: usize) -> String {
    let mut path = format!("{route}?limit={limit}");
    if let Some(after) = after {
        path.push_str(&format!("&after={after}"));
    }
    path
}

fn route(vault: &VaultId, tail: &str) -> String {
    format!("/v3/v/{vault}/{tail}")
}

fn object_route(vault: &VaultId, name: &Name) -> String {
    format!("/v3/v/{vault}/o/{name}")
}

/// Exactly `length` bytes of the file at `path`, opened on first poll and
/// read [`FILE_CHUNK`] at a time. A file that ends early fails the stream,
/// and with it the request: a short body is never sent as a whole one.
fn file_chunks(
    path: PathBuf,
    length: u64,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    futures::stream::try_unfold(
        (None::<tokio::fs::File>, path, length),
        |(file, path, remaining)| async move {
            if remaining == 0 {
                return Ok(None);
            }
            let mut file = match file {
                Some(file) => file,
                None => tokio::fs::File::open(&path).await?,
            };
            let want = usize::try_from(remaining.min(FILE_CHUNK)).unwrap_or(0);
            let mut buffer = vec![0_u8; want];
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    format!("{} ended {remaining} bytes early", path.display()),
                ));
            }
            buffer.truncate(read);
            Ok(Some((
                Bytes::from(buffer),
                (Some(file), path, remaining - read as u64),
            )))
        },
    )
}

/// A bundle's body: each part's frame header, then its bytes, one part after
/// the other, each file opened only when its turn comes.
fn parts_stream(
    parts: Vec<(Part, u64)>,
) -> impl futures::Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static {
    futures::stream::iter(parts)
        .map(|(part, len)| {
            let header = Bytes::copy_from_slice(&frame_header(&part.name, &part.digest, len));
            let bytes = match part.source {
                Source::Bytes(bytes) => futures::stream::once(async move { Ok(bytes) }).boxed(),
                Source::File(path) => file_chunks(path, len).boxed(),
            };
            futures::stream::once(async move { Ok(header) }).chain(bytes)
        })
        .flatten()
}

/// One step of a fetch answer: a frame begins, grows, or is complete —
/// checked against its digest and handed to `each`. Answers whether a frame
/// was handed over.
fn take(
    step: Step<'_>,
    current: &mut Option<Frame>,
    each: &mut impl FnMut(Frame) -> std::io::Result<()>,
) -> Result<bool, ClientError> {
    match step {
        Step::Header(header) => {
            if header.len > MAX_OBJECT_BYTES {
                return Err(ClientError::Protocol(format!(
                    "a fetched frame of {} bytes, over the object cap",
                    header.len
                )));
            }
            *current = Some(Frame {
                name: header.name,
                digest: header.digest,
                bytes: Vec::with_capacity(usize::try_from(header.len).unwrap_or(0)),
            });
            Ok(false)
        }
        Step::Body(bytes) => {
            if let Some(frame) = current {
                frame.bytes.extend_from_slice(bytes);
            }
            Ok(false)
        }
        Step::End => {
            let Some(frame) = current.take() else {
                return Ok(false);
            };
            if Digest::of(&frame.bytes) != frame.digest {
                return Err(ClientError::Damaged(format!(
                    "{} does not hash to its digest",
                    frame.name
                )));
            }
            each(frame)?;
            Ok(true)
        }
    }
}

fn not_a_bundle(refusal: Refusal) -> ClientError {
    ClientError::Protocol(format!("a fetch answer that is not a bundle: {refusal}"))
}

fn empty() -> Body {
    Full::new(Bytes::new())
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn json_body<B: Serialize>(body: &B) -> Result<Body, ClientError> {
    let bytes =
        serde_json::to_vec(body).map_err(|error| ClientError::Protocol(error.to_string()))?;
    Ok(Full::new(Bytes::from(bytes))
        .map_err(|never| match never {})
        .boxed_unsync())
}

fn header_value(text: &str) -> Result<HeaderValue, ClientError> {
    HeaderValue::from_str(text).map_err(|error| ClientError::Protocol(error.to_string()))
}

/// What a non-success answer means. The body's code is the answer; a body
/// that is not a refusal falls back to the `centraid-code` header, which is
/// how a `HEAD` says why.
fn refusal_of(status: StatusCode, headers: &hyper::HeaderMap, body: &[u8]) -> ClientError {
    let parsed = serde_json::from_slice::<RefusalBody>(body)
        .ok()
        .or_else(|| {
            let code = Code::parse(headers.get(CODE_HEADER)?.to_str().ok()?)?;
            Some(RefusalBody::bare(code, 0))
        });
    match parsed {
        // Every code has one status (`Code::status`); a refusal under another
        // breaks the protocol, and is not acted on as its code.
        Some(body) if body.code.status() != status.as_u16() => ClientError::Protocol(format!(
            "{} answered with status {status}, not {}",
            body.code,
            body.code.status()
        )),
        Some(body) if body.code == Code::Internal => ClientError::GatewayFault,
        Some(body) => Refusal::from_body(&body).map_or_else(
            || {
                ClientError::Protocol(format!(
                    "a {} refusal without the companion its code requires",
                    body.code
                ))
            },
            ClientError::Refused,
        ),
        None => ClientError::Protocol(format!("status {status} without a refusal")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::ids::GatewayId;

    fn info(protocol: u32) -> Info {
        Info {
            gateway_id: GatewayId::from_bytes([1; 16]),
            protocol,
            time_ms: 0,
        }
    }

    /// A GATEWAY BELOW PROTOCOL 3 IS REFUSED, TYPED, whichever way it says so:
    /// it answers `/v3/info` with a lower protocol, or it does not know
    /// `/v3/info` and answers `/v2/info`. There is no fallback to speak v2.
    #[test]
    fn an_older_gateway_is_too_old_and_never_spoken_to() {
        assert!(matches!(
            handshake(Ok(info(2)), None),
            Err(ClientError::GatewayTooOld {
                found: 2,
                required: REQUIRED_PROTOCOL
            })
        ));
        assert!(matches!(
            handshake(
                Err(ClientError::Refused(Refusal::NotFound { name: None })),
                Some(2)
            ),
            Err(ClientError::GatewayTooOld { found: 2, .. })
        ));
        assert!(matches!(
            handshake(
                Err(ClientError::Refused(Refusal::NotFound { name: None })),
                None
            ),
            Err(ClientError::Refused(Refusal::NotFound { .. }))
        ));
        assert!(handshake(Ok(info(REQUIRED_PROTOCOL)), None).is_ok());
    }
}
