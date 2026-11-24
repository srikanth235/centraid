//! THE PHONE'S CLIENT (#1080).
//!
//! HTTP/2 over TLS over TCP to one gateway, with HTTP/1.1 when the gateway's
//! ALPN answers only that, trusting exactly one certificate ([`tls`]). Every
//! route of protocol 1 is a method here; the bodies and refusals are
//! [`crate::rules`]' own types, so the client reads back exactly what the
//! server rendered.
//!
//! # EVERY ADDRESS IS DIALLED, THE FIRST VERIFIED HANDSHAKE WINS
//!
//! A [`Destination`] carries the addresses the pairing QR or the last
//! Bonjour browse listed. The client dials the preferred one (the one that
//! won last) first and each of the others after [`Limits::stagger`] (250 ms),
//! or at once when everything dialled before it has failed, so three dead
//! addresses ahead of a live one cost one dial attempt and no wait. The first
//! handshake that verifies the pinned certificate wins and becomes the
//! preferred address; the rest are dropped, and so are their sockets. No
//! address answering is [`ClientError::Unreachable`] — a phone away from home,
//! not a refusal. An address that answers with the wrong certificate is
//! [`ClientError::Untrusted`], which outranks "unreachable" when nothing else
//! answered: it is a different machine where the gateway should be.
//!
//! # ONE CONNECTION, KEPT, AND RETRIES BY COUNT
//!
//! Requests on one client share one connection, re-dialled when the gateway
//! closed it. A call that may have reached the gateway is repeated only when
//! it is **idempotent** (`info`, a `head` read, `snapshots`, `held`, `exists`,
//! `bundle`, `fetch`, `GET` and `HEAD` of an object, `objects`), at most
//! [`MAX_RETRIES`] times, and only after the connection dropped under it: a
//! gateway that merely went silent is not asked again. A `BUSY` answer is
//! honoured: the call waits the `retry_after_ms` it was told (up to
//! [`Limits::busy_cap`]) and asks again, as one of those retries. The head's
//! compare-and-set, a delete, an undo, a check and a revoke are never
//! repeated here: the caller reads the head and decides.
//!
//! # A TYPED REACH
//!
//! [`Reach`] says what a call found, in the words the Backup screen uses:
//! `ok`, `unreachable`, `untrusted`, `too_old`, `pair_again`, `moved`,
//! `frozen`, `busy` ([`ClientError::reach`], [`Client::reach`]).
//!
//! # NO WAIT IS UNBOUNDED
//!
//! A gateway that went to sleep, or a network that changed, leaves the connection open and
//! silent. Connect and handshake have their own limits; after that a request is given
//! [`HEADER_TIMEOUT`] without progress to answer its headers (a body frame handed to the socket is
//! progress) and a body read [`IDLE_TIMEOUT`] between chunks, both [`Limits`]. A call also looks at
//! its [`Stop`] every [`Limits::poll`] while it waits, so a Cancel ends a transfer in flight.
//! A call that gives up drops the connection; the next one dials fresh.
//!
//! # BUNDLES AND FETCHES STREAM
//!
//! [`Client::bundle_parts`] sends parts from memory or straight from staged
//! files, and [`Client::fetch_each`] hands the answer over one frame at a
//! time, so a body of [`MAX_BUNDLE_BYTES`] never sits in memory at either end
//! (#1080, the root's ruling A14). `tests/store_client.rs` holds a process
//! sending a quarter-gibibyte up and back to a few MiB of growth.
//!
//! # WHAT THIS CLIENT NEVER SAYS
//!
//! That something is backed up. It returns what the gateway acknowledged —
//! [`BundleAnswer::acknowledged`] — and nothing more; "backed up" is a word
//! the phone may use only over an acknowledgement it recorded.

pub mod tls;

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::stream::FuturesUnordered;
use futures::{StreamExt as _, TryStreamExt as _};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt as _, Full, StreamBody};
use hyper::body::{Frame as BodyFrame, Incoming};
use hyper::header::{self, HeaderValue};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::io::AsyncReadExt as _;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::ClientConfig;
use tokio_rustls::rustls::pki_types::ServerName;

use crate::client::tls::{Trust, client_config, is_untrusted};
use crate::rules::bundle::{Decoder, Frame, HEADER_LEN, Step, header as frame_header};
use crate::rules::code::{Code, Refusal, RefusalBody};
use crate::rules::ids::{Digest, GatewayId, Name, Pin, Token, VaultId};
use crate::rules::limits::{LIST_LIMIT, MAX_BUNDLE_BYTES, MAX_OBJECT_BYTES, REQUIRED_PROTOCOL};
use crate::rules::range::ByteRange;
use crate::rules::signing::{HeadFields, verify_claim, verify_head};
use crate::rules::wire::{
    BundleAnswer, CODE_HEADER, DIGEST_HEADER, DeleteAnswer, DeleteRequest, HeadView, HeldEntry,
    Info, Missing, Names, NonceAnswer, ObjectEntry, PairRequest, Paired, Revoked, SetHead,
    SnapshotView, UndoRequest, Undone,
};

/// How many times an idempotent call is repeated after its connection dropped
/// or the gateway said `BUSY`: three, counted, never timed.
pub const MAX_RETRIES: usize = 3;

/// How long the next address waits behind the ones dialled before it.
pub const DIAL_STAGGER: Duration = Duration::from_millis(250);

/// The longest a `BUSY`'s `retry_after_ms` is waited in one go.
pub const BUSY_CAP: Duration = Duration::from_secs(120);

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
    /// An answer's signature does not verify against the vault's key and the
    /// gateway's id the phone knows: a gateway that lies, or the wrong one.
    /// Names what failed.
    #[error("{0} is not signed by this vault for this gateway")]
    Unverified(&'static str),
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

/// What a call found out about the gateway, in the words the Backup screen
/// uses. Anything the gateway answered that is not one of these is `Ok`: it
/// was reached, trusted, current and willing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    /// Reached, trusted, current: the call went through or was refused for its
    /// own reason.
    Ok,
    /// No address answered, or the connection kept dropping.
    Unreachable,
    /// An address answered with a certificate that is not the pinned one, or
    /// a head the vault key did not sign.
    Untrusted,
    /// The gateway speaks an older protocol than this phone requires.
    TooOld,
    /// The gateway does not know this token: pair again.
    PairAgain,
    /// A newer phone took the vault over: this phone is superseded.
    Moved,
    /// The operator froze the vault.
    Frozen,
    /// The gateway is busy and said when to ask again.
    Busy,
}

impl ClientError {
    /// This error as a [`Reach`].
    #[must_use]
    pub fn reach(&self) -> Reach {
        match self {
            Self::Unreachable(_) | Self::GatewayFault | Self::Protocol(_) | Self::Io(_) => {
                Reach::Unreachable
            }
            Self::Untrusted | Self::Unverified(_) => Reach::Untrusted,
            Self::GatewayTooOld { .. } => Reach::TooOld,
            Self::NoToken | Self::Refused(Refusal::Unauthorized) => Reach::PairAgain,
            Self::Refused(Refusal::Moved { .. }) => Reach::Moved,
            Self::Refused(Refusal::Frozen { .. }) => Reach::Frozen,
            Self::Refused(Refusal::Busy { .. }) => Reach::Busy,
            Self::Refused(_) | Self::Damaged(_) => Reach::Ok,
        }
    }
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

/// A bundle `POST` prepared for someone else to perform: the iPhone's
/// background `URLSession` and Android's WorkManager upload a staged bundle
/// file while the app is suspended. The shell adds the file as the body and
/// pins the destination's certificate in its own trust challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handoff {
    /// `https://<preferred address>/v1/v/<vault>/bundle`.
    pub url: String,
    /// `POST`.
    pub method: String,
    /// `authorization`, `content-length` and `content-type`, lowercase. The
    /// `authorization` value is the bearer token: the shell holds it as a
    /// credential.
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
    /// How long each address waits behind the ones dialled before it
    /// ([`DIAL_STAGGER`]).
    pub stagger: Duration,
    /// The most of a `BUSY`'s `retry_after_ms` one wait takes ([`BUSY_CAP`]).
    pub busy_cap: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            header: HEADER_TIMEOUT,
            idle: IDLE_TIMEOUT,
            poll: STOP_POLL,
            stagger: DIAL_STAGGER,
            busy_cap: BUSY_CAP,
        }
    }
}

type Body = UnsyncBoxBody<Bytes, std::io::Error>;

/// The connection's request sender: HTTP/2 when ALPN agreed `h2`, HTTP/1.1
/// otherwise.
enum Sender {
    One(hyper::client::conn::http1::SendRequest<Body>),
    Two(hyper::client::conn::http2::SendRequest<Body>),
}

impl Sender {
    fn is_closed(&self) -> bool {
        match self {
            Self::One(sender) => sender.is_closed(),
            Self::Two(sender) => sender.is_closed(),
        }
    }

    async fn ready(&mut self) -> Result<(), hyper::Error> {
        match self {
            Self::One(sender) => sender.ready().await,
            Self::Two(sender) => sender.ready().await,
        }
    }

    async fn try_send(
        &mut self,
        request: Request<Body>,
    ) -> Result<Response<Incoming>, hyper::client::conn::TrySendError<Request<Body>>> {
        match self {
            Self::One(sender) => sender.try_send_request(request).await,
            Self::Two(sender) => sender.try_send_request(request).await,
        }
    }

    const fn is_h2(&self) -> bool {
        matches!(self, Self::Two(_))
    }
}

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
    /// Addresses dialled, whether or not they answered.
    attempts: Arc<AtomicUsize>,
    /// Idempotent calls repeated.
    retries: Arc<AtomicUsize>,
    /// Connections that dropped under a request that may have reached the gateway.
    dropped: Arc<AtomicUsize>,
    /// What each `BUSY` told this client to wait, in milliseconds.
    busy_waits: Arc<Mutex<Vec<u64>>>,
    /// `h2` or `http/1.1`: what the last connection negotiated.
    negotiated: Arc<Mutex<Option<&'static str>>>,
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
            attempts: Arc::new(AtomicUsize::new(0)),
            retries: Arc::new(AtomicUsize::new(0)),
            dropped: Arc::new(AtomicUsize::new(0)),
            busy_waits: Arc::new(Mutex::new(Vec::new())),
            negotiated: Arc::new(Mutex::new(None)),
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
            attempts: Arc::clone(&self.attempts),
            retries: Arc::clone(&self.retries),
            dropped: Arc::clone(&self.dropped),
            busy_waits: Arc::clone(&self.busy_waits),
            negotiated: Arc::clone(&self.negotiated),
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

    /// Forget the kept connection, so the next call dials every address again
    /// (the preferred one first): what a phone does when its network changed.
    pub async fn drop_connection(&self) {
        *self.live.lock().await = None;
    }

    /// How many addresses this client, and every sibling, has dialled: one per
    /// address per connection attempt, answered or not.
    #[must_use]
    pub fn dial_attempts(&self) -> usize {
        self.attempts.load(Ordering::Relaxed)
    }

    /// How many times an idempotent call was repeated, `BUSY` waits included.
    #[must_use]
    pub fn retries(&self) -> usize {
        self.retries.load(Ordering::Relaxed)
    }

    /// What each `BUSY` answer told this client to wait, in order, in
    /// milliseconds.
    #[must_use]
    pub fn busy_waits(&self) -> Vec<u64> {
        self.busy_waits
            .lock()
            .map(|waits| waits.clone())
            .unwrap_or_default()
    }

    /// The index in [`Destination::addrs`] that won the last dial and is
    /// dialled first next time.
    #[must_use]
    pub fn preferred_index(&self) -> usize {
        self.preferred.load(Ordering::Relaxed)
    }

    /// `h2` or `http/1.1`: the protocol the last connection negotiated.
    #[must_use]
    pub fn negotiated(&self) -> Option<&'static str> {
        self.negotiated.lock().ok().and_then(|held| *held)
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

    /// `GET /v1/info`. Needs no token. **The handshake**: a gateway that
    /// answers with a protocol below [`REQUIRED_PROTOCOL`] is refused as
    /// [`ClientError::GatewayTooOld`]; an older dialect is never spoken.
    ///
    /// # Errors
    ///
    /// [`ClientError`], [`ClientError::GatewayTooOld`] included.
    pub async fn info(&self) -> Result<Info, ClientError> {
        let answer: Result<Info, ClientError> = self
            .call_idem(Method::GET, "/v1/info", None::<&()>, false)
            .await;
        handshake(answer)
    }

    /// `POST /v1/pair`. On success the client keeps the token.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn pair(&self, request: &PairRequest) -> Result<Paired, ClientError> {
        let paired: Paired = self
            .call(Method::POST, "/v1/pair", Some(request), false)
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
        self.call_idem(Method::GET, &route(vault, "head"), None::<&()>, true)
            .await
    }

    /// `GET head`, with `NO_HEAD` folded into an answer: what a restore reads
    /// before it claims one past the epoch. **The epoch is verified, never
    /// taken on the gateway's word**: the head's signature and the standing
    /// claim's are checked against `vault` (the identity public key) and
    /// `gateway` (the id the phone learned at pairing, not one this answer
    /// names), and the writer epoch is the greater of the two verified epochs
    /// — or 1, the pairing's, when the vault has neither. An unsigned number
    /// in the answer, `NO_HEAD`'s included, is not read.
    ///
    /// # Errors
    ///
    /// [`ClientError`]; [`ClientError::Unverified`] when the head or the claim
    /// is not signed by this vault for this gateway.
    pub async fn head_state(
        &self,
        vault: &VaultId,
        gateway: &GatewayId,
    ) -> Result<HeadState, ClientError> {
        let (head, claim) = match self.head(vault).await {
            Ok(head) => (Some(head), head.claim),
            Err(ClientError::Refused(Refusal::NoHead { claim, .. })) => (None, claim.map(|c| *c)),
            Err(error) => return Err(error),
        };
        let mut epoch = 1;
        if let Some(head) = &head {
            let fields = HeadFields {
                epoch: head.epoch,
                generation: head.generation,
                writes: head.writes,
                taken_at_ms: head.taken_at_ms,
                manifest: head.name,
                prev: head.prev,
            };
            if !verify_head(gateway, vault, &fields, &head.signature) {
                return Err(ClientError::Unverified("the head"));
            }
            epoch = epoch.max(head.epoch);
        }
        if let Some(claim) = &claim {
            if !verify_claim(
                gateway,
                vault,
                claim.epoch,
                claim.head_seen.as_ref(),
                &claim.nonce,
                &claim.signature,
            ) {
                return Err(ClientError::Unverified("the standing claim"));
            }
            epoch = epoch.max(claim.epoch);
        }
        Ok(HeadState { epoch, head })
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
        self.call_idem(Method::GET, &path, None::<&()>, true).await
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
        self.call_idem(Method::GET, &path, None::<&()>, true).await
    }

    /// `POST /v1/nonce`: a nonce for one pair request. No token, no vault.
    ///
    /// # Errors
    ///
    /// [`ClientError`]; `BUSY` as a refusal carrying when to ask again.
    pub async fn nonce(&self) -> Result<NonceAnswer, ClientError> {
        self.call(Method::POST, "/v1/nonce", None::<&()>, false)
            .await
    }

    /// `POST exists`: which of `names` the gateway does not hold.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn exists(&self, vault: &VaultId, names: &[Name]) -> Result<Vec<Name>, ClientError> {
        let missing: Missing = self
            .call_idem(
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
        self.retrying(|| self.get_once(vault, name, range)).await
    }

    async fn get_once(
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
        self.retrying(|| self.stat_once(vault, name)).await
    }

    async fn stat_once(&self, vault: &VaultId, name: &Name) -> Result<ObjectStat, ClientError> {
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

    /// `POST bundle`: many parts in one body, each committed on its own and
    /// answered on its own ([`BundleAnswer`]; [`BundleAnswer::acknowledged`] is
    /// what a phone may record).
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
        // Idempotent: a frame is write-once by name and digest, so the whole
        // body is sent again when the connection dropped under it.
        self.retrying(|| self.bundle_once(vault, parts.clone()))
            .await
    }

    async fn bundle_once(
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
        // Repeated after a drop only while nothing has been handed to `each`:
        // a frame is never delivered twice.
        let mut tried = 0;
        loop {
            let before = self.dropped.load(Ordering::Relaxed);
            let mut delivered = 0;
            let outcome = Box::pin(self.fetch_once(vault, names, &mut |frame| {
                delivered += 1;
                each(frame)
            }))
            .await;
            match outcome {
                Err(error) if delivered == 0 && self.again(&error, &mut tried, before).await? => {}
                other => return other,
            }
        }
    }

    async fn fetch_once(
        &self,
        vault: &VaultId,
        names: &[Name],
        each: &mut impl FnMut(Frame) -> std::io::Result<()>,
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
                count += usize::from(take(step, &mut current, each)?);
            }
        }
        while let (Some(step), _) = decoder.step(&[]).map_err(not_a_bundle)? {
            count += usize::from(take(step, &mut current, each)?);
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
        self.call_idem(Method::GET, &path, None::<&()>, true).await
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

    /// `POST check`: the vault key's signed request that the gateway hash one stored object
    /// against its recorded digest (decision 34).
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn check(
        &self,
        vault: &VaultId,
        request: &crate::rules::wire::CheckRequest,
    ) -> Result<crate::rules::wire::Checked, ClientError> {
        self.call(Method::POST, &route(vault, "check"), Some(request), true)
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

    /// A bundle `POST` for the platform to perform: no network here, only the
    /// URL and headers the shell's background upload needs, built for the
    /// address that answered last. `size` is the staged bundle file's length.
    ///
    /// # Errors
    ///
    /// [`ClientError::NoToken`] without a token, [`ClientError::Unreachable`]
    /// with no address.
    pub fn presign_bundle(&self, vault: &VaultId, size: u64) -> Result<Handoff, ClientError> {
        let token = self.token().ok_or(ClientError::NoToken)?;
        let addr = self
            .preferred_addr()
            .ok_or_else(|| ClientError::Unreachable("no address".to_owned()))?;
        Ok(Handoff {
            url: format!("https://{addr}{}", route(vault, "bundle")),
            method: "POST".to_owned(),
            headers: vec![
                ("authorization".to_owned(), format!("Bearer {token}")),
                ("content-length".to_owned(), size.to_string()),
                (
                    "content-type".to_owned(),
                    "application/octet-stream".to_owned(),
                ),
            ],
        })
    }

    /// What the gateway is, to this phone, right now: [`Self::info`] first
    /// (reached, trusted, current), then — with a token and a `vault` — the
    /// head read, which tells a token the gateway forgot (`pair_again`), a
    /// superseded phone (`moved`) and a frozen vault apart. A vault with no
    /// head yet is `ok`.
    pub async fn reach(&self, vault: Option<&VaultId>) -> Reach {
        if let Err(error) = self.info().await {
            return error.reach();
        }
        let Some(vault) = vault else {
            return Reach::Ok;
        };
        match self.head(vault).await {
            Ok(_) | Err(ClientError::Refused(Refusal::NoHead { .. })) => Reach::Ok,
            Err(error) => error.reach(),
        }
    }

    // ─── the plumbing ────────────────────────────────────────────────────────

    /// The next chunk of a response body, within the idle limit.
    async fn next_chunk(
        &self,
        body: &mut http_body_util::BodyDataStream<Incoming>,
    ) -> Result<Option<Bytes>, ClientError> {
        self.guarded(self.limits().idle, "reading the answer", body.try_next())
            .await?
            .map_err(|error| {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                ClientError::Unreachable(error.to_string())
            })
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

    /// [`Self::call`] for a route that is idempotent: see [`Self::retrying`].
    async fn call_idem<T: DeserializeOwned, B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
        authorized: bool,
    ) -> Result<T, ClientError> {
        self.retrying(|| self.call(method.clone(), path, body, authorized))
            .await
    }

    /// Run an idempotent call, repeating it at most [`MAX_RETRIES`] times: when
    /// the connection dropped under it, or when the gateway said `BUSY` (after
    /// waiting what it asked). Any other outcome is the answer.
    async fn retrying<T, Fut>(&self, mut attempt: impl FnMut() -> Fut) -> Result<T, ClientError>
    where
        Fut: std::future::Future<Output = Result<T, ClientError>>,
    {
        let mut tried = 0;
        loop {
            let before = self.dropped.load(Ordering::Relaxed);
            // Boxed, so a call's state lives on the heap and not in every
            // future that awaits it (a suite drives hundreds of calls from one
            // thread's small stack).
            match Box::pin(attempt()).await {
                Err(error) if self.again(&error, &mut tried, before).await? => {}
                other => return other,
            }
        }
    }

    /// After a failed attempt of an idempotent call: wait if the gateway said
    /// `BUSY`, and say whether to try again. Counted: `tried` never passes
    /// [`MAX_RETRIES`].
    async fn again(
        &self,
        error: &ClientError,
        tried: &mut usize,
        dropped_before: usize,
    ) -> Result<bool, ClientError> {
        if *tried >= MAX_RETRIES {
            return Ok(false);
        }
        match error {
            ClientError::Refused(Refusal::Busy { retry_after_ms }) => {
                *tried += 1;
                self.retries.fetch_add(1, Ordering::Relaxed);
                self.pause(*retry_after_ms).await?;
                Ok(true)
            }
            ClientError::Unreachable(_)
                if self.dropped.load(Ordering::Relaxed) != dropped_before =>
            {
                *tried += 1;
                self.retries.fetch_add(1, Ordering::Relaxed);
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Wait `ms` as a `BUSY` asked (at most [`Limits::busy_cap`]), looking at
    /// the stop while waiting.
    async fn pause(&self, ms: u64) -> Result<(), ClientError> {
        if let Ok(mut waits) = self.busy_waits.lock() {
            waits.push(ms);
        }
        let limits = self.limits();
        let mut left = Duration::from_millis(ms).min(limits.busy_cap);
        while !left.is_zero() {
            if self.stopped() {
                return Err(ClientError::Io(std::io::Error::new(
                    std::io::ErrorKind::Interrupted,
                    "stopped by the caller",
                )));
            }
            let step = left.min(limits.poll);
            tokio::time::sleep(step).await;
            left -= step;
        }
        Ok(())
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
        let dial = (CONNECT_TIMEOUT + HANDSHAKE_TIMEOUT * 2).saturating_add(
            limits
                .stagger
                .saturating_mul(u32::try_from(self.addrs.len()).unwrap_or(u32::MAX)),
        );
        let mut live = self.live.lock().await;
        for attempt in 0..2 {
            if live.as_ref().is_none_or(|(sender, _)| sender.is_closed()) {
                *live = Some(self.guarded(dial, "dialling", self.connect()).await??);
            }
            let Some((sender, host)) = live.as_mut() else {
                continue;
            };
            addressed(&mut request, sender.is_h2(), host)?;
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
                    sender.try_send(request),
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
                        Some(_) => {
                            return Err(ClientError::Unreachable(failed.error().to_string()));
                        }
                        None => {
                            // It may have reached the gateway: an idempotent call
                            // may be repeated, and only because of this.
                            self.dropped.fetch_add(1, Ordering::Relaxed);
                            return Err(ClientError::Unreachable(failed.error().to_string()));
                        }
                    }
                }
            }
        }
        Err(ClientError::Unreachable(
            "the connection closed before the request was sent".to_owned(),
        ))
    }

    /// Dial every address, the preferred one first and each other after
    /// [`Limits::stagger`] (at once when everything dialled before it has
    /// failed); the first verified handshake wins and becomes the preferred
    /// address. The rest are dropped, sockets and all.
    async fn connect(&self) -> Result<(Sender, String), ClientError> {
        if self.addrs.is_empty() {
            return Err(ClientError::Unreachable("no address".to_owned()));
        }
        let count = self.addrs.len();
        let start = self.preferred.load(Ordering::Relaxed) % count;
        let stagger = self.limits().stagger;
        let mut queue = (0..count).map(|offset| (start + offset) % count);
        let mut running = FuturesUnordered::new();
        let mut timer = Box::pin(tokio::time::sleep(stagger));
        let mut untrusted = false;
        let mut last = String::new();
        let won = loop {
            if running.is_empty() {
                let Some(index) = queue.next() else {
                    break None;
                };
                running.push(self.dial(index));
                timer.as_mut().reset(tokio::time::Instant::now() + stagger);
            }
            let more = queue.len() > 0;
            tokio::select! {
                Some((index, result)) = running.next() => match result {
                    Ok(dialled) => break Some((index, dialled)),
                    Err(Dial::Untrusted(why)) => {
                        untrusted = true;
                        last = why;
                    }
                    Err(Dial::Failed(why)) => last = why,
                },
                () = &mut timer, if more => {
                    if let Some(index) = queue.next() {
                        running.push(self.dial(index));
                    }
                    timer
                        .as_mut()
                        .reset(tokio::time::Instant::now() + stagger);
                }
            }
        };
        drop(running);
        let Some((index, stream)) = won else {
            return if untrusted {
                Err(ClientError::Untrusted)
            } else {
                Err(ClientError::Unreachable(last))
            };
        };
        let addr = self.addrs[index].clone();
        if let Some(der) = stream
            .get_ref()
            .1
            .peer_certificates()
            .and_then(<[_]>::first)
            && let Ok(mut seen) = self.seen.lock()
        {
            *seen = Some(der.to_vec());
        }
        let h2 = stream.get_ref().1.alpn_protocol() == Some(&b"h2"[..]);
        let negotiated = if h2 { "h2" } else { "http/1.1" };
        if let Ok(mut held) = self.negotiated.lock() {
            *held = Some(negotiated);
        }
        let io = TokioIo::new(stream);
        let sender = if h2 {
            let (sender, connection) = tokio::time::timeout(
                HANDSHAKE_TIMEOUT,
                hyper::client::conn::http2::Builder::new(TokioExecutor::new())
                    .adaptive_window(true)
                    .handshake(io),
            )
            .await
            .map_err(|_| ClientError::Unreachable(format!("{addr}: the HTTP handshake timed out")))?
            .map_err(|error| ClientError::Unreachable(format!("{addr}: {error}")))?;
            // The connection task drives the stream and ends with it; its
            // error is the one the next request reports.
            tokio::spawn(async move {
                let _ = connection.await;
            });
            Sender::Two(sender)
        } else {
            let (sender, connection) =
                tokio::time::timeout(HANDSHAKE_TIMEOUT, hyper::client::conn::http1::handshake(io))
                    .await
                    .map_err(|_| {
                        ClientError::Unreachable(format!("{addr}: the HTTP handshake timed out"))
                    })?
                    .map_err(|error| ClientError::Unreachable(format!("{addr}: {error}")))?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            Sender::One(sender)
        };
        self.preferred.store(index, Ordering::Relaxed);
        Ok((sender, addr))
    }

    /// One address: TCP, then the pinned TLS handshake. Counted when it
    /// starts, so a test sees how many addresses a connection tried.
    fn dial(
        &self,
        index: usize,
    ) -> impl std::future::Future<Output = (usize, Result<TlsStream<tokio::net::TcpStream>, Dial>)>
    {
        let addr = self.addrs[index].clone();
        let config = Arc::clone(&self.config);
        let dials = Arc::clone(&self.dials);
        let attempts = Arc::clone(&self.attempts);
        async move {
            attempts.fetch_add(1, Ordering::Relaxed);
            (index, dial_address(&addr, config, &dials).await)
        }
    }
}

/// Why one address did not win.
enum Dial {
    /// The handshake failed because the certificate was not the pinned one.
    Untrusted(String),
    /// Nothing answered, or the handshake failed for any other reason.
    Failed(String),
}

async fn dial_address(
    addr: &str,
    config: Arc<ClientConfig>,
    dials: &AtomicUsize,
) -> Result<TlsStream<tokio::net::TcpStream>, Dial> {
    let socket =
        match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect(addr)).await {
            Ok(Ok(socket)) => socket,
            Ok(Err(error)) => return Err(Dial::Failed(format!("{addr}: {error}"))),
            Err(_) => return Err(Dial::Failed(format!("{addr}: timed out"))),
        };
    dials.fetch_add(1, Ordering::Relaxed);
    let _ = socket.set_nodelay(true);
    // A peer that vanishes under a silent connection is found by the kernel as well.
    let keepalive = socket2::TcpKeepalive::new()
        .with_time(KEEPALIVE)
        .with_interval(KEEPALIVE);
    let _ = socket2::SockRef::from(&socket).set_tcp_keepalive(&keepalive);
    let connector = TlsConnector::from(config);
    // The name is not the trust — the verifier compares bytes — but a
    // handshake needs one, and the certificate carries `localhost`.
    let server_name = ServerName::try_from("localhost")
        .map_err(|error| Dial::Failed(format!("{addr}: {error}")))?;
    match tokio::time::timeout(HANDSHAKE_TIMEOUT, connector.connect(server_name, socket)).await {
        Ok(Ok(stream)) => Ok(stream),
        Ok(Err(error)) if is_untrusted(&error) => Err(Dial::Untrusted(format!("{addr}: {error}"))),
        Ok(Err(error)) => Err(Dial::Failed(format!("{addr}: {error}"))),
        Err(_) => Err(Dial::Failed(format!("{addr}: the handshake timed out"))),
    }
}

/// Address the request to the gateway: HTTP/2 wants the scheme and authority
/// in the URI; HTTP/1.1 wants them in `Host`.
fn addressed(request: &mut Request<Body>, h2: bool, host: &str) -> Result<(), ClientError> {
    if h2 {
        let path = request
            .uri()
            .path_and_query()
            .map_or("/", hyper::http::uri::PathAndQuery::as_str);
        *request.uri_mut() = format!("https://{host}{path}").parse().map_err(
            |error: hyper::http::uri::InvalidUri| ClientError::Protocol(error.to_string()),
        )?;
        request.headers_mut().remove(header::HOST);
    } else {
        request
            .headers_mut()
            .insert(header::HOST, header_value(host)?);
    }
    Ok(())
}

/// What the handshake decides from the `/v1/info` answer: any protocol below
/// [`REQUIRED_PROTOCOL`] is refused as [`ClientError::GatewayTooOld`].
fn handshake(answer: Result<Info, ClientError>) -> Result<Info, ClientError> {
    match answer {
        Ok(info) if info.protocol < REQUIRED_PROTOCOL => Err(ClientError::GatewayTooOld {
            found: info.protocol,
            required: REQUIRED_PROTOCOL,
        }),
        other => other,
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
    format!("/v1/v/{vault}/{tail}")
}

fn object_route(vault: &VaultId, name: &Name) -> String {
    format!("/v1/v/{vault}/o/{name}")
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

    /// A GATEWAY BELOW [`REQUIRED_PROTOCOL`] IS REFUSED, TYPED.
    #[test]
    fn an_older_gateway_is_too_old_and_never_spoken_to() {
        assert!(matches!(
            handshake(Ok(info(0))),
            Err(ClientError::GatewayTooOld {
                found: 0,
                required: REQUIRED_PROTOCOL
            })
        ));
        assert!(matches!(
            handshake(Err(ClientError::Refused(Refusal::NotFound { name: None }))),
            Err(ClientError::Refused(Refusal::NotFound { .. }))
        ));
        assert!(handshake(Ok(info(REQUIRED_PROTOCOL))).is_ok());
    }
}
