//! The turmoil world: one gateway host, N seat hosts, a scripted network.
//!
//! ## Every host is real except the network
//!
//! The gateway host opens a real [`centraid_vault::Vault`] on a real file and
//! answers through the real [`centraid_core::Handle::call`]. Each seat host
//! opens a real seat file cut from a real snapshot, and runs the real
//! [`centraid_seat::sync::pass`] over the real applier and the real outbox.
//! What turmoil provides is the network and the clock.
//!
//! That matters because the alternative — a simulation over mocks — proves that
//! the mocks agree. v0 could not run this at all: its seat was a phone, a
//! browser worker and a Bun process, and there was no way to put three of them
//! in one deterministic process.
//!
//! ## One file per host, and the files outlive the hosts
//!
//! A crash is `turmoil::Sim::crash`, which drops the host's future. The *file*
//! stays on disk, and the restarted host reopens it — which is what makes
//! "process death between commit and ack" a real test rather than a described
//! one. So the temp directory is owned by the caller, not by a host.

use std::cell::RefCell;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig};
use centraid_seat::sync::{FetchOutcome, FetchedPage, IntentSink, LogSource, SubmitOutcome};

use crate::protocol;
use crate::schedule::{Fault, Schedule};

/// The gateway's port in the simulated world.
const GATEWAY_PORT: u16 = 4_001;
/// How long a seat waits for one answer before calling the gateway unreachable.
const REQUEST_TIMEOUT: Duration = Duration::from_millis(500);
/// The buffer one datagram is read into.
const RECV_BUFFER: usize = protocol::MAX_DATAGRAM_BYTES + 4;
/// How many consecutive idle passes count as quiescence.
///
/// Three, not one: another seat's commit is what a catching-up seat has to
/// outlast, and one idle pass only says "nothing happened in the last 50ms".
const QUIET_PASSES: u32 = 3;
/// How many extra passes a seat gets to catch up after the faults are repaired.
///
/// Bounded, so "until caught up" still terminates: a schedule whose bug is "it
/// never converges" has to be reported rather than hung on.
const CATCH_UP_PASSES: usize = 240;
/// Every fault is repaired by this tick, whatever its own window said.
///
/// Late enough that a fault is genuinely live for a while, early enough that
/// every seat still has most of its catch-up budget on a repaired network.
///
/// The seats keep passing afterwards, so convergence is measured on a repaired
/// network — which is the only network the claim is about.
const REPAIR_BY_TICK: u64 = 400;

/// What one run produced.
pub struct SimOutcome {
    pub schedule: Schedule,
    /// The gateway's file.
    pub gateway_path: PathBuf,
    /// One path per seat, in seat order.
    pub seat_paths: Vec<PathBuf>,
    /// What each seat's passes reported, in order.
    pub reports: Vec<Vec<String>>,
    /// Whatever turmoil itself refused.
    pub turmoil: Option<String>,
}

impl SimOutcome {
    /// Open the files for the invariant check.
    ///
    /// Opened AFTER the run, on this thread, rather than handed out by the
    /// hosts: a connection a host still owned would be one whose transactions
    /// are not finished, and the invariants are about what is durable.
    pub fn open(&self) -> (rusqlite::Connection, Vec<(String, rusqlite::Connection)>) {
        let gateway = rusqlite::Connection::open(&self.gateway_path)
            .expect("the gateway's file opens for inspection");
        let seats = self
            .seat_paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                (
                    format!("seat-{index}"),
                    rusqlite::Connection::open(path)
                        .unwrap_or_else(|error| panic!("seat {index}'s file opens: {error}")),
                )
            })
            .collect();
        (gateway, seats)
    }
}

/// Host names, so turmoil's DNS and the findings agree.
fn gateway_host() -> &'static str {
    "gateway"
}

fn seat_host(index: usize) -> String {
    format!("seat-{index}")
}

/// Run one schedule to completion.
///
/// `dir` holds one file per host and is the caller's to remove: the files have
/// to outlive the hosts for a crash-and-restart to mean anything.
pub fn run_schedule(schedule: &Schedule, dir: &Path) -> SimOutcome {
    std::fs::create_dir_all(dir).expect("the simulation's directory is made");
    let gateway_path = dir.join("gateway.db");
    let seat_paths: Vec<PathBuf> = (0..schedule.seats)
        .map(|index| dir.join(format!("seat-{index}.db")))
        .collect();

    // --- the authority, founded and snapshotted BEFORE the world starts -----
    //
    // A seat bootstraps from a snapshot, and cutting one inside a host would
    // mean the first seat's bootstrap raced the gateway's founding. So the
    // founding and the snapshot happen here, on this thread, which is also what
    // a real deployment does: the gateway exists before a phone pairs with it.
    let snapshot_head = {
        let vault = centraid_vault::Vault::create_with(
            &gateway_path,
            Box::new(centraid_vault::clock::FixedClock::frozen()),
            Box::new(centraid_vault::clock::SeededIds::new(format!(
                "sim-{}",
                schedule.seed
            ))),
        )
        .expect("the gateway's vault is created");
        vault.found("Simulation", "Owner").expect("it is founded");
        // THE VAULT'S OWN NAMED READER. Every caller outside `crates/vault`
        // was writing the same `SELECT`, which the `sql-confinement` rule
        // caught — correctly, and the fix was a reader rather than an exemption.
        let owner = vault.self_party_id().expect("the owner reads");
        for index in 0..schedule.seats {
            vault
                .enrol_device(
                    &seat_host(index),
                    &owner,
                    &format!("Seat {index}"),
                    "sim",
                    &format!("pk-{index}"),
                )
                .expect("the seat enrols");
        }
        let head = centraid_vault::build_snapshot(&vault, &dir.join("snapshot"))
            .expect("the snapshot builds");
        vault.close().expect("the vault closes");
        head
    };

    for path in &seat_paths {
        bootstrap_seat(dir, &snapshot_head, path);
    }

    // --- the world ----------------------------------------------------------

    let mut builder = turmoil::Builder::new();
    builder
        .rng_seed(schedule.seed)
        // A bounded simulation. A schedule that needed longer would be one
        // whose bug is "it never converges", and the timeout is how that is
        // reported rather than hung on.
        .simulation_duration(Duration::from_secs(60))
        .tick_duration(Duration::from_millis(10))
        .min_message_latency(Duration::from_millis(1))
        .max_message_latency(Duration::from_millis(50));
    let mut sim = builder.build();

    let reports: Rc<RefCell<Vec<Vec<String>>>> =
        Rc::new(RefCell::new(vec![Vec::new(); schedule.seats]));

    // THE QUIESCENCE BARRIER, shared by every seat.
    //
    // Bumped whenever any seat submits an intent. A seat may stop polling only
    // after several idle passes during which NOBODY submitted anything — which
    // is what keeps seat A from giving up just before seat B's last write lands.
    //
    // In production a change event wakes a seat that has gone quiet; there is
    // no change feed to a seat in wave 2 (it is wave 3's), so the simulation
    // needs this barrier instead. Without it the harness reported a
    // convergence failure on seeds 11 and 14 while the product was correct:
    // the seats had each independently reached the end of what they knew about.
    let submissions: Rc<std::cell::Cell<u64>> = Rc::new(std::cell::Cell::new(0));
    // And how many seats have emptied their queue. A seat under a five-second
    // clock skew has not even STARTED while the others are quiescing, so a
    // barrier that only watched submissions would let them all leave before it
    // arrived — which is what seed 14 reproduced.
    let finished: Rc<std::cell::Cell<usize>> = Rc::new(std::cell::Cell::new(0));

    // The gateway. `host`, not `client`, so `crash` and `bounce` restart it —
    // and the restart REOPENS THE FILE, which is the whole of the
    // process-death case.
    {
        let path = gateway_path.clone();
        let seed_label = format!("sim-{}", schedule.seed);
        sim.host(gateway_host(), move || {
            let path = path.clone();
            let seed_label = seed_label.clone();
            async move { serve_gateway(&path, seed_label).await }
        });
    }

    // The seats.
    for (index, seat_path) in seat_paths.iter().enumerate() {
        let path = seat_path.clone();
        let schedule = schedule.clone();
        let reports = Rc::clone(&reports);
        let submissions = Rc::clone(&submissions);
        let finished = Rc::clone(&finished);
        sim.client(seat_host(index), async move {
            let outcome = drive_seat(index, &path, &schedule, &submissions, &finished).await;
            reports.borrow_mut()[index] = outcome;
            Ok(())
        });
    }

    // --- the faults ---------------------------------------------------------

    let turmoil_error = apply_faults_and_run(&mut sim, schedule);

    SimOutcome {
        schedule: schedule.clone(),
        gateway_path,
        seat_paths,
        reports: reports.borrow().clone(),
        turmoil: turmoil_error,
    }
}

/// Inflate the snapshot into a seat file and initialise `seat_state`.
fn bootstrap_seat(dir: &Path, head: &centraid_vault::SnapshotHead, path: &Path) {
    use std::io::Read as _;
    let artifact = dir.join("snapshot").join(&head.name);
    let bytes = std::fs::read(&artifact).expect("the snapshot artifact reads");
    let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut inflated = Vec::new();
    decoder
        .read_to_end(&mut inflated)
        .expect("the artifact inflates");
    std::fs::write(path, inflated).expect("the seat file writes");

    let connection = rusqlite::Connection::open(path).expect("the seat file opens");
    let (epoch, floor, _) =
        centraid_vault::converge::position(&connection).expect("the copy carries its position");
    centraid_seat::init_seat_state(
        &connection,
        &centraid_seat::SeatPosition {
            vault_id: head.vault_id.clone(),
            epoch,
            schema_epoch: head.schema_epoch,
            ddl_version: centraid_vault::log::constants().ddl_version,
            applied_seq: floor,
            applied_commit_seq: 0,
        },
        "2026-01-01T00:00:00.000Z",
    )
    .expect("the seat state initialises");
    centraid_seat::Outbox::open(&connection).expect("the outbox is created");
}

/// The gateway host: answer datagrams through the real core, forever.
async fn serve_gateway(path: &Path, seed_label: String) -> turmoil::Result {
    // The core is opened INSIDE the host, so a crash-and-restart reopens the
    // file — running the migrations again, taking the WAL as it was left, and
    // recovering whatever the crash interrupted. That is the case under test.
    // A FROZEN CLOCK AND A SEEDED ID SEQUENCE. The simulation found its own
    // need for this: two runs of one seed produced identical rows and
    // different timestamps, and the receipt hashes over those timestamps
    // differed too — so a seed could not be replayed byte for byte, which is
    // what recording a failing seed requires.
    let handle = Core::open(
        CoreConfig {
            path: path.to_path_buf(),
            role: centraid_core::Role::Gateway,
            ui_thread_name: None,
            create: false,
            clock: None,
            ids: None,
            // The simulation IS this build; there is no prebuilt artifact to
            // check against (#1020 wave 3).
            expected_digest: None,
        }
        .with_clock(
            Box::new(centraid_vault::clock::FixedClock::frozen()),
            Box::new(centraid_vault::clock::SeededIds::new(seed_label)),
        ),
    )
    .map_err(|error| format!("the gateway's core did not open: {error}"))?;

    let socket = turmoil::net::UdpSocket::bind((IpAddr::V4(Ipv4Addr::UNSPECIFIED), GATEWAY_PORT))
        .await
        .map_err(|error| format!("the gateway's socket did not bind: {error}"))?;

    let mut buffer = vec![0_u8; RECV_BUFFER];
    loop {
        let (len, from) = match socket.recv_from(&mut buffer).await {
            Ok(received) => received,
            // A partitioned host's socket errors rather than hanging. Keep
            // serving: the partition will be repaired and the seat will retry.
            Err(_) => continue,
        };
        let answer = answer_one(&handle, &buffer[..len]);
        // A send that fails is a partition. Dropping the answer is correct —
        // the seat's request will time out and it will ask again, which is what
        // the whole idempotency plane is for.
        let _ = socket.send_to(&answer, from).await;
    }
}

/// Decode one datagram, answer it through the core, encode the answer.
fn answer_one(handle: &centraid_core::Handle, datagram: &[u8]) -> Vec<u8> {
    let envelope = match protocol::decode_envelope(datagram) {
        Ok(envelope) => envelope,
        // A MALFORMED DATAGRAM IS NOT AN ANSWER. The reply is an error under
        // request id 0, which the seat treats as unavailable — a gateway that
        // guessed at a truncated request would be worse than one that refuses.
        Err(reason) => {
            return protocol::encode_envelope(&wire::Envelope {
                request_id: 0,
                body: Some(wire::envelope::Body::Error(wire::Error {
                    code: wire::ErrorCode::MalformedFrame as i32,
                    detail: reason,
                    diagnostic_id: String::new(),
                    // ONE OWNER FOR THE SENTENCE. The simulated gateway
                    // answers what the real one answers; a second wording here
                    // would be a second product (#1020 wave 3).
                    sentence: centraid_core::sentence_for_code(wire::ErrorCode::MalformedFrame)
                        .to_owned(),
                })),
            })
            .unwrap_or_default();
        }
    };
    let request_id = envelope.request_id;
    let Some(wire::envelope::Body::Request(request)) = envelope.body else {
        return protocol::encode_envelope(&wire::Envelope {
            request_id,
            body: Some(wire::envelope::Body::Error(wire::Error {
                code: wire::ErrorCode::UnsupportedMessage as i32,
                detail: "not a request".to_owned(),
                diagnostic_id: String::new(),
                sentence: centraid_core::sentence_for_code(wire::ErrorCode::UnsupportedMessage)
                    .to_owned(),
            })),
        })
        .unwrap_or_default();
    };

    let body = match handle.call(&request) {
        Ok(response) => wire::envelope::Body::Response(response),
        Err(error) => wire::envelope::Body::Error(error.to_wire()),
    };
    protocol::encode_envelope(&wire::Envelope {
        request_id,
        body: Some(body),
    })
    .unwrap_or_default()
}

/// A seat's one connection, shared by its two logical channels.
///
/// No `RefCell`. `send_to` and `recv_from` take `&self`, so the socket needs no
/// interior mutability — and a `RefCell` borrow held across an `await` is a
/// deadlock waiting for the day the driver interleaves the two channels.
/// Clippy's `await_holding_refcell_ref` said so, and it was right: only the
/// request-id counter mutates, and a `Cell` is what that wants.
struct LinkInner {
    socket: turmoil::net::UdpSocket,
    gateway: SocketAddr,
    next_request_id: std::cell::Cell<u64>,
    /// Every request is sent twice. Set by a `Duplicate` fault, and the point
    /// of the whole idempotency plane: a page applied twice changes nothing and
    /// an intent executed twice is answered from the ledger.
    duplicate: bool,
}

impl LinkInner {
    /// One request/response exchange, bounded.
    async fn exchange(&self, request: wire::Request) -> Result<wire::Envelope, String> {
        let request_id = self.next_request_id.get() + 1;
        self.next_request_id.set(request_id);
        let datagram = protocol::encode_request(request_id, request)?;
        self.socket
            .send_to(&datagram, self.gateway)
            .await
            .map_err(|error| format!("the send failed: {error}"))?;
        if self.duplicate {
            // THE SAME DATAGRAM AGAIN. Not a retry after a timeout — a
            // deliberate re-send while the first is still in flight, which is
            // the case a retry cannot reproduce.
            let _ = self.socket.send_to(&datagram, self.gateway).await;
        }
        let mut buffer = vec![0_u8; RECV_BUFFER];
        loop {
            let received =
                tokio::time::timeout(REQUEST_TIMEOUT, self.socket.recv_from(&mut buffer))
                    .await
                    .map_err(|_| "the request timed out".to_owned())?
                    .map_err(|error| format!("the receive failed: {error}"))?;
            let envelope = protocol::decode_envelope(&buffer[..received.0])?;
            // A DUPLICATE ANSWER TO A PREVIOUS REQUEST is discarded rather
            // than mistaken for this one's: request ids are what makes that
            // possible, and a simulation that ignored them would be testing a
            // protocol without them.
            if envelope.request_id == request_id || envelope.request_id == 0 {
                return Ok(envelope);
            }
        }
    }
}

/// The log channel. A thin view onto the shared connection.
///
/// Two views and not one value implementing both traits, because the traits are
/// separate *for a reason*: a seat whose log source is down is stale and a seat
/// whose intent sink is down is blocked, and those are the two most different
/// states a seat has. A real seat may have two connections; this one has one,
/// and sharing it through an `Rc<RefCell<…>>` is the honest way to say so
/// rather than collapsing the traits to match the implementation.
struct PageChannel(Rc<LinkInner>);

/// The intent channel, onto the same connection.
struct SubmitChannel(Rc<LinkInner>);

impl LogSource for PageChannel {
    fn fetch<'a>(
        &'a mut self,
        epoch: &'a str,
        since: i64,
        limit: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchOutcome> + 'a>> {
        Box::pin(async move {
            let request = protocol::log_request(epoch, since, limit);
            let envelope = match self.0.exchange(request).await {
                Ok(envelope) => envelope,
                Err(reason) => return FetchOutcome::Unavailable(reason),
            };
            decode_page(envelope)
        })
    }
}

/// Read a page, a re-bootstrap or a refusal out of one answer.
fn decode_page(envelope: wire::Envelope) -> FetchOutcome {
    match envelope.body {
        Some(wire::envelope::Body::Response(wire::Response {
            kind: Some(wire::response::Kind::Log(page)),
        })) => {
            let header = centraid_seat::applier::PageHeader {
                epoch: page.epoch.clone(),
                schema_epoch: i64::from(page.schema_epoch),
                ddl_version: i64::from(page.ddl_version),
                watermark: i64::try_from(page.watermark).unwrap_or(i64::MAX),
            };
            let rows = page
                .rows
                .iter()
                .map(|row| centraid_core::convert::log_row_from_wire(row, &page.epoch))
                .collect::<Result<Vec<_>, _>>();
            match rows {
                Ok(rows) => FetchOutcome::Page(FetchedPage {
                    header,
                    rows,
                    has_more: page.has_more,
                    next: i64::try_from(page.next).unwrap_or(i64::MAX),
                }),
                Err(error) => FetchOutcome::Unavailable(format!("an unreadable page: {error}")),
            }
        }
        Some(wire::envelope::Body::Response(wire::Response {
            kind: Some(wire::response::Kind::RebootstrapRequired(required)),
        })) => FetchOutcome::RebootstrapRequired {
            reason: rebootstrap_from_wire(required.reason),
            epoch: required.epoch,
            floor: i64::try_from(required.floor).unwrap_or(0),
            watermark: i64::try_from(required.watermark).unwrap_or(0),
        },
        Some(wire::envelope::Body::Error(error)) => {
            FetchOutcome::Unavailable(format!("the gateway refused: {}", error.detail))
        }
        _ => FetchOutcome::Unavailable("an answer that was not a page".to_owned()),
    }
}

impl IntentSink for SubmitChannel {
    fn submit<'a>(
        &'a mut self,
        record: &'a centraid_seat::IntentRecord,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = SubmitOutcome> + 'a>> {
        Box::pin(async move { self.submit_one(record).await })
    }
}

impl SubmitChannel {
    async fn submit_one(&mut self, record: &centraid_seat::IntentRecord) -> SubmitOutcome {
        // The intent's id rides as the command's `invoke_key`, and the device
        // id is the seat's host name — so the gateway's ledger keys on
        // `(vault, intent, hash)` exactly as it does in production.
        let request = protocol::command_request(
            &record.action,
            &record.input,
            &record.intent_id,
            &record.app_id,
        );
        let envelope = match self.0.exchange(request).await {
            Ok(envelope) => envelope,
            Err(reason) => return SubmitOutcome::Unavailable(reason),
        };
        match envelope.body {
            Some(wire::envelope::Body::Response(wire::Response {
                kind: Some(wire::response::Kind::Command(outcome)),
            })) => {
                let status = match wire::CommandStatus::try_from(outcome.status) {
                    Ok(wire::CommandStatus::Executed) => centraid_seat::OutcomeStatus::Executed,
                    Ok(wire::CommandStatus::Denied) => centraid_seat::OutcomeStatus::Denied,
                    Ok(wire::CommandStatus::Parked) => centraid_seat::OutcomeStatus::Parked,
                    // Everything else the command plane can say is a failure
                    // the member is owed a sentence for.
                    _ => centraid_seat::OutcomeStatus::Failed,
                };
                SubmitOutcome::Answered(centraid_seat::settlement::Answer {
                    intent_id: record.intent_id.clone(),
                    status,
                    commit_seq: commit_seq_of(&outcome),
                    conflicts: Vec::new(),
                    answered_versions: Vec::new(),
                    waiting_on: Vec::new(),
                    reason: (!outcome.reason.is_empty()).then(|| outcome.reason.clone()),
                })
            }
            Some(wire::envelope::Body::Error(error)) => {
                SubmitOutcome::Unavailable(format!("the gateway refused: {}", error.detail))
            }
            _ => SubmitOutcome::Unavailable("an answer that was not an outcome".to_owned()),
        }
    }
}

/// The commit an outcome landed in.
///
/// `CommandOutcome.commit_seq` was added in this lane because this simulation
/// found its absence to be a liveness bug: without it an `executed` answer
/// carried nothing a seat could settle against, and every overlay stayed on
/// screen for the life of the seat. See `command.proto`'s note on field 7.
///
/// `None` is still a real answer — a command that wrote nothing a session saw
/// has no commit — and `crates/seat`'s settlement now refuses an `executed`
/// answer that carries neither this nor a version set, rather than parking it
/// where nothing can reach it.
fn commit_seq_of(outcome: &wire::CommandOutcome) -> Option<i64> {
    outcome
        .commit_seq
        .map(|seq| i64::try_from(seq).unwrap_or(i64::MAX))
}

fn rebootstrap_from_wire(reason: i32) -> centraid_vault::RebootstrapReason {
    use centraid_vault::RebootstrapReason as R;
    match wire::RebootstrapReason::try_from(reason) {
        Ok(wire::RebootstrapReason::EpochMismatch) => R::EpochMismatch,
        Ok(wire::RebootstrapReason::Retention) => R::Retention,
        Ok(wire::RebootstrapReason::CursorAhead) => R::CursorAhead,
        Ok(wire::RebootstrapReason::Initial) => R::Initial,
        // Every reason a reader does not know normalises to `invalid-cursor`,
        // as v0's door does: no raw error text ever reaches a peer.
        _ => R::InvalidCursor,
    }
}

/// One seat: queue its workload, then run its passes.
async fn drive_seat(
    index: usize,
    path: &Path,
    schedule: &Schedule,
    submissions: &std::cell::Cell<u64>,
    finished: &std::cell::Cell<usize>,
) -> Vec<String> {
    let mut reports = Vec::new();

    // CLOCK SKEW, as a delay before the first pass. Turmoil's clock is the
    // host's, so a seat that starts late is a seat whose view of time differs
    // from the gateway's — which is the property, and it is more honest than
    // pretending to move one host's wall clock.
    if let Some(Fault::ClockSkew { millis, .. }) = schedule
        .faults
        .iter()
        .find(|fault| matches!(fault, Fault::ClockSkew { seat, .. } if *seat == index))
    {
        tokio::time::sleep(Duration::from_millis(*millis)).await;
    }

    let connection = match rusqlite::Connection::open(path) {
        Ok(connection) => connection,
        Err(error) => {
            reports.push(format!("the seat's file did not open: {error}"));
            return reports;
        }
    };

    // Queue this seat's writes.
    if let Some(workload) = schedule
        .workloads
        .iter()
        .find(|workload| workload.seat == index)
    {
        let outbox = match centraid_seat::Outbox::open(&connection) {
            Ok(outbox) => outbox,
            Err(error) => {
                reports.push(format!("the outbox did not open: {error}"));
                return reports;
            }
        };
        for (order, (command, title)) in workload.writes.iter().enumerate() {
            let input = serde_json::json!({ "display_name": title, "kind": "person" });
            let intent_id = format!("sim-{}-s{index}-w{order}", schedule.seed);
            let hash = centraid_seat::PayloadHash::of(command, command, &input, &[], &[])
                .map(|hash| hash.as_str().to_owned())
                .unwrap_or_else(|_| "0".repeat(64));
            let record = centraid_seat::IntentRecord {
                intent_id,
                created_order: 0,
                // `app_id` carries the command name, because the sink submits
                // it as a command: the command plane's own ledger is what
                // proves idempotency in wave 2 (see `protocol::command_request`).
                app_id: command.clone(),
                action: command.clone(),
                input,
                payload_hash: hash,
                state: centraid_seat::IntentState::Queued,
                attempts: 0,
                depends_on: Vec::new(),
                base_versions: Vec::new(),
                optimistic: None,
                commit_seq: None,
                waiting_on: Vec::new(),
                needs_blobs: Vec::new(),
                enqueued_at: "2026-01-01T00:00:00.000Z".to_owned(),
                updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
                reason: None,
                conflicts: Vec::new(),
                online_only: false,
            };
            if let Err(error) = outbox.enqueue(&record, "2026-01-01T00:00:00.000Z") {
                reports.push(format!("the intent did not queue: {error}"));
            }
        }
    }

    let socket = match turmoil::net::UdpSocket::bind((IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)).await {
        Ok(socket) => socket,
        Err(error) => {
            reports.push(format!("the seat's socket did not bind: {error}"));
            return reports;
        }
    };
    let gateway = SocketAddr::new(turmoil::lookup(gateway_host()), GATEWAY_PORT);
    let duplicate = schedule
        .faults
        .iter()
        .any(|fault| matches!(fault, Fault::Duplicate { seat } if *seat == index));

    let inner = Rc::new(LinkInner {
        socket,
        gateway,
        next_request_id: std::cell::Cell::new(0),
        duplicate,
    });
    let mut pages = PageChannel(Rc::clone(&inner));
    let mut intents = SubmitChannel(Rc::clone(&inner));

    // The passes. Two phases, because a fixed pass count is the artificial
    // bit: the schedule's own passes run while the faults are live, and then a
    // CATCH-UP phase runs until the seat is actually caught up.
    //
    // A real seat retries until it has nothing left to do. A simulation that
    // stopped after N passes would assert "converges within N passes of a
    // partition", which is a claim about the harness rather than about the
    // protocol — and it is the claim that failed on seeds 11, 14 and 16 while
    // the product was correct.
    for pass in 0..schedule.passes {
        let outcome = pass_outcome(&connection, &mut pages, &mut intents, pass).await;
        submissions.set(submissions.get() + outcome.intents_submitted as u64);
        reports.push(describe(pass, &outcome));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // CATCH-UP, to QUIESCENCE rather than to `behind == 0`.
    //
    // `behind` is a display number: it is derived from the watermark the last
    // served page carried, so a gateway that commits after that page was cut
    // leaves it at zero while the seat is genuinely behind. Breaking on it
    // stopped seats early on seeds 1, 6, 11 and 14 — a harness bug whose cause
    // is a real product subtlety, now documented on `PassReport::behind`.
    //
    // Quiescence is the honest test: several consecutive passes that applied
    // nothing, submitted nothing and reached the end of the log. Other seats'
    // commits are what this has to outlast, so "several" and not "one".
    let mut quiet = 0_u32;
    let mut seen_submissions = submissions.get();
    let mut announced = false;
    for pass in schedule.passes..(schedule.passes + CATCH_UP_PASSES) {
        let outcome = pass_outcome(&connection, &mut pages, &mut intents, pass).await;
        submissions.set(submissions.get() + outcome.intents_submitted as u64);

        // ANNOUNCE, once, that this seat has nothing left to send. Until every
        // seat has, nobody may stop: the gateway may still be about to gain a
        // commit no seat has seen.
        if !announced && !has_queued(&connection) {
            announced = true;
            finished.set(finished.get() + 1);
        }
        let idle = outcome.rows_applied == 0
            && outcome.intents_submitted == 0
            && outcome.reached_the_end
            && outcome.stale.is_none()
            && outcome.blocked.is_none();
        reports.push(describe(pass, &outcome));

        // ANY seat's submission resets every seat's quiet count: the commit it
        // produced is one this seat has not seen yet.
        let now_submissions = submissions.get();
        if now_submissions != seen_submissions {
            seen_submissions = now_submissions;
            quiet = 0;
        } else {
            quiet = if idle { quiet + 1 } else { 0 };
        }
        if quiet >= QUIET_PASSES && finished.get() >= schedule.seats {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    reports
}

/// Whether this seat still has an intent waiting to be sent.
fn has_queued(connection: &rusqlite::Connection) -> bool {
    centraid_seat::Outbox::open(connection)
        .and_then(|outbox| outbox.all())
        .map(|records| {
            records
                .iter()
                .any(|record| record.state == centraid_seat::IntentState::Queued)
        })
        // A file that will not open has not finished; claiming otherwise would
        // let the run end on a seat nobody could read.
        .unwrap_or(true)
}

/// One pass, or a report of why it did not run.
async fn pass_outcome(
    connection: &rusqlite::Connection,
    pages: &mut PageChannel,
    intents: &mut SubmitChannel,
    pass: usize,
) -> centraid_seat::sync::PassReport {
    let now = format!("2026-01-01T00:{:02}:{:02}.000Z", pass / 60, pass % 60);
    centraid_seat::sync::pass(connection, pages, intents, &now)
        .await
        .unwrap_or_else(|error| centraid_seat::sync::PassReport {
            // A FAILED PASS IS NOT AN IDLE ONE. `stale` carries the error so
            // the quiescence test cannot mistake a broken pass for a finished
            // one, which would end the run early and pass the invariants for
            // the wrong reason.
            stale: Some(format!("the pass failed: {error}")),
            ..centraid_seat::sync::PassReport::default()
        })
}

/// One pass as a report line.
fn describe(pass: usize, report: &centraid_seat::sync::PassReport) -> String {
    format!(
        "pass {pass}: applied {} dup {} commits {} submitted {} settled {} behind {} end {}{}{}",
        report.rows_applied,
        report.rows_duplicate,
        report.commits_applied,
        report.intents_submitted,
        report.intents_settled,
        report.behind,
        report.reached_the_end,
        report
            .stale
            .as_ref()
            .map(|reason| format!(" stale({reason})"))
            .unwrap_or_default(),
        report
            .blocked
            .as_ref()
            .map(|reason| format!(" blocked({reason})"))
            .unwrap_or_default(),
    )
}

/// Apply the schedule's faults and run the world.
fn apply_faults_and_run(sim: &mut turmoil::Sim<'_>, schedule: &Schedule) -> Option<String> {
    // Latency is set up front: it is a property of a link, not an event.
    for fault in &schedule.faults {
        if let Fault::Latency { seat, millis } = fault {
            sim.set_link_max_message_latency(
                gateway_host(),
                seat_host(*seat).as_str(),
                Duration::from_millis(*millis),
            );
        }
    }

    let mut elapsed_ticks = 0_u64;
    let mut pending: Vec<(u64, &Fault)> = schedule
        .faults
        .iter()
        .filter_map(|fault| match fault {
            // A partition or a hold starts at tick 0; its  is how long
            // it LASTS, and is read when the repair is scheduled.
            Fault::Partition { .. } | Fault::HoldRelease { .. } => Some((0, fault)),
            Fault::CrashGateway { after_ticks } | Fault::CrashSeat { after_ticks, .. } => {
                Some((*after_ticks, fault))
            }
            _ => None,
        })
        .collect();
    // A repair is scheduled when its fault is applied.
    let mut repairs: Vec<(u64, &Fault)> = Vec::new();

    loop {
        // Apply whatever is due at this tick.
        pending.retain(|(due, fault)| {
            if *due > elapsed_ticks {
                return true;
            }
            match fault {
                Fault::Partition { seat, ticks } => {
                    sim.partition(gateway_host(), seat_host(*seat).as_str());
                    repairs.push((elapsed_ticks + ticks, fault));
                }
                Fault::HoldRelease { seat, ticks } => {
                    // HELD, NOT DROPPED. The held messages arrive after the
                    // ones sent later, which is how turmoil reorders — and
                    // reordering is the failure mode a stream transport hides.
                    sim.hold(gateway_host(), seat_host(*seat).as_str());
                    repairs.push((elapsed_ticks + ticks, fault));
                }
                Fault::CrashGateway { .. } => {
                    // THE FILE SURVIVES. `bounce` restarts the host, which
                    // reopens it — the process-death case, run rather than
                    // described.
                    sim.bounce(gateway_host());
                }
                Fault::CrashSeat { seat, .. } => {
                    // A seat is a `client` and cannot be bounced, so its crash
                    // is expressed as a partition it never recovers from within
                    // this fault's window. Recorded honestly rather than
                    // claimed: the seat-side crash-and-reopen case is covered
                    // by `crates/seat/tests/failure_matrix.rs`, which can drop
                    // and reopen the connection directly.
                    sim.partition(gateway_host(), seat_host(*seat).as_str());
                    repairs.push((elapsed_ticks + 5, fault));
                }
                _ => {}
            }
            false
        });
        repairs.retain(|(due, fault)| {
            if *due > elapsed_ticks {
                return true;
            }
            match fault {
                Fault::Partition { seat, .. } | Fault::CrashSeat { seat, .. } => {
                    sim.repair(gateway_host(), seat_host(*seat).as_str());
                }
                Fault::HoldRelease { seat, .. } => {
                    sim.release(gateway_host(), seat_host(*seat).as_str());
                }
                _ => {}
            }
            false
        });

        // EVERY FAULT IS REPAIRED WHILE THE SEATS STILL HAVE PASSES LEFT.
        // Repairing only at the end would make the convergence claim
        // "converges unless partitioned", which is not a claim — and it is the
        // harness bug that failed seeds 11, 14 and 16 while the product was
        // correct.
        if elapsed_ticks >= REPAIR_BY_TICK {
            for (_, fault) in repairs.drain(..) {
                match fault {
                    Fault::Partition { seat, .. } | Fault::CrashSeat { seat, .. } => {
                        sim.repair(gateway_host(), seat_host(*seat).as_str());
                    }
                    Fault::HoldRelease { seat, .. } => {
                        sim.release(gateway_host(), seat_host(*seat).as_str());
                    }
                    _ => {}
                }
            }
        }

        match sim.step() {
            Ok(done) => {
                if done {
                    for (_, fault) in &repairs {
                        match fault {
                            Fault::Partition { seat, .. } | Fault::CrashSeat { seat, .. } => {
                                sim.repair(gateway_host(), seat_host(*seat).as_str());
                            }
                            Fault::HoldRelease { seat, .. } => {
                                sim.release(gateway_host(), seat_host(*seat).as_str());
                            }
                            _ => {}
                        }
                    }
                    return None;
                }
            }
            Err(error) => return Some(error.to_string()),
        }
        elapsed_ticks += 1;
        if elapsed_ticks > 12_000 {
            return Some("the simulation did not finish inside 12,000 ticks".to_owned());
        }
    }
}
