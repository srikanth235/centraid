//! THE LISTENER, AND THE ONLY FILE IN THIS CRATE THAT ACCEPTS (#1080).
//!
//! The phone is the vault and a client: it dials, and accepts no inbound
//! connection. The gateway is the thing it dials, so this file binds a TCP
//! port, completes TLS handshakes and hands each connection to
//! [`crate::server::http::router`]. `cargo xtask rules`' `no-listening-socket`
//! allows this file by name and no other in the crate; the harness that tests
//! bind on an ephemeral port bind through [`bind`] here.
//!
//! The Bonjour advertisement lives here too: answering a LAN's queries is
//! listening, and every way in belongs in the one file a reader checks.
//!
//! # HANDSHAKES DO NOT BLOCK THE ACCEPT LOOP
//!
//! Each accepted socket's TLS handshake runs on its own task under a timeout
//! and a finished connection is queued for `axum::serve`; one slow or silent
//! peer stalls only itself. The queue is bounded, so a flood of handshakes
//! applies back-pressure to itself rather than to this process's memory.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::server::TlsStream;

use crate::rules::ids::GatewayId;
use crate::server::Handle;

/// How long a peer has to finish a TLS handshake.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

/// The Bonjour service type a gateway advertises and a phone browses.
pub const SERVICE_TYPE: &str = "_centraid-gateway._tcp.local.";

/// Bind the TCP port, e.g. `0.0.0.0:8443`, or `127.0.0.1:0` for a free one.
///
/// # Errors
///
/// If the address does not parse or the port cannot be bound; the address is
/// in the message, because "bind failed" on a home box is otherwise
/// unactionable.
pub async fn bind(address: &str) -> std::io::Result<TcpListener> {
    TcpListener::bind(address)
        .await
        .map_err(|error| std::io::Error::new(error.kind(), format!("binding {address}: {error}")))
}

/// A bound port whose connections arrive already past TLS.
pub struct TlsListener {
    connections: mpsc::Receiver<(TlsStream<TcpStream>, SocketAddr)>,
    local: SocketAddr,
    accepting: JoinHandle<()>,
}

impl core::fmt::Debug for TlsListener {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("TlsListener")
            .field("local", &self.local)
            .finish_non_exhaustive()
    }
}

impl TlsListener {
    /// Start accepting on `listener`, completing handshakes with `config`.
    ///
    /// # Errors
    ///
    /// If the listener's own address cannot be read.
    pub fn new(listener: TcpListener, config: Arc<ServerConfig>) -> std::io::Result<Self> {
        let local = listener.local_addr()?;
        let acceptor = TlsAcceptor::from(config);
        let (sender, connections) = mpsc::channel(64);
        let accepting = tokio::spawn(async move {
            loop {
                let (socket, peer) = match listener.accept().await {
                    Ok(accepted) => accepted,
                    Err(error) => {
                        // Out of descriptors, usually: wait rather than spin.
                        tracing::debug!(%error, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                        continue;
                    }
                };
                let acceptor = acceptor.clone();
                let sender = sender.clone();
                tokio::spawn(async move {
                    let _ = socket.set_nodelay(true);
                    match tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor.accept(socket)).await {
                        Ok(Ok(stream)) => {
                            let _ = sender.send((stream, peer)).await;
                        }
                        Ok(Err(error)) => tracing::debug!(%error, "a TLS handshake failed"),
                        Err(_) => tracing::debug!("a TLS handshake timed out"),
                    }
                });
            }
        });
        Ok(Self {
            connections,
            local,
            accepting,
        })
    }

    /// The address actually bound: what `:0` turned into.
    #[must_use]
    pub const fn local(&self) -> SocketAddr {
        self.local
    }
}

impl Drop for TlsListener {
    fn drop(&mut self) {
        self.accepting.abort();
    }
}

impl axum::serve::Listener for TlsListener {
    type Io = TlsStream<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            if let Some(connection) = self.connections.recv().await {
                return connection;
            }
            // The accept loop is gone and nothing more will arrive; park
            // rather than spin. `axum::serve` has no way to be told "done".
            std::future::pending::<()>().await;
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        Ok(self.local)
    }
}

/// Serve the routes on `listener` until `shutdown` resolves.
///
/// # Errors
///
/// If the server stops with an error.
pub async fn run(
    listener: TlsListener,
    shared: Handle,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, crate::server::http::router(shared))
        .with_graceful_shutdown(shutdown)
        .await
}

/// The Bonjour advertisement of one gateway: `_centraid-gateway._tcp` on the
/// LAN, with `gw=<gateway id>` and `v=2` in its TXT record, so a phone at home
/// refreshes a destination's addresses by browsing. Stopped when dropped.
pub struct Advertisement {
    daemon: mdns_sd::ServiceDaemon,
}

impl core::fmt::Debug for Advertisement {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("Advertisement")
    }
}

impl Advertisement {
    /// Advertise `port` under `host` (a bare host name; `.local.` is added).
    ///
    /// # Errors
    ///
    /// If the responder cannot start or the record is malformed.
    pub fn start(gateway_id: GatewayId, host: &str, port: u16) -> Result<Self, mdns_sd::Error> {
        let daemon = mdns_sd::ServiceDaemon::new()?;
        let id = gateway_id.hex();
        let properties = [("gw", id.as_str()), ("v", "2")];
        let service = mdns_sd::ServiceInfo::new(
            SERVICE_TYPE,
            &format!("centraid-gateway-{}", &id[..8]),
            &format!("{host}.local."),
            "",
            port,
            &properties[..],
        )?
        .enable_addr_auto();
        daemon.register(service)?;
        Ok(Self { daemon })
    }
}

impl Drop for Advertisement {
    fn drop(&mut self) {
        let _ = self.daemon.shutdown();
    }
}
