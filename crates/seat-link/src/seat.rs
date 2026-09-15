//! The seat's runtime, and the synchronous door a shell knocks on (#1020,
//! D-1020-B6).
//!
//! ## The core owns the runtime, and the old comment was wrong
//!
//! `Handle::start_endpoint` refused with "lane C's `Endpoint::spawn` needs a
//! tokio runtime, and which runtime a shell owns is the shell's decision, so
//! the core is handed one rather than making one."
//!
//! **A Swift shell does not own a tokio runtime and never will.** Neither does
//! a Kotlin one. There is no runtime to be handed, so "the shell decides" is
//! not a deferral — it is a requirement nothing can satisfy, and it kept the
//! endpoint unbuilt for two waves. The same shape as the `Send` comment that
//! kept the seat lane shut (D-1020-D2C): a plausible sentence that nothing
//! could ever act on.
//!
//! So [`SeatLink`] owns a multi-threaded runtime on threads of its own, and the
//! door stays synchronous. `Handle::call` is synchronous because a shell asking
//! one question wants one answer and should not need an executor in Swift; that
//! was always the right call and it is unaffected by where the runtime lives.
//!
//! ## Blocking is a per-verb decision, not a global one
//!
//! | Verb | Shape | Why |
//! | --- | --- | --- |
//! | [`SeatLink::pair`] | blocks, with a timeout | a member is watching a spinner and pairing is one round trip |
//! | [`SeatLink::sync`] | blocks | called from a background task — a `BGAppRefreshTask` handler or a `Worker`, never the UI thread |
//!
//! Neither may be called on a UI thread, and neither can enforce that. What
//! keeps it honest is that the only callers are the scheduler and an explicit
//! "sync now", both of which are already off the main thread on both platforms.
//!
//! ## ONE ENDPOINT PER OPEN REPLICA (#1025 S1)
//!
//! The vault is the unit on a device. Each vault this device holds has its own
//! pairing, its own address to reach it at, its own replica file, cursor,
//! outbox, **byte store and endpoint key** — so [`SeatLink`] is constructed
//! from a REPLICA PATH and is one per open replica, never one per process.
//!
//! The key is the half that matters: an endpoint shared between two vaults
//! would show the same device identity to two gateways run by two different
//! people, who would then be able to tell they are talking to one phone.
//!
//! **THE SHELL SUPPLIES IT, AND NOTHING HERE WRITES IT TO A FILE** (#1025 S5).
//! [`SeatLink::start_with_key`] takes the secret half the shell kept in the
//! platform's secure store — iOS Keychain, Android Keystore — so a relaunched
//! seat comes back as the device its gateway enrolled. [`SeatLink::start`] is
//! the shell that has no store yet: a fresh key per open, and a seat the
//! gateway refuses at admission until it pairs again. That was every seat
//! before this slice, in both S1's and S2's registers.
//!
//! ## ONE CONNECTION PER PASS, AND THE DEADLINE IS THE CALLER'S (#1025 S2)
//!
//! A pass used to dial twice — `centraid/v1/seat` for rows, `centraid/v1/byte`
//! for files — and the comment here defended it on the grounds that the two
//! planes fail independently. They do, and they still report independently;
//! what the second dial bought was nothing. Both planes now ride streams of one
//! connection, so a phone pays for one QUIC setup per window instead of two,
//! and the byte plane inherits the enrolment decision the row plane already
//! made rather than repeating it.
//!
//! The other constant that went is [`PLANE_TIMEOUT`]: sixty seconds per plane,
//! which outlived an iOS refresh window and cut a night-shift pass that had
//! hours. [`SeatLink::sync`] takes the caller's own window instead, and a pass
//! the deadline cuts is a NORMAL END that reports what it kept.
//!
//! [`PLANE_TIMEOUT`]: https://github.com/srikanth235/centraid/issues/1025

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use centraid_blobs::{Budget, ByteStore};
use centraid_core::link::BootstrapRefusal;
use centraid_net::endpoint::{Endpoint, EndpointConfig};
use centraid_net::{pairing, ticket};
use centraid_protocol::alpn;
use centraid_seat::sync::{ByteMover, ByteOutcome, PassReport, SkipReason, Swept, Window};

use crate::link::GatewayLink;

/// How long a member will wait at a pairing screen before being told it failed.
const PAIR_TIMEOUT: Duration = Duration::from_secs(20);

/// A SMALL GRACE ON TOP OF THE CALLER'S DEADLINE, AND WHAT IT IS FOR.
///
/// The pass checks the caller's deadline between units of work and returns the
/// report it has built, which is what "a window cut by the deadline reports
/// what it kept" means. That check cannot fire inside a single await that never
/// completes — a socket read on a network that went away without a FIN — so the
/// whole pass is also wrapped in a hard cut, a little after the caller's own.
///
/// It is a BACKSTOP and not the deadline. The difference matters: the inner
/// check produces an honest report and the outer one produces a report with
/// nothing in it, so a build where the outer cut is what normally fires has a
/// bug rather than a tight schedule.
const DEADLINE_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, thiserror::Error)]
pub enum LinkError {
    #[error("the seat's runtime could not start: {0}")]
    Runtime(String),
    #[error("the seat's endpoint could not bind: {0}")]
    Endpoint(String),
    #[error("the byte store could not open: {0}")]
    Store(String),
    #[error("that pairing code could not be read: {0}")]
    Ticket(String),
    /// The gateway was not reached at all. **Its own variant**, because the
    /// member's next action differs: come back in range, do NOT mint a new
    /// code. This was briefly folded into [`Self::Pair`] and the sentence was
    /// then recovered by matching on its text — so a gateway that was simply
    /// switched off told the member their pairing code was rejected, which sent
    /// them to mint a new one that would fail the same way.
    #[error("the gateway did not answer the pairing request")]
    GatewayUnreachable,
    /// The gateway answered and refused. `expired` is carried apart because it
    /// is the one refusal whose remedy really is a new code.
    #[error("the gateway refused that pairing code")]
    PairRefused { expired: bool },
    #[error("this seat is not paired to a gateway")]
    NotPaired,
    #[error("the replica could not be read: {0}")]
    Replica(String),
}

pub type Result<T> = std::result::Result<T, LinkError>;

/// Where a paired gateway is, and what it is called.
///
/// **The shell persists this**, not this crate: on iOS it belongs in the
/// Keychain beside the vault credential, and this crate has no business
/// choosing a file. `direct_addrs` are dialling hints and carry no authority —
/// iroh's TLS proves `endpoint_id`, so a stale or tampered address reaches the
/// right gateway or nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedGateway {
    pub endpoint_id: [u8; 32],
    pub relay_url: String,
    pub direct_addrs: Vec<String>,
    pub vault_id: String,
    pub vault_name: String,
    /// THE BLOB THIS GATEWAY NAMED THE LAST TIME IT TOLD THIS DEVICE TO TAKE A
    /// COPY (#1025 S7, item 5).
    ///
    /// `PairOk` carries it, and so does `RebootstrapRequired`. `None` on a
    /// pairing a shell re-adopted out of its secure store or the replica: a
    /// hash read back off disk is one nobody is serving any more, and offering
    /// it would send a device to fetch a blob that is not there.
    pub snapshot: Option<centraid_seat::sync::SnapshotOffer>,
    /// THE PUBLIC KEY THE GATEWAY SAID IT ENROLLED, 32 raw bytes (#1025 S7-13).
    ///
    /// The gateway derives it from the connection its TLS proved, so it is that
    /// gateway's own statement of which identity is in its allowlist. Empty on
    /// a gateway re-adopted from a record: nothing was enrolled and there is
    /// nothing to say.
    pub enrolled_public_key: Vec<u8>,
}

/// The seat's network half for ONE vault: one runtime, one endpoint, one byte
/// store, one replica.
pub struct SeatLink {
    /// A HANDLE TO THE PROCESS'S ONE RUNTIME (#1025 S7-13), not a runtime of
    /// its own. See [`shared_runtime`].
    runtime: tokio::runtime::Handle,
    endpoint: Endpoint,
    blobs: ByteStore,
    /// The replica this link is the network half of. Held because a bootstrap
    /// REPLACES that file and a path is the only way to say which one.
    replica: PathBuf,
    gateway: Mutex<Option<PairedGateway>>,
    /// THE CONNECTION A REDEMPTION PROMOTED, kept for the next thing this seat
    /// does (#1025 S3, D-1025-S3-4).
    ///
    /// Pairing and bootstrapping are the only two things a phone does on its
    /// first screen, and they used to be two dials on two ALPNs — a second QUIC
    /// setup and a second hole-punch in the middle of the one moment a member
    /// is watching a spinner. There is one ALPN now and a redemption promotes
    /// the connection it arrived on, so the connection is kept here and the
    /// next [`SeatLink::bootstrap`] or [`SeatLink::sync`] rides it.
    ///
    /// TAKEN, not cloned: it is used once and then goes with the pass. A stale
    /// one is checked for a close reason before it is handed out, because a
    /// connection the gateway dropped between the pairing screen and the tap is
    /// a connection that would fail on its first stream rather than at the
    /// dial.
    paired_connection: Mutex<Option<centraid_net::IrohConnection>>,
    last: Arc<Mutex<Option<PassReport>>>,
    /// THE STOP FOR THE TAIL THIS LINK IS HOLDING (#1025 S2, D-1025-S7-40).
    ///
    /// One per link and never more, because a seat holds at most one tail per
    /// vault — the gateway enforces the same rule from its side, and a second
    /// one here would be a tail nothing could close.
    ///
    /// Held across passes so [`SeatLink::stop_tail`] can be called by a shell
    /// that is not the thread inside the pass, which is every caller: the tail
    /// runs on a coroutine and the news that the foreground was lost arrives on
    /// the main one.
    tail_stop: Arc<crate::link::TailStop>,
    /// THE TAIL THIS LINK IS HOLDING, when it is holding one (#1025 S2,
    /// D-1025-S7-40).
    ///
    /// The connection, the delivered pages and the reader task. It survives
    /// BETWEEN passes on purpose: the core waits for a page with nothing held,
    /// then takes the vault and applies what is in hand, then comes back here.
    /// A tail that lived inside a pass would hold the vault while it waited,
    /// which is the defect this shape exists to make impossible — see
    /// `crate::link::TailPages`.
    tail: Mutex<Option<TailRun>>,
    product_version: String,
}

/// ONE OPEN TAIL: its connection, its pages, and the task reading them.
///
/// The connection is held for the tail's life rather than per pass, which is
/// also what the gateway sees: one dial, one stream, pages until somebody
/// closes it. The byte plane of a live step rides the SAME connection — a
/// second dial per commit would make a photograph's arrival cost a hole-punch.
struct TailRun {
    connection: centraid_net::IrohConnection,
    pages: Arc<crate::link::TailPages>,
    reader: tokio::task::JoinHandle<()>,
    /// The gateway's own half of the symmetric loop, for the length of the
    /// tail: it may open `blob` streams on this connection to pull a
    /// photograph this device minted.
    serving: tokio::task::JoinHandle<()>,
}

/// SHUT THE ENDPOINT AND THE BYTE STORE DOWN WHEN THE LINK GOES (#1025 S7-13).
///
/// **This was free while every link owned its own runtime**: dropping the link
/// dropped the runtime, and dropping a runtime kills every task on it — the
/// store's actor with them. One process-wide runtime takes that away. A dropped
/// link's store actor keeps running, keeps its lock on `<replica>.bytes`, and
/// the NEXT open of that replica blocks forever inside `ByteStore::open`.
///
/// Found exactly that way: `tests/seat_identity.rs` pairs, closes, and reopens
/// the same replica, and the reopen hung in `Handle::block_on` with the first
/// store still holding the directory.
///
/// So the link closes what it opened. `close` flushes the index, which is worth
/// having on its own: a store that went away with a runtime never flushed.
impl Drop for SeatLink {
    fn drop(&mut self) {
        // A CLONE, because `ByteStore::close` consumes. The clone is a handle
        // to the same actor; shutting it down shuts the store down.
        let blobs = self.blobs.clone();
        let endpoint = self.endpoint.clone();
        self.runtime.block_on(async move {
            endpoint.close().await;
            blobs.close().await;
        });
    }
}

/// THE ONE TOKIO RUNTIME THIS PROCESS HAS (#1025 S7-13).
///
/// Every [`SeatLink`] used to build its own two-worker multi-threaded runtime.
/// With one core open per process that was one runtime; with **every held
/// vault's core open** — which is what a shelf that does not close background
/// cores means — a phone holding four vaults held four runtimes, eight worker
/// threads and four independent executors, for four endpoints that are idle
/// between sync rounds. Threads are the scarce thing on a phone, and an
/// executor per vault buys nothing: tokio multiplexes N endpoints on one.
///
/// **The endpoints stay per vault.** The runtime is the device's; the identity,
/// the socket and the byte store are the vault's (#1025 S7-13, ruling A). This
/// shares the cheapest thing and nothing else.
///
/// Never dropped, on purpose: a `OnceLock<Runtime>` lives for the process, so
/// no link's teardown can take the executor another link is running on.
///
/// **The worker count is the host's, capped at four, and two was wrong.** Two
/// is what ONE link had; sharing one runtime means every endpoint on the device
/// — and, in a test binary, every endpoint of every scenario running in
/// parallel — is on those workers. At two, `tests/seat_bootstrap.rs` and
/// `tests/seat_offline.rs` timed out their pairing dials wholesale: the work is
/// IO-bound and the endpoints park, but a parked worker is not an available
/// one. The cap is there because this is a phone's process as often as a test
/// binary's, and a thread per core on a desktop is more than iroh needs.
fn shared_runtime() -> Result<tokio::runtime::Handle> {
    static RUNTIME: std::sync::OnceLock<std::result::Result<tokio::runtime::Runtime, String>> =
        std::sync::OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(
                    std::thread::available_parallelism()
                        .map_or(2, std::num::NonZeroUsize::get)
                        .clamp(2, 8),
                )
                .thread_name("centraid-seat")
                .enable_all()
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map(tokio::runtime::Runtime::handle)
        .map(Clone::clone)
        .map_err(|error| LinkError::Runtime(error.clone()))
}

impl SeatLink {
    /// Bind an endpoint for ONE replica and open that vault's byte store.
    ///
    /// `replica` is the seat file's path — it need not exist, and on a seat
    /// that has never paired it does not. The byte store is `<replica>.bytes`,
    /// per vault for the same reason everything else here is: a vault handed to
    /// someone else is handed over whole, and a sibling directory travels with
    /// the file it belongs to. It is deliberately NOT `<data-dir>/blobs`, which
    /// is the backup plane's shared artefact store.
    ///
    /// Returns as soon as the UDP socket is bound and **never waits on the
    /// network** — `Endpoint::spawn` deliberately does not call
    /// `iroh::Endpoint::online` (D-1020-C10). A shell whose first screen waited
    /// for this would show a spinner forever on a phone in aeroplane mode.
    pub fn start(replica: impl AsRef<Path>, product_version: &str) -> Result<Self> {
        // NO KEY AND NO RELAYS, because every caller of this is a LAN test
        // against a `centraid gateway --no-relay` and none is a product path —
        // a shipped seat comes through `start_with_key`, with the identity the
        // shell kept and the relay choice the shell read off the ticket.
        //
        // Relay-free is not a convenience here: a relay-mode seat waits on
        // iroh's `net_report` before its first dial, and on a machine with no
        // route to those relays that probe runs to its own timeout while the
        // ten-second connect bound expires behind it (#1025 S7,
        // `docs/traps/first-dial-readiness.md`). A suite of such tests running
        // in parallel is a suite where most of them report a gateway in the
        // same process tree as unreachable.
        Self::start_with_key(replica, product_version, None, Some(""))
    }

    /// The same, with THIS DEVICE'S ENDPOINT IDENTITY FOR THIS VAULT supplied
    /// by the shell (#1025 S5).
    ///
    /// `secret` is the private half of the key a gateway enrolled when this
    /// seat paired. Without it the endpoint mints a fresh one on every open, so
    /// a relaunched seat presents an endpoint id its gateway has never seen and
    /// is refused at admission — the defect #1025 S1 and S2 both recorded and
    /// neither closed.
    ///
    /// `None` is [`Self::start`]'s behaviour, unchanged. The key belongs in the
    /// platform's secure store and this crate will not invent a file for it:
    /// putting the one unrecoverable secret on disk beside the vault it
    /// protects, in a place no shell asked for and no backup excludes, is
    /// worse than pairing again.
    pub fn start_with_key(
        replica: impl AsRef<Path>,
        product_version: &str,
        secret: Option<[u8; 32]>,
        relay_url: Option<&str>,
    ) -> Result<Self> {
        let replica: PathBuf = replica.as_ref().to_path_buf();
        let blobs_dir = replica.with_extension("bytes");
        // ONE RUNTIME FOR THE PROCESS (#1025 S7-13). A phone holding four
        // vaults used to hold four multi-threaded runtimes — eight worker
        // threads and four executors, for four endpoints doing almost nothing
        // each. See [`shared_runtime`].
        let runtime = shared_runtime()?;
        let (endpoint, blobs) = runtime.block_on(async {
            let endpoint = Endpoint::spawn(EndpointConfig {
                // NO RELAYS IS A DEPLOYMENT, NOT A FAILURE (#1025 S7), AND THE
                // ENROLMENT RECORD IS WHAT SAYS SO (#1025 S7-13). A seat paired
                // from a ticket that names no relay has no use for one, and
                // keeping relay mode on made its FIRST DIAL wait behind a relay
                // probe — which on a network with no route to those relays runs
                // to its own timeout, past the ten-second connect bound, and
                // reports a gateway in the same room as unreachable.
                //
                // `None` is "this device does not know yet", which is a seat
                // in the middle of redeeming a ticket, and it keeps relays on:
                // guessing them off would make pairing over the internet
                // impossible. A settled record's EMPTY url is the LAN-only
                // deployment and turns them off.
                relay: match relay_url {
                    Some("") => centraid_net::endpoint::RelayMode::Disabled,
                    _ => centraid_net::endpoint::RelayMode::Default,
                },
                secret_key: secret.as_ref().map(iroh::SecretKey::from_bytes),
                ..EndpointConfig::default()
            })
            .await
            .map_err(|error| LinkError::Endpoint(format!("{error:?}")))?;
            let blobs = ByteStore::open(&blobs_dir)
                .await
                .map_err(|error| LinkError::Store(error.to_string()))?;
            Ok::<_, LinkError>((endpoint, blobs))
        })?;
        Ok(Self {
            runtime,
            endpoint,
            blobs,
            replica,
            gateway: Mutex::new(None),
            paired_connection: Mutex::new(None),
            tail_stop: crate::link::TailStop::new(),
            tail: Mutex::new(None),
            last: Arc::new(Mutex::new(None)),
            product_version: product_version.to_owned(),
        })
    }

    /// This seat's endpoint id — what lands in the gateway's allowlist.
    #[must_use]
    pub fn endpoint_id(&self) -> [u8; 32] {
        self.endpoint.id()
    }

    #[must_use]
    pub fn blobs(&self) -> &ByteStore {
        &self.blobs
    }

    /// The runtime the store's actor runs on.
    ///
    /// Handed out for ONE purpose: `centraid_blobs::ContentBytes` drives the
    /// store from synchronous command handlers, and it needs a runtime that is
    /// this store's own. A second runtime would be a second executor over one
    /// actor's channels.
    #[must_use]
    pub fn runtime(&self) -> tokio::runtime::Handle {
        self.runtime.clone()
    }

    /// The vault's byte door over THIS seat's one content store (#1025 S3).
    ///
    /// What `centraid_core::Handle::attach_bytes` takes. One store per open
    /// replica: the bytes this seat fetches are the bytes its vault locates and
    /// the bytes the gateway pulls back out of it.
    #[must_use]
    pub fn content_door(&self) -> centraid_blobs::ContentBytes {
        centraid_blobs::ContentBytes::new(self.blobs.clone(), self.runtime())
    }

    /// The gateway this seat is paired to, if any.
    #[must_use]
    pub fn gateway(&self) -> Option<PairedGateway> {
        self.gateway.lock().ok().and_then(|held| held.clone())
    }

    /// Re-adopt a gateway the shell persisted. Pairing is one-shot; this is how
    /// a seat comes back after a restart without burning another ticket.
    pub fn adopt(&self, gateway: PairedGateway) {
        if let Ok(mut held) = self.gateway.lock() {
            *held = Some(gateway);
        }
    }

    /// Redeem a pairing ticket read off a QR code.
    ///
    /// Blocks for at most [`PAIR_TIMEOUT`]. A ticket is one-shot and burned by
    /// redemption, so a timeout here is reported as a failure the member must
    /// act on — with a fresh ticket, never a retry of this one.
    pub fn pair(&self, encoded: &str, device_name: &str, platform: &str) -> Result<PairedGateway> {
        // `decode` answers `Option`: a ticket is the ONE message with no
        // handshake in front of it, so "it did not parse" carries no detail
        // worth keeping and certainly none worth showing.
        let Some(scanned) = ticket::decode(encoded.trim()) else {
            return Err(LinkError::Ticket(
                "that is not a Centraid pairing code".to_owned(),
            ));
        };
        let endpoint_id: [u8; 32] = scanned
            .gateway_endpoint
            .as_slice()
            .try_into()
            .map_err(|_| LinkError::Ticket("the ticket's endpoint is not 32 bytes".to_owned()))?;

        let answered = self.runtime.block_on(async {
            tokio::time::timeout(
                PAIR_TIMEOUT,
                pairing::redeem(&self.endpoint, &scanned, device_name, platform),
            )
            .await
        });
        let (connection, paired) = match answered {
            Ok(Ok(paired)) => paired,
            // EVERY CONNECT FAILURE IS "NOT REACHED", and none of them is a bad
            // ticket: the ticket has not been shown to anyone yet at this point.
            // `Unauthorized` included — on the PAIR lane an unenrolled peer is
            // exactly who is supposed to be calling, so it cannot mean the code
            // was wrong either.
            Ok(Err(error)) => {
                tracing::warn!(?error, "the pairing dial failed");
                return Err(LinkError::GatewayUnreachable);
            }
            Err(_) => return Err(LinkError::GatewayUnreachable),
        };
        use centraid_api_proto::core_v1::pair_response;
        let ok = match paired.result {
            Some(pair_response::Result::Ok(ok)) => ok,
            // THE REFUSAL VOCABULARY IS THREE VALUES AND CARRIES NO TEXT, on
            // purpose: a member holding a screenshot of an old QR must not
            // learn from the answer whether that ticket ever existed, so a
            // wrong secret and an unknown ticket are one code. The sentence is
            // therefore made HERE, from the code, and there is nothing else it
            // could have been made from.
            Some(pair_response::Result::Error(error)) => {
                tracing::warn!(code = error.code, "the gateway refused a ticket");
                return Err(LinkError::PairRefused {
                    expired: error.code
                        == centraid_api_proto::core_v1::PairErrorCode::ExpiredCode as i32,
                });
            }
            // An answer with no result at all. The gateway spoke and said
            // nothing, which is a refusal and not an unreachable peer.
            None => return Err(LinkError::PairRefused { expired: false }),
        };
        let gateway = PairedGateway {
            endpoint_id,
            relay_url: scanned.relay_url.clone(),
            direct_addrs: scanned.direct_addrs.clone(),
            // WHAT THE GATEWAY SAID IT ENROLLED, and not this endpoint's own id
            // (#1025 S7-13). They agree today and the point is that the device
            // is not the one asserting it: a seat that wrote down its own key
            // would be checking, at every later open, against a fact it made up
            // rather than against the allowlist row that decides.
            enrolled_public_key: ok.enrolled_public_key.clone(),
            vault_id: ok.vault_id,
            // THE GATEWAY'S NAME FOR THE VAULT, not the ticket's. A ticket is
            // minted once and read off a screen later; a vault renamed in
            // between would be shown under its old name forever.
            vault_name: if ok.vault_name.is_empty() {
                scanned.vault_name.clone()
            } else {
                ok.vault_name
            },
            // THE HEAD, IN THE ANSWER THAT CREATED THE PAIRING (#1025 S7,
            // item 5). An empty hash is a gateway that had no artifact to name;
            // the pairing still stands — the ticket is burned and this device
            // is enrolled — and the device is then paired with no file yet,
            // which is a state the shell draws.
            snapshot: (!ok.snapshot_hash.is_empty()).then(|| centraid_seat::sync::SnapshotOffer {
                hash: ok.snapshot_hash,
                seq: i64::try_from(ok.snapshot_seq).unwrap_or(0),
                bytes: ok.snapshot_bytes,
            }),
        };
        // THE CONNECTION THE REDEMPTION PROMOTED. Kept only on SUCCESS: a
        // refused ticket leaves a provisional connection the gateway is about
        // to close, and handing that to the bootstrap would turn one refusal
        // into two failures with different words.
        if let Ok(mut held) = self.paired_connection.lock() {
            *held = Some(connection);
        }
        self.adopt(gateway.clone());
        Ok(gateway)
    }

    /// The connection a redemption promoted, if one is still usable.
    ///
    /// Takes it: it is used once. A connection the gateway has closed since is
    /// discarded here rather than handed out to fail on its first stream.
    fn promoted_connection(&self) -> Option<centraid_net::IrohConnection> {
        let taken = self.paired_connection.lock().ok()?.take()?;
        // `close_reason` is `None` while the connection is live. A closed one is
        // dropped and the caller dials, which is the ordinary path anyway.
        taken.iroh().close_reason().is_none().then_some(taken)
    }

    /// Run one sync pass — rows, then writes, then bytes — inside `window`.
    ///
    /// `connection` is the SEAT'S OWN replica, handed in rather than opened
    /// here. The core holds the writable connection to that file and SQLite
    /// allows one writer; a connection opened in this crate would contend with
    /// the core for the same lock and the loser would be whichever asked
    /// second.
    ///
    /// Rows before bytes, because a row is what tells this seat a blob exists
    /// at all. A byte pass that ran first would plan over last window's rows.
    ///
    /// **ONE CONNECTION** (#1025 S2). Rows, intents and blobs are streams of it,
    /// and the byte plane's failure is still reported apart from the row
    /// plane's — a seat that got its rows and not its files is in a good state.
    pub fn sync(
        &self,
        connection: &rusqlite::Connection,
        window: centraid_core::link::SyncWindow,
        changes: &dyn centraid_seat::sync::ChangeSink,
    ) -> PassReport {
        let Some(gateway) = self.gateway() else {
            let report = PassReport::stopped(SkipReason::NotPaired);
            self.remember(&report);
            return report;
        };
        // WHAT THE SWEEP MAY NOT TAKE (#1025 S3, R25). Read from the outbox
        // BEFORE the pass, on the caller's connection, because the sweep runs
        // inside the runtime and this crate holds no connection of its own.
        // `None` IS NOT AN EMPTY PIN LIST. The failure mode of conflating them
        // is deleting the only copy of a queued photograph, so an outbox that
        // cannot be read means the sweep does not run at all and the cache
        // keeps everything for one more window.
        let pinned = match centraid_seat::outbox::pinned_blobs(connection) {
            Ok(pinned) => Some(pinned),
            Err(error) => {
                tracing::warn!(%error, "the outbox could not say which files are pinned");
                None
            }
        };
        // THE VAULT'S CLOCK, not `SystemTime::now()` inline: the text form has to
        // be the one the schema's own defaults write, or two spellings sort
        // differently in the same column (`crates/vault/src/clock.rs`).
        let now = centraid_vault::clock::Clock::now_text(&centraid_vault::clock::SystemClock);
        // ONE DEADLINE FOR THE WHOLE PASS, not one per plane. A phone is given
        // one expiry by the OS; two per-plane ceilings would add up to twice the
        // window it actually has.
        let deadline = std::time::Instant::now() + window.deadline;
        // THE SHELL'S THREE NUMBERS, HANDED TO THE ONE MACHINE (#1025 S7). The
        // byte ceilings a caller named explicitly are still this crate's to
        // apply — they are `centraid_blobs`' units and the loop has no opinion
        // on bytes — so they travel on the mover and the SITUATION travels on
        // the window.
        let pass_window = centraid_seat::sync::Window {
            deadline: Some(deadline),
            budget: which(window.budget),
            network: centraid_seat::sync::Network {
                metered: window.metered,
                // THE MEMBER'S RULE TRAVELS WITH THE LINK (#1025 S4). Two
                // facts, one struct, because "may this window fetch an
                // original" needs both and neither alone can answer it.
                originals: transfer_rule(window.originals),
            },
            // THE ONE BLOB A MEMBER TAPPED (#1025 S5), or none. It rides the
            // window rather than a call of its own, because a fetch IS a pass.
            fetch: window.fetch.map(|hash| *hash.as_bytes()),
            // THE CATCH-UP PASS IS NOT A TAIL (#1025 S2, D-1025-S7-40). It is
            // the ordinary windowed pass, over one-shot requests, and the tail
            // is opened AFTER it by the core — see `start_tail` and the note in
            // `crate::link::TailPages` about why the waiting and the applying
            // are two different threads.
            tail: false,
        };
        let ceilings = Ceilings {
            bytes: window.budget_bytes,
            items: window.budget_items,
        };
        self.runtime.block_on(async {
            let relay = (!gateway.relay_url.is_empty()).then_some(gateway.relay_url.as_str());
            // THE PAIRING'S OWN CONNECTION, when a bootstrap has not already
            // spent it (#1025 S3, D-1025-S3-4). `Ok(Ok(_))` so the two arms
            // below read the same either way.
            let dialled = match self.promoted_connection() {
                Some(promoted) => Ok(Ok(promoted)),
                None => {
                    tokio::time::timeout(
                        window.deadline,
                        self.endpoint.connect(
                            gateway.endpoint_id,
                            relay,
                            &gateway.direct_addrs,
                            alpn::PLANE,
                        ),
                    )
                    .await
                }
            };
            let connection_to_gateway = match dialled {
                // NOT REACHED AT ALL. Every plane is untouched and the seat is
                // stale, which is a state and not a fault. ONE construction
                // site for the shape (`PassReport::stopped`), because four
                // spellings of "nothing happened" is what this report deletes.
                Ok(Err(error)) => {
                    tracing::warn!(detail = ?error, "the gateway did not answer");
                    let report = PassReport::stopped(SkipReason::Unreachable);
                    self.remember(&report);
                    return report;
                }
                Err(_) => {
                    tracing::warn!("the window ended before the gateway answered");
                    let report = PassReport::stopped(SkipReason::CutBeforeReaching);
                    self.remember(&report);
                    return report;
                }
                Ok(Ok(connection_to_gateway)) => connection_to_gateway,
            };

            if let Err(why) =
                crate::link::handshake(&connection_to_gateway, &self.product_version).await
            {
                tracing::warn!(detail = %why, "the gateway refused this build");
                let report = PassReport::stopped(SkipReason::HandshakeRefused);
                self.remember(&report);
                return report;
            }

            // THE OTHER HALF OF THE SYMMETRIC LOOP, for the length of the pass.
            // The gateway may open streams on the connection this seat dialled;
            // today it asks for blobs (S3's pull), and a seat that never
            // accepted would leave those opens hanging. Aborted with the pass,
            // because the connection goes with it.
            let serving = {
                let blobs = self.blobs.clone();
                let connection_to_gateway = connection_to_gateway.clone();
                tokio::spawn(async move {
                    crate::serve::accept_streams(&connection_to_gateway, blobs).await;
                })
            };

            // THE THREE PLANES, AS ONE MACHINE. Two borrows of the one
            // connection for the log source and the intent sink, because they
            // cannot be the same borrow — which is exactly what one stream per
            // connection could not give it, and why the sink was shut — and a
            // third for the bytes.
            let mut source = GatewayLink::over(&connection_to_gateway);
            let mut sink = GatewayLink::over(&connection_to_gateway);
            let mut mover = GatewayBytes {
                store: &self.blobs,
                connection: connection_to_gateway.iroh(),
                ceilings,
                pinned,
            };
            let mut report = match tokio::time::timeout(
                // THE BACKSTOP IS STILL THE WINDOW'S, and a tail is inside it:
                // the tail's own reader holds the same deadline and closes the
                // stream at it, so this stays what it has always been — the
                // guard for an await that never returned.
                window.deadline + DEADLINE_GRACE,
                centraid_seat::sync::sync(
                    connection,
                    &mut source,
                    &mut sink,
                    &mut mover,
                    &now,
                    pass_window,
                    changes,
                ),
            )
            .await
            {
                Ok(Ok(pass)) => pass,
                Ok(Err(error)) => {
                    tracing::warn!(%error, "the pass could not read this seat's replica");
                    PassReport::stopped(SkipReason::LogUnreadable)
                }
                // THE BACKSTOP FIRED. See `DEADLINE_GRACE`: the inner check
                // should have ended the pass with a report, so reaching here
                // means one await never returned. What landed is still durable;
                // what is lost is the accounting.
                Err(_) => {
                    tracing::warn!("the pass ran out of window and its accounting is lost");
                    let mut cut = PassReport::stopped(SkipReason::NotRun);
                    cut.rows = centraid_seat::sync::Stage::Cut(Default::default());
                    cut
                }
            };

            // THE EVICTION SWEEP, AFTER THE FETCHING AND BEFORE THE CONNECTION
            // GOES (#1025 S3, R25). Last, because a window that has just landed
            // four hundred thumbnails is exactly when the store is over budget,
            // and a sweep that ran first would measure the wrong store.
            //
            // It takes nothing an unsettled outbox intent names. Those bytes
            // are the ONE copy of a write the member has already made: the
            // gateway has not got them — that is why the intent is still
            // queued — so evicting them loses the photograph, and no later
            // window can recover it.
            serving.abort();
            // The connection is dropped only now: QUIC discards stream data the
            // peer has not read, and the pass reads until its last answer
            // (D-1020-G10).
            drop(connection_to_gateway);
            report.behind = report.behind.max(0);
            self.remember(&report);
            report
        })
    }

    /// Take a fresh copy of the vault and make it this seat's replica.
    ///
    /// **Nothing may hold the replica file open.** The publication is a rename
    /// over `self.replica`, and a SQLite connection that survived it would go
    /// on reading the inode that is no longer there. `centraid_core::Handle`
    /// closes its vault around this call, which is why the lifecycle lives
    /// there.
    ///
    /// ONE CONNECTION, AND IT MAY BE THE ONE THAT PAIRED (#1025 S2, S3). The
    /// blob rides a `blob` stream of the connection a redemption promoted
    /// moments ago, so a member's first screen costs one QUIC setup and one
    /// hole-punch rather than two. There is no `snapshot_head` round trip in
    /// front of it any more: the offer arrived on `PairOk` (#1025 S7, item 5).
    ///
    /// `adopt` is the foreground/background decision — see
    /// `centraid_core::link::SeatNetwork::bootstrap`.
    pub fn bootstrap(
        &self,
        offer: &centraid_seat::sync::SnapshotOffer,
        adopt: bool,
    ) -> std::result::Result<centraid_seat::sync::BootstrapMoved, BootstrapRefusal> {
        let Some(gateway) = self.gateway() else {
            return Err(BootstrapRefusal::NotPaired);
        };
        let relay = (!gateway.relay_url.is_empty()).then(|| gateway.relay_url.clone());
        // THE PAIRING RECORD, WRITTEN INTO THE FILE THE ADOPTION LANDS
        // (#1025 S7, item 3). Before this there is no replica to hold it, which
        // is why the shell keeps it in the secure store until now — a device
        // that paired and could not take its copy still knows where to dial.
        let record = centraid_seat::PairedGateway {
            endpoint_id: centraid_core::link::hex_lower(&gateway.endpoint_id),
            relay_url: gateway.relay_url.clone(),
            direct_addrs: gateway.direct_addrs.clone(),
            vault_id: gateway.vault_id.clone(),
            vault_name: gateway.vault_name.clone(),
            device_id: String::new(),
        };
        self.runtime.block_on(async {
            // THE CONNECTION THE PAIRING PROMOTED, when there is one. A phone
            // taps "pair" and then bootstraps within the same second, and the
            // connection from the first is already open, already hole-punched
            // and already promoted.
            let connection_to_gateway = match self.promoted_connection() {
                Some(promoted) => promoted,
                None => self
                    .endpoint
                    .connect(
                        gateway.endpoint_id,
                        relay.as_deref(),
                        &gateway.direct_addrs,
                        alpn::PLANE,
                    )
                    .await
                    .map_err(|error| {
                        tracing::warn!(detail = ?error, "the gateway did not answer");
                        BootstrapRefusal::Unreachable
                    })?,
            };
            crate::link::handshake(&connection_to_gateway, &self.product_version)
                .await
                .map_err(|why| {
                    tracing::warn!(detail = %why, "the gateway refused this build");
                    BootstrapRefusal::Unreachable
                })?;
            let landing = crate::bootstrap::install(
                &self.blobs,
                connection_to_gateway.iroh(),
                offer,
                &gateway.vault_id,
                &self.replica,
                Some(&record),
                adopt,
            )
            .await;
            // The connection is dropped only now: QUIC discards stream data the
            // peer has not read (D-1020-G10).
            drop(connection_to_gateway);
            landing
        })
    }

    /// ASK THE GATEWAY WHAT COPY IT WOULD GIVE THIS DEVICE (#1025 S7, item 5).
    ///
    /// One dial, one stream, one `log` request from a cursor this seat does not
    /// have — and the gateway's refusal IS the answer, because a
    /// `RebootstrapRequired` carries the head. There is no `snapshot_head`
    /// request and this is not one: it is the conversation a seat under the
    /// floor already has, used by the one state that has no other way to find
    /// out (paired, and no file yet).
    pub fn ask_for_an_offer(&self) -> Option<centraid_seat::sync::SnapshotOffer> {
        let gateway = self.gateway()?;
        let relay = (!gateway.relay_url.is_empty()).then(|| gateway.relay_url.clone());
        self.runtime.block_on(async {
            let connection_to_gateway = match self.promoted_connection() {
                Some(promoted) => promoted,
                None => self
                    .endpoint
                    .connect(
                        gateway.endpoint_id,
                        relay.as_deref(),
                        &gateway.direct_addrs,
                        alpn::PLANE,
                    )
                    .await
                    .inspect_err(|error| {
                        tracing::warn!(detail = ?error, "the gateway did not answer");
                    })
                    .ok()?,
            };
            crate::link::handshake(&connection_to_gateway, &self.product_version)
                .await
                .inspect_err(|why| {
                    tracing::warn!(detail = %why, "the gateway refused this build");
                })
                .ok()?;
            let mut source = GatewayLink::over(&connection_to_gateway);
            // FROM NOTHING, WHICH IS THE POINT. `since: 0` is sent as an absent
            // cursor and a gateway with a pruned log answers a re-bootstrap; a
            // gateway whose log still reaches the floor answers a PAGE, which
            // is a seat that could have tailed from zero and is not the state
            // this call is for.
            let outcome = {
                use centraid_seat::sync::LogSource as _;
                source.fetch("", 0, 1).await
            };
            drop(connection_to_gateway);
            match outcome {
                centraid_seat::sync::FetchOutcome::RebootstrapRequired { snapshot, .. } => snapshot,
                _ => None,
            }
        })
    }

    /// Take the copy this gateway last OFFERED.
    ///
    /// The offer arrived on `PairOk` and is remembered with the pairing. A seat
    /// that has none is refused by name rather than fetching nothing quietly:
    /// "this gateway offered no copy" and "this device is not paired" are
    /// different states with different remedies, and both are shapes a phone is
    /// really in.
    pub fn bootstrap_offered(
        &self,
        adopt: bool,
    ) -> std::result::Result<centraid_seat::sync::BootstrapMoved, BootstrapRefusal> {
        let offer = self
            .gateway()
            .and_then(|gateway| gateway.snapshot)
            .or_else(|| self.ask_for_an_offer())
            .ok_or(BootstrapRefusal::NothingOffered)?;
        self.bootstrap(&offer, adopt)
    }

    /// Whether this seat holds a replica at all.
    #[must_use]
    pub fn is_bootstrapped(&self) -> bool {
        crate::bootstrap::is_bootstrapped(&self.replica)
    }

    fn remember(&self, report: &PassReport) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(report.clone());
        }
    }

    /// The last pass's report, for a shell that wants to draw a badge without
    /// running one.
    #[must_use]
    pub fn last_pass(&self) -> Option<PassReport> {
        self.last.lock().ok().and_then(|held| held.clone())
    }

    /// Stop dialling and release the socket.
    ///
    /// What a backgrounded phone does: an endpoint with no socket cannot be the
    /// reason the radio is awake (D-1020-C14).
    /// CLOSE THE TAIL THIS LINK IS HOLDING, if it is holding one (#1025 S2).
    ///
    /// What the shell calls when the foreground is lost, the device locks, or a
    /// bounded background round is over. A no-op when no tail is open, which is
    /// the ordinary case and not worth a refusal: "stop" is an instruction
    /// about a state, and the state it names is already true.
    ///
    /// Safe from any thread and never blocks on the pass — that is the whole
    /// reason the stop is a flag and a wake rather than a message into the
    /// runtime.
    pub fn stop_tail(&self) {
        self.tail_stop.stop();
        let held = self
            .tail
            .lock()
            .ok()
            .and_then(|mut held| held.take());
        if let Some(run) = held {
            run.pages.close();
            run.reader.abort();
            run.serving.abort();
            // THE CONNECTION GOES LAST, and dropping it is what unregisters
            // this seat's tail on the gateway: the stream resets, the write
            // fails, and the task serving it ends.
            drop(run.connection);
        }
    }

    /// OPEN A TAIL FROM `since`, and leave a task reading it (#1025 S2,
    /// D-1025-S7-40).
    ///
    /// Dials, handshakes, asks for the log with `tail` set, and spawns the
    /// reader. Returns `false` when there is nothing to tail — no gateway, no
    /// answer, a refusal — which is a state and not a failure: the next window
    /// asks again.
    ///
    /// **It holds no vault and takes no lock the rest of the core wants.** The
    /// caller is `centraid_core::Handle::sync_now`, standing outside its own
    /// vault mutex, and everything below runs on this link's runtime.
    pub fn start_tail(&self, epoch: &str, since: i64, deadline: std::time::Instant) -> bool {
        if self.tail_is_open() {
            return true;
        }
        let Some(gateway) = self.gateway() else {
            return false;
        };
        // ARMED HERE, at the start of a tail: a stop pulled to close the LAST
        // window must not close this one before it opens.
        self.tail_stop.arm();
        let stop = Arc::clone(&self.tail_stop);
        let blobs = self.blobs.clone();
        let product_version = self.product_version.clone();
        let epoch = epoch.to_owned();
        let opened = self.runtime.block_on(async move {
            let relay = (!gateway.relay_url.is_empty()).then_some(gateway.relay_url.as_str());
            let dialled = tokio::time::timeout(
                crate::link::TAIL_DIAL_TIMEOUT,
                self.endpoint.connect(
                    gateway.endpoint_id,
                    relay,
                    &gateway.direct_addrs,
                    alpn::PLANE,
                ),
            )
            .await;
            let connection = match dialled {
                Ok(Ok(connection)) => connection,
                Ok(Err(error)) => {
                    tracing::warn!(detail = ?error, "the gateway did not answer a tail");
                    return None;
                }
                Err(_) => {
                    tracing::warn!("the gateway did not answer a tail in time");
                    return None;
                }
            };
            if let Err(why) = crate::link::handshake(&connection, &product_version).await {
                tracing::warn!(detail = %why, "the gateway refused this build on a tail");
                return None;
            }
            let recv = match crate::link::ask_to_tail(&connection, &epoch, since).await {
                Ok(recv) => recv,
                Err(why) => {
                    tracing::warn!(detail = %why, "the tail stream would not open");
                    return None;
                }
            };
            let pages = crate::link::TailPages::new();
            let reader = tokio::spawn(crate::link::read_tail(
                recv,
                Arc::clone(&pages),
                stop,
                Some(deadline),
            ));
            // THE OTHER HALF OF THE SYMMETRIC LOOP, for the tail's length. The
            // gateway may open `blob` streams on the connection this seat
            // dialled, and a seat that never accepted would leave those opens
            // hanging.
            let serving = {
                let connection = connection.clone();
                tokio::spawn(async move {
                    crate::serve::accept_streams(&connection, blobs).await;
                })
            };
            Some(TailRun {
                connection,
                pages,
                reader,
                serving,
            })
        });
        let Some(run) = opened else {
            return false;
        };
        if let Ok(mut held) = self.tail.lock() {
            *held = Some(run);
            return true;
        }
        false
    }

    /// Whether a tail is open right now.
    #[must_use]
    pub fn tail_is_open(&self) -> bool {
        self.tail
            .lock()
            .is_ok_and(|held| held.as_ref().is_some_and(|run| !run.reader.is_finished()))
    }

    /// WAIT — WITH NOTHING HELD — until this tail has a page to apply.
    ///
    /// `false` means there will be no more: the gateway closed, the deadline
    /// arrived, or the shell pulled the stop. **This is the only place a tail
    /// blocks**, and it is deliberately outside the vault: a wait inside one is
    /// a grid on a spinner that killing the gateway does not release.
    pub fn await_tail_page(&self, until: std::time::Instant) -> bool {
        let pages = {
            let Ok(held) = self.tail.lock() else {
                return false;
            };
            match held.as_ref() {
                Some(run) => Arc::clone(&run.pages),
                None => return false,
            }
        };
        self.runtime.block_on(pages.wait(Some(until)))
    }

    /// APPLY WHAT THE TAIL HAS ALREADY DELIVERED, and nothing else.
    ///
    /// One pass of the one machine over a queue-backed source: the rows that
    /// are in hand, the outbox, and the byte plane for what those rows name —
    /// over the TAIL'S OWN connection, because a second dial per commit would
    /// make a photograph's arrival cost a hole-punch. It returns the moment the
    /// queue is empty, which is what keeps the vault free between pages.
    pub fn apply_tail(
        &self,
        connection: &rusqlite::Connection,
        window: centraid_core::link::SyncWindow,
        changes: &dyn centraid_seat::sync::ChangeSink,
    ) -> PassReport {
        let (pages, gateway_connection) = {
            let Ok(held) = self.tail.lock() else {
                return PassReport::stopped(SkipReason::Unreachable);
            };
            match held.as_ref() {
                Some(run) => (Arc::clone(&run.pages), run.connection.clone()),
                None => return PassReport::stopped(SkipReason::Unreachable),
            }
        };
        let pinned = match centraid_seat::outbox::pinned_blobs(connection) {
            Ok(pinned) => Some(pinned),
            Err(error) => {
                tracing::warn!(%error, "the outbox could not say which files are pinned");
                None
            }
        };
        let now = centraid_vault::clock::Clock::now_text(&centraid_vault::clock::SystemClock);
        let pass_window = centraid_seat::sync::Window {
            deadline: Some(std::time::Instant::now() + window.deadline),
            budget: which(window.budget),
            network: centraid_seat::sync::Network {
                metered: window.metered,
                // THE MEMBER'S RULE TRAVELS WITH THE LINK (#1025 S4). Two
                // facts, one struct, because "may this window fetch an
                // original" needs both and neither alone can answer it.
                originals: transfer_rule(window.originals),
            },
            fetch: window.fetch.map(|hash| *hash.as_bytes()),
            // THE ROW STAGE DOES NOT END AT THE FIRST PAGE. It drains every
            // page the reader has delivered and runs the byte stage after each,
            // then returns because the queue is empty — never because it waited.
            tail: true,
        };
        let ceilings = Ceilings {
            bytes: window.budget_bytes,
            items: window.budget_items,
        };
        self.runtime.block_on(async {
            let mut source = crate::link::QueuedTail::over(pages);
            let mut sink = GatewayLink::over(&gateway_connection);
            let mut mover = GatewayBytes {
                store: &self.blobs,
                connection: gateway_connection.iroh(),
                ceilings,
                pinned,
            };
            let report = match centraid_seat::sync::sync(
                connection,
                &mut source,
                &mut sink,
                &mut mover,
                &now,
                pass_window,
                changes,
            )
            .await
            {
                Ok(report) => report,
                Err(error) => {
                    tracing::warn!(%error, "a tail step could not read this seat's replica");
                    PassReport::stopped(SkipReason::LogUnreadable)
                }
            };
            self.remember(&report);
            report
        })
    }

    pub fn idle(&self) {
        self.runtime.block_on(self.endpoint.idle());
    }

    /// Bind again after [`Self::idle`]. The endpoint id survives, because it is
    /// the public half of a key that was never dropped — so every gateway that
    /// enrolled this seat still recognises it.
    pub fn resume(&self) -> Result<()> {
        self.runtime
            .block_on(self.endpoint.resume())
            .map_err(|error| LinkError::Endpoint(format!("{error:?}")))
    }
}

/// The byte budget a window asks for.
///
/// `foreground` used to be attached to EVERY pass core-ffi ever ran, which was
/// the wrong default in one direction (a metered phone) and unreachable in the
/// other (a night shift). The shell now names which of `crates/blobs`'s three
/// windows this is, and `foreground` survives as what an unnamed selector
/// means — which is the only case it was ever right for.
///
/// THE EXPLICIT NUMBERS STILL WIN. A caller with a real ceiling — the OS told
/// it, or a test wants one — keeps it; the selector is for a caller that knows
/// only its situation. Ordering them the other way would make the selector a
/// thing that silently overrode a number somebody measured.
///
/// `metered` is applied LAST and is not a number at all: it removes the
/// originals from the plan (`Budget::metered`). A ceiling could not have done
/// it, because the planner admits an item larger than the whole budget on
/// purpose.
/// The pass's own spelling of a shell's budget selector.
///
/// One conversion, here, so `centraid_core`'s enum and the loop's cannot drift
/// into two ladders that are ordered differently.
const fn which(budget: centraid_core::link::SyncBudget) -> centraid_seat::sync::Budget {
    match budget {
        centraid_core::link::SyncBudget::ShortRefresh => centraid_seat::sync::Budget::ShortRefresh,
        centraid_core::link::SyncBudget::NightShift => centraid_seat::sync::Budget::NightShift,
        centraid_core::link::SyncBudget::Foreground => centraid_seat::sync::Budget::Foreground,
    }
}

/// THE MEMBER'S TRANSFER RULE, converted once (#1025 S4).
///
/// The same reason `which` exists: `centraid_seat`'s spelling and
/// `centraid_blobs`' are two enums naming one decision, and one conversion in
/// one place is what keeps them from becoming two rules.
const fn transfer_rule(
    rule: centraid_core::link::TransferRule,
) -> centraid_seat::sync::TransferRule {
    use centraid_core::link::TransferRule as Core;
    use centraid_seat::sync::TransferRule as Seat;
    match rule {
        Core::WifiOnly => Seat::WifiOnly,
        Core::WifiAndCellularPhotos => Seat::WifiAndCellularPhotos,
        Core::Manual => Seat::Manual,
    }
}

const fn rule(rule: centraid_seat::sync::TransferRule) -> centraid_blobs::OriginalsRule {
    use centraid_blobs::OriginalsRule as Blobs;
    use centraid_seat::sync::TransferRule as Seat;
    match rule {
        Seat::WifiOnly => Blobs::WifiOnly,
        Seat::WifiAndCellularPhotos => Blobs::WifiAndCellularPhotos,
        Seat::Manual => Blobs::Manual,
    }
}

fn budget_from(
    selector: centraid_seat::sync::Budget,
    network: centraid_seat::sync::Network,
    fetch: Option<[u8; 32]>,
    ceilings: Ceilings,
) -> Budget {
    use centraid_seat::sync::Budget as Which;
    let chosen = match selector {
        Which::ShortRefresh => Budget::short_refresh(),
        Which::NightShift => Budget::night_shift(),
        Which::Foreground => Budget::foreground(),
    };
    let budget = Budget {
        bytes: ceilings.bytes.unwrap_or(chosen.bytes),
        items: ceilings.items.unwrap_or(chosen.items),
        metered: network.metered,
        originals: rule(network.originals),
        // THE MEMBER TAPPED ONE (#1025 S5). It is set LAST because it
        // overrides everything above it for that one blob — which is what the
        // download arrow means — and setting it anywhere else would leave a
        // reader guessing which of the two wins.
        only: fetch.map(centraid_blobs::ContentHash::from_bytes),
    };
    budget
}

/// THE BYTE CEILINGS A CALLER NAMED EXPLICITLY.
///
/// Separate from `centraid_seat::sync::Window` on purpose: bytes and item
/// counts are `centraid_blobs`' units, and the loop has no opinion on them. The
/// SITUATION — which of the three windows this is, and whether the link is
/// metered — travels on the window; the numbers travel here.
#[derive(Debug, Clone, Copy, Default)]
struct Ceilings {
    bytes: Option<u64>,
    items: Option<usize>,
}

/// THE BYTE PLANE, AS A STAGE OF THE ONE MACHINE (#1025 S7).
///
/// It used to be a second loop the caller sequenced after `pass`, with a report
/// of its own that `SeatLink::sync` stitched on — which is how the byte plane
/// came to have four booleans on `SyncOutcome` and no way to say "this device
/// already holds everything". Now the machine in `centraid_seat::sync` asks for
/// the bytes in its own order, and this is the answer.
///
/// The eviction sweep is HERE and not in the caller, for the same reason: it is
/// the byte plane's own end-of-window work, and a sweep the report could not
/// mention was a number that died between two loops.
struct GatewayBytes<'a> {
    store: &'a ByteStore,
    connection: &'a centraid_net::endpoint::RawConnection,
    ceilings: Ceilings,
    /// What the sweep may not take. `None` IS NOT AN EMPTY PIN LIST — the
    /// failure mode of conflating them is deleting the only copy of a queued
    /// photograph, so an unreadable outbox means no sweep at all.
    pinned: Option<Vec<String>>,
}

impl ByteMover for GatewayBytes<'_> {
    fn move_bytes<'a>(
        &'a mut self,
        needs: &'a [centraid_seat::BlobNeed],
        window: Window,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ByteOutcome> + 'a>> {
        Box::pin(async move {
            let budget = budget_from(window.budget, window.network, window.fetch, self.ceilings);
            let report = crate::bytes::byte_pass(
                self.store,
                self.connection,
                needs,
                budget,
                window.deadline,
            )
            .await;
            let (swept, evicted) = match &self.pinned {
                Some(pinned) => match sweep(self.store, pinned).await {
                    Some((swept, taken)) => (
                        Some(Swept {
                            held: swept.held,
                            pinned: swept.pinned,
                            evicted: swept.evicted,
                            freed: swept.freed,
                            over_budget_by: swept.over_budget_by,
                        }),
                        taken.iter().map(|hash| hash.to_hex()).collect::<Vec<_>>(),
                    ),
                    None => (None, Vec::new()),
                },
                None => (None, Vec::new()),
            };
            ByteOutcome {
                planned: report.planned,
                completed: report.completed,
                moved: report.moved,
                deferred: report.deferred,
                refused: report.refused,
                unaddressable: report.unaddressable,
                withheld: report.withheld,
                arrived: report.landed,
                evicted,
                cut: report.cut_by_the_deadline,
                stalled: report.stalled.is_some(),
                swept,
            }
        })
    }
}

/// Free the cache down to [`CACHE_BUDGET_BYTES`], keeping every pin.
///
/// `None` when the store could not be read, which is different from a sweep
/// that freed nothing: the first is "we do not know what is here" and the
/// second is "what is here fits".
async fn sweep(
    store: &ByteStore,
    pinned: &[String],
) -> Option<(centraid_blobs::Sweep, Vec<centraid_blobs::ContentHash>)> {
    let pins: std::collections::HashSet<centraid_blobs::ContentHash> = pinned
        .iter()
        .filter_map(|hex| centraid_blobs::ContentHash::parse_hex(hex).ok())
        .collect();
    match store.sweep(&pins, CACHE_BUDGET_BYTES).await {
        Ok((swept, taken)) => {
            if swept.over_budget_by > 0 {
                // NOT A LICENCE TO EVICT A PIN. Reported so a storage screen
                // can say a queued write is holding the space, which is a
                // sentence a member can act on.
                tracing::info!(
                    over = swept.over_budget_by,
                    "queued writes hold more bytes than the cache budget"
                );
            }
            Some((swept, taken))
        }
        Err(error) => {
            tracing::warn!(%error, "the byte store could not be swept");
            None
        }
    }
}

/// HOW MANY BYTES OF UNPINNED CACHE THIS SEAT KEEPS.
///
/// 256 MiB, which is v0's `OFFLINE_CONTENT_BUDGET_BYTES`
/// (`docs/blueprint-seats.md`) carried over unchanged. It governs the UNPINNED
/// remainder only: the pins are subtracted before anything is ordered, so a
/// store over budget because of queued writes reports how far over rather than
/// breaking the promise (`ByteStore::sweep`).
///
/// A constant here and not a window field, deliberately. A budget is how much
/// of this device's disk a vault may use, which is a property of the vault's
/// custody and not of the thirty seconds iOS just handed this process; the
/// per-window numbers that ARE the OS's are `SyncWindow`'s.
const CACHE_BUDGET_BYTES: u64 = 256 * 1024 * 1024;

/// The core's network seam, implemented (#1020, D-1020-B7).
///
/// `centraid_core` declares [`centraid_core::link::SeatNetwork`] and cannot
/// depend on this crate — this crate depends on it, to decode a page. So the
/// core holds a `Box<dyn SeatNetwork>` and the process builder attaches one:
/// `crates/core-ffi` for a phone, `crates/centraid` for a desktop seat.
impl centraid_core::link::SeatNetwork for SeatLink {
    fn endpoint_id(&self) -> [u8; 32] {
        Self::endpoint_id(self)
    }

    fn pair(
        &self,
        encoded: &str,
        device_name: &str,
        platform: &str,
    ) -> std::result::Result<centraid_core::link::PairedGateway, centraid_core::link::PairRefusal>
    {
        use centraid_core::link::PairRefusal;
        match Self::pair(self, encoded, device_name, platform) {
            Ok(gateway) => Ok(centraid_core::link::PairedGateway {
                endpoint_id: gateway.endpoint_id.to_vec(),
                // THE HINTS TRAVEL WITH THE PAIRING (#1025 S5). They are what
                // the core writes into the replica, and a pairing recorded
                // without them is a seat that can only ever reach its gateway
                // through a relay.
                relay_url: gateway.relay_url,
                direct_addrs: gateway.direct_addrs,
                enrolled_public_key: gateway.enrolled_public_key,
                vault_id: gateway.vault_id,
                vault_name: gateway.vault_name,
                // THE GATEWAY'S `PairOk.device_id` IS NOT KEPT HERE YET. An
                // empty string is the honest answer rather than this seat's own
                // endpoint id wearing the gateway's label: the two are
                // different identifiers and a shell that persisted one as the
                // other would send the wrong thing to a device list.
                device_id: String::new(),
                snapshot: gateway.snapshot,
            }),
            Err(LinkError::Ticket(_)) => Err(PairRefusal::NotATicket),
            Err(LinkError::GatewayUnreachable) => Err(PairRefusal::Unreachable),
            Err(LinkError::PairRefused { expired: true }) => Err(PairRefusal::Expired),
            Err(LinkError::PairRefused { expired: false }) => Err(PairRefusal::Refused),
            // A runtime, endpoint or store failure. The member could not have
            // caused it and a new code will not fix it, so it reads as "not
            // reached" rather than as a rejected ticket.
            Err(_) => Err(PairRefusal::Unreachable),
        }
    }

    fn bootstrap(
        &self,
        offer: &centraid_seat::sync::SnapshotOffer,
        adopt: bool,
    ) -> std::result::Result<centraid_seat::sync::BootstrapMoved, BootstrapRefusal> {
        let taken = Self::bootstrap(self, offer, adopt);
        if let Ok(moved) = &taken {
            tracing::info!(
                seq = moved.seq,
                bytes = moved.bytes_fetched,
                adopted = adopt,
                "a fresh copy of the vault landed"
            );
        }
        taken
    }

    fn offer(&self) -> Option<centraid_seat::sync::SnapshotOffer> {
        Self::ask_for_an_offer(self)
    }

    fn gateway(&self) -> Option<centraid_core::link::PairedGateway> {
        Self::gateway(self).map(|gateway| centraid_core::link::PairedGateway {
            endpoint_id: gateway.endpoint_id.to_vec(),
            vault_id: gateway.vault_id,
            vault_name: gateway.vault_name,
            device_id: String::new(),
            relay_url: gateway.relay_url,
            direct_addrs: gateway.direct_addrs,
            snapshot: gateway.snapshot,
            enrolled_public_key: gateway.enrolled_public_key,
        })
    }

    /// TAKE BACK A PAIRING THE REPLICA REMEMBERED (#1025 S5).
    ///
    /// This is what `SeatLink::adopt`'s doc comment always described and what
    /// nothing in the product ever called: its only caller in the whole tree
    /// was a test, so a reopened seat had no gateway, and `Self::sync` refuses
    /// outright without one — the seat reported itself unreachable having never
    /// dialled, which is why the gateway's log showed no attempt at all.
    ///
    /// AN ENDPOINT ID THAT IS NOT 32 BYTES IS IGNORED rather than truncated: a
    /// half id is a peer that does not exist, and adopting it would turn a
    /// readable bad row into a dial that fails far from the cause.
    fn adopt(&self, gateway: centraid_core::link::PairedGateway) {
        let Ok(endpoint_id) = <[u8; 32]>::try_from(gateway.endpoint_id.as_slice()) else {
            tracing::warn!("a remembered gateway's endpoint id is not 32 bytes; not adopted");
            return;
        };
        Self::adopt(
            self,
            PairedGateway {
                endpoint_id,
                relay_url: gateway.relay_url,
                direct_addrs: gateway.direct_addrs,
                vault_id: gateway.vault_id,
                vault_name: gateway.vault_name,
                snapshot: gateway.snapshot,
                enrolled_public_key: gateway.enrolled_public_key,
            },
        );
    }

    /// WHAT THE STORE HOLDS, FOR THE TABLE THAT PROJECTS IT (#1025,
    /// D-1025-S7-20).
    ///
    /// One `complete_hashes` round trip and a `stat` per blob, on this link's
    /// own runtime. `None` only when the store cannot answer at all, which is
    /// not the same as an empty store: the caller leaves a correct table alone
    /// rather than clearing it on the one occasion nobody could measure it.
    fn held_blobs(&self) -> Option<Vec<centraid_seat::HeldBlob>> {
        let held = self
            .runtime
            .block_on(async { self.blobs.held_files().await })
            .map_err(|error| {
                tracing::warn!(%error, "the byte store could not say what it holds");
            })
            .ok()?;
        Some(
            held.into_iter()
                .map(|(hash, path, byte_size)| centraid_seat::HeldBlob {
                    hash: hash.to_hex(),
                    path: path.to_string_lossy().into_owned(),
                    byte_size: i64::try_from(byte_size).unwrap_or(i64::MAX),
                })
                .collect(),
        )
    }

    /// THE PASS, AND NOTHING ADDED TO IT (#1025 S7).
    ///
    /// This used to flatten the two reports it had into a dozen fields, and
    /// every one of them was a decision made twice — once here and once in the
    /// shell that read them. There is one report now, it comes out of the one
    /// machine, and this seam carries it up unchanged. `centraid_core` projects
    /// it; nothing computes it.
    fn sync(
        &self,
        connection: &rusqlite::Connection,
        window: centraid_core::link::SyncWindow,
        changes: &dyn centraid_seat::sync::ChangeSink,
    ) -> PassReport {
        Self::sync(self, connection, window, changes)
    }

    fn tail_stopper(&self) -> Option<Arc<dyn centraid_core::link::TailStopper>> {
        Some(Arc::clone(&self.tail_stop) as Arc<dyn centraid_core::link::TailStopper>)
    }

    fn start_tail(&self, epoch: &str, since: i64, deadline: std::time::Instant) -> bool {
        Self::start_tail(self, epoch, since, deadline)
    }

    fn tail_is_open(&self) -> bool {
        Self::tail_is_open(self)
    }

    fn await_tail_page(&self, until: std::time::Instant) -> bool {
        Self::await_tail_page(self, until)
    }

    fn apply_tail(
        &self,
        connection: &rusqlite::Connection,
        window: centraid_core::link::SyncWindow,
        changes: &dyn centraid_seat::sync::ChangeSink,
    ) -> PassReport {
        Self::apply_tail(self, connection, window, changes)
    }

    fn idle(&self) {
        Self::idle(self);
    }

    fn resume(&self) -> std::result::Result<(), String> {
        Self::resume(self).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_blobs::{ContentHash, Tier, Want};
    use centraid_core::link::SyncBudget;

    /// A link the shell described, with the member's DEFAULT rule on it. The
    /// tests that are about the rule name their own.
    pub(super) fn over(metered: bool) -> centraid_seat::sync::Network {
        centraid_seat::sync::Network {
            metered,
            originals: centraid_seat::sync::TransferRule::WifiOnly,
        }
    }

    /// THE SHELL CHOOSES, AND THE THREE CHOICES ARE THREE WINDOWS (#1025 S5).
    ///
    /// `Budget::foreground()` was attached to every pass `core-ffi` ever ran,
    /// so a thirty-second cellular refresh and a night on the charger spent the
    /// same. The three shapes existed in `crates/blobs` the whole time and
    /// nothing could pick between them.
    #[test]
    fn each_selector_reaches_its_own_budget() {
        assert_eq!(
            budget_from(
                which(SyncBudget::ShortRefresh),
                over(false),
                None,
                Ceilings::default(),
            ),
            Budget::short_refresh()
        );
        assert_eq!(
            budget_from(
                which(SyncBudget::NightShift),
                over(false),
                None,
                Ceilings::default(),
            ),
            Budget::night_shift()
        );
        assert_eq!(
            budget_from(
                which(SyncBudget::Foreground),
                over(false),
                None,
                Ceilings::default(),
            ),
            Budget::foreground()
        );
        // And they really are different windows, which is the point.
        assert_ne!(Budget::short_refresh().bytes, Budget::night_shift().bytes);
    }

    /// A NUMBER THE CALLER MEASURED BEATS A SITUATION IT NAMED. The selector is
    /// for a shell that knows only which window it is in; a caller with the
    /// OS's own ceiling keeps it.
    #[test]
    fn an_explicit_ceiling_overrides_the_selector() {
        let budget = budget_from(
            which(SyncBudget::NightShift),
            over(false),
            None,
            Ceilings {
                bytes: Some(1_024),
                items: Some(7),
            },
        );
        assert_eq!(budget.bytes, 1_024);
        assert_eq!(budget.items, 7);
    }

    /// A SENTINEL DEADLINE IS ARITHMETIC, NOT A PANIC (#1025 S5).
    ///
    /// A shell with no expiry sends one — `Long.MAX_VALUE` milliseconds, about
    /// 292 million years — and this module does three things with that number
    /// that could each have overflowed: `Instant::now() + deadline` (which
    /// PANICS on overflow rather than saturating), `deadline + DEADLINE_GRACE`,
    /// and `remaining + DEADLINE_GRACE` after a saturating subtraction. None
    /// does, because `from_millis(u64::MAX)` is about 5.8e14 years of SECONDS
    /// and an `i64` of seconds holds it — but that is a fact about the
    /// arithmetic and not a thing anyone should have to re-derive, so it is
    /// pinned here.
    ///
    /// `SyncWindow::unbounded()` still exists and is still what Rust callers
    /// should use: a day is past every real window and needs no reasoning.
    #[test]
    fn a_sentinel_deadline_does_not_overflow_the_arithmetic_this_module_does() {
        for millis in [u64::from(u32::MAX), i64::MAX as u64, u64::MAX] {
            let deadline = Duration::from_millis(millis);
            assert!(
                std::time::Instant::now().checked_add(deadline).is_some(),
                "`Instant + {millis}ms` overflows, and `Instant::add` panics rather than saturating"
            );
            let grace = deadline
                .checked_add(DEADLINE_GRACE)
                .expect("the backstop's grace overflowed the window");
            let remaining = (std::time::Instant::now() + deadline)
                .saturating_duration_since(std::time::Instant::now());
            assert!(remaining.checked_add(DEADLINE_GRACE).is_some());
            assert!(grace >= deadline);
        }
    }

    /// A METERED WINDOW FETCHES NO ORIGINALS AT ALL, and it is the PLAN that
    /// proves it rather than the flag: the planner deliberately admits an item
    /// larger than the whole budget, so a byte ceiling alone would start a
    /// video on a cellular link and resume it every window after that.
    #[test]
    fn a_metered_window_plans_no_originals() {
        let wants = [
            Want {
                moving: false,
                hash: ContentHash::of(b"cell"),
                tier: Tier::Thumbnail,
                size: 9_000,
                held: 0,
                recency: 2,
            },
            Want {
                moving: false,
                hash: ContentHash::of(b"a long video"),
                tier: Tier::Original,
                size: 900_000_000,
                held: 0,
                recency: 1,
            },
        ];
        let metered = centraid_blobs::plan(
            wants,
            budget_from(
                which(SyncBudget::NightShift),
                over(true),
                None,
                Ceilings::default(),
            ),
        );
        assert!(
            metered.items.iter().all(|item| item.tier != Tier::Original),
            "a metered window planned an original"
        );
        assert_eq!(metered.items.len(), 1);
        // STILL OWED, so a member is told there is more rather than told there
        // is nothing.
        assert_eq!(metered.deferred, 1);

        let unmetered = centraid_blobs::plan(
            wants,
            budget_from(
                which(SyncBudget::NightShift),
                over(false),
                None,
                Ceilings::default(),
            ),
        );
        assert!(
            unmetered
                .items
                .iter()
                .any(|item| item.tier == Tier::Original),
            "the same window unmetered withheld the original too, so the flag proved nothing"
        );
    }
}

#[cfg(test)]
mod withholding {
    use super::tests::over;
    use super::*;
    use centraid_blobs::{ContentHash, Tier, Want};
    use centraid_core::link::SyncBudget;

    /// A METERED WINDOW PLANS NOTHING OVER A LIBRARY OF PHOTOGRAPHS, AND SAYS
    /// SO (#1025 S5).
    ///
    /// The device's shape exactly: 19 originals, none held, no derivatives with
    /// a hash — so the whole want list is originals, a metered window orders
    /// none of them, and every number a caller could read is zero. `withheld`
    /// is what tells that apart from a device that already holds everything,
    /// and the difference is a grid of placeholders versus a full one.
    #[test]
    fn a_metered_window_over_a_library_of_originals_plans_nothing_and_names_why() {
        let wants: Vec<Want> = (0..19_i64)
            .map(|n| Want {
                hash: ContentHash::of(&n.to_le_bytes()),
                tier: Tier::Original,
                size: 2_000_000,
                held: 0,
                recency: n,
                moving: false,
            })
            .collect();

        let metered = centraid_blobs::plan(
            wants.clone(),
            budget_from(
                which(SyncBudget::Foreground),
                over(true),
                None,
                Ceilings::default(),
            ),
        );
        assert!(
            metered.items.is_empty(),
            "a metered window ordered an original"
        );
        assert_eq!(metered.withheld, 19, "an empty plan gave no reason");
        assert_eq!(
            metered.deferred, 19,
            "the withheld originals are still owed"
        );

        // THE SAME LIBRARY UNMETERED gets all nineteen, so `withheld` is the
        // metered flag's own footprint and not a property of the fixture.
        let unmetered = centraid_blobs::plan(
            wants,
            budget_from(
                which(SyncBudget::Foreground),
                over(false),
                None,
                Ceilings::default(),
            ),
        );
        assert_eq!(unmetered.items.len(), 19);
        assert_eq!(unmetered.withheld, 0);
    }
}
