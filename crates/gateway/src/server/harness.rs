//! A REAL GATEWAY ON AN EPHEMERAL PORT, FOR TESTS IN ANY CRATE (#1080).
//!
//! [`spawn`] opens a data directory exactly as `serve` does — minting the
//! identity, opening `state.db` and the object directory — binds
//! `127.0.0.1:0` through [`crate::server::serve::bind`], and serves on the
//! caller's tokio runtime. What it adds is what only a test may do: mint a
//! pairing secret without a terminal, move the gateway's clock, run a sweep
//! now, flip a stored bit, and cut the [`Cable`] its listener's connections
//! run through, part-way through whatever a phone is doing. Nothing is faked
//! below the socket: a phone's client talks TLS to it and the rules answer
//! from SQLite and real files.
//!
//! It advertises nothing on the LAN. Dropping the handle stops the server;
//! [`spawn_on`] starts it again where it was.

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::client::{Client, Destination};
use crate::rules::engine::ScrubCounts;
use crate::rules::ids::{GatewayId, Name, Pin, Secret, Token, VaultId};
use crate::rules::payload::PairPayload;
use crate::rules::state::{Fault, StoreFault};
use crate::server::serve::{Cable, TlsListener, bind, run};
use crate::server::sweeps::{purge_once, scrub_once};
use crate::server::{Announcer, Handle, OpenError, Shared, system_now_ms};

/// A gateway serving on `127.0.0.1`, and the handles a test needs.
#[derive(Debug)]
pub struct Spawned {
    /// Where it listens.
    pub addr: SocketAddr,
    /// `blake3(cert_der)`: what a pairing QR carries.
    pub pin: Pin,
    /// Its certificate, DER: what a paired phone keeps.
    pub cert_der: Vec<u8>,
    /// Its id: what a claim is signed to.
    pub gateway_id: GatewayId,
    shared: Handle,
    offset: Arc<AtomicI64>,
    cable: Arc<Cable>,
    stop: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<std::io::Result<()>>>,
}

/// Start a gateway over `data_dir`, which may be empty or a previous run's.
///
/// # Errors
///
/// [`OpenError`] if the directory will not open or the port will not bind.
pub async fn spawn(data_dir: &Path) -> Result<Spawned, OpenError> {
    spawn_with(data_dir, None).await
}

/// [`spawn`], telling `announcer` about each [`crate::server::Event`] as
/// `serve` tells its terminal.
///
/// # Errors
///
/// As [`spawn`].
pub async fn spawn_with(
    data_dir: &Path,
    announcer: Option<Announcer>,
) -> Result<Spawned, OpenError> {
    serve_on(data_dir, announcer, "127.0.0.1:0", false).await
}

/// [`spawn`] on `address`, where a gateway that stopped was listening: the
/// same gateway started again where its phones reach it, as `serve` is on its
/// configured port.
///
/// # Errors
///
/// As [`spawn`].
pub async fn spawn_on(data_dir: &Path, address: SocketAddr) -> Result<Spawned, OpenError> {
    serve_on(data_dir, None, &address.to_string(), true).await
}

/// Open `data_dir` as `serve` does and serve it on `address`. `again` is a
/// port a stopped gateway's runtime just freed, so a bind that finds it not
/// yet free is tried again for a second.
async fn serve_on(
    data_dir: &Path,
    announcer: Option<Announcer>,
    address: &str,
    again: bool,
) -> Result<Spawned, OpenError> {
    let offset = Arc::new(AtomicI64::new(0));
    let clock_offset = Arc::clone(&offset);
    let clock =
        Arc::new(move || system_now_ms().saturating_add(clock_offset.load(Ordering::SeqCst)));
    let opened = Shared::open(data_dir, clock)?;
    let shared = Arc::new(match announcer {
        Some(announcer) => opened.with_announcer(announcer),
        None => opened,
    });
    shared
        .store()
        .clear_staged()
        .map_err(|error| OpenError::Io(data_dir.display().to_string(), error))?;
    let mut tries = 0;
    let listener = loop {
        match bind(address).await {
            Ok(listener) => break listener,
            Err(error) if again && tries < 50 && error.kind() == std::io::ErrorKind::AddrInUse => {
                tries += 1;
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            Err(error) => return Err(OpenError::Io(address.to_owned(), error)),
        }
    };
    let config = shared
        .identity()
        .server_config()
        .map_err(|error| OpenError::Tls(error.to_string()))?;
    let cable = Arc::new(Cable::default());
    let listener = TlsListener::cabled(listener, config, Arc::clone(&cable))
        .map_err(|error| OpenError::Io("the bound socket".to_owned(), error))?;
    let addr = listener.local();
    let (stop, stopped) = oneshot::channel::<()>();
    let task = tokio::spawn(run(listener, Arc::clone(&shared), async {
        let _ = stopped.await;
    }));
    Ok(Spawned {
        addr,
        pin: shared.identity().pin(),
        cert_der: shared.identity().cert_der().to_vec(),
        gateway_id: shared.identity().gateway_id(),
        shared,
        offset,
        cable,
        stop: Some(stop),
        task: Some(task),
    })
}

impl Spawned {
    /// The operator's `pair` verb: one fresh pairing secret.
    ///
    /// # Panics
    ///
    /// If the gateway's state cannot be written, which a test should not
    /// survive.
    #[must_use]
    pub fn mint_pairing_secret(&self) -> Secret {
        self.shared
            .mint_secret()
            .unwrap_or_else(|fault| panic!("the harness could not mint a secret: {fault}"))
    }

    /// A fresh secret as the QR payload `pair` would print for this gateway.
    ///
    /// # Panics
    ///
    /// As [`Self::mint_pairing_secret`].
    #[must_use]
    pub fn payload(&self) -> PairPayload {
        self.shared
            .payload(vec![self.addr.to_string()])
            .unwrap_or_else(|fault| panic!("the harness could not mint a payload: {fault}"))
    }

    /// A client on first contact: it trusts the pin, as a phone that just
    /// scanned the QR does.
    #[must_use]
    pub fn first_contact(&self) -> Client {
        Client::first_contact(vec![self.addr.to_string()], self.pin)
    }

    /// A client for a paired phone holding `token`.
    #[must_use]
    pub fn client(&self, token: Token) -> Client {
        Client::new(&Destination {
            addrs: vec![self.addr.to_string()],
            cert_der: self.cert_der.clone(),
            token,
        })
    }

    /// Move the gateway's clock `ms` forward.
    pub fn advance_clock(&self, ms: i64) {
        self.offset.fetch_add(ms, Ordering::SeqCst);
    }

    /// The cable every connection to this gateway runs through: cut it, or
    /// let a budget of bytes through and then cut it, to take the gateway
    /// away part-way through what a phone is doing.
    #[must_use]
    pub fn cable(&self) -> &Cable {
        &self.cable
    }

    /// The data directory.
    #[must_use]
    pub fn data_dir(&self) -> &Path {
        self.shared.data_dir()
    }

    /// The running gateway.
    #[must_use]
    pub const fn shared(&self) -> &Handle {
        &self.shared
    }

    /// Run the purge sweep now.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn purge_now(&self) -> Result<u64, Fault> {
        let shared = Arc::clone(&self.shared);
        tokio::task::spawn_blocking(move || purge_once(&shared))
            .await
            .map_err(|error| StoreFault::new(error.to_string()))?
    }

    /// Run the scrub sweep now.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub async fn scrub_now(&self) -> Result<ScrubCounts, Fault> {
        let shared = Arc::clone(&self.shared);
        tokio::task::spawn_blocking(move || scrub_once(&shared))
            .await
            .map_err(|error| StoreFault::new(error.to_string()))?
    }

    /// Flip the first bit of a stored object.
    ///
    /// # Errors
    ///
    /// If the object cannot be read or rewritten.
    pub fn corrupt(&self, vault: &VaultId, name: &Name) -> std::io::Result<()> {
        self.shared.store().flip_bit(vault, name)
    }

    /// Stop serving and wait for the server to finish.
    pub async fn shutdown(mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
    }
}

impl Drop for Spawned {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
