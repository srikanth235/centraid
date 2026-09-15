//! The seam between the core and the network (#1020, D-1020-B7).
//!
//! ## Why a trait and not a dependency
//!
//! `crates/seat-link` owns the endpoint, the sync pass and the byte plane — and
//! it depends on `crates/core`, because a page it fetches is decoded with
//! `core::convert`. So the core cannot depend on it back. This trait is the
//! inversion: the core declares what it needs a network to do, and whoever
//! builds the process — `crates/core-ffi` for a phone, `crates/centraid` for a
//! desktop seat — attaches one.
//!
//! That is also the right layering on its own merits. A core with no network
//! attached is exactly a local-first vault, which is what a seat is between
//! windows and what every unit test in this crate wants to be.
//!
//! ## What the old comment got wrong
//!
//! `Handle::start_endpoint` refused with "which runtime a shell owns is the
//! shell's decision, so the core is handed one rather than making one." **A
//! Swift shell does not own a tokio runtime and never will**, so that was not a
//! deferral — it was a requirement nothing could satisfy, and it kept the
//! endpoint unbuilt for two waves. The runtime belongs to the implementation
//! behind this trait; `centraid_seat_link::SeatLink` owns one on threads of its
//! own. See D-1020-D2C: the same shape as the `Send` comment that kept the seat
//! lane shut.

/// Why a pairing did not happen.
///
/// **A CODE AND NEVER A SENTENCE.** `CoreError::sentence` is a table keyed by
/// code and nothing else, precisely so no database text, no path and no peer's
/// words can reach a member through an error; a refusal that carried its own
/// string would be a hole in that rule. The gateway's own vocabulary is three
/// coarse values for a second reason — a member holding a screenshot of an old
/// QR must not learn from the answer whether that ticket ever existed — and
/// this adds only the two failures that happen before a gateway is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRefusal {
    /// The text was not a Centraid ticket at all. Decided locally.
    NotATicket,
    /// The gateway did not answer. Not the ticket's fault, and the member's
    /// action is different: come back in range, do not mint a new code.
    Unreachable,
    /// The gateway refused it. A wrong secret and an unknown ticket are one
    /// value here because they are one value on the wire.
    Refused,
    /// The gateway refused it as expired.
    Expired,
}

/// A gateway this seat is paired to, as the core reports it.
///
/// Deliberately not `centraid_seat_link::PairedGateway`: this crate cannot name
/// that type, and a shell only needs the two facts it would show a member plus
/// the id it persists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedGateway {
    /// The gateway's iroh endpoint id, 32 raw bytes. THE AUTHORITY: iroh's TLS
    /// proves this and nothing else in this struct is proved by anything.
    pub endpoint_id: Vec<u8>,
    pub vault_id: String,
    pub vault_name: String,
    /// The device id the gateway filed this seat under.
    pub device_id: String,
    /// Where to reach the gateway through, when it uses a relay. A DIALLING
    /// HINT (#1025 S5): empty is a LAN-only deployment, not an error.
    pub relay_url: String,
    /// `<ip>:<port>` shortcuts. Hints with NO AUTHORITY — a stale or tampered
    /// address reaches the right gateway or nothing at all — which is what
    /// makes them safe to persist alongside the id that is proved.
    pub direct_addrs: Vec<String>,
    /// THE BLOB THIS PAIRING NAMED (#1025 S7, item 5).
    ///
    /// `None` when the gateway had none to offer, which does not fail the
    /// pairing: the ticket is burned and the device is enrolled either way, and
    /// a device that is paired with no file yet is a real state the shell draws
    /// ("Copying your vault").
    pub snapshot: Option<centraid_seat::sync::SnapshotOffer>,
    /// THE PUBLIC KEY THE GATEWAY SAID IT ENROLLED, 32 raw bytes (#1025 S7-13).
    ///
    /// Set only on the value a REDEMPTION produces — the gateway derives it
    /// from the connection its TLS proved — and empty on a gateway re-adopted
    /// from a record, where nothing was enrolled and there is nothing to say.
    /// It travels out to the shell on `PairOk` so the enrolment record can hold
    /// it and every later open can check the endpoint against it.
    pub enrolled_public_key: Vec<u8>,
}

/// WHY A DEVICE COULD NOT TAKE A COPY — a closed set, and never a sentence.
///
/// The same rule every other refusal in this crate follows: a code, and the
/// sentence from a table. [`Self::NoRoom`] carries two numbers because the
/// member's action depends on them — how much to free — and neither is a path,
/// a hash or a peer's words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BootstrapRefusal {
    /// There is no gateway to ask.
    NotPaired,
    /// The gateway named no artifact.
    NothingOffered,
    /// The gateway was not reached, or the window ended mid-transfer. **Not a
    /// failure**: every verified chunk group is durable and the next window
    /// resumes from it.
    Unreachable,
    /// THE ROOM CHECK, BEFORE THE FIRST BYTE (#1025 S7, item 3).
    ///
    /// A first bootstrap needs one copy of the artifact — it is ADOPTED, by
    /// rename, rather than expanded — and a re-bootstrap needs two, because the
    /// old file is still there until the new one is renamed over it. Checking
    /// afterwards is checking after a phone has filled its own disk.
    NoRoom { needed: u64, free: u64 },
    /// The artifact is a copy of a different vault. Refused before this
    /// device's own file is touched.
    WrongVault,
    /// Something else, already logged. The member is told the generic sentence.
    Failed,
}

/// HOW LONG THIS PASS HAS AND WHAT IT MAY SPEND — the shell's numbers, not the
/// core's (#1025 S2, D-1025-S2-3).
///
/// The core used to hold both as constants: a 60-second per-plane ceiling in
/// `centraid_seat_link` and `Budget::foreground()` on every pass `core-ffi`
/// ever attached. Neither is a fact the core can know. iOS hands a
/// `BGAppRefreshTask` an expiry it chose, Android stops a worker when its own
/// budget runs out, and a member tapping "sync now" has no expiry at all — so a
/// constant in the middle outlives the first and cuts the third.
///
/// **A window the deadline cuts is a NORMAL END.** The pass reports what it
/// kept: every applied commit is committed, every verified chunk group is
/// durable, and the next pass continues from there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncWindow {
    /// How long from now the caller's window lasts. A DURATION rather than an
    /// instant, because the shell's clock and the core's are the same clock
    /// only by luck and a skewed absolute deadline is either already past or
    /// never reached.
    pub deadline: std::time::Duration,
    /// The most payload bytes the byte plane may move. `None` leaves the
    /// implementation's own default, which is what a foreground pass wants.
    pub budget_bytes: Option<u64>,
    /// The most blobs the byte plane may ask for, however small.
    pub budget_items: Option<usize>,
    /// WHICH OF `crates/blobs`'s THREE WINDOWS THIS IS (#1025 S5).
    ///
    /// The three shapes have existed since #1020 and nothing could pick
    /// between them: `core-ffi` attached `Budget::foreground()` to every pass,
    /// so a thirty-second cellular refresh and a night on the charger asked
    /// for the same thing. [`Self::budget_bytes`] and [`Self::budget_items`]
    /// still override what this selects — a caller with a real number keeps
    /// it — but a shell with only a situation now has a way to say which one.
    pub budget: SyncBudget,
    /// THE MEMBER IS PAYING BY THE MEGABYTE.
    ///
    /// Separate from the selector because it is separately true, and it
    /// changes WHAT is fetched rather than how much: no originals cross a
    /// metered link at all. A byte ceiling could not have done it — the
    /// planner admits an item larger than the whole budget on purpose, which
    /// is the only way a 900 MB video ever crosses.
    pub metered: bool,
    /// THE MEMBER'S TRANSFER RULE (#1025 S4, D-1025-S7-60).
    ///
    /// The third input to "may this window fetch an original", beside
    /// [`Self::metered`] and the budget selector. A fact about the MEMBER
    /// rather than about the link, kept in the shell's secure store, one per
    /// DEVICE and not per vault — what it governs is a data plan, and a phone
    /// has one data plan however many vaults it holds.
    ///
    /// A SELECTOR AND NEVER A BYTE COUNT. `crates/blobs` does the arithmetic;
    /// nothing in Kotlin or Swift computes any part of it.
    pub originals: TransferRule,
    /// THE ONE BLOB A MEMBER TAPPED (#1025 S5, D-1025-S7-63).
    ///
    /// WhatsApp's download arrow. It narrows the byte stage to that blob and
    /// suspends the tier rules for it — a member who tapped has overridden the
    /// rule for that item, and a window that then withheld it would be
    /// answering a tap with nothing.
    ///
    /// A fetch is an ORDINARY PASS with a one-item window: it writes
    /// `seat_blob_held` like any landed blob, so the screen refreshes through
    /// the same `RowsChanged` (D-1025-S7-21) and there is no second way for a
    /// byte to become a row.
    pub fetch: Option<centraid_blobs::ContentHash>,
    /// THIS WINDOW IS A TAIL (#1025 S2, D-1025-S7-40).
    ///
    /// ONE MECHANISM, THREE OCCASIONS. A seat becomes current by connecting,
    /// tailing the log from its durable cursor and staying open as long as the
    /// OS allows; the occasions are a foreground the member is looking at, a
    /// bounded background window, and a relaunch. Polling and foreground
    /// timers are deleted concepts, and nothing in this crate holds one.
    ///
    /// `false` is a bounded catch-up: the same pass, closing at the last
    /// page. That is what the other holdings of a sync round get, and what a
    /// desktop `sync now` is.
    pub tail: bool,
}

/// Which window a shell says this pass is.
///
/// [`Self::Foreground`] is the default because it is what "no budget was
/// named" has always meant: a desktop "sync now" and a developer at a
/// terminal, neither of which has anything held back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncBudget {
    #[default]
    Foreground,
    /// iOS's `BGAppRefreshTask`: about thirty seconds, possibly cellular.
    ShortRefresh,
    /// Charging, unmetered, and usually one LAN hop from the gateway.
    NightShift,
}

/// THE MEMBER'S TRANSFER RULE, as the core spells it (#1025 S4).
///
/// One value, three cases, and the arithmetic lives in
/// `centraid_blobs::Budget::admits_original` — this is the value travelling.
/// Named here for the reason [`SyncBudget`] is: `crates/seat` owns the loop's
/// spelling, `crates/blobs` the planner's, and one conversion in one place
/// keeps three names from becoming three rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TransferRule {
    /// THE DEFAULT. Originals wait for a link the member is not paying for —
    /// the rule whose failure mode is a late photograph rather than a bill.
    #[default]
    WifiOnly,
    /// A photograph's original may cross a metered link; a video's may not.
    /// The second half is fixed and is not a fourth setting.
    WifiAndCellularPhotos,
    /// No original crosses on any link unless the member taps it
    /// ([`SyncWindow::fetch`]).
    Manual,
}

impl SyncWindow {
    /// A window with no expiry and no ceiling: what a desktop "sync now" is.
    ///
    /// Deliberately NOT `Default`: a caller that reached for a default would
    /// get "as long as it takes" on a phone, which is the constant this type
    /// exists to delete. Asking for it by this name is a decision.
    #[must_use]
    pub const fn unbounded() -> Self {
        Self {
            // Not `Duration::MAX`: `tokio::time::timeout` computes an `Instant`
            // from it and an overflowing addition panics on some platforms. A
            // day is past every window any caller has and still arithmetic.
            deadline: std::time::Duration::from_secs(86_400),
            budget_bytes: None,
            budget_items: None,
            budget: SyncBudget::Foreground,
            metered: false,
            // THE DEFAULT RULE, and a desktop seat's own: a machine on a wired
            // link is not paying by the megabyte, and the rule is then the one
            // that admits everything.
            originals: TransferRule::WifiOnly,
            fetch: None,
            // A DESKTOP `sync now` CATCHES UP AND STOPS. Asking for a tail is a
            // decision a caller makes by name, never one a default makes for it.
            tail: false,
        }
    }
}

/// WHAT ONE SYNC PASS ACHIEVED — a projection, and nothing of its own
/// (#1025 S7).
///
/// This used to be a dozen flat fields, and every one of them was a decision
/// made twice: `centraid_seat_link` flattened its two reports into them, and a
/// shell read them back and inferred the state again. Each field was added the
/// first time somebody could not tell two outcomes apart — `stale`, `blocked`,
/// `bytes_stalled`, `blobs_refused`, `originals_withheld` — and the one nobody
/// had thought of came back as four zeros and no error every time.
///
/// There is one report now, it is [`centraid_seat::sync::PassReport`], and it
/// comes out of the one state machine in `crates/seat`. This type carries it,
/// plus the two facts the CORE knows and the pass does not: whether this seat
/// has parked, and the sentence a member reads. Everything else on here is a
/// method over the report, so a number and the stage it came from cannot
/// disagree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncOutcome {
    /// The pass, stage by stage. The shell RENDERS this and computes nothing.
    pub report: centraid_seat::sync::PassReport,
    /// This seat is PARKED: the repair ran three times in a row and ended under
    /// the floor each time (#1025 S2, D-1025-S2-4). Nothing has been wiped —
    /// the copy and the outbox are exactly as they were — and the remedy is a
    /// gateway that stops outrunning this device, not another download.
    ///
    /// The core's own, because it is about CONSECUTIVE passes and a pass sees
    /// one.
    pub parked: bool,
    /// A member-facing sentence when something is worth saying. Never a detail,
    /// never a path, never a hash.
    pub sentence: String,
}

impl SyncOutcome {
    /// Rows this pass applied.
    #[must_use]
    pub fn rows_applied(&self) -> u64 {
        self.report.rows_applied() as u64
    }

    /// Blobs that became whole in this window.
    #[must_use]
    pub fn blobs_completed(&self) -> u64 {
        self.report
            .bytes
            .moved()
            .map_or(0, |bytes| bytes.completed as u64)
    }

    /// Payload bytes that crossed.
    #[must_use]
    pub fn bytes_moved(&self) -> u64 {
        self.report.bytes.moved().map_or(0, |bytes| bytes.moved)
    }

    /// Blobs left for a later window.
    #[must_use]
    pub fn blobs_deferred(&self) -> u64 {
        self.report
            .bytes
            .moved()
            .map_or(0, |bytes| bytes.deferred as u64)
    }

    /// Blobs the gateway would not serve, on a link that stayed up.
    #[must_use]
    pub fn blobs_refused(&self) -> u64 {
        self.report
            .bytes
            .moved()
            .map_or(0, |bytes| bytes.refused as u64)
    }

    /// Originals this window refused to ask for because the link is metered.
    #[must_use]
    pub fn originals_withheld(&self) -> u64 {
        self.report
            .bytes
            .moved()
            .map_or(0, |bytes| bytes.withheld as u64)
    }

    /// The gateway refused this seat's cursor: the copy it holds is under the
    /// floor, or of another epoch. **Not a failure** — it is the ordinary end
    /// of a seat that was away longer than the log is kept, and the remedy is
    /// the one path a bootstrap already is.
    #[must_use]
    pub const fn rebootstrap_required(&self) -> bool {
        self.report.rebootstrap.is_some()
    }

    /// The gateway could not be reached. **A state, not a failure**: the seat
    /// is stale, it still reads, and the next window continues.
    #[must_use]
    pub fn unreachable(&self) -> bool {
        !self.report.reached_the_gateway()
    }

    /// Whether this pass reached the gateway. A pass that did not is not a
    /// failure a member needs told about — it is being on a train.
    #[must_use]
    pub fn reached_the_gateway(&self) -> bool {
        self.report.reached_the_gateway()
    }

    /// The deadline ended this window before it ran out of work.
    ///
    /// **NOT A FAILURE** (#1025 S2). It is the ordinary shape of a background
    /// refresh: what landed is durable and the next pass continues from it. A
    /// shell draws "still catching up", never an error.
    #[must_use]
    pub fn cut_by_the_deadline(&self) -> bool {
        self.report.cut_by_the_deadline()
    }
}

/// HOW A TAIL IS CLOSED FROM OUTSIDE THE PASS (#1025 S2, D-1025-S7-40).
///
/// One method, because there is one thing to say. The implementation is
/// `centraid_seat_link::TailStop`, which is a flag AND a wake: a tail is quiet
/// most of the time — that is the point of it — so a flag alone would not close
/// one until the next commit somebody else made.
///
/// `Send + Sync` and never `&mut`, because the caller is whichever thread
/// learned that the member left: the main one on both phones.
pub trait TailStopper: Send + Sync {
    /// Close it. Idempotent, non-blocking, and a no-op when no tail is open.
    fn stop(&self);
}

/// WHO IS TOLD THAT THIS VAULT'S WATERMARK MOVED (#1025 S2, D-1025-S7-40).
///
/// The gateway's half of the tail. A seat tailing this vault is a task parked
/// on a wake, and this is the wake: the core rings it after every request that
/// may have written, and the lane serving that seat reads the log from where it
/// left off. **It carries no payload on purpose** — not a seq, not a table, not
/// a row — because the thing that knows what to send is the log door, and a
/// number handed across here would be a second opinion about the same fact.
///
/// A ring is ALLOWED TO BE SPURIOUS and never allowed to be missed: the reader
/// answers a ring that moved nothing with a page it does not write, and a miss
/// is a row a member is waiting for.
///
/// The core has no runtime, no channel and no opinion about scheduling, which
/// is why this is a trait the process builder implements rather than a
/// `tokio::sync::watch` in a crate that does not depend on tokio.
pub trait CommitBell: Send + Sync {
    /// Something committed. Non-blocking, and called on the writing thread.
    fn rang(&self);
}

/// What the core needs a network to do. Implemented by `crates/seat-link`.
///
/// Every method is SYNCHRONOUS, because `Handle::call` is: a shell asking one
/// question wants one answer and should not need an executor in Swift. The
/// implementation blocks on its own runtime, and none of these may be called on
/// a UI thread.
pub trait SeatNetwork: Send + Sync {
    /// This seat's endpoint id — what lands in a gateway's allowlist.
    fn endpoint_id(&self) -> [u8; 32];

    /// Redeem a pairing ticket.
    fn pair(
        &self,
        encoded: &str,
        device_name: &str,
        platform: &str,
    ) -> Result<PairedGateway, PairRefusal>;

    /// The gateway this seat is paired to, if any.
    fn gateway(&self) -> Option<PairedGateway>;

    /// ASK WHAT COPY THIS GATEWAY WOULD GIVE THIS DEVICE (#1025 S7, item 5).
    ///
    /// For the one state that has no other way to find out: **paired, and no
    /// file yet**. The offer arrives on `PairOk` and on `RebootstrapRequired`,
    /// and a device whose first copy did not land has neither any more — the
    /// pairing came back out of the shell's secure store and a `PairOk` is
    /// one-shot.
    ///
    /// It is NOT a `snapshot_head` request come back. There is no such request:
    /// this asks for a LOG PAGE from a cursor this seat does not have, and the
    /// gateway's refusal is the answer — `RebootstrapRequired`, carrying the
    /// head. A seat with no cursor asking for the log and being told to
    /// bootstrap is the same conversation every seat under the floor has.
    ///
    /// `None` is a gateway that was not reached or had nothing to offer. Both
    /// leave the device where it was: paired, with no file, and asking again.
    fn offer(&self) -> Option<centraid_seat::sync::SnapshotOffer>;

    /// TAKE BACK A PAIRING THE REPLICA REMEMBERS (#1025 S5).
    ///
    /// The implementation holds its gateway in memory and `sync` refuses
    /// outright when it has none — so a seat that reopened dialled NOTHING, was
    /// reported unreachable, and left no trace on the gateway at all. The
    /// record itself is durable in the replica (`centraid_seat::gateway`); this
    /// is how the core puts it back after an open, and it is why pairing is
    /// still one-shot: coming back is not re-pairing and must not burn a
    /// second ticket.
    fn adopt(&self, gateway: PairedGateway);

    /// Take a fresh copy of the vault and put it at this seat's replica path
    /// (#1025 S1, rewritten for S7 item 3).
    ///
    /// **The core has closed its vault before this is called and opens it
    /// after.** The implementation publishes the new file by rename, which
    /// nothing may hold open. The path is the implementation's own — it is
    /// constructed per replica — so there is nothing to pass and nothing for
    /// the core to get wrong.
    ///
    /// `offer` is the blob the gateway named, on `PairOk` or on
    /// `RebootstrapRequired`. It is passed in rather than asked for: the
    /// request that asked for it is deleted, and a device that had to ask would
    /// have a state in which it is told to take a copy and does not know which.
    ///
    /// `adopt` IS THE FOREGROUND/BACKGROUND DECISION (#1025 S7, item 3).
    /// `false` fetches the bytes and stops: every verified chunk group is
    /// durable and the next foreground window adopts what this one paid for.
    /// Adoption closes the vault, renames a file into place and reopens it, and
    /// a thirty-second background refresh cut halfway through that is a member
    /// looking at a device that went blank and came back.
    ///
    /// The refusal is a CODE (`BootstrapRefusal`) and never a string. It never
    /// reaches a member as itself: the core turns it into a sentence from the
    /// code table.
    fn bootstrap(
        &self,
        offer: &centraid_seat::sync::SnapshotOffer,
        adopt: bool,
    ) -> Result<centraid_seat::sync::BootstrapMoved, BootstrapRefusal>;

    /// Run one sync pass against the replica behind `connection`, inside
    /// `window`.
    ///
    /// The CONNECTION IS THE CORE'S, handed down rather than opened by the
    /// network: SQLite allows one writer and the core holds it, so a connection
    /// opened on the other side of this trait would contend with its owner and
    /// the loser would be whichever asked second.
    ///
    /// The WINDOW IS THE CALLER'S for the reason [`SyncWindow`] states, and it
    /// bounds the whole pass rather than each plane: a phone gets one expiry,
    /// not one per plane, and a per-plane ceiling would let two of them add up
    /// to twice the window the OS actually gave.
    ///
    /// `changes` IS THE CORE'S EVENT QUEUE, HANDED DOWN (#1025 S5). The queue
    /// is on `Handle` and the applier is two crates below it, so the
    /// alternative was `crates/seat` depending on `crates/core`, which is the
    /// wrong way round — the core already depends on the seat. So the sink
    /// travels down with the connection, and the implementation's only job is
    /// to give it to `centraid_seat::sync::pass`.
    ///
    /// Nothing pushed a change event before this parameter existed. The queue
    /// was built, bounded, coalescing and tested; `Handle::next_event` drained
    /// it; and a shell that waited for a row to arrive waited forever.
    fn sync(
        &self,
        connection: &rusqlite::Connection,
        window: SyncWindow,
        changes: &dyn centraid_seat::sync::ChangeSink,
    ) -> centraid_seat::sync::PassReport;

    /// EVERY WHOLE BLOB THE BYTE STORE HOLDS, with the file it holds it in
    /// (#1025, D-1025-S7-20).
    ///
    /// The seat keeps a row per held blob so a page read can join it and fill
    /// a cell's `thumbnail_path` in one statement. That table is a PROJECTION
    /// of the store, and a projection only ever written incrementally drifts —
    /// a crash between a fetch and its insert, a file removed underneath the
    /// app, a replica carried across a re-bootstrap while the store was not.
    /// Drift here is invisible, because a missing row draws exactly like a
    /// photograph that has not arrived, so the core rebuilds the table from
    /// this at every open and after every adoption.
    ///
    /// `None` is a network with no store to ask — the test double, a seat
    /// whose store would not open — and it leaves the table ALONE. Reading it
    /// as "this device holds nothing" would clear a correct table on the one
    /// occasion nobody could measure it.
    fn held_blobs(&self) -> Option<Vec<centraid_seat::HeldBlob>>;

    /// THE THING THAT CLOSES THIS NETWORK'S TAIL (#1025 S2, D-1025-S7-40).
    ///
    /// Handed out at `attach_network` and kept on the handle, because
    /// [`Self::sync`] holds the network for the whole of a pass — and a tail IS
    /// the whole of a pass. A "stop" that had to take the same lock could only
    /// ever be answered after the thing it was stopping had already ended.
    ///
    /// `None` is a network that cannot tail, which is every test double and
    /// every seat with no gateway.
    fn tail_stopper(&self) -> Option<std::sync::Arc<dyn TailStopper>>;

    /// OPEN A TAIL FROM `since`, and leave something reading it (#1025 S2,
    /// D-1025-S7-40).
    ///
    /// `false` is a tail that could not be opened — no gateway, no answer, a
    /// refusal — which is a state and not a failure: the next window asks
    /// again. An implementation must NOT block on the vault or on anything the
    /// rest of the core wants; the caller is standing outside its own vault
    /// mutex precisely so that everything else stays answerable.
    fn start_tail(&self, epoch: &str, since: i64, deadline: std::time::Instant) -> bool;

    /// Whether a tail is open right now.
    fn tail_is_open(&self) -> bool;

    /// WAIT — WITH NOTHING HELD — until the tail has a page to apply.
    ///
    /// `false` means there will be no more. **This is the only place a tail
    /// blocks**, and the whole reason it is a method of its own: a pass holds
    /// the vault for its length, so a pass that also waited on a quiet network
    /// held the vault while it waited — and every read on that core hung until
    /// somebody else committed something. Slice 1 found exactly that on a
    /// phone: a grid on a spinner that killing the gateway did not release.
    fn await_tail_page(&self, until: std::time::Instant) -> bool;

    /// Apply what the tail has ALREADY delivered, and return.
    ///
    /// Called with the vault held, so it must touch no network it could wait
    /// on: the rows are in hand, and the write and byte planes ride the tail's
    /// own live connection. It returns the moment there is nothing left in
    /// hand, which is what keeps the vault free between pages.
    fn apply_tail(
        &self,
        connection: &rusqlite::Connection,
        window: SyncWindow,
        changes: &dyn centraid_seat::sync::ChangeSink,
    ) -> centraid_seat::sync::PassReport;

    /// Release the socket. What a backgrounded phone does.
    fn idle(&self);

    /// Bind again. The endpoint id survives, so every gateway that enrolled
    /// this seat still recognises it.
    fn resume(&self) -> Result<(), String>;
}

/// The 32 raw bytes a lowercase-hex endpoint id spells, or `None`.
///
/// The exact inverse of [`hex_lower`], beside it so the two cannot drift. A
/// value that is not 64 hex characters answers `None` rather than a truncated
/// id: half an endpoint id is a peer that does not exist, and dialling it would
/// fail somewhere far from the row that was wrong.
#[must_use]
pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 {
        return None;
    }
    (0..32)
        .map(|index| u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok())
        .collect()
}

/// Lowercase hex, for an endpoint id a shell persists and shows.
///
/// The same spelling `centraid_net::allowlist::hex_lower` produces, because the
/// two values are compared by eye in logs and by string in a shell's storage.
#[must_use]
pub fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
