//! The port something else carries the bytes through (#1029 §3, W5B-1).
//!
//! # WHY A PORT AND NOT A CLIENT
//!
//! On a phone the carrier is not this crate and cannot be. iOS suspends a
//! process within seconds of the member leaving the app, and the *only* way
//! bytes keep moving after that is an `NSURLSession` background task the system
//! owns — so a Rust client holding its own socket would be a client that stops
//! the moment a backup matters. Android is the same shape with a different
//! name: work outside a foreground process belongs to `WorkManager`.
//!
//! So: **this crate signs, and the platform carries.** The shape of that seam
//! is [`HttpRequest`] in and [`HttpResponse`] out, both plain data, both
//! trivially crossable by an FFI door.
//!
//! # WHAT A TRANSPORT MAY NOT DO
//!
//! Decide anything. It may not retry (the retry rule is one refusal and one
//! attempt — see [`crate::client`]), it may not follow a redirect to another
//! origin (the signature covers a path, not a host, so a redirect is a request
//! signed for somewhere it was not sent), and it may not add a header: the four
//! that matter are inside the signature, and a middlebox that rewrote one is
//! precisely what the signature exists to catch.

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
