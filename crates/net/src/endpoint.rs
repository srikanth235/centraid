//! The iroh endpoint (#1020, D-1020-C9, D-1020-C10).
//!
//! This is the only file in the workspace that names an iroh type. Everything
//! above it speaks [`centraid_protocol::Transport`] and
//! [`centraid_protocol::Connection`], which is what lets lane D2's `turmoil`
//! simulation be the primary sync proof (D-1020-C1).
//!
//! Three behaviours are stated here rather than in a comment somewhere else,
//! because each one is a promise #1020 makes:
//!
//! * **`spawn` never blocks on the network** (D-1020-C10). It binds the UDP
//!   socket and returns. It deliberately does NOT call `iroh::Endpoint::online`,
//!   which is the call that waits for a relay handshake: connectivity arrives as
//!   a [`ConnectivityEvent`], and a shell renders `OFFLINE` until it does.
//! * **Connect is bounded** (D-1020-C9). [`CONNECT_TIMEOUT`] is ten seconds and
//!   every dial goes through it, so an unroutable peer is a typed `Timeout` and
//!   never a hang.
//! * **A connection on the seat lane is admitted before a frame is read.** The
//!   remote EndpointId is checked against the allowlist and an unenrolled or
//!   revoked peer is closed with `Unauthorized` — no stream is accepted, so no
//!   byte an unauthorised peer sent is ever parsed.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use centraid_api_proto::core_v1::{ConnectivityEvent, ConnectivityState, ErrorCode};
use centraid_protocol::alpn;
use iroh::endpoint::VarInt;
use iroh::{EndpointAddr, EndpointId, RelayMode as IrohRelayMode, RelayUrl, SecretKey};
use tokio::sync::{RwLock, broadcast};

use crate::allowlist::{AllowlistStore, Device};
use crate::error::ConnectError;

/// The bounded dial budget. Ten seconds is long enough for a relay handshake
/// plus a hole-punch attempt on a mobile network and short enough that a member
/// watching a spinner gets an answer.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The QUIC application close code for an unauthorised peer. v0 uses `401`
/// (`CLOSE_UNAUTHORIZED`, `packages/tunnel/src/protocol.ts:80`) and this is the
/// same number, so a packet capture reads the same across the two trees.
pub const CLOSE_UNAUTHORIZED: u32 = 401;

/// How many connectivity events a slow subscriber may fall behind before it
/// loses the oldest. Small on purpose: a shell that is this far behind needs
/// the CURRENT state, not a replay of the last hour.
const EVENT_CAPACITY: usize = 32;

/// Which relays the endpoint may use (#1020, D-1020-C9).
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RelayMode {
    /// n0's public relays. The product's default, and the reason a VPS needs no
    /// domain, certificate or reverse proxy — with the dependency #1020 names
    /// out loud: hole-punching falls back to relays reached over outbound TCP
    /// 443, so the product depends on relay availability.
    Default,
    /// A self-hosted relay. Documented in `README.md`; this is the answer for a
    /// deployment that will not depend on n0.
    Custom(String),
    /// No relays at all. Direct paths only — a LAN, a loopback test, or a
    /// deployment that has decided a relay is an unacceptable third party and
    /// accepts that a symmetric NAT then means no connection.
    Disabled,
}

impl RelayMode {
    fn to_iroh(&self) -> Result<IrohRelayMode, ConnectError> {
        match self {
            Self::Default => Ok(IrohRelayMode::Default),
            Self::Disabled => Ok(IrohRelayMode::Disabled),
            Self::Custom(url) => {
                let parsed: RelayUrl = url.parse().map_err(|error| {
                    ConnectError::Endpoint(format!("relay url `{url}`: {error}"))
                })?;
                Ok(IrohRelayMode::custom([parsed]))
            }
        }
    }
}

/// How to bring the endpoint up.
#[derive(Clone, Debug)]
pub struct EndpointConfig {
    pub relay: RelayMode,
    pub connect_timeout: Duration,
    /// The ALPNs this endpoint ACCEPTS. Dialling is unaffected. The peer plane
    /// is not here (`alpn::ADVERTISED`), because "no link policy ⇒ never
    /// negotiate the plane" (`packages/tunnel/src/gateway-endpoint.ts:149-154`).
    pub alpns: Vec<Vec<u8>>,
    /// The endpoint's long-term identity. `None` mints a fresh one, which is
    /// what a test wants and what a gateway must never do twice — an identity
    /// that changes is a gateway every paired seat stops recognising.
    pub secret_key: Option<SecretKey>,
}

impl Default for EndpointConfig {
    fn default() -> Self {
        Self {
            relay: RelayMode::Default,
            connect_timeout: CONNECT_TIMEOUT,
            alpns: alpn::ADVERTISED.iter().map(|a| a.to_vec()).collect(),
            secret_key: None,
        }
    }
}

impl EndpointConfig {
    /// A loopback-only endpoint: no relays, ephemeral identity. What a test and
    /// a LAN-only deployment use.
    pub fn loopback() -> Self {
        Self {
            relay: RelayMode::Disabled,
            ..Self::default()
        }
    }
}

/// The endpoint. Cheap to clone; every clone shares one socket.
#[derive(Clone)]
pub struct Endpoint {
    inner: Arc<RwLock<Option<iroh::Endpoint>>>,
    config: EndpointConfig,
    secret_key: SecretKey,
    idle: Arc<AtomicBool>,
    events: broadcast::Sender<ConnectivityEvent>,
}

/// An accepted connection, with what the admission check decided.
pub struct Accepted {
    /// The negotiated ALPN. **Routing is by this and nothing else** — never by
    /// anything the caller says (`iroh_relay.rs:486`).
    pub alpn: Vec<u8>,
    pub connection: IrohConnection,
    /// The enrolled device, on the seat lane. `None` on the pair lane, where
    /// the peer is by definition not yet enrolled.
    pub device: Option<Device>,
}

impl Endpoint {
    /// Bind the UDP socket and return. **Never blocks on the network**
    /// (D-1020-C10): `iroh::Endpoint::online`, the call that waits for a relay
    /// handshake, is deliberately not made.
    pub async fn spawn(config: EndpointConfig) -> Result<Self, ConnectError> {
        let secret_key = match config.secret_key.clone() {
            Some(key) => key,
            None => SecretKey::generate(),
        };
        let (events, _) = broadcast::channel(EVENT_CAPACITY);
        let endpoint = Self {
            inner: Arc::new(RwLock::new(None)),
            config,
            secret_key,
            idle: Arc::new(AtomicBool::new(false)),
            events,
        };
        endpoint.bind().await?;
        Ok(endpoint)
    }

    async fn bind(&self) -> Result<(), ConnectError> {
        let bound = iroh::Endpoint::builder(iroh::endpoint::presets::N0)
            .secret_key(self.secret_key.clone())
            .relay_mode(self.config.relay.to_iroh()?)
            .alpns(self.config.alpns.clone())
            .bind()
            .await
            .map_err(|error| ConnectError::Endpoint(error.to_string()))?;
        *self.inner.write().await = Some(bound);
        // The first state every shell sees. Not `CONNECTING`: nothing has been
        // dialled, and a shell that shows a spinner from here shows one forever
        // on a gateway that is simply not running.
        self.emit(ConnectivityState::Offline, 0, String::new());
        Ok(())
    }

    /// This endpoint's id — 32 raw bytes. Stable across [`Self::idle`] and
    /// [`Self::resume`], because it is the public half of the secret key.
    pub fn id(&self) -> [u8; 32] {
        *self.secret_key.public().as_bytes()
    }

    /// The address to put in a pair ticket: this endpoint's id plus, when there
    /// is one, the relay it is reachable through.
    pub async fn addr(&self) -> Option<EndpointAddr> {
        self.inner.read().await.as_ref().map(iroh::Endpoint::addr)
    }

    /// Subscribe to connectivity. Every state change and every typed connect
    /// failure arrives here, which is how a shell knows anything about the
    /// network at all (#1020: the renderer sees connectivity states).
    pub fn events(&self) -> broadcast::Receiver<ConnectivityEvent> {
        self.events.subscribe()
    }

    fn emit(&self, state: ConnectivityState, code: u32, relay_url: String) {
        // A send with no subscribers is not an error: a headless gateway has
        // nobody listening and is not thereby broken.
        let _ = self.events.send(ConnectivityEvent {
            state: state as i32,
            code,
            relay_url,
        });
    }

    /// Stop using the network (#1020 Network lifecycle: "the endpoint idles when
    /// the app is backgrounded ... so an open QUIC connection is never the
    /// reason a phone's battery drains").
    ///
    /// **D-1020-C14 — idling CLOSES the endpoint and resuming re-binds it.**
    /// iroh 1.2 has no pause: while an endpoint is bound it keeps a relay
    /// connection and its keepalives, which is precisely the battery cost the
    /// rule exists to remove. A flag that only stopped our own accept loop
    /// would leave that cost in place and the rule would be a comment. Closing
    /// is safe because identity is the SECRET KEY, not the endpoint object:
    /// [`Self::id`] is unchanged across an idle/resume cycle, so every paired
    /// seat still recognises the gateway, and only the addresses move.
    pub async fn idle(&self) {
        self.idle.store(true, Ordering::SeqCst);
        if let Some(endpoint) = self.inner.write().await.take() {
            endpoint.close().await;
        }
        self.emit(ConnectivityState::Offline, 0, String::new());
    }

    /// Bind again after [`Self::idle`], under the same identity.
    pub async fn resume(&self) -> Result<(), ConnectError> {
        if !self.idle.swap(false, Ordering::SeqCst) && self.inner.read().await.is_some() {
            return Ok(());
        }
        self.bind().await
    }

    pub fn is_idle(&self) -> bool {
        self.idle.load(Ordering::SeqCst)
    }

    /// Dial a peer on one ALPN. Bounded by `connect_timeout`; the failure is
    /// typed and is also emitted as a `ConnectivityEvent`.
    ///
    /// `direct_addrs` are the ticket's `<ip>:<port>` HINTS (D-1020-C15).
    /// Required with [`RelayMode::Disabled`], where an EndpointId alone has
    /// nothing to be dialled through; an address that does not parse is
    /// SKIPPED rather than fatal, because a hint is a shortcut and losing one
    /// must not lose the connection.
    pub async fn connect(
        &self,
        peer: [u8; 32],
        relay_url: Option<&str>,
        direct_addrs: &[String],
        alpn: &[u8],
    ) -> Result<IrohConnection, ConnectError> {
        let endpoint = self
            .inner
            .read()
            .await
            .clone()
            .ok_or(ConnectError::PeerUnreachable)?;
        if self.is_idle() {
            // D-1020-C14: an idled endpoint has no socket. Refusing with the
            // peer's own code rather than silently re-binding is the honest
            // answer — a backgrounded phone that dialled on its own would be
            // exactly the battery cost idling exists to remove.
            return Err(ConnectError::PeerUnreachable);
        }

        let id = EndpointId::from_bytes(&peer)
            .map_err(|error| ConnectError::Endpoint(format!("peer id: {error}")))?;
        let mut addr = EndpointAddr::from(id);
        if let Some(url) = relay_url.filter(|url| !url.is_empty()) {
            let parsed: RelayUrl = url
                .parse()
                .map_err(|error| ConnectError::Endpoint(format!("relay url `{url}`: {error}")))?;
            addr = addr.with_relay_url(parsed);
        }
        for hint in direct_addrs {
            match hint.parse::<std::net::SocketAddr>() {
                Ok(parsed) => addr = addr.with_ip_addr(parsed),
                Err(error) => {
                    tracing::debug!(hint, %error, "skipping an unparseable ticket address hint");
                }
            }
        }

        self.emit(ConnectivityState::Connecting, 0, String::new());
        let dialled =
            tokio::time::timeout(self.config.connect_timeout, endpoint.connect(addr, alpn)).await;
        let failure = match dialled {
            Ok(Ok(connection)) => {
                // Relay versus direct is reported because the member whose media
                // is slow is owed the reason.
                let state = if matches!(self.config.relay, RelayMode::Disabled) {
                    ConnectivityState::Direct
                } else {
                    ConnectivityState::Relay
                };
                self.emit(state, 0, String::new());
                return Ok(IrohConnection { inner: connection });
            }
            Err(_elapsed) => ConnectError::Timeout(self.config.connect_timeout),
            Ok(Err(error)) => self.classify(&error.to_string()),
        };
        let event = failure.event();
        let _ = self.events.send(event);
        Err(failure)
    }

    /// Turn iroh's dial error into one of ours.
    ///
    /// **The classification is stated rather than guessed at each call site**,
    /// and it is deliberately coarse: with relays disabled there is no relay to
    /// blame, so every failure is the peer's; with relays configured, a failure
    /// that names one is a relay failure and everything else is the peer's. A
    /// finer reading would be a reading of iroh's error prose, which is not a
    /// stable interface.
    fn classify(&self, error: &str) -> ConnectError {
        if matches!(self.config.relay, RelayMode::Disabled) {
            return ConnectError::PeerUnreachable;
        }
        let lowered = error.to_lowercase();
        if lowered.contains("relay") {
            ConnectError::NoRelayReachable
        } else {
            ConnectError::PeerUnreachable
        }
    }

    /// Accept the next connection and admit it.
    ///
    /// `Ok(None)` means the endpoint closed — the gateway is shutting down or
    /// has idled. An unauthorised peer on the seat lane is closed here, with no
    /// stream accepted, so **no byte it sent is ever parsed**.
    pub async fn accept<S>(&self, allowlist: &S) -> Result<Option<Accepted>, ConnectError>
    where
        S: AllowlistStore,
    {
        let endpoint = self.inner.read().await.clone();
        let Some(endpoint) = endpoint else {
            return Ok(None);
        };
        let Some(incoming) = endpoint.accept().await else {
            return Ok(None);
        };
        let connection = incoming
            .await
            .map_err(|error| ConnectError::Endpoint(error.to_string()))?;
        let negotiated = connection.alpn().to_vec();
        let peer = *connection.remote_id().as_bytes();

        // Routing by ALPN alone.
        if negotiated == alpn::SEAT {
            let device = allowlist.device(&peer).await.filter(Device::is_live);
            let Some(device) = device else {
                connection.close(
                    VarInt::from_u32(CLOSE_UNAUTHORIZED),
                    b"centraid: not an enrolled, unrevoked device",
                );
                self.emit(
                    ConnectivityState::Failed,
                    ErrorCode::Unauthorized as u32,
                    String::new(),
                );
                return Err(ConnectError::Unauthorized);
            };
            return Ok(Some(Accepted {
                alpn: negotiated,
                connection: IrohConnection { inner: connection },
                device: Some(device),
            }));
        }
        if negotiated == alpn::PAIR {
            // The pair lane MUST accept an unenrolled peer: that is what it is
            // for. Its admission is the ticket, checked one layer up.
            return Ok(Some(Accepted {
                alpn: negotiated,
                connection: IrohConnection { inner: connection },
                device: None,
            }));
        }
        // An ALPN this endpoint advertised and this function does not handle.
        // Refused loudly rather than served: the peer plane arrives in wave 4
        // and a silently-accepted connection on it would be an unpoliced plane.
        connection.close(
            VarInt::from_u32(CLOSE_UNAUTHORIZED),
            b"centraid: that plane is not served by this build",
        );
        Err(ConnectError::Unauthorized)
    }

    /// Close the endpoint for good.
    pub async fn close(&self) {
        if let Some(endpoint) = self.inner.write().await.take() {
            endpoint.close().await;
        }
    }
}

/// A connection over iroh, behind `crates/protocol`'s trait.
///
/// `Debug` names the peer and the lane and nothing else: a connection's
/// internals are not a thing a log line should carry, and the two facts a
/// reader wants are who and which plane.
pub struct IrohConnection {
    inner: iroh::endpoint::Connection,
}

impl std::fmt::Debug for IrohConnection {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("IrohConnection")
            .field("peer", &crate::allowlist::hex_lower(&self.peer_id()))
            .field(
                "alpn",
                &String::from_utf8_lossy(self.inner.alpn()).to_string(),
            )
            .finish()
    }
}

impl IrohConnection {
    pub fn peer_id(&self) -> [u8; 32] {
        *self.inner.remote_id().as_bytes()
    }

    pub fn alpn(&self) -> Vec<u8> {
        self.inner.alpn().to_vec()
    }

    pub fn close_unauthorized(&self) {
        self.inner.close(
            VarInt::from_u32(CLOSE_UNAUTHORIZED),
            b"centraid: not an enrolled, unrevoked device",
        );
    }
}

impl centraid_protocol::Connection for IrohConnection {
    type Send = iroh::endpoint::SendStream;
    type Recv = iroh::endpoint::RecvStream;

    async fn open_bi(&self) -> centraid_protocol::Result<(Self::Send, Self::Recv)> {
        self.inner
            .open_bi()
            .await
            .map_err(|error| std::io::Error::other(error.to_string()).into())
    }

    async fn accept_bi(&self) -> centraid_protocol::Result<(Self::Send, Self::Recv)> {
        self.inner
            .accept_bi()
            .await
            .map_err(|error| std::io::Error::other(error.to_string()).into())
    }

    fn peer(&self) -> Vec<u8> {
        self.peer_id().to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_config_advertises_the_two_live_lanes_and_not_the_peer_plane() {
        let config = EndpointConfig::default();
        assert_eq!(config.connect_timeout, CONNECT_TIMEOUT);
        assert!(config.alpns.contains(&alpn::SEAT.to_vec()));
        assert!(config.alpns.contains(&alpn::PAIR.to_vec()));
        assert!(
            !config.alpns.contains(&alpn::PEER.to_vec()),
            "the peer plane needs a link policy first (wave 4)"
        );
    }

    #[test]
    fn a_loopback_config_has_no_relays() {
        assert_eq!(EndpointConfig::loopback().relay, RelayMode::Disabled);
    }

    /// With relays disabled there is no relay to blame, so every dial failure
    /// is the peer's. The test exists because the opposite — reporting
    /// `NoRelayReachable` on a relay-less endpoint — is the kind of answer that
    /// sends a member to look at a relay they deliberately turned off.
    #[test]
    fn a_relay_less_endpoint_never_blames_a_relay() {
        let relay_less = Endpoint {
            inner: Arc::new(RwLock::new(None)),
            config: EndpointConfig::loopback(),
            secret_key: SecretKey::generate(),
            idle: Arc::new(AtomicBool::new(false)),
            events: broadcast::channel(EVENT_CAPACITY).0,
        };
        assert!(matches!(
            relay_less.classify("no relay could be reached"),
            ConnectError::PeerUnreachable
        ));

        let relayed = Endpoint {
            config: EndpointConfig::default(),
            ..relay_less
        };
        assert!(matches!(
            relayed.classify("no relay could be reached"),
            ConnectError::NoRelayReachable
        ));
        assert!(matches!(
            relayed.classify("connection timed out"),
            ConnectError::PeerUnreachable
        ));
    }

    #[test]
    fn a_custom_relay_url_is_parsed_and_a_bad_one_is_refused() {
        assert!(
            RelayMode::Custom("https://relay.example.com".to_owned())
                .to_iroh()
                .is_ok()
        );
        assert!(matches!(
            RelayMode::Custom("not a url".to_owned()).to_iroh(),
            Err(ConnectError::Endpoint(_))
        ));
    }

    #[test]
    fn the_unauthorized_close_code_is_v0s() {
        assert_eq!(CLOSE_UNAUTHORIZED, 401);
    }
}
