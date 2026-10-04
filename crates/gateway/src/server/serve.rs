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
//!
//! # EVERY CONNECTION RUNS THROUGH A CABLE A TEST CAN CUT
//!
//! What a phone owes its member when the gateway goes away part-way through
//! a pass — a laptop that sleeps, leaves the network or is killed — is proved
//! against this listener, not a stand-in. A relay in front of it would be a
//! second listener, so the cut lives here: each accepted socket reads and
//! writes through the listener's [`Cable`], whose other end the harness
//! holds. `serve` never cuts its cable, and an uncut cable costs a read or a
//! write two atomic loads (and a read a count of what the phones sent).

use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
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
    connections: mpsc::Receiver<(TlsStream<Cabled>, SocketAddr)>,
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
    /// Start accepting on `listener`, completing handshakes with `config`,
    /// through a cable nothing cuts.
    ///
    /// # Errors
    ///
    /// If the listener's own address cannot be read.
    pub fn new(listener: TcpListener, config: Arc<ServerConfig>) -> std::io::Result<Self> {
        Self::cabled(listener, config, Arc::default())
    }

    /// [`Self::new`], with every connection through `cable`, whose other end
    /// the caller keeps: the harness's way to take the gateway away.
    ///
    /// # Errors
    ///
    /// If the listener's own address cannot be read.
    pub fn cabled(
        listener: TcpListener,
        config: Arc<ServerConfig>,
        cable: Arc<Cable>,
    ) -> std::io::Result<Self> {
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
                let cable = Arc::clone(&cable);
                tokio::spawn(async move {
                    let _ = socket.set_nodelay(true);
                    let socket = Cabled { socket, cable };
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
    type Io = TlsStream<Cabled>;
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

// ─── the cable ──────────────────────────────────────────────────────────────

/// THE CONNECTIONS BETWEEN THIS GATEWAY AND ITS PHONES, AS A TEST CUTS THEM
/// (#1080, the adversarial sweep). The module header has the reason.
///
/// A cut is what a sleeping laptop looks like to a phone: every connection
/// fails at its next read or write, and a new one fails in its handshake.
/// A budget lets that many more bytes cross one way and then cuts. Bytes are
/// counted on the TCP stream, below TLS: a budget is the bytes on the wire.
#[derive(Debug, Default)]
pub struct Cable {
    cut: AtomicBool,
    /// Whether either way has a budget: the one load an uncut cable costs
    /// beyond `cut`.
    budgeted: AtomicBool,
    budgets: Mutex<Budgets>,
    /// Every byte the phones have sent.
    sent: AtomicU64,
}

/// What may still cross each way before the cable is cut; `None` is no limit.
#[derive(Debug, Default)]
struct Budgets {
    sent: Option<u64>,
    answered: Option<u64>,
}

/// Which way bytes cross.
#[derive(Debug, Clone, Copy)]
enum Way {
    /// From a phone to this gateway.
    Sent,
    /// From this gateway to a phone.
    Answered,
}

impl Budgets {
    const fn of(&mut self, way: Way) -> &mut Option<u64> {
        match way {
            Way::Sent => &mut self.sent,
            Way::Answered => &mut self.answered,
        }
    }
}

impl Cable {
    /// Cut every connection now, and fail every new one in its handshake.
    pub fn cut(&self) {
        self.cut.store(true, Ordering::SeqCst);
    }

    /// Let `bytes` more of what the phones send through, then cut.
    pub fn cut_after(&self, bytes: u64) {
        self.budget(Way::Sent, bytes);
    }

    /// Let `bytes` more of this gateway's answers through, then cut: a
    /// restore asks little and is answered a vault.
    pub fn cut_after_answers(&self, bytes: u64) {
        self.budget(Way::Answered, bytes);
    }

    /// Join the cable again: no cut, and no budget either way.
    pub fn mend(&self) {
        *self.budgets() = Budgets::default();
        self.budgeted.store(false, Ordering::SeqCst);
        self.cut.store(false, Ordering::SeqCst);
    }

    /// Every byte the phones have sent so far.
    #[must_use]
    pub fn sent(&self) -> u64 {
        self.sent.load(Ordering::SeqCst)
    }

    fn budget(&self, way: Way, bytes: u64) {
        *self.budgets().of(way) = Some(bytes);
        self.budgeted.store(true, Ordering::SeqCst);
    }

    fn budgets(&self) -> std::sync::MutexGuard<'_, Budgets> {
        self.budgets.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn is_cut(&self) -> bool {
        self.cut.load(Ordering::SeqCst)
    }
}

/// The error every read and write of a cut cable answers.
fn cut_error() -> io::Error {
    io::Error::new(io::ErrorKind::ConnectionReset, "the gateway's cable is cut")
}

/// One accepted socket, reading and writing through its listener's [`Cable`].
#[derive(Debug)]
pub struct Cabled {
    socket: TcpStream,
    cable: Arc<Cable>,
}

impl AsyncRead for Cabled {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.cable.is_cut() {
            return Poll::Ready(Err(cut_error()));
        }
        let before = buf.filled().len();
        if !this.cable.budgeted.load(Ordering::SeqCst) {
            let polled = Pin::new(&mut this.socket).poll_read(context, buf);
            let read = buf.filled().len() - before;
            this.cable.sent.fetch_add(read as u64, Ordering::SeqCst);
            return polled;
        }
        // BUDGETED: the lock is held across the read, which never blocks, so
        // two connections cannot both spend what is left.
        let mut budgets = this.cable.budgets();
        let Some(left) = *budgets.of(Way::Sent) else {
            let polled = Pin::new(&mut this.socket).poll_read(context, buf);
            let read = buf.filled().len() - before;
            this.cable.sent.fetch_add(read as u64, Ordering::SeqCst);
            return polled;
        };
        if left == 0 {
            this.cable.cut();
            return Poll::Ready(Err(cut_error()));
        }
        let room = buf
            .remaining()
            .min(usize::try_from(left).unwrap_or(usize::MAX));
        let mut window = vec![0_u8; room];
        let mut limited = ReadBuf::new(&mut window);
        let polled = Pin::new(&mut this.socket).poll_read(context, &mut limited);
        if let Poll::Ready(Ok(())) = polled {
            let read = limited.filled();
            buf.put_slice(read);
            this.cable
                .sent
                .fetch_add(read.len() as u64, Ordering::SeqCst);
            let after = left.saturating_sub(read.len() as u64);
            *budgets.of(Way::Sent) = Some(after);
            if after == 0 {
                this.cable.cut();
            }
        }
        polled
    }
}

impl AsyncWrite for Cabled {
    fn poll_write(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if this.cable.is_cut() {
            return Poll::Ready(Err(cut_error()));
        }
        if !this.cable.budgeted.load(Ordering::SeqCst) {
            return Pin::new(&mut this.socket).poll_write(context, data);
        }
        let mut budgets = this.cable.budgets();
        let Some(left) = *budgets.of(Way::Answered) else {
            return Pin::new(&mut this.socket).poll_write(context, data);
        };
        if left == 0 {
            this.cable.cut();
            return Poll::Ready(Err(cut_error()));
        }
        let room = data.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        let polled = Pin::new(&mut this.socket).poll_write(context, &data[..room]);
        if let Poll::Ready(Ok(written)) = polled {
            let after = left.saturating_sub(written as u64);
            *budgets.of(Way::Answered) = Some(after);
            if after == 0 {
                this.cable.cut();
            }
        }
        polled
    }

    fn poll_flush(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket).poll_flush(context)
    }

    fn poll_shutdown(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().socket).poll_shutdown(context)
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
