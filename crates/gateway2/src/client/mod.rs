//! THE PHONE'S CLIENT (#1080).
//!
//! HTTP/1.1 over TLS over TCP to one gateway, trusting exactly one
//! certificate ([`tls`]). Every route of protocol v2 is a method here; the
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
//! never repeated here — `PUT`s and the head's compare-and-set are idempotent
//! by the rules, and the caller decides about the rest.
//!
//! # WHAT THIS CLIENT NEVER SAYS
//!
//! That something is backed up. It returns what the gateway acknowledged and
//! nothing more; "backed up" is a word the phone may use only over an
//! acknowledgement it recorded.

pub mod tls;

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use futures::TryStreamExt as _;
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
use crate::rules::bundle::{Frame, decode, encode};
use crate::rules::code::{Code, Refusal, RefusalBody};
use crate::rules::engine::PutOutcome;
use crate::rules::ids::{Digest, Name, Pin, Token, VaultId};
use crate::rules::limits::MAX_BUNDLE_BYTES;
use crate::rules::range::ByteRange;
use crate::rules::wire::{
    BundleAnswer, CODE_HEADER, DIGEST_HEADER, DeleteAnswer, HeadView, Info, Missing, Names,
    ObjectEntry, PairRequest, Paired, SetHead, SnapshotView,
};

/// How long one address gets to accept a TCP connection.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a TLS handshake gets.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// The largest JSON answer read: a page of a thousand objects is far less.
const MAX_ANSWER_BYTES: u64 = 16 * 1024 * 1024;

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
    #[error("the gateway's certificate is not the one this phone pinned")]
    Untrusted,
    /// An answer that does not parse or breaks the protocol.
    #[error("the gateway's answer broke the protocol: {0}")]
    Protocol(String),
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

/// A `PUT` prepared for someone else to perform: the iPhone's background
/// `URLSession`, which uploads a spool file while the app is suspended. The
/// shell adds the file as the body and pins the destination's certificate in
/// its own trust challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handoff {
    /// `https://<preferred address>/v2/v/<vault>/o/<name>`.
    pub url: String,
    /// `PUT`.
    pub method: String,
    /// `authorization`, `content-digest`, `content-length` and
    /// `content-type`, lowercase. The `authorization` value is the bearer
    /// token: the shell holds it as a credential.
    pub headers: Vec<(String, String)>,
}

type Body = UnsyncBoxBody<Bytes, std::io::Error>;
type Sender = hyper::client::conn::http1::SendRequest<Body>;

/// The client for one gateway. See the module header.
pub struct Client {
    addrs: Vec<String>,
    trust: Trust,
    config: Arc<ClientConfig>,
    token: Mutex<Option<Token>>,
    preferred: AtomicUsize,
    seen: Mutex<Option<Vec<u8>>>,
    live: tokio::sync::Mutex<Option<(Sender, String)>>,
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
            preferred: AtomicUsize::new(0),
            seen: Mutex::new(None),
            live: tokio::sync::Mutex::new(None),
        }
    }

    /// First contact, from a scanned pairing payload: trust the certificate
    /// whose BLAKE3 is `pin`. Its DER is [`Self::cert_der`] after the first
    /// connection, for the caller to keep.
    #[must_use]
    pub fn first_contact(addrs: Vec<String>, pin: Pin) -> Self {
        Self::with_trust(addrs, Trust::Pin(pin), None)
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

    /// `GET /v2/info`. Needs no token.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn info(&self) -> Result<Info, ClientError> {
        self.call(Method::GET, "/v2/info", None::<&()>, false).await
    }

    /// `POST /v2/pair`. On success the client keeps the token.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn pair(&self, request: &PairRequest) -> Result<Paired, ClientError> {
        let paired: Paired = self
            .call(Method::POST, "/v2/pair", Some(request), false)
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
                epoch: head.epoch,
                head: Some(head),
            }),
            Err(ClientError::Refused(Refusal::NoHead { epoch })) => {
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

    /// `GET snapshots`.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn snapshots(&self, vault: &VaultId) -> Result<Vec<SnapshotView>, ClientError> {
        self.call(Method::GET, &route(vault, "snapshots"), None::<&()>, true)
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
    ) -> Result<PutOutcome, ClientError> {
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
    ) -> Result<PutOutcome, ClientError> {
        let file = tokio::fs::File::open(path).await?;
        let length = file.metadata().await?.len();
        let chunks = futures::stream::try_unfold(file, |mut file| async move {
            let mut buffer = vec![0_u8; 256 * 1024];
            let read = file.read(&mut buffer).await?;
            if read == 0 {
                return Ok(None);
            }
            buffer.truncate(read);
            Ok(Some((BodyFrame::data(Bytes::from(buffer)), file)))
        });
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
    ) -> Result<PutOutcome, ClientError> {
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
        let entry: ObjectEntry = read_answer(response).await?;
        match status {
            StatusCode::CREATED => Ok(PutOutcome::Stored(entry)),
            _ => Ok(PutOutcome::AlreadyStored(entry)),
        }
    }

    /// `GET o/{name}`, whole or one range. A whole object is checked against
    /// the digest the gateway sends with it.
    ///
    /// # Errors
    ///
    /// [`ClientError`]; [`ClientError::Protocol`] when the bytes do not hash
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
            let body = read_capped(response, MAX_ANSWER_BYTES).await?;
            return Err(refusal_of(status, &headers, &body));
        }
        let declared = response
            .headers()
            .get(DIGEST_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| Digest::from_header(value).ok());
        let bytes = read_capped(response, crate::rules::limits::MAX_OBJECT_BYTES).await?;
        if status == StatusCode::OK
            && let Some(declared) = declared
            && Digest::of(&bytes) != declared
        {
            return Err(ClientError::Protocol(format!(
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

    /// `POST bundle`: many objects in one body.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn bundle(
        &self,
        vault: &VaultId,
        frames: &[Frame],
    ) -> Result<BundleAnswer, ClientError> {
        let body = Bytes::from(encode(frames));
        let length = body.len() as u64;
        let mut request = self.request(
            Method::POST,
            &route(vault, "bundle"),
            Full::new(body)
                .map_err(|never| match never {})
                .boxed_unsync(),
            true,
        )?;
        let headers = request.headers_mut();
        headers.insert(header::CONTENT_LENGTH, HeaderValue::from(length));
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
        let response = self.send(request).await?;
        read_answer(response).await
    }

    /// `POST fetch`: the objects the gateway holds of `names`, in order, each
    /// checked against its digest.
    ///
    /// # Errors
    ///
    /// [`ClientError`]; [`ClientError::Protocol`] for a frame that does not
    /// hash to its digest.
    pub async fn fetch(&self, vault: &VaultId, names: &[Name]) -> Result<Vec<Frame>, ClientError> {
        let body = json_body(&Names {
            names: names.to_vec(),
        })?;
        let request = self.request(Method::POST, &route(vault, "fetch"), body, true)?;
        let response = self.send(request).await?;
        let status = response.status();
        if !status.is_success() {
            let headers = response.headers().clone();
            let body = read_capped(response, MAX_ANSWER_BYTES).await?;
            return Err(refusal_of(status, &headers, &body));
        }
        let bytes = read_capped(response, MAX_BUNDLE_BYTES).await?;
        let frames = decode(&bytes).map_err(|refusal| {
            ClientError::Protocol(format!("a fetch answer that is not a bundle: {refusal}"))
        })?;
        if let Some(frame) = frames
            .iter()
            .find(|frame| Digest::of(&frame.bytes) != frame.digest)
        {
            return Err(ClientError::Protocol(format!(
                "{} does not hash to its digest",
                frame.name
            )));
        }
        Ok(frames)
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
        let mut path = format!("{}?limit={limit}", route(vault, "objects"));
        if let Some(after) = after {
            path.push_str(&format!("&after={after}"));
        }
        self.call(Method::GET, &path, None::<&()>, true).await
    }

    /// `POST delete`.
    ///
    /// # Errors
    ///
    /// [`ClientError`].
    pub async fn delete(
        &self,
        vault: &VaultId,
        names: &[Name],
    ) -> Result<DeleteAnswer, ClientError> {
        self.call(
            Method::POST,
            &route(vault, "delete"),
            Some(&Names {
                names: names.to_vec(),
            }),
            true,
        )
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
        read_answer(response).await
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

    /// Send on the kept connection, dialling one when there is none.
    async fn send(&self, mut request: Request<Body>) -> Result<Response<Incoming>, ClientError> {
        let mut live = self.live.lock().await;
        for attempt in 0..2 {
            if live.as_ref().is_none_or(|(sender, _)| sender.is_closed()) {
                *live = Some(self.connect().await?);
            }
            let Some((sender, host)) = live.as_mut() else {
                continue;
            };
            request
                .headers_mut()
                .insert(header::HOST, header_value(host)?);
            if sender.ready().await.is_err() {
                *live = None;
                continue;
            }
            match sender.try_send_request(request).await {
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
            let _ = socket.set_nodelay(true);
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
            let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
                .await
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

fn route(vault: &VaultId, tail: &str) -> String {
    format!("/v2/v/{vault}/{tail}")
}

fn object_route(vault: &VaultId, name: &Name) -> String {
    format!("/v2/v/{vault}/o/{name}")
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

/// A response body, refusing one longer than `cap`.
async fn read_capped(response: Response<Incoming>, cap: u64) -> Result<Vec<u8>, ClientError> {
    let mut body = response.into_body().into_data_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = body
        .try_next()
        .await
        .map_err(|error| ClientError::Unreachable(error.to_string()))?
    {
        if (bytes.len() + chunk.len()) as u64 > cap {
            return Err(ClientError::Protocol(format!("an answer over {cap} bytes")));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// A JSON answer, or the refusal it is.
async fn read_answer<T: DeserializeOwned>(response: Response<Incoming>) -> Result<T, ClientError> {
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = read_capped(response, MAX_ANSWER_BYTES).await?;
    if status.is_success() {
        serde_json::from_slice(&bytes).map_err(|error| ClientError::Protocol(error.to_string()))
    } else {
        Err(refusal_of(status, &headers, &bytes))
    }
}

/// What a non-success answer means. The body's code is the answer; a body
/// that is not a refusal falls back to the `centraid-code` header, which is
/// how a `HEAD` says why.
fn refusal_of(status: StatusCode, headers: &hyper::HeaderMap, body: &[u8]) -> ClientError {
    let parsed = serde_json::from_slice::<RefusalBody>(body)
        .ok()
        .or_else(|| {
            let code = Code::parse(headers.get(CODE_HEADER)?.to_str().ok()?)?;
            Some(RefusalBody {
                code,
                time_ms: 0,
                epoch: None,
                head: None,
                name: None,
                digest: None,
                limit: None,
                size: None,
            })
        });
    match parsed {
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
