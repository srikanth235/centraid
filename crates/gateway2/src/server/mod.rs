//! THE GATEWAY A MEMBER RUNS (#1080).
//!
//! What is here is a certificate, a socket, a SQLite file, a directory of
//! objects, two timers and the CLI's pieces — the things a rule cannot be.
//! Every decision is [`crate::rules`]', reached through
//! [`crate::rules::engine::Gateway`]; a handler that grows an `if` about what
//! is allowed has put a rule in the wrong module.
//!
//! # THE DATA DIRECTORY IS THE WHOLE BACKUP
//!
//! | Path | What |
//! | --- | --- |
//! | `tls.key`, `tls.crt`, `gateway.id` | the identity, minted together at first `serve`, mode 0600 ([`tls`]) |
//! | `state.db` (with `-wal`, `-shm`) | vaults, hashed tokens and secrets, heads, snapshots, the object index ([`state`]) |
//! | `objects/<vault>/<nn>/<name>` | one sealed object per file ([`store`]) |
//! | `incoming/` | uploads being staged; emptied at start |
//! | `serve.json` | the address `serve` last bound, which `pair` reads |
//!
//! Plain files: copying the directory anywhere — a VPS, a NAS, a disk in a
//! drawer — copies everything a gateway has. A stolen copy yields ciphertext
//! under names nobody can invert, sizes, times and device labels.
//!
//! | Module | What it holds |
//! | --- | --- |
//! | [`tls`] | the certificate and gateway id, minted once |
//! | [`state`], [`sql`] | `State` over SQLite, its statements as files |
//! | [`store`] | objects as files: staged, verified, renamed |
//! | [`http`] | axum over the rules |
//! | [`serve`] | the one bind and accept loop, and the Bonjour advertisement |
//! | [`sweeps`] | purge hourly, scrub quarterly |
//! | [`harness`] | a real gateway on an ephemeral port, for tests in any crate |
//! | [`addrs`] | the addresses the pairing QR lists |
//! | [`report`] | what the terminal says: the payload, the safety number, `pairings` |
//! | [`service`], [`qr`] | the unit files `install` writes, the terminal QR |

pub mod addrs;
pub mod harness;
pub mod http;
pub mod qr;
pub mod report;
pub mod serve;
pub mod service;
pub mod sql;
pub mod state;
pub mod store;
pub mod sweeps;
pub mod tls;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rand::TryRngCore as _;

use crate::rules::engine::Gateway;
use crate::rules::ids::{GatewayId, Secret, Token, VaultId};
use crate::rules::limits::SECRET_TTL_MS;
use crate::rules::payload::{PAYLOAD_VERSION, PairPayload};
use crate::rules::state::{Fault, StoreFault};
use crate::rules::wire::PairKind;
use crate::server::state::{STATE_FILE, SqliteState};
use crate::server::store::ObjectStore;
use crate::server::tls::{Identity, IdentityError};

/// The port `serve` binds when told nothing.
pub const DEFAULT_PORT: u16 = 8443;

/// Where `serve` records the address it bound, for `pair` and `health`: they
/// run as second processes beside it and cannot ask the socket.
pub const SERVE_FILE: &str = "serve.json";

#[derive(serde::Serialize, serde::Deserialize)]
struct Served {
    bind: String,
}

/// Record the address `serve` bound. Written whole and renamed into place, so
/// a reader never sees half of it; it holds no key.
///
/// # Errors
///
/// If the data directory cannot be written.
pub fn record_bound(data_dir: &Path, bound: SocketAddr) -> std::io::Result<()> {
    let staged = data_dir.join(format!("{SERVE_FILE}.tmp"));
    let text = serde_json::to_string(&Served {
        bind: bound.to_string(),
    })
    .map_err(std::io::Error::other)?;
    std::fs::write(&staged, text)?;
    std::fs::rename(&staged, data_dir.join(SERVE_FILE))
}

/// The address `serve` last recorded, if it ever ran here.
#[must_use]
pub fn last_bound(data_dir: &Path) -> Option<SocketAddr> {
    let text = std::fs::read_to_string(data_dir.join(SERVE_FILE)).ok()?;
    serde_json::from_str::<Served>(&text)
        .ok()?
        .bind
        .parse()
        .ok()
}

/// The gateway's clock, in milliseconds since the Unix epoch. The rules take
/// time as an argument; this is where the argument comes from.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The wall clock.
#[must_use]
pub fn system_clock() -> Clock {
    Arc::new(system_now_ms)
}

/// Milliseconds since the Unix epoch, now.
#[must_use]
pub fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

/// Something the member at the gateway's terminal should hear about. The
/// library prints nothing; the binary decides what to say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A phone paired, claimed or was granted reads.
    Paired {
        vault: VaultId,
        kind: PairKind,
        epoch: u64,
        label: String,
    },
}

/// What hears [`Event`]s.
pub type Announcer = Arc<dyn Fn(&Event) + Send + Sync>;

/// Why a gateway could not open its data directory.
#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    #[error(transparent)]
    Identity(#[from] IdentityError),
    #[error(transparent)]
    State(#[from] StoreFault),
    #[error("{0}: {1}")]
    Io(String, std::io::Error),
    #[error("the TLS configuration: {0}")]
    Tls(String),
}

/// One running gateway: its identity, its rules over its state, its objects
/// and its clock. Shared by every connection as [`Handle`].
pub struct Shared {
    gateway: Mutex<Gateway<SqliteState>>,
    store: ObjectStore,
    identity: Identity,
    clock: Clock,
    data_dir: PathBuf,
    announcer: Option<Announcer>,
}

impl core::fmt::Debug for Shared {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter
            .debug_struct("Shared")
            .field("identity", &self.identity)
            .field("data_dir", &self.data_dir)
            .finish_non_exhaustive()
    }
}

/// The handle every route takes.
pub type Handle = Arc<Shared>;

/// Bytes from the operating system's generator: tokens, pairing secrets and
/// the gateway id are the values whose predictability would hand over a
/// vault, so a failure to read it is an error and never a fallback.
///
/// # Errors
///
/// A store fault if the generator cannot be read.
pub fn os_random<const N: usize>() -> Result<[u8; N], StoreFault> {
    let mut bytes = [0_u8; N];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|error| StoreFault::new(format!("the OS generator: {error}")))?;
    Ok(bytes)
}

impl Shared {
    /// Open the gateway whose data directory this is, minting its identity
    /// at first use.
    ///
    /// # Errors
    ///
    /// [`OpenError`] for an identity, state or directory that will not open.
    pub fn open(data_dir: &Path, clock: Clock) -> Result<Self, OpenError> {
        std::fs::create_dir_all(data_dir)
            .map_err(|error| OpenError::Io(data_dir.display().to_string(), error))?;
        // Drawn on every open and used only on the first: the id is minted
        // with the certificate, from the OS.
        let fresh_id = GatewayId::from_bytes(os_random::<16>()?);
        let identity = Identity::load_or_mint(data_dir, || fresh_id)?;
        let state = SqliteState::open(&data_dir.join(STATE_FILE))?;
        let store = ObjectStore::open(data_dir)
            .map_err(|error| OpenError::Io(data_dir.display().to_string(), error))?;
        Ok(Self {
            gateway: Mutex::new(Gateway::new(state, identity.gateway_id())),
            store,
            identity,
            clock,
            data_dir: data_dir.to_path_buf(),
            announcer: None,
        })
    }

    /// Tell `announcer` about every [`Event`].
    #[must_use]
    pub fn with_announcer(mut self, announcer: Announcer) -> Self {
        self.announcer = Some(announcer);
        self
    }

    /// The gateway's clock, now.
    #[must_use]
    pub fn now(&self) -> i64 {
        (self.clock)()
    }

    /// Run one operation of the rules. The lock is a plain mutex held for one
    /// operation and never across an `await`: every call under it is a few
    /// SQLite statements and, for a `PUT`, one rename.
    ///
    /// # Errors
    ///
    /// Whatever the operation returns, or a store fault for a poisoned lock.
    pub fn rules<T>(
        &self,
        op: impl FnOnce(&mut Gateway<SqliteState>) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        let mut gateway = self
            .gateway
            .lock()
            .map_err(|_| StoreFault::new("the state lock was poisoned"))?;
        op(&mut gateway)
    }

    /// The object directory.
    #[must_use]
    pub const fn store(&self) -> &ObjectStore {
        &self.store
    }

    /// The certificate and gateway id.
    #[must_use]
    pub const fn identity(&self) -> &Identity {
        &self.identity
    }

    /// The data directory.
    #[must_use]
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// The operator's `pair` verb: a fresh secret, good for one new vault for
    /// a day. Its plaintext exists only in what this returns.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn mint_secret(&self) -> Result<Secret, Fault> {
        let secret = Secret::from_bytes(os_random::<16>()?);
        let now = self.now();
        self.rules(|gateway| gateway.mint_secret(&secret, now))?;
        Ok(secret)
    }

    /// A fresh secret, as the QR payload that carries it to a phone.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn payload(&self, addrs: Vec<String>) -> Result<PairPayload, Fault> {
        let now = self.now();
        let secret = self.mint_secret()?;
        Ok(PairPayload {
            v: PAYLOAD_VERSION,
            gw: self.identity.gateway_id(),
            addrs,
            pin: self.identity.pin(),
            secret,
            exp_ms: now.saturating_add(SECRET_TTL_MS),
        })
    }

    /// A fresh bearer token, from the OS.
    ///
    /// # Errors
    ///
    /// A store fault if the generator cannot be read.
    pub fn fresh_token(&self) -> Result<Token, Fault> {
        Ok(Token::from_bytes(os_random::<32>()?))
    }

    pub(crate) fn announce(&self, event: &Event) {
        if let Some(announcer) = &self.announcer {
            announcer(event);
        }
    }
}
