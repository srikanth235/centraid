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
//! ## A pass is two connections, not one
//!
//! Rows come over `centraid/v1/seat` and bytes over `centraid/v1/byte`, and
//! [`SeatLink::sync`] dials both. That is not overhead worth removing: the
//! lanes speak different protocols, they fail independently, and a seat that
//! got its rows and not its files is in a *good* state — it shows the grid with
//! cells that say the file has not arrived. Collapsing them would make a byte
//! failure take the rows down with it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use centraid_blobs::{Budget, ByteStore};
use centraid_net::endpoint::{Endpoint, EndpointConfig};
use centraid_net::{pairing, ticket};
use centraid_protocol::alpn;
use centraid_seat::sync::PassReport;

use crate::bytes::BytePassReport;
use crate::link::GatewayLink;

/// How long a member will wait at a pairing screen before being told it failed.
const PAIR_TIMEOUT: Duration = Duration::from_secs(20);

/// THE LONGEST ONE PLANE MAY TAKE, AND WHY THERE IS A CEILING AT ALL.
///
/// A window is bounded by definition: iOS hands back about thirty seconds and
/// Android's worker is killed when its budget runs out, so an unbounded pass is
/// a pass the OS ends for you, at a moment you learn nothing about.
///
/// It is also the guard that would have caught this module's worst bug in
/// seconds instead of an hour. `sync` used to open a SECOND stream for the
/// intent sink; the gateway accepts one, so the open waited for an accept that
/// never came — no error, no close, no end. A hang with no ceiling looks
/// exactly like a slow network, and that is what it was mistaken for.
const PLANE_TIMEOUT: Duration = Duration::from_secs(60);

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
}

/// What one full pass did, both planes.
#[derive(Debug, Clone, Default)]
pub struct SeatPassReport {
    pub rows: PassReport,
    pub bytes: BytePassReport,
    /// The gateway could not be reached at all this pass. Both planes are
    /// therefore untouched, and the seat is stale rather than broken.
    pub unreachable: Option<String>,
}

impl SeatPassReport {
    /// Whether this pass reached the gateway. A pass that did not is not a
    /// failure a member needs told about — it is being on a train.
    #[must_use]
    pub const fn reached_the_gateway(&self) -> bool {
        self.unreachable.is_none()
    }
}

/// The seat's network half: one runtime, one endpoint, one byte store.
pub struct SeatLink {
    runtime: tokio::runtime::Runtime,
    endpoint: Endpoint,
    blobs: ByteStore,
    gateway: Mutex<Option<PairedGateway>>,
    last: Arc<Mutex<Option<SeatPassReport>>>,
    product_version: String,
    /// What a pass triggered through the core's seam spends.
    ///
    /// `foreground` by default: the callers that reach this crate through
    /// `SeatNetwork` are an explicit "sync now" and a background task that has
    /// already decided it is allowed to run. A scheduler that wants a smaller
    /// window calls [`Self::sync`] with its own budget.
    budget: Budget,
}

impl SeatLink {
    /// Bind the endpoint and open the byte store.
    ///
    /// Returns as soon as the UDP socket is bound and **never waits on the
    /// network** — `Endpoint::spawn` deliberately does not call
    /// `iroh::Endpoint::online` (D-1020-C10). A shell whose first screen waited
    /// for this would show a spinner forever on a phone in aeroplane mode.
    pub fn start(blobs_dir: impl AsRef<Path>, product_version: &str) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("centraid-seat")
            .enable_all()
            .build()
            .map_err(|error| LinkError::Runtime(error.to_string()))?;
        let blobs_dir: PathBuf = blobs_dir.as_ref().to_path_buf();
        let (endpoint, blobs) = runtime.block_on(async {
            let endpoint = Endpoint::spawn(EndpointConfig::default())
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
            gateway: Mutex::new(None),
            last: Arc::new(Mutex::new(None)),
            product_version: product_version.to_owned(),
            budget: Budget::foreground(),
        })
    }

    /// Spend a different budget on passes driven through the core's seam.
    #[must_use]
    pub const fn with_budget(mut self, budget: Budget) -> Self {
        self.budget = budget;
        self
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
        let paired = match answered {
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
            vault_id: ok.vault_id,
            // THE GATEWAY'S NAME FOR THE VAULT, not the ticket's. A ticket is
            // minted once and read off a screen later; a vault renamed in
            // between would be shown under its old name forever.
            vault_name: if ok.vault_name.is_empty() {
                scanned.vault_name.clone()
            } else {
                ok.vault_name
            },
        };
        self.adopt(gateway.clone());
        Ok(gateway)
    }

    /// Run one sync pass: rows first, then bytes.
    ///
    /// `connection` is the SEAT'S OWN replica, handed in rather than opened
    /// here. The core holds the writable connection to that file and SQLite
    /// allows one writer; a connection opened in this crate would contend with
    /// the core for the same lock and the loser would be whichever asked
    /// second.
    ///
    /// Rows before bytes, because a row is what tells this seat a blob exists
    /// at all. A byte pass that ran first would plan over last window's rows.
    pub fn sync(&self, connection: &rusqlite::Connection, budget: Budget) -> SeatPassReport {
        let Some(gateway) = self.gateway() else {
            return SeatPassReport {
                unreachable: Some("this seat is not paired to a gateway".to_owned()),
                ..Default::default()
            };
        };
        let needs = match centraid_seat::needed_blobs(connection, NEEDS_LIMIT) {
            Ok(needs) => needs,
            Err(error) => {
                tracing::warn!(%error, "the replica could not say which files it wants");
                Vec::new()
            }
        };
        // THE VAULT'S CLOCK, not `SystemTime::now()` inline: the text form has to
        // be the one the schema's own defaults write, or two spellings sort
        // differently in the same column (`crates/vault/src/clock.rs`).
        let now = centraid_vault::clock::Clock::now_text(&centraid_vault::clock::SystemClock);
        self.runtime.block_on(async {
            let mut report = SeatPassReport::default();

            // THE ROW PLANE.
            let relay = (!gateway.relay_url.is_empty()).then_some(gateway.relay_url.as_str());
            match self
                .endpoint
                .connect(
                    gateway.endpoint_id,
                    relay,
                    &gateway.direct_addrs,
                    alpn::SEAT,
                )
                .await
            {
                Err(error) => {
                    // NOT REACHED AT ALL. Both planes are untouched and the
                    // seat is stale, which is a state and not a fault.
                    report.unreachable = Some(format!("{error:?}"));
                    self.remember(&report);
                    return report;
                }
                Ok(connection_to_gateway) => {
                    match GatewayLink::open(&connection_to_gateway, &self.product_version).await {
                        Err(why) => report.rows.stale = Some(why),
                        Ok(mut link) => {
                            // A SEAT THAT HAS NEVER SYNCED HAS NO SCHEMA TO
                            // APPLY A PAGE INTO. One page is asked for first,
                            // purely for its header — the epoch is the log's
                            // identity and changes on a restore, so it must
                            // come from a page this gateway just served rather
                            // than be assumed from pairing. Idempotent: on an
                            // already-bootstrapped replica this is one cheap
                            // round trip and no write.
                            if !crate::bootstrap::is_bootstrapped(connection) {
                                use centraid_seat::sync::{FetchOutcome, LogSource as _};
                                if let FetchOutcome::Page(page) = link.fetch("", 0, 1).await
                                    && let Err(why) = crate::bootstrap::bootstrap_from(
                                        connection,
                                        &gateway.vault_id,
                                        &page.header,
                                        &now,
                                    )
                                {
                                    report.rows.stale = Some(why);
                                    self.remember(&report);
                                    return report;
                                }
                            }
                            // ONE STREAM PER CONNECTION, AND THAT IS THE
                            // GATEWAY'S RULE, NOT A PREFERENCE (#1020,
                            // D-1020-B6). `seat_lane::serve` calls `accept_bi`
                            // exactly ONCE and then loops on that stream, so a
                            // second `open_bi` waits for an accept that never
                            // comes — with no error on either side and no
                            // timeout to end it. This code opened a second
                            // stream for the intent sink and hung the whole
                            // pass forever; `link.rs`'s own header had already
                            // written down why that would happen.
                            //
                            // Nothing is lost by not having one: the gateway
                            // serves `LogRequest` and refuses every other
                            // message by name (D-1020-D2A), so an intent stream
                            // would be refused on its first frame anyway. The
                            // sink reports itself shut, the outbox keeps the
                            // write, and the badge says writes are queued —
                            // which is true.
                            let mut sink = ShutSink;
                            match tokio::time::timeout(
                                PLANE_TIMEOUT,
                                centraid_seat::sync::pass(connection, &mut link, &mut sink, &now),
                            )
                            .await
                            {
                                Ok(Ok(pass)) => report.rows = pass,
                                Ok(Err(error)) => report.rows.stale = Some(error.to_string()),
                                Err(_) => {
                                    report.rows.stale =
                                        Some("the row plane ran out of window".to_owned());
                                }
                            }
                        }
                    }
                    // The connection is dropped only now: QUIC discards stream
                    // data the peer has not read, and the pass reads until its
                    // last answer (D-1020-G10).
                    drop(connection_to_gateway);
                }
            }

            // THE BYTE PLANE, on its own connection and its own ALPN.
            match self
                .endpoint
                .connect(
                    gateway.endpoint_id,
                    relay,
                    &gateway.direct_addrs,
                    alpn::BYTE,
                )
                .await
            {
                Err(error) => {
                    // The rows landed and the files did not. A good state: the
                    // grid draws, and its cells say the file has not arrived.
                    report.bytes.stalled = Some(format!("{error:?}"));
                }
                Ok(byte_connection) => {
                    match tokio::time::timeout(
                        PLANE_TIMEOUT,
                        crate::bytes::byte_pass(
                            &self.blobs,
                            byte_connection.iroh(),
                            &needs,
                            budget,
                        ),
                    )
                    .await
                    {
                        Ok(bytes) => report.bytes = bytes,
                        // THE CHUNKS THAT LANDED ARE STILL HERE. A byte pass
                        // that runs out of window is the ordinary case, not a
                        // failure: every verified chunk group is durable and
                        // the next window resumes from it.
                        Err(_) => {
                            report.bytes.stalled =
                                Some("the byte plane ran out of window".to_owned());
                        }
                    }
                    drop(byte_connection);
                }
            }
            self.remember(&report);
            report
        })
    }

    fn remember(&self, report: &SeatPassReport) {
        if let Ok(mut last) = self.last.lock() {
            *last = Some(report.clone());
        }
    }

    /// The last pass's report, for a shell that wants to draw a badge without
    /// running one.
    #[must_use]
    pub fn last_pass(&self) -> Option<SeatPassReport> {
        self.last.lock().ok().and_then(|held| held.clone())
    }

    /// Stop dialling and release the socket.
    ///
    /// What a backgrounded phone does: an endpoint with no socket cannot be the
    /// reason the radio is awake (D-1020-C14).
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

/// How many rows the byte planner considers. Bounded because the query orders
/// by recency and a window will never get through more than this; an unbounded
/// query on a forty-thousand-row roll is an allocation on a phone.
const NEEDS_LIMIT: usize = 20_000;

/// A sink that is simply not there. Used when the second stream will not open,
/// so the row plane still runs.
struct ShutSink;

impl centraid_seat::sync::IntentSink for ShutSink {
    fn submit<'a>(
        &'a mut self,
        _record: &'a centraid_seat::IntentRecord,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = centraid_seat::sync::SubmitOutcome> + 'a>>
    {
        Box::pin(async move {
            centraid_seat::sync::SubmitOutcome::Unavailable(
                "no stream for writes this window".to_owned(),
            )
        })
    }
}

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
                vault_id: gateway.vault_id,
                vault_name: gateway.vault_name,
                // THE GATEWAY'S `PairOk.device_id` IS NOT KEPT HERE YET. An
                // empty string is the honest answer rather than this seat's own
                // endpoint id wearing the gateway's label: the two are
                // different identifiers and a shell that persisted one as the
                // other would send the wrong thing to a device list.
                device_id: String::new(),
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

    fn gateway(&self) -> Option<centraid_core::link::PairedGateway> {
        Self::gateway(self).map(|gateway| centraid_core::link::PairedGateway {
            endpoint_id: gateway.endpoint_id.to_vec(),
            vault_id: gateway.vault_id,
            vault_name: gateway.vault_name,
            device_id: String::new(),
        })
    }

    fn sync(&self, connection: &rusqlite::Connection) -> centraid_core::link::SyncOutcome {
        let report = Self::sync(self, connection, self.budget);
        centraid_core::link::SyncOutcome {
            rows_applied: report.rows.rows_applied as u64,
            blobs_completed: report.bytes.completed as u64,
            bytes_moved: report.bytes.moved,
            blobs_deferred: report.bytes.deferred as u64,
            unreachable: !report.reached_the_gateway(),
            // A SENTENCE A MEMBER COULD BE SHOWN, and never a detail. The
            // reasons a pass did not finish are all the same to a member — the
            // gateway was not there — and the numbers above are what changes.
            sentence: if report.reached_the_gateway() {
                String::new()
            } else {
                "Centraid could not reach your gateway, so this device is showing what it already has."
                    .to_owned()
            },
        }
    }

    fn idle(&self) {
        Self::idle(self);
    }

    fn resume(&self) -> std::result::Result<(), String> {
        Self::resume(self).map_err(|error| error.to_string())
    }
}
