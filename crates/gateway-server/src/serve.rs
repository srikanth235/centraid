//! THE LISTENER, AND IT IS THE ONLY ONE IN THIS WORKSPACE (#1029 §3).
//!
//! Everything else Centraid ships is a client: the phone opens no inbound
//! socket, the desktop talks to a sidecar over stdio, the browser Companion
//! talks to a native host. `cargo xtask rules`' `no-listening-socket` exists to
//! keep that true, and it predates #1029 §3 — which introduces, deliberately,
//! **a server anyone can self-host**. A gateway that did not listen would not
//! be a gateway.
//!
//! So the bind is confined to this one file, and the rule was repointed rather
//! than relaxed: it still scans every other crate, and inside this crate it
//! still scans every other file. A listener anywhere else in the workspace is
//! still a finding, which is the property the rule was written for.
//!
//! # TWO CARRIERS, AND IROH IS THE DEFAULT
//!
//! The [scope amendment of 2026-09-21](https://github.com/srikanth235/centraid/issues/1029#issuecomment-5755559795)
//! makes v0 a phone backing up to the member's own laptop. A laptop has no
//! domain, no certificate and no port anybody forwarded, so the default
//! carrier is **iroh**: [`serve_iroh`] serves the same
//! [`crate::http::router`] through an [`IrohListener`], under
//! [`centraid_gateway_core::ALPN`]. Nothing on the wire changes — the router
//! cannot tell which carrier a request arrived on, and that is the property
//! this file exists to keep.
//!
//! The TCP carrier stays for the self-hoster who *does* have a domain:
//! [`serve_plain`] behind a reverse proxy or a tunnel, and [`serve_acme`] with
//! a certificate this process obtains itself. `acme.rs` is not deleted.
//!
//! # WHAT THIS FILE IS ALLOWED TO DO
//!
//! Accept connections, hand them to the router, and shut down when asked.
//! It makes no decision about a request: [`crate::http`] does the decoding and
//! `centraid-gateway-core` does the deciding.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context as _;
use iroh::endpoint::presets;
use iroh::{Endpoint, EndpointId, RelayMode, SecretKey};
use tokio::net::TcpListener;
use tokio::sync::{Mutex, mpsc};

use crate::config::{Config, IrohConfig, TlsConfig};
use crate::http::{Server, Shared};

/// A bound listener and the address it actually got.
///
/// The address is returned because `:0` is how a test binds a free port, and a
/// test that had to guess one would be a test that fails when a machine is
/// busy.
#[derive(Debug)]
pub struct Bound {
    pub listener: TcpListener,
    pub address: SocketAddr,
}

/// Bind the configured address.
///
/// # Errors
///
/// If the address cannot be parsed or the port cannot be bound.
pub async fn bind(bind_address: &str) -> anyhow::Result<Bound> {
    let listener = TcpListener::bind(bind_address)
        .await
        .with_context(|| format!("binding {bind_address}"))?;
    let address = listener.local_addr().context("reading the bound address")?;
    Ok(Bound { listener, address })
}

/// Wrap a server in the handle the handlers take.
#[must_use]
pub fn shared(server: Server) -> Shared {
    Arc::new(Mutex::new(server))
}

/// Serve plain HTTP on an already-bound listener.
///
/// This is the `TlsConfig::Terminated` arm and the default: a reverse proxy, a
/// Cloudflare Tunnel or a Tailscale Funnel is holding the certificate. It is
/// also the arm the tests run, because a conformance run should not need an
/// ACME server.
///
/// # Errors
///
/// If the server stops with an error.
pub async fn serve_plain(bound: Bound, server: Shared) -> anyhow::Result<()> {
    axum::serve(bound.listener, crate::http::router(server))
        .await
        .context("serving")
}

/// Serve with a certificate this process obtains and renews itself.
///
/// # Errors
///
/// If ACME cannot be started or the server stops with an error.
pub async fn serve_acme(bound: Bound, server: Shared, config: &Config) -> anyhow::Result<()> {
    let TlsConfig::Acme {
        domains,
        contact_email,
        staging,
    } = &config.tls
    else {
        anyhow::bail!("serve_acme was called for a server that terminates TLS in front");
    };
    std::fs::create_dir_all(config.acme_cache()).context("creating the ACME cache")?;
    let mut state =
        crate::acme::configure(domains, contact_email, &config.acme_cache(), *staging).state();
    let acceptor = state.acceptor();

    // The resolver is the ACME state's own; the rest of the TLS configuration
    // is ordinary. `http/1.1` only, because ALPN is how the challenge is
    // distinguished and an `h2` entry here would advertise a protocol this
    // server does not speak.
    let mut rustls_config = tokio_rustls::rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_cert_resolver(state.resolver());
    rustls_config.alpn_protocols = vec![b"http/1.1".to_vec()];
    let rustls_config = Arc::new(rustls_config);

    // The ACME state machine is a stream of events, and an operator needs to
    // see them: a renewal that has been failing for a month is the failure mode
    // that ends with an expired certificate and no warning.
    tokio::spawn(async move {
        use futures::StreamExt as _;
        while let Some(event) = state.next().await {
            match event {
                Ok(ok) => tracing::info!(event = ?ok, "acme"),
                Err(error) => tracing::error!(%error, "acme"),
            }
        }
    });

    axum::serve(
        AcmeListener {
            listener: bound.listener,
            acceptor,
            rustls_config,
        },
        crate::http::router(server),
    )
    .await
    .context("serving")
}

/// A listener that answers the ACME challenge and hands on a TLS stream.
///
/// `axum::serve` takes a `Listener`, and a handshake that turns out to be a
/// TLS-ALPN-01 challenge is **not** a connection to serve — the ACME acceptor
/// answers it and yields nothing. So this loops until a real stream comes out,
/// which is what keeps the challenge invisible to everything above.
struct AcmeListener {
    listener: TcpListener,
    acceptor: tokio_rustls_acme::AcmeAcceptor,
    rustls_config: Arc<tokio_rustls::rustls::ServerConfig>,
}

impl axum::serve::Listener for AcmeListener {
    type Io = tokio_rustls::server::TlsStream<tokio::net::TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let Ok((stream, address)) = self.listener.accept().await else {
                continue;
            };
            match self.acceptor.accept(stream).await {
                // A challenge handshake. Answered, and there is nothing to
                // serve over it.
                Ok(None) => continue,
                Ok(Some(start)) => {
                    if let Ok(stream) = start.into_stream(Arc::clone(&self.rustls_config)).await {
                        return (stream, address);
                    }
                }
                Err(error) => tracing::debug!(%error, "a handshake failed"),
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.listener.local_addr()
    }
}

// ---------------------------------------------------------------------------
// The iroh carrier — the default (scope amendment 2026-09-21)
// ---------------------------------------------------------------------------

/// The file the endpoint's secret key lives in, beside the SQLite state.
///
/// **It is generated once and never regenerated.** The endpoint id a member
/// scanned off a QR at pairing is this key's public half, and a laptop that
/// minted a fresh one on restart would be a laptop every paired phone stops
/// being able to find — with no error either end could explain. So: read it if
/// it is there, mint it if it is not, and fail loudly if it is there and
/// unreadable rather than quietly minting a second identity over the top.
pub const NODE_KEY_FILE: &str = "node.key";

/// Where the endpoint's secret key lives for a given data directory.
#[must_use]
pub fn node_key_path(data_dir: &Path) -> PathBuf {
    data_dir.join(NODE_KEY_FILE)
}

/// Load the endpoint's persistent secret key, minting it on first run.
///
/// 32 raw bytes, `0600`. Raw rather than hex or PEM because there is exactly
/// one thing in the file and a format would be a second thing to get wrong; the
/// length check is what rejects a truncated write.
///
/// # Errors
///
/// If the file exists and is not 32 bytes, or cannot be read or written.
pub fn node_secret(data_dir: &Path) -> anyhow::Result<SecretKey> {
    let path = node_key_path(data_dir);
    if path.exists() {
        let bytes = std::fs::read(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let bytes: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
            anyhow::anyhow!(
                "{} is {} bytes and an endpoint secret key is 32. Refusing to mint a second \
                 identity over it: every paired phone dials the id this key's public half names",
                path.display(),
                bytes.len()
            )
        })?;
        return Ok(SecretKey::from_bytes(&bytes));
    }
    std::fs::create_dir_all(data_dir).context("creating the data directory")?;
    let secret = SecretKey::generate();
    std::fs::write(&path, secret.to_bytes()).with_context(|| format!("writing {}", path.display()))?;
    restrict(&path)?;
    Ok(secret)
}

/// `0600` on the key file. A no-op where the platform has no Unix modes.
#[cfg(unix)]
fn restrict(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .with_context(|| format!("restricting {}", path.display()))
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

/// Bind the iroh endpoint this gateway is dialled on.
///
/// **The defaults are n0's**, deliberately: `presets::N0` is the relay mesh and
/// the DNS address-lookup service a phone on a foreign network needs in order
/// to reach a laptop behind NAT with no port forwarded, which is the whole
/// reason the amendment answered open question 12 yes. A self-hoster who runs
/// their own `iroh-relay` or their own `iroh-dns-server` points
/// [`IrohConfig`] at it, exactly as #1029 §0 already lets them do for pkarr.
///
/// # Errors
///
/// If the key cannot be read, the relay URL does not parse, or the endpoint
/// cannot bind its UDP socket.
pub async fn bind_iroh(data_dir: &Path, config: &IrohConfig) -> anyhow::Result<Endpoint> {
    let secret = node_secret(data_dir)?;
    let mut builder = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(vec![centraid_gateway_core::ALPN.to_vec()]);
    if let Some(relay) = &config.relay_url {
        let url: iroh::RelayUrl = relay
            .parse()
            .with_context(|| format!("{relay} is not a relay URL"))?;
        builder = builder.relay_mode(RelayMode::Custom(iroh::RelayMap::from_iter([
            iroh::RelayConfig::new(url, None),
        ])));
    }
    builder.bind().await.context("binding the iroh endpoint")
}

/// Serve the router over iroh.
///
/// # Errors
///
/// If the server stops with an error.
pub async fn serve_iroh(endpoint: Endpoint, server: Shared) -> anyhow::Result<()> {
    axum::serve(IrohListener::spawn(endpoint), crate::http::router(server))
        .await
        .context("serving")
}

/// One accepted bidirectional stream, as `axum::serve` wants it: one thing that
/// reads and one that writes, joined.
pub type IrohStream =
    tokio::io::Join<iroh::endpoint::RecvStream, iroh::endpoint::SendStream>;

/// A listener that yields one iroh bi-stream per HTTP connection.
///
/// # ONE BI-STREAM IS ONE HTTP/1.1 CONNECTION, AND WHY THAT WAY ROUND
///
/// A QUIC connection carries many streams, so there are two ways to map the
/// gateway API onto it: one stream per request, or one stream that many
/// requests keep alive. **Both are chosen here, because the choice is not this
/// end's to make.** A bi-stream is handed to hyper as an ordinary HTTP/1.1
/// connection, so a client that sends one request and finishes the stream gets
/// one request per stream, and a client that keeps writing gets keep-alive —
/// the same code, and the same code the TCP carrier runs. Deciding it here
/// would be this file making a decision about a request, which is exactly what
/// its header says it may not do.
///
/// [`IrohTransport`](../../gateway_client/transport/index.html) takes the
/// second shape: one stream reused while it lives.
///
/// # WHY A CHANNEL AND NOT A LOOP
///
/// `Listener::accept` yields one connection at a time, and an iroh connection
/// yields many streams over its life. A `loop` here would have to be accepting
/// new connections and new streams on every existing connection at once, which
/// is a `select!` over a growing set. So each accepted connection gets a task
/// that pushes its streams into one channel, and `accept` pops from the
/// channel. A stalled peer stalls only its own task.
pub struct IrohListener {
    endpoint: Endpoint,
    streams: mpsc::Receiver<(IrohStream, EndpointId)>,
}

impl IrohListener {
    /// Start accepting on an endpoint.
    #[must_use]
    pub fn spawn(endpoint: Endpoint) -> Self {
        // Bounded, so a peer opening streams faster than they are served
        // applies back-pressure to its own connection instead of growing this
        // process's memory.
        let (sender, streams) = mpsc::channel(64);
        let accepting = endpoint.clone();
        tokio::spawn(async move {
            while let Some(incoming) = accepting.accept().await {
                let sender = sender.clone();
                tokio::spawn(async move {
                    // Awaiting the handshake HERE and not in the accept loop:
                    // Reference A records "the accept loop awaits each
                    // handshake inline" as a defect of the plane #1029 deleted,
                    // and this is the one place it would come back.
                    let Ok(connection) = incoming.await else {
                        return;
                    };
                    let peer = connection.remote_id();
                    while let Ok((send, recv)) = connection.accept_bi().await {
                        if sender.send((tokio::io::join(recv, send), peer)).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        Self { endpoint, streams }
    }

    /// The endpoint id a phone dials. This is what the pairing QR carries.
    #[must_use]
    pub fn endpoint_id(&self) -> EndpointId {
        self.endpoint.id()
    }
}

impl axum::serve::Listener for IrohListener {
    type Io = IrohStream;
    type Addr = EndpointId;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            if let Some(accepted) = self.streams.recv().await {
                return accepted;
            }
            // Every sender dropped, which means the endpoint closed. There is
            // nothing left to accept and `axum::serve`'s contract has no way to
            // say so, so this parks rather than spinning or lying.
            std::future::pending::<()>().await;
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.endpoint.id())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `:0` gets a free port and says which, so a test never guesses one.
    #[tokio::test]
    async fn binding_port_zero_reports_the_port_it_got() {
        let bound = bind("127.0.0.1:0").await.expect("a free port");
        assert!(bound.address.port() > 0);
        assert!(bound.address.ip().is_loopback());
    }

    /// A bind that cannot work fails with the address in the message, because
    /// "binding failed" on a home box is otherwise unactionable.
    #[tokio::test]
    async fn a_bad_address_names_itself_in_the_error() {
        let error = bind("not-an-address").await.expect_err("cannot bind");
        assert!(format!("{error}").contains("not-an-address"), "{error}");
    }

    /// THE ENDPOINT ID A PHONE SCANNED MUST STILL BE THIS LAPTOP TOMORROW.
    /// A second start reads the key it wrote; it does not mint a new identity
    /// every paired phone would stop being able to find.
    #[test]
    fn the_node_key_is_minted_once_and_read_back_on_every_later_start() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let first = node_secret(dir.path()).expect("minted");
        let second = node_secret(dir.path()).expect("read back");
        assert_eq!(first.public(), second.public());
        assert_eq!(first.to_bytes(), second.to_bytes());
    }

    /// The key file is the one secret this directory holds, so it is `0600`
    /// and not whatever the umask happened to be.
    #[cfg(unix)]
    #[test]
    fn the_node_key_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("a temp dir");
        node_secret(dir.path()).expect("minted");
        let mode = std::fs::metadata(node_key_path(dir.path()))
            .expect("the key file")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "{mode:o}");
    }

    /// A TRUNCATED KEY IS AN ERROR, NOT A FRESH IDENTITY. Minting over it
    /// would turn a half-written file into a laptop nobody can reach, with the
    /// only evidence of what happened deleted by the fix.
    #[test]
    fn a_key_file_that_is_not_thirty_two_bytes_is_refused_rather_than_replaced() {
        let dir = tempfile::tempdir().expect("a temp dir");
        std::fs::write(node_key_path(dir.path()), [0u8; 16]).expect("a short file");
        let error = node_secret(dir.path()).expect_err("refused");
        assert!(format!("{error}").contains("is 16 bytes"), "{error}");
    }
}
