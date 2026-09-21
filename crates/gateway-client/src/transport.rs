//! The port the bytes are carried through (#1029 §3, W5B-1, W17).
//!
//! # WHAT CARRIES, AND WHY THE OLD ANSWER IS SUPERSEDED
//!
//! This header used to say "this crate signs, and the platform carries": on a
//! phone the carrier had to be an `NSURLSession` background task, because iOS
//! suspends a process within seconds and that was the only way bytes kept
//! moving after it.
//!
//! **That reasoning is superseded.** The
//! [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)
//! strikes the hosted gateway and makes v0 a phone backing up to the member's
//! own laptop, and it strikes the `URLSession` background-transfer seam with
//! it — *its destination no longer exists*. A laptop behind NAT has no domain,
//! no certificate and no forwarded port, so the carrier is **iroh**, and the
//! amendment states the posture the change buys: the phone drains its spool in
//! the foreground and inside the `BGProcessingTask` window iOS grants on the
//! charger, and under WorkManager on Android. There is no transfer while the
//! app is suspended. That is the iCloud Backup posture and the copy says so.
//!
//! So [`IrohTransport`] is what a phone uses: one iroh connection to the
//! laptop's `EndpointId`, one bidirectional stream, HTTP/1.1 over it under
//! [`centraid_gateway_core::ALPN`]. **Nothing on the wire changes** — the same
//! requests, headers, signatures, JSON bodies and refusal shapes. The port
//! stays a port because the shape of the seam is still right:
//! [`HttpRequest`] in and [`HttpResponse`] out, both plain data, both
//! trivially crossable by an FFI door.
//!
//! [`ReqwestTransport`] remains for the drill and for anything that is not a
//! phone, and the TCP carrier it speaks to remains the self-hoster's option.
//!
//! # THE PHONE DIALS; IT ACCEPTS NO INBOUND CONNECTION
//!
//! The amendment restates the invariant §6 carried, and `IrohTransport` is
//! what has to hold it. Its endpoint **offers no ALPN** and **never calls
//! `accept`**. A QUIC endpoint binds a UDP socket because QUIC must, and that
//! is not a listener: with no ALPN offered there is nothing an inbound
//! handshake could negotiate, and with no `accept` there is nothing to hand it
//! to. `cargo xtask rules`' `no-listening-socket` checks both halves.
//!
//! # WHAT A TRANSPORT MAY NOT DO
//!
//! Decide anything. It may not retry (the retry rule is one refusal and one
//! attempt — see [`crate::client`]), it may not follow a redirect to another
//! origin (the signature covers a path, not a host, so a redirect is a request
//! signed for somewhere it was not sent), and it may not add a header: the four
//! that matter are inside the signature, and a middlebox that rewrote one is
//! precisely what the signature exists to catch.
//!
//! iroh's own path migration — LAN-direct to hole-punched to relayed and back —
//! is **below** this line and is fine: it changes which wire the same bytes
//! travel on, and decides nothing about the request. Reconnecting a connection
//! the peer closed is the one thing that looks like a retry and is not: a
//! closed connection carried no answer, so there is no refusal to be re-judged.
//! It happens **once**, and then the caller gets a [`TransportError`].

use std::collections::BTreeMap;
use std::fmt;

/// One request, ready to carry.
///
/// `path` is a path and never an origin, because that is what the signature
/// covers. The transport owns the base URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// Uppercase, as the method is written and as it was signed.
    pub method: String,
    /// From the first `/`, with its query.
    pub path: String,
    /// Header name to value. Lowercase names, as they arrive on the server.
    pub headers: BTreeMap<String, String>,
    /// The bytes. Empty for a body-less request.
    pub body: Vec<u8>,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// The HTTP status. The **code in the body** is the answer; the status is
    /// so that a proxy in between behaves ([`crate::outcome`]).
    pub status: u16,
    /// The bytes.
    pub body: Vec<u8>,
}

/// A transport failed to carry, which is not the same as a gateway refusing.
///
/// The distinction is the whole reason this is a separate type: a refusal is a
/// decision a member may need to see, and a transport failure is a phone on a
/// train. A client that collapsed them would show "your plan has lapsed" to
/// somebody in a tunnel.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("the gateway could not be reached: {reason}")]
pub struct TransportError {
    /// For a log line, never for a sentence a member reads.
    pub reason: String,
}

impl TransportError {
    /// Name a failure to carry.
    #[must_use]
    pub fn new(reason: impl fmt::Display) -> Self {
        Self {
            reason: reason.to_string(),
        }
    }
}

/// Carry one request and answer with what came back.
///
/// `async_trait`-free: a return-position `impl Future`, so no allocation and no
/// dependency — this crate compiles into a phone.
///
/// **No `Send` bound.** A phone's carrier is whatever the platform handed the
/// app, and requiring `Send` here would rule out a transport that is pinned to
/// one thread — which is the ordinary shape of a platform HTTP stack behind an
/// FFI door. A caller that needs `Send` bounds its own transport.
pub trait Transport {
    /// Send it. The base URL is the transport's.
    fn send(
        &self,
        request: HttpRequest,
    ) -> impl Future<Output = Result<HttpResponse, TransportError>>;
}

/// The one transport this crate ships: `reqwest`, for the desktop seat, the
/// drill, and anything else that is not a phone.
///
/// It is **not** the phone's. See the module header.
#[derive(Debug, Clone)]
pub struct ReqwestTransport {
    base: String,
    inner: reqwest::Client,
}

impl ReqwestTransport {
    /// Point a transport at a gateway's base URL.
    ///
    /// The trailing slash is trimmed once, here, so `https://gw.example/` and
    /// `https://gw.example` do not become two different request lines — and a
    /// signature covers the path, so a doubled slash is a refusal a member
    /// could not act on.
    ///
    /// # Errors
    ///
    /// If the HTTP client cannot be built.
    pub fn new(base_url: &str) -> Result<Self, TransportError> {
        Ok(Self {
            base: base_url.trim_end_matches('/').to_owned(),
            inner: reqwest::Client::builder()
                // A REDIRECT IS A REQUEST SIGNED FOR SOMEWHERE IT WAS NOT SENT.
                // The signature covers the path and not the origin, which is
                // what lets a self-hoster put one server behind two names — and
                // it is also what makes a followed cross-origin redirect a
                // credential handed to a stranger.
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(TransportError::new)?,
        })
    }

    /// The base URL this transport carries to.
    #[must_use]
    pub fn base(&self) -> &str {
        &self.base
    }
}

impl Transport for ReqwestTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let method =
            reqwest::Method::from_bytes(request.method.as_bytes()).map_err(TransportError::new)?;
        let mut builder = self
            .inner
            .request(method, format!("{}{}", self.base, request.path));
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let response = builder
            .body(request.body)
            .send()
            .await
            .map_err(TransportError::new)?;
        let status = response.status().as_u16();
        let body = response
            .bytes()
            .await
            .map_err(TransportError::new)?
            .to_vec();
        Ok(HttpResponse {
            status,
            body: body.to_vec(),
        })
    }
}

/// THE PHONE'S CARRIER: the gateway API over one iroh bidirectional stream.
///
/// # THE SHAPE, IN FIVE LINES
///
/// An [`Endpoint`](iroh::Endpoint) built with **no ALPNs** (it dials, it never
/// accepts) connects to the laptop's [`EndpointAddr`](iroh::EndpointAddr) under
/// [`centraid_gateway_core::ALPN`]. One bi-stream is opened and kept: hyper's
/// `http1::handshake` runs over `tokio::io::join(recv, send)` and the
/// `SendRequest` half is reused for every later request, so keep-alive works
/// exactly as it does over TCP. A connection the peer closed is re-dialled
/// **once**, then the caller gets a [`TransportError`].
///
/// # WHY THE CONNECTION IS STATE AND THE STREAM IS TOO
///
/// A dial is the expensive part — a hole-punch is round trips, and a phone on
/// cellular pays for every one of them. A transport that dialled per request
/// would make a spool drain of 400 objects 400 hole-punches. So both the
/// connection and the stream live in a [`Mutex`](tokio::sync::Mutex) here, and
/// [`Transport::send`] takes it: requests on one transport are serialised,
/// which is what an HTTP/1.1 connection means anyway.
pub struct IrohTransport {
    endpoint: iroh::Endpoint,
    gateway: iroh::EndpointAddr,
    live: tokio::sync::Mutex<Option<Sender>>,
}

/// The hyper half that outlives one request.
type Sender = hyper::client::conn::http1::SendRequest<http_body_util::Full<bytes::Bytes>>;

impl core::fmt::Debug for IrohTransport {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("IrohTransport")
            .field("gateway", &self.gateway.id)
            .finish_non_exhaustive()
    }
}

impl IrohTransport {
    /// Take an already-bound endpoint and point it at a gateway.
    ///
    /// The endpoint is the caller's because a phone has exactly one and it
    /// outlives any single vault's client; [`Self::dial_only_endpoint`] is how
    /// to build one that holds the no-inbound invariant.
    #[must_use]
    pub fn new(endpoint: iroh::Endpoint, gateway: iroh::EndpointAddr) -> Self {
        Self {
            endpoint,
            gateway,
            live: tokio::sync::Mutex::new(None),
        }
    }

    /// Bind a **dial-only** endpoint: no ALPN offered, and nothing here ever
    /// calls `accept`.
    ///
    /// # Errors
    ///
    /// If the endpoint cannot bind its UDP socket.
    pub async fn dial_only_endpoint() -> Result<iroh::Endpoint, TransportError> {
        // NO `.alpns(…)`. This is the phone's half of "the phone dials; it
        // accepts no inbound connection", and it is load-bearing rather than an
        // omission: an endpoint that offers no protocol has nothing an inbound
        // handshake could negotiate.
        iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .bind()
            .await
            .map_err(TransportError::new)
    }

    /// The gateway this transport dials.
    #[must_use]
    pub const fn gateway(&self) -> &iroh::EndpointAddr {
        &self.gateway
    }

    /// Open a fresh connection and stream, and hand back the hyper half.
    async fn connect(&self) -> Result<Sender, TransportError> {
        let connection = self
            .endpoint
            .connect(self.gateway.clone(), centraid_gateway_core::ALPN)
            .await
            .map_err(TransportError::new)?;
        let (send, recv) = connection.open_bi().await.map_err(TransportError::new)?;
        let (sender, driver) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(
            tokio::io::join(recv, send),
        ))
        .await
        .map_err(TransportError::new)?;
        // The connection task drives the stream. It ends when the stream does,
        // and its error is the one `send` will already have reported through a
        // failed request — logging it twice would put a line in a member's log
        // for an ordinary close.
        tokio::spawn(async move {
            let _ = driver.await;
        });
        Ok(sender)
    }

    /// One attempt over an existing sender.
    async fn attempt(
        sender: &mut Sender,
        request: &HttpRequest,
    ) -> Result<HttpResponse, TransportError> {
        let mut builder = hyper::Request::builder()
            .method(request.method.as_str())
            // A PATH AND NEVER AN ORIGIN. There is no origin here to get wrong:
            // the authority is the endpoint id this transport dialled.
            .uri(request.path.as_str());
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        // hyper/1 requires a Host header; the endpoint id IS the authority, so
        // it is spelled here rather than left to a default that would name a
        // machine nobody dialled. It is not one of the four inside the
        // signature, so adding it is not the transport deciding anything about
        // the request.
        let built = builder
            .header(hyper::header::HOST, "centraid.invalid")
            .body(http_body_util::Full::new(bytes::Bytes::from(
                request.body.clone(),
            )))
            .map_err(TransportError::new)?;
        let response = sender
            .send_request(built)
            .await
            .map_err(TransportError::new)?;
        let status = response.status().as_u16();
        let body = {
            use http_body_util::BodyExt as _;
            response
                .into_body()
                .collect()
                .await
                .map_err(TransportError::new)?
                .to_bytes()
                .to_vec()
        };
        Ok(HttpResponse { status, body })
    }
}

impl Transport for IrohTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let mut live = self.live.lock().await;
        if let Some(sender) = live.as_mut()
            && !sender.is_closed()
            && let Ok(()) = std::future::poll_fn(|context| sender.poll_ready(context)).await
        {
            match Self::attempt(sender, &request).await {
                Ok(response) => return Ok(response),
                // The connection died under us. That carried no answer, so
                // there is no refusal to re-judge and re-dialling is not a
                // retry of a decision — see the module header.
                Err(_) => *live = None,
            }
        } else {
            *live = None;
        }

        let mut sender = self.connect().await?;
        let response = Self::attempt(&mut sender, &request).await?;
        *live = Some(sender);
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_keeps_one_slash_between_it_and_a_path() {
        let transport = ReqwestTransport::new("https://gw.example/").expect("built");
        assert_eq!(transport.base(), "https://gw.example");
    }

    /// A transport failure is not a refusal, and the types keep it that way.
    #[test]
    fn a_transport_failure_carries_no_error_code() {
        let failure = TransportError::new("connection reset");
        assert!(failure.to_string().contains("could not be reached"));
    }
}
