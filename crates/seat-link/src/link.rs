//! The gateway connection, as the seat's sync loop sees it (#1020, D-1020-B6;
//! rebuilt by #1025 S2).
//!
//! `crates/seat`'s [`pass`](centraid_seat::sync::pass) is written over two
//! traits so that `crates/sim` can drive it over turmoil and a real phone can
//! drive it over QUIC. `crates/sim` had the only implementation; this is the
//! other one, and it is why the loop was production code rather than a test
//! driver.
//!
//! ## ONE STREAM PER REQUEST, OPENED HERE
//!
//! This used to be one stream per CONNECTION, handshaked once and reused for
//! every request, because the gateway called `accept_bi` exactly once. That
//! shape is gone: the gateway loops on `accept_bi` now, so a request is a
//! stream — opened, tagged with a `Request` envelope, answered, finished.
//!
//! It is what makes both of this module's old apologies unnecessary. A second
//! stream for the intent sink no longer hangs waiting for an accept that never
//! comes, so [`GatewayLink`] is a live [`IntentSink`] rather than an honest
//! excuse; and two links over one connection can be held at once, which is what
//! `pass` needs, because it takes `&mut dyn LogSource` and `&mut dyn IntentSink`
//! and they cannot be the same borrow.
//!
//! ## THE HANDSHAKE IS ITS OWN STREAM, AND IT IS FIRST
//!
//! [`handshake`] opens the connection's first stream and exchanges `Hello`
//! there. The gateway requires it: a seat whose schema it cannot serve must
//! learn that from the handshake and not from a page it cannot apply. After
//! that the stream is finished — it has said everything it will ever say.
//!
//! ## THE INTENT SINK IS LIVE, AND AN ANSWER IS NOT A SETTLEMENT
//!
//! [`GatewayLink::submit`] answers with the gateway's `Outcome`, commit
//! position and all. It does NOT clear an overlay, and nothing here should read
//! as though it does: an `executed` answer parks the intent at
//! `awaiting-change` and the applier clears the paint inside the transaction
//! that lands that commit (`centraid_seat::settlement`). This module's job ends
//! at turning the wire's answer into `centraid_seat`'s.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use centraid_api_proto::core_v1 as core;
use centraid_net::{IrohConnection, RawRecv};
use centraid_protocol::Connection as _;
use centraid_protocol::version::local_hello;
use centraid_protocol::wire::{read_envelope, write_envelope};
use centraid_seat::sync::{FetchOutcome, FetchedPage, IntentSink, LogSource, SubmitOutcome};
use tokio::io::AsyncWriteExt as _;

/// What this seat tells a gateway it can do.
const CAPABILITIES: &[&str] = &["replica"];

/// The connection's version window, exchanged on its first stream.
///
/// Separate from [`GatewayLink`] because it happens ONCE per connection and a
/// link is made per borrow: folding it into a constructor would handshake twice
/// the moment `pass` wanted a source and a sink at the same time.
pub async fn handshake(connection: &IrohConnection, product_version: &str) -> Result<(), String> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|error| format!("the handshake stream would not open: {error}"))?;
    centraid_protocol::handshake::dial(
        &mut send,
        &mut recv,
        &local_hello(product_version, CAPABILITIES),
    )
    .await
    .map_err(|error| format!("the version window refused this seat: {error:?}"))?;
    send.flush()
        .await
        .map_err(|error| format!("the handshake would not flush: {error}"))?;
    let _ = send.finish();
    Ok(())
}

/// One borrow of an open connection, as a [`LogSource`] and an [`IntentSink`].
///
/// Holds no stream of its own. Every request opens one, and two of these over
/// the same connection are two independent request paths — which is exactly
/// what a pass needs, and what the one-stream-per-connection shape could not
/// give it.
pub struct GatewayLink<'a> {
    connection: &'a IrohConnection,
}

/// HOW A TAIL IS CLOSED FROM OUTSIDE THE PASS (#1025 S2, D-1025-S7-40).
///
/// A tail is quiet most of the time — that is the point of it — so a flag
/// checked between pages would not close one for as long as the vault stayed
/// still. This is a flag AND a wake: the reader selects on it, so "the member
/// left the foreground" lands on the stream within a scheduler tick rather than
/// at the next commit somebody else makes.
#[derive(Debug, Default)]
pub struct TailStop {
    stopped: AtomicBool,
    wake: tokio::sync::Notify,
}

impl TailStop {
    /// A stop nobody has pulled yet.
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Close every tail watching this stop. Idempotent, and safe from any
    /// thread: the shell calls it from wherever "the foreground was lost"
    /// arrives.
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // `notify_waiters` AND a flag: the flag is what a reader that has not
        // waited yet sees, and the wake is what a reader already parked on the
        // stream gets.
        self.wake.notify_waiters();
    }

    /// Clear it, so the next tail is not closed by the one before it.
    pub fn arm(&self) {
        self.stopped.store(false, Ordering::SeqCst);
    }

    /// Whether it has been pulled.
    #[must_use]
    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Wait until it is. Returns immediately if it already was.
    async fn pulled(&self) {
        loop {
            if self.is_stopped() {
                return;
            }
            // REGISTERED BEFORE THE FLAG IS RE-CHECKED, which is what
            // `notified()`'s two-step shape is for: a stop pulled between the
            // check above and the await below is still seen, because the future
            // is created first and the loop re-checks.
            let waiting = self.wake.notified();
            if self.is_stopped() {
                return;
            }
            waiting.await;
        }
    }
}

impl centraid_core::link::TailStopper for TailStop {
    fn stop(&self) {
        Self::stop(self);
    }
}

/// THE PAGES AN OPEN TAIL HAS ALREADY DELIVERED (#1025 S2, D-1025-S7-40).
///
/// **The reason this queue exists is a defect Slice 1 found on a real phone:**
/// with a tail open, every `Request::Page` on that core hung for ever. A pass
/// holds the vault for its whole length — `Handle::with_vault` is one mutex and
/// every read takes it — so a pass that also waited on a quiet network held the
/// vault while it waited, and the grid sat on a spinner that killing the gateway
/// did not release.
///
/// So the WAITING and the APPLYING are two different things on two different
/// threads. A reader task owns the stream and parks on it, holding nothing; it
/// pushes each page here. The core waits here too — **outside the vault** — and
/// only then takes the vault to apply what is already in hand. Every other call
/// is answerable in between, because between pages nobody is holding anything.
///
/// The queue is BOUNDED by the reader's own back-pressure: it pushes one page
/// and waits to be drained, so a gateway committing faster than this device can
/// apply is slowed by QUIC rather than by this device's memory.
#[derive(Default)]
pub struct TailPages {
    ready: Mutex<VecDeque<FetchOutcome>>,
    arrived: tokio::sync::Notify,
    drained: tokio::sync::Notify,
    closed: AtomicBool,
}

/// The most pages a reader will hold in front of an applier.
///
/// Two: one being applied and one in hand. A deeper queue buys nothing — the
/// pages are already durable on the gateway and it will still be there — and
/// costs a phone the memory of every page in it.
const TAIL_QUEUE_DEPTH: usize = 2;

impl TailPages {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Hand a page over, and wait until there is room to hand over the next.
    async fn deliver(&self, outcome: FetchOutcome) {
        loop {
            {
                let mut ready = self.ready.lock().unwrap_or_else(|held| held.into_inner());
                if ready.len() < TAIL_QUEUE_DEPTH {
                    ready.push_back(outcome);
                    self.arrived.notify_waiters();
                    return;
                }
            }
            self.drained.notified().await;
        }
    }

    /// Take the next page, if one is already here. **Never waits**: this is
    /// called from inside the vault lock and a wait there is the defect above.
    fn take(&self) -> Option<FetchOutcome> {
        let taken = self
            .ready
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .pop_front();
        if taken.is_some() {
            self.drained.notify_waiters();
        }
        taken
    }

    fn has_a_page(&self) -> bool {
        !self
            .ready
            .lock()
            .unwrap_or_else(|held| held.into_inner())
            .is_empty()
    }

    /// The stream is over. Whatever is already queued is still taken.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.arrived.notify_waiters();
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Wait until a page is here or the tail is over. `true` means there is
    /// something to apply. **Called outside the vault lock, always.**
    pub async fn wait(&self, until: Option<std::time::Instant>) -> bool {
        loop {
            if self.has_a_page() {
                return true;
            }
            if self.is_closed() {
                return false;
            }
            let waiting = self.arrived.notified();
            if self.has_a_page() {
                return true;
            }
            if self.is_closed() {
                return false;
            }
            match until {
                Some(at) => {
                    if tokio::time::timeout_at(tokio::time::Instant::from_std(at), waiting)
                        .await
                        .is_err()
                    {
                        return self.has_a_page();
                    }
                }
                None => waiting.await,
            }
        }
    }
}

/// A [`LogSource`] over pages a tail reader has ALREADY delivered.
///
/// Every method answers from memory. That is the whole point: this is the
/// source a pass uses while it holds the vault, and it can no more block on a
/// network than the applier can.
pub struct QueuedTail {
    pages: Arc<TailPages>,
}

impl QueuedTail {
    /// Read from what a tail reader has delivered.
    #[must_use]
    pub const fn over(pages: Arc<TailPages>) -> Self {
        Self { pages }
    }
}

impl LogSource for QueuedTail {
    fn fetch<'a>(
        &'a mut self,
        _epoch: &'a str,
        _since: i64,
        _limit: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchOutcome> + 'a>> {
        // A TAILING PASS NEVER TAKES THE ONE-SHOT DOOR. The catch-up came down
        // the tail's own stream, and a fetch here would be a second request for
        // pages this seat is already being sent.
        Box::pin(async move {
            self.pages.take().unwrap_or_else(|| {
                FetchOutcome::Unavailable("the tail has no page in hand".to_owned())
            })
        })
    }

    fn open_tail<'a>(
        &'a mut self,
        _epoch: &'a str,
        _since: i64,
        _limit: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchOutcome> + 'a>> {
        Box::pin(async move {
            self.pages.take().unwrap_or_else(|| {
                FetchOutcome::Unavailable("the tail has no page in hand".to_owned())
            })
        })
    }

    fn next_tail_page<'a>(
        &'a mut self,
        _deadline: Option<std::time::Instant>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<FetchOutcome>> + 'a>> {
        // `None` THE MOMENT THE QUEUE IS EMPTY, and the deadline is ignored on
        // purpose: waiting is the core's job and it does it with nothing held.
        // A pass that waited here would hold the vault while it did.
        Box::pin(async move { self.pages.take() })
    }

    fn tail_is_open(&self) -> bool {
        self.pages.has_a_page()
    }
}

/// Read an open tail stream until it ends, delivering each page.
///
/// **Holds no lock and touches no vault.** It is spawned once per tail and its
/// three ends are the same three a tail has: the gateway closed, the shell
/// pulled the stop, or the window's deadline arrived.
pub async fn read_tail(
    mut recv: RawRecv,
    pages: Arc<TailPages>,
    stop: Arc<TailStop>,
    deadline: Option<std::time::Instant>,
) {
    loop {
        let read = read_envelope(&mut recv);
        tokio::pin!(read);
        let expiry = async {
            match deadline {
                Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
                None => std::future::pending::<()>().await,
            }
        };
        let outcome = tokio::select! {
            answer = &mut read => match answer {
                Ok(Some(envelope)) => Some(decode_page(envelope)),
                // THE GATEWAY CLOSED THE TAIL. Not an error to escalate: a
                // window ending is the normal shape of a seat's life.
                Ok(None) => None,
                Err(error) => {
                    tracing::warn!(%error, "a tail stream ended unreadably");
                    None
                }
            },
            () = expiry => None,
            () = stop.pulled() => None,
        };
        let Some(outcome) = outcome else {
            pages.close();
            return;
        };
        // A RE-BOOTSTRAP OR A REFUSAL IS THE LAST THING THIS STREAM SAYS.
        let last = !matches!(outcome, FetchOutcome::Page(_));
        // THE BACK-PRESSURE IS HERE. `deliver` waits for room, which stops the
        // reader reading, which stops the gateway writing — a phone that cannot
        // keep up is slowed by QUIC rather than by its own memory.
        pages.deliver(outcome).await;
        if last {
            pages.close();
            return;
        }
    }
}

impl<'a> GatewayLink<'a> {
    /// Borrow an already-handshaked connection.
    #[must_use]
    pub const fn over(connection: &'a IrohConnection) -> Self {
        Self { connection }
    }

    /// One request, on one stream, answered once.
    ///
    /// The send half is FINISHED before the answer is read. That is what tells
    /// the gateway the request is whole — it reads to the end of the stream
    /// rather than guessing from a length — and it costs nothing, because a
    /// stream that carries one request has nothing more to send.
    async fn exchange(&mut self, request: core::Request) -> Result<core::Envelope, String> {
        let (mut send, mut recv) = self
            .connection
            .open_bi()
            .await
            .map_err(|error| format!("a request stream would not open: {error}"))?;
        let asked = centraid_protocol::wire::request(REQUEST_ID, request);
        write_envelope(&mut send, &asked)
            .await
            .map_err(|error| format!("the request would not write: {error}"))?;
        send.flush()
            .await
            .map_err(|error| format!("the request would not flush: {error}"))?;
        let _ = send.finish();
        match read_envelope(&mut recv).await {
            Ok(Some(envelope)) => Ok(envelope),
            // THE GATEWAY CLOSED. Not an error to escalate: a window ending is
            // the normal shape of a seat's life, and the next pass opens a new
            // connection.
            Ok(None) => Err("the gateway closed the stream without answering".to_owned()),
            Err(error) => Err(format!("an unreadable answer: {error}")),
        }
    }
}

/// How long a tail's own dial may take before it is called unreachable.
///
/// The same ten seconds every other dial has (D-1020-C9) and for the same
/// reason: it is a dial, on the same endpoint, to the same gateway.
pub const TAIL_DIAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// ASK FOR THE LOG AND STAY ON IT (#1025 S2, D-1025-S7-40).
///
/// One stream, opened once, read until it ends. The request is written and the
/// send half FINISHED — a tail sends exactly one request and has nothing more
/// to say — and the gateway then writes page after page down the recv half for
/// as long as both sides keep it.
///
/// The recv half comes back rather than being read here, because reading it is
/// [`read_tail`]'s job and that runs on a task of its own.
pub async fn ask_to_tail(
    connection: &IrohConnection,
    epoch: &str,
    since: i64,
) -> Result<RawRecv, String> {
    let (mut send, recv) = connection
        .open_bi()
        .await
        .map_err(|error| format!("a tail stream would not open: {error}"))?;
    // The same "absent means from the floor" rule `fetch` states, and for the
    // same reason: a cursor of zero is a resume point that never existed.
    let cursor = (since > 0).then(|| core::LogCursor {
        epoch: epoch.to_owned(),
        seq: u64::try_from(since).unwrap_or(0),
    });
    let asked = centraid_protocol::wire::request(
        REQUEST_ID,
        core::Request {
            kind: Some(core::request::Kind::Log(core::LogRequest {
                since: cursor,
                limit: u32::try_from(centraid_seat::sync::SYNC_PAGE_ROWS).unwrap_or(1_000),
                tail: true,
            })),
        },
    );
    write_envelope(&mut send, &asked)
        .await
        .map_err(|error| format!("the tail request would not write: {error}"))?;
    send.flush()
        .await
        .map_err(|error| format!("the tail request would not flush: {error}"))?;
    let _ = send.finish();
    Ok(recv)
}

/// The request id every request envelope carries.
///
/// ONE, AND IT IS A CONSTANT rather than a counter, because a stream carries
/// exactly one request and there is nothing to disambiguate. Zero is reserved
/// for the handshake and an envelope reader refuses it anywhere else.
const REQUEST_ID: u64 = 1;

impl LogSource for GatewayLink<'_> {
    fn fetch<'a>(
        &'a mut self,
        _epoch: &'a str,
        since: i64,
        limit: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchOutcome> + 'a>> {
        Box::pin(async move {
            // `since <= 0` means "from the floor" and is sent as ABSENT, not as
            // a zero cursor: `LogRequest.since` is optional and a gateway reads
            // a present cursor as a resume point. A seat with nothing applied
            // that sent `seq: 0` would be asking to resume from a seq that
            // never existed.
            let cursor = (since > 0).then(|| core::LogCursor {
                epoch: _epoch.to_owned(),
                seq: u64::try_from(since).unwrap_or(0),
            });
            let request = core::Request {
                kind: Some(core::request::Kind::Log(core::LogRequest {
                    since: cursor,
                    limit: u32::try_from(limit).unwrap_or(u32::MAX),
                    // A ONE-SHOT PAGE. `tail` is the stay-open request
                    // (D-1025-S7-40) and this call site is the windowed pass,
                    // which asks for what it can use inside its deadline and
                    // closes. Stated rather than defaulted, so a reader does
                    // not have to know which way proto3 falls.
                    tail: false,
                })),
            };
            match self.exchange(request).await {
                Ok(envelope) => decode_page(envelope),
                Err(reason) => FetchOutcome::Unavailable(reason),
            }
        })
    }

}

impl IntentSink for GatewayLink<'_> {
    fn submit<'s>(
        &'s mut self,
        record: &'s centraid_seat::IntentRecord,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = SubmitOutcome> + 's>> {
        // LIVE SINCE #1025 S2. The comment that stood here said the gateway had
        // no principal to attribute an intent to. It has one: `accept` proved
        // the DEVICE, and an intent is run under that device's principal with
        // its own idempotency key — which is the whole reason identity is
        // `(vault_id, intent_id, payload_hash)` and not the device.
        Box::pin(async move {
            let intent = match wire_intent(record) {
                Ok(intent) => intent,
                // A RECORD THIS BUILD CANNOT PUT ON THE WIRE. Reported as the
                // sink being unavailable rather than as a refusal, because a
                // refusal would burn the member's write: `Unavailable` leaves
                // it QUEUED, and a build that can encode it will send it.
                Err(why) => return SubmitOutcome::Unavailable(why),
            };
            let request = core::Request {
                kind: Some(core::request::Kind::Intent(intent)),
            };
            match self.exchange(request).await {
                Ok(envelope) => decode_outcome(&record.intent_id, envelope),
                Err(reason) => SubmitOutcome::Unavailable(reason),
            }
        })
    }
}

/// A queued intent, as the wire carries it.
///
/// The payload hash is the OUTBOX'S, not one computed here. It was computed
/// where the payload was built and it is what the gateway rehashes; recomputing
/// it at the door would make this function a second opinion about what the
/// member signed for, and the two would differ exactly when it mattered.
fn wire_intent(record: &centraid_seat::IntentRecord) -> Result<core::Intent, String> {
    Ok(core::Intent {
        intent_id: record.intent_id.clone(),
        app_id: record.app_id.clone(),
        action: record.action.clone(),
        // CANONICAL JSON IN BYTES, and canonical is the load-bearing word: the
        // gateway rehashes exactly these bytes.
        input: centraid_vault::intents::canonical_json(&record.input)
            .map_err(|error| format!("an intent's input is not canonical JSON: {error}"))?
            .into_bytes(),
        payload_hash: record.payload_hash.clone(),
        base_versions: record
            .base_versions
            .iter()
            .map(|version| core::BaseVersion {
                entity: version.entity.clone(),
                row_id: version.row_id.clone(),
                shape_id: version.shape_id.clone(),
                version: u64::try_from(version.version).unwrap_or(0),
            })
            .collect(),
        depends_on: record.depends_on.clone(),
        online_only: record.online_only,
        // THE BYTES THIS WRITE NEEDS (#1025 S3). Straight off the outbox row,
        // because they are IN the payload hash the row also carries: deriving
        // them here would be a second opinion about what the member signed for,
        // and the two would differ exactly when a photograph was involved.
        needs: record
            .needs_blobs
            .iter()
            .map(|need| core::NeededBytes {
                hash: need.hash.clone(),
                byte_size: u64::try_from(need.byte_size).unwrap_or(0),
                media_type: need.media_type.clone(),
            })
            .collect(),
    })
}

/// Turn the gateway's answer into the seat's own vocabulary.
///
/// The ten-state seat machine is NOT this enum (`intent.proto`), so the mapping
/// is explicit rather than a cast: `centraid_seat::settlement` decides what each
/// status does to the queue, and this function's only job is to say which
/// status arrived.
fn decode_outcome(intent_id: &str, envelope: core::Envelope) -> SubmitOutcome {
    use centraid_seat::intent::OutcomeStatus;
    match envelope.body {
        Some(core::envelope::Body::Response(core::Response {
            kind: Some(core::response::Kind::Outcome(outcome)),
        })) => {
            let status = match core::IntentStatus::try_from(outcome.status) {
                Ok(core::IntentStatus::Executed) => OutcomeStatus::Executed,
                Ok(core::IntentStatus::Denied) => OutcomeStatus::Denied,
                Ok(core::IntentStatus::Conflict) => OutcomeStatus::Conflict,
                Ok(core::IntentStatus::Parked) => OutcomeStatus::Parked,
                // `queued`, `sending`, `unspecified`, and anything a later
                // build answers that this one does not know. FAILED is the
                // safe normalisation: it is terminal, the member sees a write
                // that did not happen, and it never clears an overlay for rows
                // that are not there.
                _ => OutcomeStatus::Failed,
            };
            SubmitOutcome::Answered(centraid_seat::settlement::Answer {
                // THE ANSWER IS FOR THE INTENT THAT WAS SENT. A gateway that
                // named another id would settle somebody else's overlay, so the
                // id is taken from the REQUEST and the answer's own is only
                // checked against it.
                intent_id: intent_id.to_owned(),
                status,
                commit_seq: outcome
                    .commit_seq
                    .map(|seq| i64::try_from(seq).unwrap_or(i64::MAX)),
                conflicts: outcome
                    .conflicts
                    .iter()
                    .map(|conflict| centraid_seat::Conflict {
                        entity: conflict.entity.clone(),
                        row_id: conflict.row_id.clone(),
                        shape_id: conflict.shape_id.clone(),
                        expected_version: i64::try_from(conflict.expected_version).unwrap_or(0),
                        // ZERO MEANS THE ROW IS GONE, and it survives the
                        // conversion as zero rather than as an absence.
                        actual_version: i64::try_from(conflict.actual_version).unwrap_or(0),
                    })
                    .collect(),
                answered_versions: outcome
                    .answered_versions
                    .iter()
                    .map(|version| centraid_vault::intents::BaseVersion {
                        entity: version.entity.clone(),
                        row_id: version.row_id.clone(),
                        shape_id: version.shape_id.clone(),
                        version: i64::try_from(version.version).unwrap_or(0),
                    })
                    .collect(),
                waiting_on: outcome
                    .waiting_on
                    .iter()
                    .map(|waiting| centraid_seat::intent::WaitingOn {
                        seat: match core::WaitingOnSeat::try_from(waiting.seat) {
                            Ok(core::WaitingOnSeat::Owner) => {
                                centraid_seat::intent::WaitingOnSeat::Owner
                            }
                            Ok(core::WaitingOnSeat::Origin) => {
                                centraid_seat::intent::WaitingOnSeat::Origin
                            }
                            Ok(core::WaitingOnSeat::Intent) => {
                                centraid_seat::intent::WaitingOnSeat::Intent
                            }
                            // GATEWAY, and every value this build does not
                            // know. "The gateway is working on it" is the one
                            // wait that needs nobody to do anything, so an
                            // unknown wait cannot send a member to chase the
                            // wrong person.
                            _ => centraid_seat::intent::WaitingOnSeat::Gateway,
                        },
                        label: waiting.label.clone(),
                    })
                    .collect(),
                reason: (!outcome.reason.is_empty()).then(|| outcome.reason.clone()),
            })
        }
        // A REFUSAL IS NOT A VERDICT — **UNLESS THE CODE SAYS IT IS** (#1025
        // S5). A refused stream usually says nothing about whether the write
        // is allowed, only that this attempt did not land, so the intent stays
        // queued and the attempt count rises.
        //
        // But some refusals are about the REQUEST and no retry can change
        // them: a write naming a command this build does not register is
        // `INVALID_REQUEST` forever, and treating it as transient is an intent
        // that retries on every pass for the life of the install while the
        // member is told "Synced: 0 changes". The device found exactly that —
        // `attempts` climbing 1 → 2 → 3 against a gateway that answered the
        // same refusal each time — so a terminal code becomes a terminal
        // ANSWER, which moves the intent out of the queue and puts the code's
        // sentence where a member can see it.
        //
        // **THE SENTENCE COMES FROM THE CODE AND THE DETAIL GOES TO A LOG**
        // (#1025 S5). This used to put `Error.detail` in the reason, which then
        // travelled into `PassReport::blocked` — a value a shell would
        // eventually render, carrying a gateway's own words about a gateway's
        // own internals. `Error.detail` is never rendered; the code table is
        // where a member's words come from, and it is the same table every
        // other refusal in the product reads.
        Some(core::envelope::Body::Error(error)) => {
            tracing::warn!(
                code = error.code,
                detail = %error.detail,
                intent = intent_id,
                "the gateway refused an intent"
            );
            if is_terminal_refusal(&error) {
                // FAILED, the same normalisation an unknown status gets: it is
                // terminal, the member sees a write that did not happen, and
                // it never clears an overlay for rows that are not there.
                return SubmitOutcome::Answered(centraid_seat::settlement::Answer {
                    intent_id: intent_id.to_owned(),
                    status: OutcomeStatus::Failed,
                    commit_seq: None,
                    conflicts: Vec::new(),
                    answered_versions: Vec::new(),
                    waiting_on: Vec::new(),
                    reason: Some(refusal_sentence(&error)),
                });
            }
            SubmitOutcome::Unavailable(refusal_sentence(&error))
        }
        _ => SubmitOutcome::Unavailable("an answer that was not an outcome".to_owned()),
    }
}

/// Read a page, a re-bootstrap or a refusal out of one answer.
///
/// Carried from `crates/sim`'s `decode_page` because it is the same wire and
/// the same three outcomes; the simulation's copy stays where it is so a change
/// to one is visible as a divergence from the other rather than as a silent
/// shared edit.
fn decode_page(envelope: core::Envelope) -> FetchOutcome {
    match envelope.body {
        Some(core::envelope::Body::Response(core::Response {
            kind: Some(core::response::Kind::Log(page)),
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
        Some(core::envelope::Body::Response(core::Response {
            kind: Some(core::response::Kind::RebootstrapRequired(required)),
        })) => FetchOutcome::RebootstrapRequired {
            reason: rebootstrap_from_wire(required.reason),
            epoch: required.epoch,
            floor: i64::try_from(required.floor).unwrap_or(0),
            watermark: i64::try_from(required.watermark).unwrap_or(0),
            // THE BLOB TO TAKE, IN THE ANSWER THAT ASKS FOR IT (#1025 S7,
            // item 5). An empty hash is a gateway with nothing to offer — a
            // snapshot it could not build — and the seat then keeps the copy it
            // has and asks again, rather than a `snapshot_head` round trip that
            // would have been answered the same way.
            snapshot: (!required.snapshot_hash.is_empty()).then(|| {
                centraid_seat::sync::SnapshotOffer {
                    hash: required.snapshot_hash,
                    seq: i64::try_from(required.snapshot_seq).unwrap_or(0),
                    bytes: required.snapshot_bytes,
                }
            }),
        },
        // `Error.detail` is logs-only and must never reach a member, so the
        // value that travels into `PassReport::stale` is the CODE'S sentence
        // and the detail goes to a log line and a `doctor` run (#1025 S5).
        Some(core::envelope::Body::Error(error)) => {
            tracing::warn!(
                code = error.code,
                detail = %error.detail,
                "the gateway refused a log page"
            );
            FetchOutcome::Unavailable(refusal_sentence(&error))
        }
        _ => FetchOutcome::Unavailable("an answer that was not a page".to_owned()),
    }
}

/// WHETHER A GATEWAY'S REFUSAL IS ABOUT THIS REQUEST OR ABOUT THIS MOMENT
/// (#1025 S5).
///
/// A refusal about the REQUEST cannot be fixed by sending it again: the bytes
/// will be the same bytes next pass. Those become a terminal `FAILED` answer,
/// which takes the intent out of the queue and gives the member a sentence.
///
/// Everything else is about the MOMENT — the gateway is busy, the bytes are not
/// staged yet, something broke — and stays `Unavailable`, which leaves the
/// intent QUEUED with its attempt count raised. **The list is deliberately
/// short**: the cost of calling a transient refusal terminal is a write the
/// member loses, and the cost of the reverse is a retry, so anything not
/// obviously about the request itself belongs on the retry side.
fn is_terminal_refusal(error: &core::Error) -> bool {
    matches!(
        core::ErrorCode::try_from(error.code),
        Ok(core::ErrorCode::InvalidRequest
            | core::ErrorCode::UnsupportedMessage
            | core::ErrorCode::IntentHashMismatch
            | core::ErrorCode::MalformedFrame)
    )
}

/// A MEMBER'S SENTENCE FOR A GATEWAY'S REFUSAL, from the code and never the
/// detail (#1025 S5).
///
/// The gateway already puts one on the wire — `Error.sentence`, made from the
/// same table — so that is preferred and the local table is the fallback for a
/// peer that sent none. What is never used is `Error.detail`: it is a
/// developer's string about a gateway's internals, and this value ends up in
/// `PassReport::stale` and `PassReport::blocked`, which a shell draws.
fn refusal_sentence(error: &core::Error) -> String {
    if !error.sentence.is_empty() {
        return error.sentence.clone();
    }
    let code = core::ErrorCode::try_from(error.code).unwrap_or(core::ErrorCode::Unspecified);
    centraid_core::error::sentence_for_code(code).to_owned()
}

fn rebootstrap_from_wire(reason: i32) -> centraid_vault::RebootstrapReason {
    use centraid_vault::RebootstrapReason as R;
    match core::RebootstrapReason::try_from(reason) {
        Ok(core::RebootstrapReason::EpochMismatch) => R::EpochMismatch,
        Ok(core::RebootstrapReason::Retention) => R::Retention,
        Ok(core::RebootstrapReason::CursorAhead) => R::CursorAhead,
        Ok(core::RebootstrapReason::Initial) => R::Initial,
        // EVERY REASON A READER DOES NOT KNOW NORMALISES TO `InvalidCursor`, as
        // v0's door does and as `crates/sim` does: no raw error text reaches a
        // peer, and a wire enum this build predates must still produce a
        // re-bootstrap rather than a guess at which kind.
        _ => R::InvalidCursor,
    }
}
