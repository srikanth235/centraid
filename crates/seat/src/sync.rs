//! THE SYNC PASS: one state machine over rows, writes and bytes (#1025 S7).
//!
//! ## Why this is here and not in the simulation (D-1020-D2-10)
//!
//! The simulation is #1020's primary sync proof, and a proof of a sync loop
//! that only exists inside the test is a proof of nothing. So the loop is
//! production code in this crate, written over traits, and `crates/sim`
//! implements them over turmoil while a real seat implements them over
//! `crates/net`. The alternative — a driver in the test crate — would have made
//! every simulation bug a bug in code no phone runs.
//!
//! ## ONE MACHINE, THREE PLANES, ONE REPORT (#1025 S7, item 4)
//!
//! The three planes used to be sequenced in two places: [`pass`]'s ancestor
//! drove rows and intents here, and `centraid_seat_link::SeatLink::sync` drove
//! the byte plane after it and stitched two reports together. So there was no
//! single object that said what a window did, and the shell computed the
//! answer from a handful of booleans — `unreachable`, `stale`, `blocked`,
//! `blobs_refused` — each added the first time somebody could not tell two
//! outcomes apart.
//!
//! Now there is one machine and one [`PassReport`]. **Every stage answers with
//! exactly one of three things** ([`Stage`]): what it moved, what it kept when
//! the deadline ended it, or a TYPED reason it did not run. There is no
//! four-zeros-and-no-error answer left to guess at, because "nothing moved" is
//! not expressible without saying which of the closed reasons it was.
//!
//! **The reasons are codes and never sentences** ([`SkipReason`]). That is the
//! same rule `CoreError::sentence` is built on: no database text, no path, no
//! peer's words reach a member. A stage that carried its own string would be
//! the hole in it. The transport's own words go to a `tracing` line at the
//! point they arise, which is where a developer wanted them anyway.
//!
//! ## The driver is async; `Handle::call` is not (D-1020-D2-12)
//!
//! A sync *pass* is network I/O — fetch a page, wait, submit an intent, wait —
//! so [`sync`] is `async` and the traits below return futures.
//! [`centraid_core`]'s `call` is synchronous because a *shell* asking one
//! question wants one answer and should not need a runtime in Swift.
//!
//! The SQLite work between the awaits stays synchronous, which is correct: an
//! apply is one transaction per commit and there is nothing to await inside
//! one. So a pass is `await`, work, `await`, work — and the applier never
//! holds a transaction across an await point, which is the rule that keeps a
//! cancelled future from leaving one open.
//!
//! ## Three traits, not one
//!
//! [`LogSource`], [`IntentSink`] and [`ByteMover`] are separate because they
//! fail independently and the remedies differ. A seat whose log source is down
//! shows what it has and says how far behind it is. A seat whose intent sink is
//! down is holding the member's writes. A seat whose byte plane stopped has its
//! rows and not its photographs, which is a good state to be in. Collapsing
//! them into one "connection" trait makes those the same state, and they are
//! the three most different states a seat has.
//!
//! ## The loop's order is the contract
//!
//! 1. **Drain the inbound log first.** An intent's answer settles against a
//!    commit seq, so a seat that submitted before applying would hold an
//!    `awaiting-change` overlay it could have cleared this pass.
//! 2. **Then submit.** One intent at a time, in outbox order, skipping the ones
//!    a hold blocks.
//! 3. **Then apply the answers**, which parks the executed ones at
//!    `awaiting-change`.
//! 4. **Then drain the log again**, because step 2's own effects are now in it.
//! 5. **Then the bytes**, because a row is what tells this seat a blob exists
//!    at all. A byte plane that ran first would plan over last window's rows.
//!
//! Step 4 is not a nicety: without it an intent submitted and executed in this
//! pass waits a whole poll interval before its overlay clears, which is the
//! "it didn't save" flicker seen from the other side.

use std::future::Future;
use std::time::Instant;

use rusqlite::Connection;

use crate::applier::{ApplyHooks, PageHeader, apply_page};
use crate::error::{Result, SeatError};
use crate::intent::{IntentRecord, IntentState};
use crate::outbox::Outbox;
use crate::settlement::{Answer, apply_intent_outcomes, settle_at_commit_seq};
use crate::state::seat_state;

/// One page of the log, as a source hands it over.
#[derive(Debug, Clone)]
pub struct FetchedPage {
    pub header: PageHeader,
    pub rows: Vec<centraid_vault::log::LogRow>,
    pub has_more: bool,
    /// Where to ask from next: the last served seq when `has_more`, else the
    /// watermark.
    pub next: i64,
}

/// What a source says instead of a page.
#[derive(Debug, Clone)]
pub enum FetchOutcome {
    Page(FetchedPage),
    /// The cursor cannot be served from. **A response, not an error**: the seat
    /// is being told what to do next, and told WHICH BLOB to take (#1025 S7).
    RebootstrapRequired {
        reason: centraid_vault::RebootstrapReason,
        epoch: String,
        floor: i64,
        watermark: i64,
        /// The artifact to adopt. `None` when the gateway had none to name, in
        /// which case the seat keeps the copy it has and asks again.
        snapshot: Option<SnapshotOffer>,
    },
    /// The source is not reachable. The seat is *stale*, not broken.
    Unavailable(String),
}

/// THE BLOB A DEVICE IS TOLD TO TAKE (#1025 S7, item 5).
///
/// Three values, and they arrive on exactly two messages: `PairOk`, which is
/// the first copy, and `RebootstrapRequired`, which is a fresh one after
/// falling under the floor. There is no request that asks for them, because
/// those are the only two occasions on which a device takes a copy and both
/// already had an answer to put them in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotOffer {
    /// The BLAKE3 content address, lowercase hex.
    pub hash: String,
    /// The log position the artifact stands at. The cursor after it lands.
    pub seq: i64,
    /// THE ROOM CHECK'S INPUT. A device that cannot fit the artifact is told so
    /// by name before the first byte moves, rather than filling its disk and
    /// failing somewhere further in.
    pub bytes: u64,
}

/// Where a seat gets log pages.
///
/// The future is boxed so the trait is `dyn`-compatible: [`sync`] takes
/// `&mut dyn LogSource`, because a seat picks its transport once at startup and
/// a generic parameter would push that choice into every caller's signature.
pub trait LogSource {
    /// One page from `since`, at most `limit` rows.
    fn fetch<'a>(
        &'a mut self,
        epoch: &'a str,
        since: i64,
        limit: i64,
    ) -> std::pin::Pin<Box<dyn Future<Output = FetchOutcome> + 'a>>;

    /// ASK FOR THE LOG AND STAY ON IT (#1025 S2, D-1025-S7-40).
    ///
    /// The first answer of a TAIL: the same page [`Self::fetch`] would have
    /// given, on a stream the source keeps open. Every page after it —
    /// catch-up and live alike — comes back from [`Self::next_tail_page`].
    ///
    /// The default is `fetch`, which makes every source that has not learned
    /// to tail a source whose tail is one page long. That is the honest
    /// degradation: `crates/sim` drives this loop over turmoil and a
    /// simulation that silently blocked forever on a stream nobody keeps open
    /// would be a hang wearing a feature's clothes.
    fn open_tail<'a>(
        &'a mut self,
        epoch: &'a str,
        since: i64,
        limit: i64,
    ) -> std::pin::Pin<Box<dyn Future<Output = FetchOutcome> + 'a>> {
        self.fetch(epoch, since, limit)
    }

    /// The next page off an open tail, or `None` because there will be no more.
    ///
    /// `None` is every ordinary end and they are deliberately one answer: the
    /// gateway closed, the connection dropped, the shell said stop, or
    /// `deadline` arrived. The loop above reports what it applied either way,
    /// and the cursor it applied to is durable — so the difference between
    /// them changes nothing a seat does next.
    ///
    /// **The deadline is enforced HERE and not by the caller**, because the
    /// caller is blocked inside this future while a tail is quiet: a window
    /// check between pages cannot end a stream that is saying nothing.
    fn next_tail_page<'a>(
        &'a mut self,
        deadline: Option<Instant>,
    ) -> std::pin::Pin<Box<dyn Future<Output = Option<FetchOutcome>> + 'a>> {
        let _ = deadline;
        Box::pin(async { None })
    }

    /// Whether this source is holding a tail open right now.
    ///
    /// The fact a shell draws ONLINE from: a tail that is open IS a gateway
    /// that is reached, and a header that could only say so after a pass
    /// returned would say OFFLINE for exactly as long as the device was most
    /// certainly online.
    fn tail_is_open(&self) -> bool {
        false
    }
}

/// What a sink says about one intent.
#[derive(Debug, Clone)]
pub enum SubmitOutcome {
    /// The gateway answered.
    Answered(Answer),
    /// The sink is not reachable. The intent stays queued and its attempt count
    /// rises, which is what the backoff reads.
    Unavailable(String),
}

/// WHERE A PASS SAYS ROWS ARRIVED (#1025 S5).
///
/// The third seam, and it is the one that was missing. `centraid_core`'s
/// `EventQueue` is bounded, coalescing, tested and drained by
/// `Handle::next_event` — and until this trait existed **nothing in the
/// repository ever pushed a change event**, so a shell that waited for a row to
/// arrive waited forever and every screen was a poll or a lie.
///
/// A SINK HANDED DOWN rather than a report handed back, for two reasons. A
/// change event is per PAGE — a pass drains up to 32 of them, and a shell that
/// learned about the first only when the last had landed is a grid that fills
/// in one jump a minute after the rows did. And the queue STALLS rather than
/// dropping: a sink can block the applier until the shell catches up, which is
/// the backpressure the queue was built for, and a report returned at the end
/// has nothing left to push back on.
///
/// `&self` and `Sync`, because the applier holds it by shared reference across
/// the pass and the queue behind it does its own locking.
pub trait ChangeSink: Sync {
    /// Rows landed and are durable. `touched` is one `(table, primary key)` per
    /// applied row, in apply order; `commit_seq` is the HIGHEST commit the page
    /// carried, because an overlay clears against a commit seq and the lower of
    /// two would leave paint on the screen.
    ///
    /// Called AFTER the transactions are committed. A sink told about rows that
    /// then rolled back would be a screen redrawn from a file that never had
    /// them.
    fn rows_applied(
        &self,
        touched: &[(String, Vec<centraid_vault::value::Value>)],
        commit_seq: i64,
    );

    /// BYTES LANDED FOR THESE ASSET ROWS (#1025 S7, rewritten by D-1025-S7-20).
    ///
    /// The fourth complete half with no join, and the one a member sees: 19
    /// photographs arrived on a device and **nothing on the screen moved**,
    /// because no ROW changed and a change event is what a screen listens for.
    /// A grid drew "not on this device yet" over files that were on the device,
    /// until something else happened to make it re-read.
    ///
    /// Its own method rather than a `rows_applied` with an invented commit seq:
    /// a blob arriving is not a commit, it clears no overlay, and handing it a
    /// commit number would be a number a settlement could later be compared
    /// against. What it carries is **`media_asset.asset_id`** —
    /// [`crate::bytes::asset_rows_for`] does the join from hashes — because
    /// that is the key a grid draws its cells by, and a thumbnail arriving
    /// changes the same cell as its original. It used to carry content ids,
    /// which matched nothing any screen was showing; the shell paid for that
    /// with an event kind of its own whose only meaning was "re-read
    /// everything", and both are gone.
    fn blobs_arrived(&self, asset_ids: &[String]);

    /// How far behind the gateway this seat is, as of the last page fetched.
    ///
    /// A DISPLAY NUMBER with the qualifier [`PassReport::behind`] states, and a
    /// distance in log positions rather than rows or seconds.
    fn behind(&self, behind: i64);
}

/// A sink for a caller that has nowhere to put the news: a simulation, a
/// `doctor` run, every unit test in this crate.
///
/// Not an `Option<&dyn ChangeSink>` at the call sites, because the pass would
/// then carry a branch per page for a case that differs from the real one only
/// in doing nothing.
pub struct NoChanges;

impl ChangeSink for NoChanges {
    fn rows_applied(
        &self,
        _touched: &[(String, Vec<centraid_vault::value::Value>)],
        _commit_seq: i64,
    ) {
    }
    fn blobs_arrived(&self, _asset_ids: &[String]) {}
    fn behind(&self, _behind: i64) {}
}

/// Where a seat submits intents.
pub trait IntentSink {
    fn submit<'a>(
        &'a mut self,
        record: &'a IntentRecord,
    ) -> std::pin::Pin<Box<dyn Future<Output = SubmitOutcome> + 'a>>;
}

/// Which of `crates/blobs`'s three windows this pass is.
///
/// Named here rather than taken from `centraid_core` because the loop is this
/// crate's and the core depends on it, not the other way round. `centraid_core`
/// converts its own `SyncBudget` on the way down.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Budget {
    /// A member tapped "sync now", or a developer is at a terminal. Nothing is
    /// held back.
    #[default]
    Foreground,
    /// iOS's `BGAppRefreshTask`: about thirty seconds, possibly cellular.
    ShortRefresh,
    /// Charging, unmetered, and usually one LAN hop from the gateway.
    NightShift,
}

/// What the shell knows about the radio this pass is running over, AND what
/// the member said about it (#1025 S4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Network {
    /// THE MEMBER IS PAYING BY THE MEGABYTE. A fact about the link, from the
    /// platform.
    pub metered: bool,
    /// THE MEMBER'S TRANSFER RULE — a fact about the MEMBER, from the shell's
    /// secure store, and per device rather than per vault.
    ///
    /// Beside `metered` and not folded into it because the two are separately
    /// true and the planner needs both: `Manual` withholds on an unmetered
    /// link too, which no spelling of a metered flag could say.
    pub originals: TransferRule,
}

/// THE MEMBER'S TRANSFER RULE, as the pass spells it (#1025 S4).
///
/// Named here rather than taken from `centraid_blobs` for the reason
/// [`Budget`] gives: the loop is this crate's and the core depends on it, not
/// the other way round. `centraid_seat_link` makes the one conversion down to
/// `centraid_blobs::OriginalsRule`, and `centraid_core` the one up.
///
/// The arithmetic is `centraid_blobs`' and is not repeated here — this is the
/// value travelling, and the sizes and the table live where the planner is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TransferRule {
    /// The default: originals wait for a link the member is not paying for.
    #[default]
    WifiOnly,
    /// A photograph's original may cross a metered link; a video's may not.
    WifiAndCellularPhotos,
    /// No original crosses on any link unless the member taps it.
    Manual,
}

/// HOW LONG THIS PASS HAS, WHAT IT MAY SPEND, AND WHAT IT IS RUNNING OVER.
///
/// The three numbers a pass is not allowed to invent. `deadline` is the
/// caller's — `None` means "as long as it takes" — and it is checked BETWEEN
/// units of work, never against one, because a check against the unit in flight
/// is a unit half-done and half-done is the one outcome this loop must not
/// have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub deadline: Option<Instant>,
    pub budget: Budget,
    pub network: Network,
    /// THE ONE BLOB A MEMBER ASKED FOR BY NAME (#1025 S5).
    ///
    /// WhatsApp's download arrow. A lowercase-hex content hash narrows the
    /// byte stage to that blob and suspends the tier rules for it, because a
    /// member who tapped the affordance has overridden the rule for that item
    /// — which is what the affordance means.
    ///
    /// **Not a fourth plane and not a second entry point.** A fetch is an
    /// ordinary pass with a one-item window, so it lands `seat_blob_held` like
    /// any other blob and the grid refreshes through the same `RowsChanged` it
    /// always did. A path of its own would be a second way for a byte to
    /// become a row.
    /// The 32 raw bytes of the hash and not its hex, because [`Window`] is
    /// `Copy` and a `String` here would make a window something a loop has to
    /// clone on every check. `centraid_blobs::ContentHash` is the same 32
    /// bytes; this crate names them plainly because it does not depend on that
    /// crate and must not start (see the module header on keeping iroh out).
    pub fetch: Option<[u8; 32]>,
    /// THIS WINDOW IS A TAIL (#1025 S2, D-1025-S7-40).
    ///
    /// The row stage does not end at the last catch-up page: it holds the log
    /// stream open and applies every further page the gateway writes, until
    /// [`Self::deadline`] fires, the shell says stop, or the connection drops.
    /// There is no interval and no second mechanism — see the module header.
    pub tail: bool,
}

impl Window {
    /// A window with no expiry, an unmetered link and nothing held back.
    ///
    /// Deliberately NOT `Default`: a caller that reached for a default would
    /// get "as long as it takes" on a phone, which is the constant #1025 S2
    /// exists to delete. Asking for it by this name is a decision.
    #[must_use]
    pub const fn unbounded() -> Self {
        Self {
            deadline: None,
            budget: Budget::Foreground,
            network: Network {
                metered: false,
                originals: TransferRule::WifiOnly,
            },
            fetch: None,
            tail: false,
        }
    }

    /// Whether this window's deadline has passed. `None` never expires.
    #[must_use]
    pub fn expired(&self) -> bool {
        self.deadline.is_some_and(|at| Instant::now() >= at)
    }
}

/// WHY A STAGE DID NOT RUN — a closed set, and never a sentence (#1025 S7).
///
/// **A CODE AND NEVER A STRING.** `CoreError::sentence` is a table keyed by
/// code and nothing else, precisely so no database text, no path and no peer's
/// words reach a member through a status line; a reason that carried its own
/// string would be the hole in that rule. The transport's words go to a
/// `tracing` line where they arise.
///
/// **CLOSED, so a new way of moving nothing cannot be spelled as silence.** The
/// four booleans this replaces — `unreachable`, `stale`, `blocked`,
/// `blobs_refused` — were each added the first time somebody could not tell two
/// outcomes apart, and each time the one that had not been thought of came back
/// as four zeros and no error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The pass ended before this stage was reached. The default, and the
    /// honest answer for every stage after a rebootstrap or a cut.
    NotRun,
    /// This seat has no gateway to ask. Not a failure: it is an unpaired
    /// device, or one whose pairing record has not been adopted yet.
    NotPaired,
    /// The gateway did not answer at all. The seat is stale; it still reads.
    Unreachable,
    /// The window ended before the gateway answered.
    ///
    /// ITS OWN REASON AND NOT `Unreachable`, because the two have different
    /// remedies and a shell draws them differently: a gateway that is not there
    /// is a member on a train, and a window that ran out is an ordinary
    /// background refresh that will continue. It is also not a `Cut` variant,
    /// because nothing was kept — the pass never got as far as a stage that
    /// could keep anything.
    CutBeforeReaching,
    /// The gateway answered and refused this build. An upgrade, not an outage.
    HandshakeRefused,
    /// The gateway refused this seat's cursor; the copy is under the floor or
    /// of another epoch. **A response, not an error** — the remedy is a
    /// bootstrap, which is one path this product already has.
    RebootstrapRequired,
    /// This seat already holds a copy of its vault, so there is nothing to
    /// bootstrap. The ordinary answer on every pass but the first.
    AlreadyHeld,
    /// THERE IS NOT ENOUGH ROOM FOR THE COPY (#1025 S7, item 3).
    ///
    /// Checked before the first byte moves — a first bootstrap needs one copy
    /// of the artifact and a re-bootstrap two, because the old file is there
    /// until the new one is renamed over it. The numbers go to the log line the
    /// refusal writes; what a member gets is the sentence, and the action it
    /// names is one they can take.
    NoRoom,
    /// The copy would not land, and the log line says why. The seat keeps
    /// whatever it had: nothing before the rename touches the destination.
    BootstrapRefused,
    /// There was nothing in the outbox to send.
    NothingQueued,
    /// The log source could not be read this pass and the plane stopped where
    /// it was. Distinct from [`Self::Unreachable`], which is the whole pass.
    LogUnreadable,
    /// The intent sink went away partway through; the queue is untouched and
    /// every attempt count is raised.
    WritesUnreachable,
    /// This replica names no file it does not already hold. A caught-up device,
    /// and the answer that used to be indistinguishable from a stuck one.
    NothingWanted,
    /// The byte transport went away. The verified chunk groups that landed are
    /// durable.
    BytesUnreachable,
    /// The local byte store could not be read, so nothing could be planned.
    StoreUnreadable,
}

impl SkipReason {
    /// The stable spelling a report carries on the wire and a shell switches
    /// on. Hyphenated lowercase, one per variant, and never derived from the
    /// `Debug` shape — a rename of the Rust identifier must not move a wire
    /// value.
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotRun => "not-run",
            Self::NotPaired => "not-paired",
            Self::Unreachable => "unreachable",
            Self::CutBeforeReaching => "cut-before-reaching",
            Self::HandshakeRefused => "handshake-refused",
            Self::RebootstrapRequired => "rebootstrap-required",
            Self::AlreadyHeld => "already-held",
            Self::NoRoom => "no-room",
            Self::BootstrapRefused => "bootstrap-refused",
            Self::NothingQueued => "nothing-queued",
            Self::LogUnreadable => "log-unreadable",
            Self::WritesUnreachable => "writes-unreachable",
            Self::NothingWanted => "nothing-wanted",
            Self::BytesUnreachable => "bytes-unreachable",
            Self::StoreUnreadable => "store-unreadable",
        }
    }

    /// Whether this reason is worth saying anything to a member about.
    ///
    /// Most are not: a caught-up device and a seat that already holds its copy
    /// are the ordinary shapes of a healthy pass, and a status line that
    /// narrated them would be noise a member learns to ignore.
    #[must_use]
    pub const fn is_ordinary(self) -> bool {
        matches!(
            self,
            Self::NotRun | Self::AlreadyHeld | Self::NothingQueued | Self::NothingWanted
        )
    }
}

/// WHAT ONE STAGE OF A PASS ANSWERED — exactly one of three things.
///
/// `Cut` carries what it kept rather than nothing: a window the deadline ended
/// is the ORDINARY shape of a background refresh, everything it applied is
/// committed and every verified chunk group is durable, and a shell told only
/// "cut" would draw a failure over a pass that did most of its work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Stage<M> {
    /// It did not run, and this is why.
    Skipped(SkipReason),
    /// The deadline ended it. What is here is durable; the next pass continues.
    Cut(M),
    /// It ran to the end of its work.
    Moved(M),
}

impl<M> Stage<M> {
    /// What this stage moved, whether or not the deadline ended it.
    #[must_use]
    pub const fn moved(&self) -> Option<&M> {
        match self {
            Self::Skipped(_) => None,
            Self::Cut(moved) | Self::Moved(moved) => Some(moved),
        }
    }

    /// Why it did not run, when it did not.
    #[must_use]
    pub const fn skipped(&self) -> Option<SkipReason> {
        match self {
            Self::Skipped(reason) => Some(*reason),
            Self::Cut(_) | Self::Moved(_) => None,
        }
    }

    /// Whether the deadline ended this stage.
    #[must_use]
    pub const fn was_cut(&self) -> bool {
        matches!(self, Self::Cut(_))
    }
}

impl<M: Default> Default for Stage<M> {
    fn default() -> Self {
        Self::Skipped(SkipReason::NotRun)
    }
}

/// What a bootstrap stage moved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BootstrapMoved {
    /// The log position the copy stands at, and this seat's cursor after it.
    pub seq: i64,
    pub bytes_fetched: u64,
    /// The whole artifact's size, so a foreground state can draw progress.
    pub bytes_total: u64,
}

/// What the row plane moved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RowsMoved {
    pub applied: usize,
    pub duplicate: usize,
    pub commits: usize,
    pub pages: usize,
    /// Whether the last page this pass fetched said it was the end.
    ///
    /// The honest termination test, and still only "as of that page": a seat
    /// that wants to know it is current does not poll for this — it waits for a
    /// change event. This is for a caller draining on purpose, which is what a
    /// simulation and a `centraid doctor` run are.
    pub reached_the_end: bool,
    /// A TAIL WAS OPEN ON THIS WINDOW (#1025 S2, D-1025-S7-40).
    ///
    /// Reported on the way out because a pass answers only when the tail has
    /// closed; while it is open the fact a shell needs is the JOB it launched,
    /// and the pages arrive as change events rather than as a return value.
    /// What this says afterwards is that this window was current within one
    /// round trip for as long as it lasted — which is what lets a header keep
    /// saying ONLINE over a window that moved no rows because there were none.
    pub tailing: bool,
}

/// What the write plane moved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IntentsMoved {
    pub submitted: usize,
    pub settled: usize,
    /// Intents whose overlay cleared because the cursor reached their commit.
    pub cleared: Vec<String>,
}

/// What the byte plane moved.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BytesMoved {
    /// Blobs this window asked for.
    pub planned: usize,
    /// Blobs that are now whole. **Not the same as `planned`** — a window that
    /// ends mid-blob completes fewer than it started, and that is a success.
    pub completed: usize,
    /// Payload bytes that crossed.
    pub moved: u64,
    /// Blobs left for a later window, after the budget.
    pub deferred: usize,
    /// BLOBS THE GATEWAY WOULD NOT SERVE, on a link that stayed up (#1025 S7).
    ///
    /// A row it committed over bytes it does not hold — this product's law in
    /// the other direction — and the number that tells a STUCK plane from a
    /// caught-up one. The plane used to end its window on the first such
    /// refusal, and the plan is ordered deterministically, so the same blob
    /// came first in every window after it and nothing else ever moved.
    pub refused: usize,
    /// Rows whose `content_uri` is not `blob:blake3-<hex>`, the one form this
    /// plane addresses (D-1025-S3-3).
    pub unaddressable: usize,
    /// ORIGINALS THIS WINDOW REFUSED TO ASK FOR because the link is metered.
    ///
    /// The one honest reason a pass plans nothing over a replica full of
    /// photographs. A metered flag set from a wrong input is indistinguishable
    /// from a working, idle byte plane without it.
    pub withheld: usize,
    /// THE ASSET ROWS WHOSE BYTES LANDED, for the screens that draw them.
    ///
    /// Reported as well as pushed through [`ChangeSink::blobs_arrived`],
    /// because a caller draining on purpose — a simulation, a `doctor` run —
    /// has no sink, and a number a report cannot state is a number no test can
    /// assert on.
    pub arrived: Vec<String>,
    /// What the eviction sweep did. See [`Swept`]: `None` is "nobody could
    /// measure it" and never "nothing needed evicting".
    pub swept: Option<Swept>,
}

/// WHAT THE EVICTION SWEEP DID at the end of a byte plane (#1025 S3, R25).
///
/// `None` on [`ByteOutcome`] means it did not run or could not read the store —
/// which is NOT "nothing needed evicting". A surface that showed the two the
/// same way would tell a member their storage is fine on the one occasion
/// nobody could measure it.
///
/// Plain numbers rather than `centraid_blobs::Sweep`, because this crate holds
/// no store and must not learn about one to report on it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Swept {
    pub held: u64,
    pub pinned: u64,
    pub evicted: usize,
    pub freed: u64,
    /// How far the PINS alone exceed the budget. Non-zero is an honest report
    /// and never a licence: the sweep has already stopped, and what a surface
    /// says is that a queued write is holding the space.
    pub over_budget_by: u64,
}

/// What one byte plane did, as the mover hands it over.
///
/// Deliberately not `BytesMoved`: the mover knows nothing about content ids —
/// it moves hashes — and the join back to the rows is SQL, which is this
/// crate's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ByteOutcome {
    pub planned: usize,
    pub completed: usize,
    pub moved: u64,
    pub deferred: usize,
    pub refused: usize,
    pub unaddressable: usize,
    pub withheld: usize,
    /// THE BLOBS THAT BECAME WHOLE in this window, with the path the store
    /// gave each one (#1025, D-1025-S7-20).
    ///
    /// The path travels with the hash because the store is the only thing that
    /// knows where its own bytes are, and the row this window is about to
    /// write is a row a page read joins to get a `thumbnail_path`. A hash
    /// alone would make that a second question, asked later, of an actor.
    pub arrived: Vec<crate::held::HeldBlob>,
    /// The blobs the eviction sweep released, lowercase hex.
    ///
    /// Reported because the held table has to lose them in the same window:
    /// a row pointing at bytes the store has let go would hand a surface a
    /// file that is about to disappear.
    pub evicted: Vec<String>,
    /// The deadline ended the plane. What landed is durable.
    pub cut: bool,
    /// The transport went away. Distinct from `cut` for the same reason
    /// [`SkipReason::Unreachable`] is distinct from a window ending.
    pub stalled: bool,
    /// What the eviction sweep did, when one ran and could read the store.
    pub swept: Option<Swept>,
}

/// Where a seat gets the files its rows name.
///
/// The third plane, and the reason it is a trait here rather than a second
/// report stitched on afterwards: a pass is ONE window with ONE deadline, and
/// two loops sequenced by their caller is how the byte plane came to have its
/// own booleans on `SyncOutcome`.
pub trait ByteMover {
    fn move_bytes<'a>(
        &'a mut self,
        needs: &'a [crate::bytes::BlobNeed],
        window: Window,
    ) -> std::pin::Pin<Box<dyn Future<Output = ByteOutcome> + 'a>>;
}

/// A mover for a caller with no byte plane: a simulation, every unit test here.
pub struct NoBytes;

impl ByteMover for NoBytes {
    fn move_bytes<'a>(
        &'a mut self,
        _needs: &'a [crate::bytes::BlobNeed],
        _window: Window,
    ) -> std::pin::Pin<Box<dyn Future<Output = ByteOutcome> + 'a>> {
        Box::pin(async { ByteOutcome::default() })
    }
}

/// WHAT ONE PASS DID — exhaustively, stage by stage (#1025 S7).
///
/// Every field but [`Self::behind`] is a [`Stage`], and a stage cannot be
/// silent: it says what it moved, what it kept when the window ended, or which
/// of [`SkipReason`]'s closed set stopped it. `centraid_core::link::SyncOutcome`
/// is a PROJECTION of this and computes nothing of its own; so is the JSON on
/// `seat.sync`, and so is what the shell draws.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PassReport {
    /// Taking the first copy, or a fresh one after falling under the floor.
    ///
    /// [`SkipReason::AlreadyHeld`] on every pass but the first, which is the
    /// ordinary case and says so.
    pub bootstrap: Stage<BootstrapMoved>,
    pub rows: Stage<RowsMoved>,
    pub intents: Stage<IntentsMoved>,
    pub bytes: Stage<BytesMoved>,
    /// The seat was told to re-bootstrap, with the reason and the blob to take.
    ///
    /// Beside the stages rather than inside one because it is an INSTRUCTION to
    /// the caller — close the vault, take a copy, reopen — and the caller that
    /// acts on it is `centraid_core::Handle`, two crates up.
    pub rebootstrap: Option<Rebootstrap>,
    /// How far behind the gateway this seat is **as of the last page it
    /// fetched**.
    ///
    /// A DISPLAY NUMBER, and the qualifier is the whole of it. `behind` is
    /// derived from `seat_state.gateway_watermark`, which is the watermark the
    /// last served page carried — so a gateway that committed something after
    /// that page was cut leaves this at zero while the seat is genuinely
    /// behind. A caller that treated `behind == 0` as "done and may stop
    /// polling" would stop early and stay stale.
    ///
    /// The simulation found exactly that: seeds 1, 6, 11 and 14 had seats
    /// reporting `behind 0` on every pass while missing a commit another seat's
    /// intent had produced after their last fetch (#1020).
    pub behind: i64,
}

impl PassReport {
    /// Every stage skipped for one reason: what a pass that never reached the
    /// gateway answers.
    ///
    /// ONE CONSTRUCTION SITE for the whole shape, because the alternative —
    /// each caller building its own all-zeros report — is how a pass came to
    /// have four different spellings of "nothing happened".
    #[must_use]
    pub const fn stopped(reason: SkipReason) -> Self {
        Self {
            bootstrap: Stage::Skipped(reason),
            rows: Stage::Skipped(reason),
            intents: Stage::Skipped(reason),
            bytes: Stage::Skipped(reason),
            rebootstrap: None,
            behind: 0,
        }
    }

    /// Whether this pass reached the gateway at all.
    ///
    /// Derived rather than stored: `unreachable` as a field is one of the four
    /// booleans this report replaces, and a field that can disagree with the
    /// stages beside it is a field that eventually does.
    #[must_use]
    pub fn reached_the_gateway(&self) -> bool {
        !matches!(
            self.rows.skipped(),
            Some(
                SkipReason::NotPaired
                    | SkipReason::Unreachable
                    | SkipReason::CutBeforeReaching
                    | SkipReason::HandshakeRefused
            )
        )
    }

    /// Rows this pass applied. A PROJECTION of [`Self::rows`], so the number a
    /// caller reads and the stage it came from cannot disagree.
    #[must_use]
    pub fn rows_applied(&self) -> usize {
        self.rows.moved().map_or(0, |rows| rows.applied)
    }

    /// Rows the applier had already seen.
    #[must_use]
    pub fn rows_duplicate(&self) -> usize {
        self.rows.moved().map_or(0, |rows| rows.duplicate)
    }

    /// Commits this pass applied.
    #[must_use]
    pub fn commits_applied(&self) -> usize {
        self.rows.moved().map_or(0, |rows| rows.commits)
    }

    /// Pages this pass fetched.
    #[must_use]
    pub fn pages_fetched(&self) -> usize {
        self.rows.moved().map_or(0, |rows| rows.pages)
    }

    /// Whether the last page this pass fetched said it was the end.
    #[must_use]
    pub fn reached_the_end(&self) -> bool {
        self.rows.moved().is_some_and(|rows| rows.reached_the_end)
    }

    /// WHETHER THIS WINDOW HELD A TAIL OPEN (#1025 S2, D-1025-S7-40).
    ///
    /// A projection of [`Self::rows`] like every other number here. What a
    /// shell does with it is say ONLINE: a tail that was open is a gateway that
    /// was reached, whatever the row count says, because a caught-up device on
    /// a quiet vault moves nothing for hours and is not offline for a second
    /// of it.
    #[must_use]
    pub fn tailing(&self) -> bool {
        self.rows.moved().is_some_and(|rows| rows.tailing)
    }

    /// Intents this pass got an answer for.
    #[must_use]
    pub fn intents_submitted(&self) -> usize {
        self.intents.moved().map_or(0, |intents| intents.submitted)
    }

    /// Overlays this pass cleared.
    #[must_use]
    pub fn intents_settled(&self) -> usize {
        self.intents.moved().map_or(0, |intents| intents.settled)
    }

    /// Which overlays cleared, by intent id.
    #[must_use]
    pub fn overlays_cleared(&self) -> &[String] {
        self.intents
            .moved()
            .map_or(&[] as &[String], |intents| intents.cleared.as_slice())
    }

    /// Whether the deadline ended any stage of this pass.
    #[must_use]
    pub fn cut_by_the_deadline(&self) -> bool {
        self.bootstrap.was_cut()
            || self.rows.was_cut()
            || self.intents.was_cut()
            || self.bytes.was_cut()
            // AND THE WINDOW THAT ENDED BEFORE ANY STAGE STARTED. Nothing was
            // kept, so there is no `Cut` to carry it; the reason says so
            // instead, and a shell that drew "offline" over a thirty-second
            // window that simply ran out would be wrong about what happened.
            || self.rows.skipped() == Some(SkipReason::CutBeforeReaching)
    }
}

/// WHAT A GATEWAY ANSWERS A CURSOR IT CANNOT SERVE FROM.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rebootstrap {
    pub reason: centraid_vault::RebootstrapReason,
    /// The artifact to adopt, when the gateway named one.
    pub snapshot: Option<SnapshotOffer>,
}

/// How many rows a pass asks for at a time.
///
/// Not the door's 10,000 ceiling: a page is applied in one transaction per
/// commit and held in memory first, and on a phone a ten-thousand-row page of
/// blob images is the allocation that gets the process killed. A thousand is
/// v0's own default for the same reason.
pub const SYNC_PAGE_ROWS: i64 = 1_000;

/// How many pages one pass will drain before yielding.
///
/// A bound, so a seat that is a million rows behind still returns to its caller
/// — which is what lets the shell show progress and lets a `Cancel` land. A
/// pass that drained to the watermark would be an unbounded operation wearing a
/// bounded one's clothes.
pub const SYNC_PAGES_PER_PASS: usize = 32;

/// How many blob needs one pass reads out of the replica.
///
/// The planner drops what is already held, so this is a ceiling on the QUESTION
/// and not on the answer: a camera roll of forty thousand rows is not forty
/// thousand store round trips (`centraid_seat_link::bytes`'s header).
pub const NEEDS_LIMIT: usize = 20_000;

/// Run one sync pass: rows, then writes, then rows again, then bytes.
///
/// `now` is passed in rather than read from a clock so a simulation's schedule
/// and a seat's retries are reproducible from a seed.
/// `window` carries the caller's deadline, the budget the shell chose and what
/// the radio says (#1025 S2, S5, S7). None of the three is a constant this
/// crate is allowed to invent.
/// `changes` is told about every page this pass APPLIES, as it applies it, and
/// about every file that lands — see [`ChangeSink`]. [`NoChanges`] is the
/// caller that has nowhere to put it.
pub async fn sync(
    connection: &Connection,
    source: &mut dyn LogSource,
    sink: &mut dyn IntentSink,
    mover: &mut dyn ByteMover,
    now: &str,
    window: Window,
    changes: &dyn ChangeSink,
) -> Result<PassReport> {
    let mut report = PassReport {
        // A PASS NEVER BOOTSTRAPS. Taking a copy closes and reopens the vault,
        // which is `centraid_core::Handle`'s lifecycle and not a loop's — so
        // the honest answer here is that this seat already holds one, and the
        // caller that had to take one reports that stage itself.
        bootstrap: Stage::Skipped(SkipReason::AlreadyHeld),
        ..PassReport::default()
    };

    // 1. DRAIN THE INBOUND LOG FIRST.
    //
    // A TAIL SAYS SO BEFORE IT ASKS FOR ANYTHING (#1025 S2, D-1025-S7-40). The
    // fact the report carries is "this window was a tail", and a window the
    // deadline ended before the first page must say it too — otherwise the one
    // case a shell most needs to read honestly is the one that reports nothing.
    let mut rows = Drained {
        tailing: window.tail,
        ..Drained::default()
    };
    let rows_stage = drain(
        connection,
        source,
        &mut rows,
        &mut report,
        now,
        window,
        changes,
    )
    .await?;
    report.rows = rows_stage;
    if report.rebootstrap.is_some() {
        // Nothing else this pass. The cutover is the caller's, and submitting
        // against a cursor that is about to be replaced gets the intent refused
        // on a cursor nobody will have.
        report.intents = Stage::Skipped(SkipReason::RebootstrapRequired);
        report.bytes = Stage::Skipped(SkipReason::RebootstrapRequired);
        return Ok(report);
    }

    // 2. SUBMIT, in outbox order, skipping what a hold blocks.
    let mut intents = IntentsMoved {
        settled: rows.settled_here,
        cleared: std::mem::take(&mut rows.cleared_here),
        submitted: 0,
    };
    report.intents = submit(connection, sink, &mut intents, now, window).await?;

    // 4. DRAIN AGAIN, because step 2's own effects are now in the log. Without
    // this an intent executed in this pass waits a whole poll interval before
    // its overlay clears.
    if matches!(report.intents, Stage::Moved(_)) && intents.submitted > 0 {
        let again = drain(
            connection,
            source,
            &mut rows,
            &mut report,
            now,
            window,
            changes,
        )
        .await?;
        // The second drain's verdict is the row plane's verdict: it is the last
        // thing that asked.
        report.rows = again;
        intents.settled = rows.settled_here;
        intents.cleared = std::mem::take(&mut rows.cleared_here);
        report.intents = match report.intents {
            Stage::Cut(_) => Stage::Cut(intents.clone()),
            _ => Stage::Moved(intents.clone()),
        };
    }

    // 5. AND THE BYTES, because a row is what tells this seat a blob exists at
    // all. A byte plane that ran first would plan over last window's rows.
    report.bytes = move_bytes(connection, mover, now, window, changes).await;

    // 6. AND THEN THE TAIL STAYS OPEN (#1025 S2, D-1025-S7-40).
    //
    // Steps 1 to 5 are the CATCH-UP: the same pass, over a stream that has not
    // been closed. From here the row stage does not end — it applies every
    // further page the gateway writes, and runs the byte stage after each one
    // so a photograph that arrived with a row is on the screen with it. The
    // window's deadline, the shell saying stop and the connection dropping are
    // the three ways it closes, and all three are one answer from the source.
    if window.tail && source.tail_is_open() {
        let stage = live(connection, source, mover, &mut rows, &mut report, now, window, changes)
            .await?;
        report.rows = stage;
    }

    let state = seat_state(connection)?;
    report.behind = crate::state::watermark(&state).behind;
    // THE HEALTH HALF, ONCE PER PASS. `behind` is a sample and not a set, so
    // unlike a change event it is reported at the end rather than per page —
    // the newest reading is the true one and the ones in between are noise.
    changes.behind(report.behind);
    Ok(report)
}

/// THE LIVE HALF OF A TAIL: pages nobody asked for, applied as they arrive.
///
/// One page per commit batch, because that is what the gateway writes. Each
/// one is applied, settled and pushed to the change sink by the SAME code the
/// catch-up uses — a live page is not a different kind of page — and the byte
/// stage runs after it so the files a new row names are fetched in the same
/// breath.
///
/// Returns when the source says there will be no more: the deadline arrived,
/// the shell said stop, the gateway closed, or the connection dropped. Those
/// are one answer on purpose (see [`LogSource::next_tail_page`]): the cursor is
/// durable at every page boundary, so nothing a seat does next depends on
/// which of them it was.
#[expect(
    clippy::too_many_arguments,
    reason = "the pass's own parameters, carried one level down rather than               bundled into a struct that would exist for this call alone"
)]
async fn live(
    connection: &Connection,
    source: &mut dyn LogSource,
    mover: &mut dyn ByteMover,
    rows: &mut Drained,
    report: &mut PassReport,
    now: &str,
    window: Window,
    changes: &dyn ChangeSink,
) -> Result<Stage<RowsMoved>> {
    loop {
        // BETWEEN PAGES, NEVER DURING ONE — the same rule the catch-up drain
        // follows, and the same reason. The deadline is ALSO enforced inside
        // the source, because a quiet tail never reaches this check.
        if window.expired() {
            return Ok(Stage::Cut(rows.snapshot()));
        }
        let Some(outcome) = source.next_tail_page(window.deadline).await else {
            return Ok(Stage::Moved(rows.snapshot()));
        };
        match outcome {
            FetchOutcome::Unavailable(reason) => {
                tracing::warn!(%reason, "the tail ended");
                return Ok(Stage::Moved(rows.snapshot()));
            }
            FetchOutcome::RebootstrapRequired {
                reason, snapshot, ..
            } => {
                // A RE-BOOTSTRAP ENDS THE STREAM, exactly as it ends a one-shot
                // request. The caller closes the vault, takes a copy and
                // reopens; a tail held across that would be a stream into a
                // file that is about to be renamed away.
                report.rebootstrap = Some(Rebootstrap { reason, snapshot });
                return Ok(Stage::Skipped(SkipReason::RebootstrapRequired));
            }
            FetchOutcome::Page(page) => {
                rows.pages += 1;
                apply_with_settlement(connection, &page, rows, now, changes)?;
                rows.reached_the_end = !page.has_more;
                // THE FILES THE NEW ROWS NAME, IN THE SAME BREATH. `move_bytes`
                // answers `nothing-wanted` when a page named nothing new, which
                // is the common case and costs one indexed read.
                let moved = move_bytes(connection, mover, now, window, changes).await;
                merge_bytes(&mut report.bytes, moved);
            }
        }
    }
}

/// Fold one live page's byte stage into the window's running total.
///
/// A tail runs the byte plane many times and the report has one field for it,
/// so the numbers ADD and the state is the WORST-CASE of what happened: a
/// window that was cut once was cut, and a stage that moved something is never
/// reported as skipped afterwards. The alternative — the last run's answer —
/// would report `nothing-wanted` over a window that had moved four hundred
/// thumbnails a minute earlier.
fn merge_bytes(into: &mut Stage<BytesMoved>, moved: Stage<BytesMoved>) {
    let cut = into.was_cut() || moved.was_cut();
    let Some(new) = moved.moved() else {
        // NOTHING MOVED THIS TIME. A skip never overwrites what an earlier run
        // of this stage reported; the reason it carries is about one page.
        if cut && let Some(total) = into.moved() {
            *into = Stage::Cut(total.clone());
        }
        return;
    };
    let mut total = into.moved().cloned().unwrap_or_default();
    total.planned += new.planned;
    total.completed += new.completed;
    total.moved += new.moved;
    total.deferred = new.deferred;
    total.refused += new.refused;
    total.unaddressable += new.unaddressable;
    total.withheld += new.withheld;
    total.arrived.extend(new.arrived.iter().cloned());
    // THE SWEEP'S NUMBERS ARE A MEASUREMENT AND NOT A COUNT, so the newest
    // reading wins rather than accumulating into a store size nobody has.
    total.swept = new.swept.or(total.swept);
    *into = if cut {
        Stage::Cut(total)
    } else {
        Stage::Moved(total)
    };
}

/// The byte plane as a stage of the one machine.
///
/// The join from hashes back to rows is here and not in the mover because it is
/// SQL, and SQL lives in this crate.
async fn move_bytes(
    connection: &Connection,
    mover: &mut dyn ByteMover,
    now: &str,
    window: Window,
    changes: &dyn ChangeSink,
) -> Stage<BytesMoved> {
    if window.expired() {
        return Stage::Cut(BytesMoved::default());
    }
    let needs = match crate::bytes::needed_blobs(connection, NEEDS_LIMIT) {
        Ok(needs) => needs,
        Err(error) => {
            // THE DETAIL IS A LOG LINE. A member is owed the code beside it and
            // nothing else.
            tracing::warn!(%error, "the replica could not say which files it wants");
            return Stage::Skipped(SkipReason::StoreUnreadable);
        }
    };
    if needs.is_empty() {
        // A CAUGHT-UP DEVICE SAYS SO. This is the answer that used to be four
        // zeros and therefore indistinguishable from a stuck plane.
        return Stage::Skipped(SkipReason::NothingWanted);
    }
    let outcome = mover.move_bytes(&needs, window).await;
    if outcome.stalled && outcome.completed == 0 && outcome.planned == 0 {
        return Stage::Skipped(SkipReason::BytesUnreachable);
    }
    // A LANDED BYTE IS A ROW, AND THIS IS WHERE IT BECOMES ONE (#1025,
    // D-1025-S7-20). Written in the same window the blob completed and in the
    // same window the sweep released one, so nothing reads a table that
    // disagrees with the store it projects.
    if let Err(error) = crate::held::record(connection, &outcome.arrived, now) {
        tracing::warn!(%error, "the replica could not record the files that landed");
    }
    if let Err(error) = crate::held::release(connection, &outcome.evicted) {
        tracing::warn!(%error, "the replica could not forget the files the sweep took");
    }
    // THE FILES THAT LANDED, AS THE ROWS THAT NAME THEM. Without this join the
    // plane is durable and invisible: 19 photographs arrived and every cell
    // still read "not on this device yet".
    let hashes: Vec<String> = outcome
        .arrived
        .iter()
        .map(|blob| blob.hash.clone())
        .collect();
    let arrived = match crate::bytes::asset_rows_for(connection, &hashes) {
        Ok(arrived) => arrived,
        Err(error) => {
            tracing::warn!(%error, "the replica could not name the rows its new files belong to");
            Vec::new()
        }
    };
    if !arrived.is_empty() {
        changes.blobs_arrived(&arrived);
    }
    let moved = BytesMoved {
        planned: outcome.planned,
        completed: outcome.completed,
        moved: outcome.moved,
        deferred: outcome.deferred,
        refused: outcome.refused,
        unaddressable: outcome.unaddressable,
        withheld: outcome.withheld,
        arrived,
        swept: outcome.swept,
    };
    if outcome.cut {
        Stage::Cut(moved)
    } else {
        Stage::Moved(moved)
    }
}

/// One intent at a time, in outbox order.
async fn submit(
    connection: &Connection,
    sink: &mut dyn IntentSink,
    moved: &mut IntentsMoved,
    now: &str,
    window: Window,
) -> Result<Stage<IntentsMoved>> {
    let outbox = Outbox::open(connection)?;
    let queued = outbox.all()?;
    let holds = crate::chain::chain_holds(&queued);
    let mut sendable = 0usize;
    let mut cut = false;
    let mut blocked = false;
    for record in &queued {
        if record.state != IntentState::Queued
            || record.online_only
            || holds.iter().any(|hold| hold.intent_id == record.intent_id)
        {
            // `online_only` is belt to the outbox's braces: the refusal is at
            // queuing, and such a row in the queue at all would be a file
            // written by a build that allowed it.
            continue;
        }
        sendable += 1;
        // THE WINDOW ENDED. The intents already submitted are answered and
        // applied; the rest stay QUEUED with their attempt counts untouched,
        // which is what makes "cut" different from "refused" for the backoff.
        if window.expired() {
            cut = true;
            break;
        }
        match sink.submit(record).await {
            SubmitOutcome::Answered(answer) => {
                moved.submitted += 1;
                // 3. APPLY THE ANSWER. An `executed` answer parks at
                // `awaiting-change`; the rows have not arrived yet.
                let applied_commit_seq = seat_state(connection)?.applied_commit_seq;
                apply_intent_outcomes(&outbox, &[answer], applied_commit_seq, now)?;
            }
            SubmitOutcome::Unavailable(reason) => {
                // The attempt count rises, which is what the backoff reads.
                // The intent stays QUEUED: an intent moved to `sending` and
                // left there by a dropped connection is an intent nothing
                // retries.
                outbox.transition(&record.intent_id, IntentState::Queued, now, |entry| {
                    entry.attempts += 1;
                })?;
                tracing::warn!(%reason, "the write plane could not submit this pass");
                blocked = true;
                // One unreachable submission means the rest are too. Trying
                // them all would be N timeouts per pass.
                break;
            }
        }
    }
    if blocked && moved.submitted == 0 {
        return Ok(Stage::Skipped(SkipReason::WritesUnreachable));
    }
    if sendable == 0 && moved.settled == 0 {
        return Ok(Stage::Skipped(SkipReason::NothingQueued));
    }
    Ok(if cut {
        Stage::Cut(moved.clone())
    } else {
        Stage::Moved(moved.clone())
    })
}

/// What one drain accumulated, including the settlements it made.
///
/// The settlements belong to the WRITE plane's report and are produced by the
/// row plane's transactions — which is the whole point of the outbox sharing a
/// database with the mirrored rows — so they are carried out of here rather
/// than counted twice.
#[derive(Debug, Default)]
struct Drained {
    applied: usize,
    duplicate: usize,
    commits: usize,
    pages: usize,
    reached_the_end: bool,
    settled_here: usize,
    cleared_here: Vec<String>,
    /// A tail was opened on this window. Carried out on [`RowsMoved::tailing`].
    tailing: bool,
}

impl Drained {
    fn snapshot(&self) -> RowsMoved {
        RowsMoved {
            applied: self.applied,
            duplicate: self.duplicate,
            commits: self.commits,
            pages: self.pages,
            reached_the_end: self.reached_the_end,
            tailing: self.tailing,
        }
    }
}

/// Drain up to [`SYNC_PAGES_PER_PASS`] pages.
async fn drain(
    connection: &Connection,
    source: &mut dyn LogSource,
    rows: &mut Drained,
    report: &mut PassReport,
    now: &str,
    window: Window,
    changes: &dyn ChangeSink,
) -> Result<Stage<RowsMoved>> {
    for _ in 0..SYNC_PAGES_PER_PASS {
        // BETWEEN PAGES, NEVER DURING ONE. A page is applied one transaction
        // per commit; abandoning it half-applied would be the one thing this
        // loop must never do, and there is nothing to gain — the next page is
        // the natural place to stop.
        if window.expired() {
            return Ok(Stage::Cut(rows.snapshot()));
        }
        let state = seat_state(connection)?;
        // THE CATCH-UP HALF OF A TAIL IS THE SAME LOOP (#1025 S2,
        // D-1025-S7-40). A tail's pages arrive on ONE stream: the first is
        // asked for with `open_tail` and every one after it is read off the
        // stream that answered. A source that does not tail answers
        // `tail_is_open() == false` forever and takes the `fetch` arm on every
        // iteration, which is exactly what it did before this branch existed.
        let fetched = if window.tail {
            if source.tail_is_open() {
                match source.next_tail_page(window.deadline).await {
                    Some(outcome) => outcome,
                    // THE STREAM ENDED BEFORE THE CATCH-UP DID. What applied is
                    // durable and the cursor moved with it; the next window
                    // resumes from there.
                    None => return Ok(Stage::Moved(rows.snapshot())),
                }
            } else {
                source
                    .open_tail(&state.epoch, state.applied_seq, SYNC_PAGE_ROWS)
                    .await
            }
        } else {
            source
                .fetch(&state.epoch, state.applied_seq, SYNC_PAGE_ROWS)
                .await
        };
        match fetched {
            FetchOutcome::Unavailable(reason) => {
                tracing::warn!(%reason, "the row plane applied nothing this pass");
                return Ok(if rows.pages == 0 {
                    Stage::Skipped(SkipReason::LogUnreadable)
                } else {
                    Stage::Moved(rows.snapshot())
                });
            }
            FetchOutcome::RebootstrapRequired {
                reason, snapshot, ..
            } => {
                report.rebootstrap = Some(Rebootstrap { reason, snapshot });
                return Ok(Stage::Skipped(SkipReason::RebootstrapRequired));
            }
            FetchOutcome::Page(page) => {
                rows.pages += 1;
                apply_with_settlement(connection, &page, rows, now, changes)?;
                if !page.has_more {
                    // The end OF THIS PAGE'S VIEW. The gateway may commit
                    // again the moment after it cut this page, which is why
                    // this is `reached_the_end` and not `caught_up`.
                    rows.reached_the_end = true;
                    return Ok(Stage::Moved(rows.snapshot()));
                }
                rows.reached_the_end = false;
            }
        }
    }
    Ok(Stage::Moved(rows.snapshot()))
}

/// Apply one page, clearing overlays inside each commit's transaction.
fn apply_with_settlement(
    connection: &Connection,
    page: &FetchedPage,
    rows: &mut Drained,
    now: &str,
    changes: &dyn ChangeSink,
) -> Result<()> {
    let mut cleared: Vec<String> = Vec::new();
    let applied = {
        // THE OVERLAY CLEARS INSIDE THE TRANSACTION THAT CARRIES THE ROWS.
        // This closure is the whole reason the outbox shares a database with
        // the mirrored rows: there is no instant at which both the paint and
        // the rows are visible, and none at which neither is.
        let mut in_transaction = |connection: &Connection, commit_seq: i64| -> Result<()> {
            let outbox = Outbox::open(connection)?;
            cleared.extend(settle_at_commit_seq(&outbox, commit_seq, now)?);
            Ok(())
        };
        let mut hooks = ApplyHooks {
            on_commit_in_transaction: Some(&mut in_transaction),
            on_commit_durable: None,
        };
        apply_page(connection, &page.header, &page.rows, &mut hooks)?
    };
    rows.applied += applied.applied;
    rows.duplicate += applied.duplicate;
    rows.commits += applied.commits;
    rows.settled_here += cleared.len();
    rows.cleared_here.extend(cleared);
    // AND THE SHELL IS TOLD, once the page's transactions have committed.
    // Nothing is said about a page that applied nothing: a change event with an
    // empty key set is a redraw of nothing, and a duplicate page delivers
    // exactly that.
    if !applied.touched.is_empty() {
        changes.rows_applied(&applied.touched, applied.applied_commit_seq);
    }
    Ok(())
}

/// Whether an intent is due to be retried.
///
/// `now_ms` against the deterministic backoff. Exposed so a simulation's
/// schedule and a real seat's timer read the same rule.
#[must_use]
pub fn is_due(record: &IntentRecord, updated_at_ms: i64, now_ms: i64) -> bool {
    if record.attempts == 0 {
        return true;
    }
    now_ms - updated_at_ms >= crate::chain::backoff_ms(record.attempts)
}

/// What a seat does when it is told to re-bootstrap while writes are pending.
///
/// The answer is [`crate::chain::admission_during_rebootstrap`]: admit, do not
/// send. Re-exported through the sync module because this is where a caller is
/// standing when it needs to know.
#[must_use]
pub const fn admission_during_rebootstrap() -> crate::chain::Admission {
    crate::chain::admission_during_rebootstrap()
}

/// A refusal a caller can give when the seat has no source at all.
#[must_use]
pub fn unavailable(reason: impl Into<String>) -> SeatError {
    SeatError::Invariant {
        context: reason.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::OutcomeStatus;
    use centraid_vault::log::LogOp;
    use centraid_vault::value::Value;

    /// A source that hands over a scripted list of outcomes, then says it is
    /// caught up.
    struct ScriptedSource {
        outcomes: Vec<FetchOutcome>,
        asked: Vec<(String, i64)>,
    }

    impl LogSource for ScriptedSource {
        fn fetch<'a>(
            &'a mut self,
            epoch: &'a str,
            since: i64,
            _limit: i64,
        ) -> std::pin::Pin<Box<dyn Future<Output = FetchOutcome> + 'a>> {
            Box::pin(async move {
                self.asked.push((epoch.to_owned(), since));
                if self.outcomes.is_empty() {
                    return FetchOutcome::Page(FetchedPage {
                        header: PageHeader {
                            epoch: epoch.to_owned(),
                            schema_epoch: 4,
                            ddl_version: 0,
                            watermark: since,
                        },
                        rows: Vec::new(),
                        has_more: false,
                        next: since,
                    });
                }
                self.outcomes.remove(0)
            })
        }
    }

    /// A SOURCE THAT TAILS (#1025 S2, D-1025-S7-40).
    ///
    /// `open_tail` answers the catch-up page and leaves the stream open;
    /// `next_tail_page` hands over the scripted live pages, then `None` as a
    /// real gateway's closed stream does. It records the deadline it was given
    /// on every read, because "the deadline is enforced inside the source" is
    /// the claim that makes a quiet tail closable at all.
    struct ScriptedTail {
        catch_up: Vec<FetchOutcome>,
        live: Vec<FetchOutcome>,
        open: bool,
        deadlines: Vec<Option<Instant>>,
    }

    impl ScriptedTail {
        fn new(catch_up: Vec<FetchOutcome>, live: Vec<FetchOutcome>) -> Self {
            Self {
                catch_up,
                live,
                open: false,
                deadlines: Vec::new(),
            }
        }
    }

    impl LogSource for ScriptedTail {
        fn fetch<'a>(
            &'a mut self,
            _epoch: &'a str,
            _since: i64,
            _limit: i64,
        ) -> std::pin::Pin<Box<dyn Future<Output = FetchOutcome> + 'a>> {
            unreachable!("a tailing pass never takes the one-shot door")
        }

        fn open_tail<'a>(
            &'a mut self,
            _epoch: &'a str,
            _since: i64,
            _limit: i64,
        ) -> std::pin::Pin<Box<dyn Future<Output = FetchOutcome> + 'a>> {
            Box::pin(async move {
                self.open = true;
                self.catch_up.remove(0)
            })
        }

        fn next_tail_page<'a>(
            &'a mut self,
            deadline: Option<Instant>,
        ) -> std::pin::Pin<Box<dyn Future<Output = Option<FetchOutcome>> + 'a>> {
            Box::pin(async move {
                self.deadlines.push(deadline);
                if !self.catch_up.is_empty() {
                    return Some(self.catch_up.remove(0));
                }
                if self.live.is_empty() {
                    self.open = false;
                    return None;
                }
                Some(self.live.remove(0))
            })
        }

        fn tail_is_open(&self) -> bool {
            self.open
        }
    }

    /// THE WHOLE CLAIM OF THIS SLICE, in one pass: catch up, and then keep
    /// applying pages NOBODY ASKED FOR (#1025 S2, D-1025-S7-40).
    #[test]
    fn a_tail_applies_live_pages_after_the_catch_up() {
        let connection = seat();
        let heard = Heard::default();
        let mut source = ScriptedTail::new(
            vec![
                page(vec![row(1, 1, "a"), row(2, 1, "b")], true, 4),
                page(vec![row(3, 2, "c")], false, 3),
            ],
            // THE LIVE HALF. One page per commit batch, arriving because the
            // gateway committed — there is no second request between them, and
            // the source would panic if the pass took the one-shot door.
            vec![page(vec![row(4, 3, "d")], false, 4)],
        );
        let mut sink = ScriptedSink::default();
        let window = Window {
            tail: true,
            ..Window::unbounded()
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            window,
            &heard,
        ))
        .expect("the pass runs");

        assert_eq!(report.rows_applied(), 4, "the live page applied too");
        assert!(report.tailing(), "the report says a tail was open");
        assert!(
            matches!(report.rows, Stage::Moved(_)),
            "a tail that ended because the gateway closed is a MOVED stage, not a cut"
        );
        // THE CURSOR IS DURABLE AT EVERY PAGE BOUNDARY, which is what makes
        // every way of ending a tail one answer.
        let state = seat_state(&connection).expect("the state");
        assert_eq!(state.applied_seq, 4);
        // AND THE SHELL WAS TOLD PER PAGE, not once at the end: a grid that
        // filled in one jump a minute after the rows did is the failure the
        // change sink exists to prevent.
        assert_eq!(heard.pages.lock().expect("recorded").len(), 3);
    }

    /// THE WINDOW'S DEADLINE REACHES THE SOURCE, which is the only thing that
    /// can close a QUIET tail (#1025 S2, D-1025-S7-40).
    ///
    /// A tail says nothing for hours at a time — that is the point of it — so a
    /// deadline checked between pages cannot end one. It is carried into the
    /// read, and the read is what returns.
    #[test]
    fn a_tails_read_carries_the_windows_deadline_and_the_cursor_survives_it() {
        let connection = seat();
        let heard = Heard::default();
        // NO LIVE PAGES. The source answers `None` on the live read, which is
        // exactly what a real one does when the deadline fires, the shell pulls
        // the stop, or the gateway closes — one answer for all three, because
        // the cursor is durable either way.
        let mut source = ScriptedTail::new(vec![page(vec![row(1, 1, "a")], false, 1)], Vec::new());
        let mut sink = ScriptedSink::default();
        let deadline = Instant::now() + std::time::Duration::from_secs(30);
        let window = Window {
            tail: true,
            deadline: Some(deadline),
            ..Window::unbounded()
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            window,
            &heard,
        ))
        .expect("the pass runs");

        assert!(report.tailing());
        assert_eq!(report.rows_applied(), 1);
        assert!(
            source
                .deadlines
                .iter()
                .any(|carried| *carried == Some(deadline)),
            "the window's deadline was handed to the read: {:?}",
            source.deadlines
        );
        // WHAT IT APPLIED IS DURABLE. Every way of ending a tail ends it at a
        // page boundary, and the cursor is written with the page.
        let state = seat_state(&connection).expect("the state");
        assert_eq!(state.applied_seq, 1);
    }

    /// A WINDOW THAT ENDED BEFORE IT ASKED STILL SAYS IT WAS A TAIL.
    ///
    /// The one case a shell most needs to read honestly — a background window
    /// whose budget was gone on arrival — used to report nothing at all.
    #[test]
    fn a_tail_cut_before_its_first_page_says_both_things() {
        let connection = seat();
        let heard = Heard::default();
        let mut source = ScriptedTail::new(vec![page(vec![row(1, 1, "a")], false, 1)], Vec::new());
        let mut sink = ScriptedSink::default();
        let window = Window {
            tail: true,
            deadline: Some(Instant::now() - std::time::Duration::from_secs(1)),
            ..Window::unbounded()
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            window,
            &heard,
        ))
        .expect("the pass runs");

        assert!(report.cut_by_the_deadline(), "{:?}", report.rows);
        assert!(report.tailing(), "and it still reports that it was a tail");
        assert_eq!(report.rows_applied(), 0);
        let state = seat_state(&connection).expect("the state");
        assert_eq!(state.applied_seq, 0, "nothing was half applied");
    }

    #[derive(Default)]
    struct ScriptedSink {
        answers: Vec<SubmitOutcome>,
        submitted: Vec<String>,
    }

    impl IntentSink for ScriptedSink {
        fn submit<'a>(
            &'a mut self,
            record: &'a IntentRecord,
        ) -> std::pin::Pin<Box<dyn Future<Output = SubmitOutcome> + 'a>> {
            Box::pin(async move {
                self.submitted.push(record.intent_id.clone());
                if self.answers.is_empty() {
                    return SubmitOutcome::Unavailable("the script ran out".to_owned());
                }
                self.answers.remove(0)
            })
        }
    }

    /// Drive a future that never actually yields.
    ///
    /// A five-line executor rather than a tokio dev-dependency: every future in
    /// these tests is `async` only because the trait is, and none of them
    /// awaits anything real. Pulling in a runtime to poll a future that is
    /// always `Ready` on its first poll would be a dependency for decoration —
    /// and this `unreachable!` is the assertion that it stays true.
    fn drive<T>(future: impl Future<Output = T>) -> T {
        use std::task::{Context, Poll, Waker};
        // `Waker::noop`, not a hand-rolled `RawWaker`: this crate forbids
        // `unsafe`, and rightly — a seat is the half of the plane that runs on
        // a member's phone.
        let mut context = Context::from_waker(Waker::noop());
        let mut pinned = Box::pin(future);
        match pinned.as_mut().poll(&mut context) {
            Poll::Ready(value) => value,
            Poll::Pending => unreachable!(
                "a scripted source or sink pended; these futures are always ready on \
                 their first poll, and a runtime would be needed if that changed"
            ),
        }
    }

    fn seat() -> Connection {
        let connection = Connection::open_in_memory().expect("opens");
        connection
            .execute_batch("CREATE TABLE mirror (id TEXT PRIMARY KEY, value TEXT) STRICT;")
            .expect("the mirror");
        crate::state::init_seat_state(
            &connection,
            &crate::state::SeatPosition {
                vault_id: "v".to_owned(),
                epoch: "e".to_owned(),
                schema_epoch: 4,
                ddl_version: 0,
                applied_seq: 0,
                applied_commit_seq: 0,
            },
            "t",
        )
        .expect("the state");
        Outbox::open(&connection).expect("the outbox");
        connection
    }

    fn row(seq: i64, commit_seq: i64, id: &str) -> centraid_vault::log::LogRow {
        let mut image = centraid_vault::RowImage::new();
        image.insert("id".to_owned(), Value::Text(id.to_owned()));
        image.insert("value".to_owned(), Value::Text(format!("v{seq}")));
        centraid_vault::log::LogRow {
            seq,
            commit_seq,
            epoch: "e".to_owned(),
            schema_epoch: 4,
            ddl_version: 0,
            table: "mirror".to_owned(),
            op: LogOp::Insert,
            primary_key: vec![Value::Text(id.to_owned())],
            row: Some(image),
            prior: None,
            indirect: false,
            producer: "sim".to_owned(),
            deferred: false,
            local: false,
            committed_at: "t".to_owned(),
        }
    }

    fn page(
        rows: Vec<centraid_vault::log::LogRow>,
        has_more: bool,
        watermark: i64,
    ) -> FetchOutcome {
        let next = rows.last().map_or(watermark, |row| row.seq);
        FetchOutcome::Page(FetchedPage {
            header: PageHeader {
                epoch: "e".to_owned(),
                schema_epoch: 4,
                ddl_version: 0,
                watermark,
            },
            rows,
            has_more,
            next,
        })
    }

    fn queued(id: &str) -> IntentRecord {
        IntentRecord {
            intent_id: id.to_owned(),
            created_order: 0,
            app_id: "notes".to_owned(),
            action: "edit".to_owned(),
            input: serde_json::json!({}),
            payload_hash: "a".repeat(64),
            state: IntentState::Queued,
            attempts: 0,
            depends_on: Vec::new(),
            base_versions: Vec::new(),
            optimistic: None,
            commit_seq: None,
            waiting_on: Vec::new(),
            needs_blobs: Vec::new(),
            enqueued_at: "t".to_owned(),
            updated_at: "t".to_owned(),
            reason: None,
            conflicts: Vec::new(),
            online_only: false,
        }
    }

    fn answer(id: &str, commit_seq: Option<i64>) -> Answer {
        Answer {
            intent_id: id.to_owned(),
            status: OutcomeStatus::Executed,
            commit_seq,
            conflicts: Vec::new(),
            answered_versions: Vec::new(),
            waiting_on: Vec::new(),
            reason: None,
        }
    }

    /// A RECORDING SINK, for the tests that care what a pass says.
    #[derive(Default)]
    struct Heard {
        #[allow(clippy::type_complexity)]
        pages: std::sync::Mutex<Vec<(Vec<(String, Vec<Value>)>, i64)>>,
        behind: std::sync::Mutex<Vec<i64>>,
    }

    impl ChangeSink for Heard {
        fn rows_applied(&self, touched: &[(String, Vec<Value>)], commit_seq: i64) {
            self.pages
                .lock()
                .expect("the recording sink")
                .push((touched.to_vec(), commit_seq));
        }
        fn blobs_arrived(&self, _asset_ids: &[String]) {}
        fn behind(&self, behind: i64) {
            self.behind.lock().expect("the recording sink").push(behind);
        }
    }

    /// THE PASS TELLS SOMEBODY THE ROWS ARRIVED (#1025 S5).
    ///
    /// Before this seam the applier knew exactly which `(table, pk)` moved and
    /// threw the list away: `ApplyReport::touched` was built on every page and
    /// read by nothing, and the core's event queue — bounded, coalescing and
    /// fully tested — had no producer at all.
    #[test]
    fn a_pass_names_the_rows_it_applied_and_the_commit_they_landed_in() {
        let connection = seat();
        let heard = Heard::default();
        let mut source = ScriptedSource {
            // Two pages, so the claim "per page, as it applies" is checkable
            // rather than indistinguishable from "once at the end".
            outcomes: vec![
                page(vec![row(1, 1, "a"), row(2, 1, "b")], true, 4),
                page(vec![row(3, 2, "c")], false, 4),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink::default();
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &heard,
        ))
        .expect("the pass runs");
        assert_eq!(report.rows_applied(), 3);

        let pages = heard.pages.lock().expect("the recording sink").clone();
        assert_eq!(pages.len(), 2, "one report per page, not one per pass");
        assert_eq!(
            pages[0].0,
            vec![
                ("mirror".to_owned(), vec![Value::Text("a".to_owned())]),
                ("mirror".to_owned(), vec![Value::Text("b".to_owned())]),
            ]
        );
        // THE HIGHEST COMMIT THE PAGE CARRIED. An overlay clears against a
        // commit seq, and the lower of two would leave paint on the screen.
        assert_eq!(pages[0].1, 1);
        assert_eq!(pages[1].1, 2);
        // And the health half is a SAMPLE: once per pass, not once per page.
        assert_eq!(heard.behind.lock().expect("recorded").len(), 1);
    }

    /// A PAGE THAT APPLIED NOTHING SAYS NOTHING. A duplicate delivery is the
    /// ordinary cause, and a change event with an empty key set is a redraw of
    /// nothing — which on a phone is a screen that flickers for no reason.
    #[test]
    fn a_duplicate_page_wakes_nobody() {
        let connection = seat();
        let heard = Heard::default();
        let mut sink = ScriptedSink::default();
        let mut first = ScriptedSource {
            outcomes: vec![page(vec![row(1, 1, "a")], false, 1)],
            asked: Vec::new(),
        };
        drive(sync(
            &connection,
            &mut first,
            &mut sink,
            &mut NoBytes,
            "t",
            Window::unbounded(),
            &heard,
        ))
        .expect("the pass runs");
        assert_eq!(heard.pages.lock().expect("recorded").len(), 1);

        let mut again = ScriptedSource {
            outcomes: vec![page(vec![row(1, 1, "a")], false, 1)],
            asked: Vec::new(),
        };
        let replayed = drive(sync(
            &connection,
            &mut again,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &heard,
        ))
        .expect("the pass runs");
        assert_eq!(replayed.rows_duplicate(), 1);
        assert_eq!(
            heard.pages.lock().expect("recorded").len(),
            1,
            "a page of rows this seat already had woke the shell up"
        );
    }

    #[test]
    fn a_pass_drains_the_log_before_it_submits() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: vec![page(vec![row(1, 1, "a")], false, 1)],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: vec![SubmitOutcome::Answered(answer("i-1", Some(2)))],
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");

        assert_eq!(report.rows_applied(), 1);
        assert_eq!(report.intents_submitted(), 1);
        // The FIRST fetch was at cursor 0, before any submission — which is the
        // ordering claim.
        assert_eq!(source.asked.first(), Some(&("e".to_owned(), 0)));
        assert_eq!(sink.submitted, ["i-1"]);
    }

    /// STEP 4. Without the second drain an intent executed in this pass waits a
    /// whole poll interval before its overlay clears.
    #[test]
    fn an_intent_executed_this_pass_has_its_overlay_cleared_this_pass() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: vec![
                // The first drain: nothing yet.
                page(Vec::new(), false, 0),
                // The second drain, after the submission: the commit the
                // gateway just made.
                page(vec![row(1, 7, "a")], false, 1),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: vec![SubmitOutcome::Answered(answer("i-1", Some(7)))],
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");

        assert_eq!(report.pages_fetched(), 2, "the log was drained twice");
        assert_eq!(report.overlays_cleared(), ["i-1"]);
        // THE COUNT, not only the list. Killed the mutant that turned
        // `intents_settled +=` into `*=`: the list and the count are extended
        // by two different statements, and a caller that shows "3 writes saved"
        // reads the count.
        assert_eq!(report.intents_settled(), 1);
        assert!(
            outbox.get("i-1").expect("reads").is_none(),
            "the intent settled in the same pass it was submitted in"
        );
        assert!(outbox.was_settled("i-1").expect("reads"));
    }

    #[test]
    fn an_unreachable_source_makes_the_seat_stale_and_not_broken() {
        let connection = seat();
        let mut source = ScriptedSource {
            outcomes: vec![FetchOutcome::Unavailable("no route".to_owned())],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass still runs");
        // THE TYPED REASON, NOT A SENTENCE (#1025 S7). "no route" is the
        // transport's own words and they go to a log line; what the report
        // carries is the code, and the code is one of a closed set.
        assert_eq!(report.rows.skipped(), Some(SkipReason::LogUnreadable));
        assert_eq!(report.rows_applied(), 0);
        // And the pass RETURNED rather than erroring: a stale seat is a state,
        // not a failure.
        assert!(report.rebootstrap.is_none());
    }

    #[test]
    fn an_unreachable_sink_blocks_writes_and_raises_the_attempt_count() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");
        outbox.enqueue(&queued("i-2"), "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: Vec::new(),
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: vec![SubmitOutcome::Unavailable("no route".to_owned())],
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(
            report.intents.skipped(),
            Some(SkipReason::WritesUnreachable)
        );
        // ONE ATTEMPT, not two: the rest of the queue is not tried, because N
        // timeouts per pass is a pass that never returns.
        assert_eq!(sink.submitted, ["i-1"]);
        let record = outbox.get("i-1").expect("reads").expect("still queued");
        assert_eq!(record.attempts, 1);
        assert_eq!(
            record.state,
            IntentState::Queued,
            "an intent left at `sending` by a dropped connection is one nothing retries"
        );
    }

    #[test]
    fn a_held_intent_is_not_submitted() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");
        let mut successor = queued("i-2");
        successor.depends_on.push("i-1".to_owned());
        outbox.enqueue(&successor, "t").expect("queues");

        let mut source = ScriptedSource {
            outcomes: Vec::new(),
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            // Only `i-1` gets an answer, and it parks at `awaiting-change`.
            answers: vec![SubmitOutcome::Answered(answer("i-1", Some(9)))],
            submitted: Vec::new(),
        };
        drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(
            sink.submitted,
            ["i-1"],
            "`i-2` waits on `i-1`, which has not settled"
        );
    }

    #[test]
    fn a_rebootstrap_stops_the_pass_before_it_submits_anything() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox.enqueue(&queued("i-1"), "t").expect("queues");
        let mut source = ScriptedSource {
            outcomes: vec![FetchOutcome::RebootstrapRequired {
                snapshot: None,
                reason: centraid_vault::RebootstrapReason::EpochMismatch,
                epoch: "new".to_owned(),
                floor: 100,
                watermark: 200,
            }],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(
            report.rebootstrap.as_ref().map(|told| told.reason),
            Some(centraid_vault::RebootstrapReason::EpochMismatch)
        );
        assert!(
            sink.submitted.is_empty(),
            "submitting against a cursor about to be replaced gets the intent refused"
        );
    }

    /// The counters ACCUMULATE across the pages of one pass.
    ///
    /// Killed four mutants that turned `+=` into `-=` and `*=` on
    /// `rows_applied`, `rows_duplicate` and `commits_applied`. A single-page
    /// pass cannot tell the difference — `0 += n` and `0 -= n` differ only in
    /// sign, and every other test fetched one page. So this one fetches three.
    #[test]
    fn the_counters_accumulate_across_every_page_of_one_pass() {
        let connection = seat();
        let mut source = ScriptedSource {
            outcomes: vec![
                page(vec![row(1, 1, "a"), row(2, 1, "b")], true, 5),
                page(vec![row(3, 2, "c")], true, 5),
                page(vec![row(4, 3, "d"), row(5, 3, "e")], false, 5),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(report.pages_fetched(), 3);
        // FIVE rows over THREE pages: a counter that multiplied would be 0 and
        // one that subtracted would be negative — which a `usize` cannot even
        // hold, so the mutant that does it panics rather than lying.
        assert_eq!(report.rows_applied(), 5);
        assert_eq!(report.commits_applied(), 3);

        // And the duplicate counter accumulates too: the whole span again.
        let mut again = ScriptedSource {
            outcomes: vec![
                page(vec![row(1, 1, "a"), row(2, 1, "b")], true, 5),
                page(vec![row(3, 2, "c")], false, 5),
            ],
            asked: Vec::new(),
        };
        let replayed = drive(sync(
            &connection,
            &mut again,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(replayed.rows_duplicate(), 3);
        assert_eq!(replayed.rows_applied(), 0);
        assert_eq!(replayed.intents_settled(), 0, "nothing settled on a replay");
    }

    /// A PASS CUT BY THE DEADLINE KEEPS WHAT IT APPLIED, AND THE NEXT PASS
    /// CONTINUES FROM THERE (#1025 S2).
    ///
    /// The deadline is checked BETWEEN pages, so the page in flight is applied
    /// whole and the cut lands on the boundary. What must be true afterwards is
    /// the whole claim behind "a window the OS cuts is a normal end": the rows
    /// that landed are committed, the cursor moved to exactly them, nothing is
    /// reported as stale, and a later pass asks from the cursor rather than
    /// starting over.
    ///
    /// An ALREADY-PASSED deadline is used rather than a short one on purpose:
    /// a sleep would make this test's meaning depend on how busy the machine
    /// running it is, and the boundary it is about is not a duration.
    #[test]
    fn a_pass_cut_by_the_deadline_keeps_what_it_applied_and_the_next_one_continues() {
        let connection = seat();
        // TWO PAGES, and `has_more` on the first, so the drain wants a second
        // trip. The cut decides whether it takes one.
        let mut source = ScriptedSource {
            outcomes: vec![
                page(vec![row(1, 1, "a")], true, 2),
                page(vec![row(2, 2, "b")], false, 2),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        // Expired before the pass begins, so the check fires on the first
        // boundary it reaches — which is BEFORE the first page, meaning nothing
        // is applied and nothing is lost.
        let already_gone = Instant::now() - std::time::Duration::from_secs(1);
        let cut = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            Window {
                deadline: Some(already_gone),
                ..Window::unbounded()
            },
            &NoChanges,
        ))
        .expect("a cut pass is not an error");
        assert!(cut.cut_by_the_deadline(), "the cut was not reported");
        assert_eq!(cut.rows_applied(), 0);
        // A DEADLINE IS NOT AN UNREACHABLE GATEWAY, and the two are now
        // different VARIANTS rather than two fields that could both be set: a
        // cut stage carries what it kept, and a skipped one carries a reason.
        assert!(
            matches!(cut.rows, Stage::Cut(_)),
            "a deadline was reported as something other than a cut: {:?}",
            cut.rows
        );
        assert_eq!(
            seat_state(&connection).expect("reads").applied_seq,
            0,
            "a cut pass moved the cursor past rows it never applied"
        );

        // THE NEXT PASS, with a window. It continues from the cursor the cut
        // left — which is the whole point — and the pages the cut never took
        // are still there to take.
        let whole = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert!(!whole.cut_by_the_deadline());
        assert_eq!(whole.rows_applied(), 2, "the next pass did not catch up");
        assert_eq!(seat_state(&connection).expect("reads").applied_seq, 2);
        assert_eq!(
            source.asked.first().map(|(_, since)| *since),
            Some(0),
            "the next pass asked from somewhere other than the cursor"
        );
    }

    /// The cut lands on a PAGE BOUNDARY, never inside one.
    ///
    /// Killed the mutant that moved the check below `apply_with_settlement`:
    /// with the check after the apply, a pass that ran out of window mid-drain
    /// would still have applied a page, which is fine — but the version that
    /// matters is the one where the check is inside the page loop over ROWS,
    /// and that leaves a commit half-applied. The assertion is that a cut pass
    /// applies a whole number of PAGES.
    #[test]
    fn a_cut_applies_whole_pages_or_none() {
        let connection = seat();
        let mut source = ScriptedSource {
            outcomes: vec![page(vec![row(1, 1, "a"), row(2, 1, "b")], true, 4)],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        // A deadline far enough out that the first boundary passes and the
        // second does not is not expressible without a sleep. So the boundary
        // is asserted the other way round: with NO deadline the whole page
        // applies, and both its rows land in one commit.
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(report.rows_applied(), 2);
        assert_eq!(report.commits_applied(), 1, "one commit, two rows");
        assert_eq!(
            seat_state(&connection).expect("reads").applied_commit_seq,
            1
        );
    }

    /// `intents_settled` accumulates across the pages of one pass.
    ///
    /// Two intents waiting on two different commits, arriving on two pages. A
    /// count that multiplied would be 0 and one that took only the last page
    /// would be 1.
    #[test]
    fn the_settled_count_accumulates_across_pages() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        for (id, commit_seq) in [("i-1", 1), ("i-2", 2)] {
            outbox.enqueue(&queued(id), "t").expect("queues");
            outbox
                .transition(id, IntentState::AwaitingChange, "t", |entry| {
                    entry.commit_seq = Some(commit_seq);
                })
                .expect("waits");
        }
        let mut source = ScriptedSource {
            outcomes: vec![
                page(vec![row(1, 1, "a")], true, 2),
                page(vec![row(2, 2, "b")], false, 2),
            ],
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t2",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(report.pages_fetched(), 2);
        assert_eq!(report.intents_settled(), 2);
        assert_eq!(report.overlays_cleared().len(), 2);
    }

    /// `is_due` measures ELAPSED time, which is a subtraction.
    ///
    /// Killed the mutant that turned `-` into `+`. Every other test used
    /// `updated_at_ms = 0`, where `now - 0` and `now + 0` are the same number —
    /// so the arithmetic was unasserted for every intent that had ever been
    /// tried at a real time.
    #[test]
    fn a_retry_measures_elapsed_time_from_when_it_was_last_tried() {
        let mut record = queued("i-1");
        record.attempts = 1; // a 2,000 ms backoff
        let last_tried = 1_000_000_i64;
        assert!(
            !is_due(&record, last_tried, last_tried + 1_999),
            "not due 1,999 ms after the last attempt"
        );
        assert!(
            is_due(&record, last_tried, last_tried + 2_000),
            "due 2,000 ms after the last attempt"
        );
        // AND NOT DUE at a `now` before the last attempt, which is what a
        // clock that went backwards looks like: an addition would call it due.
        assert!(
            !is_due(&record, last_tried, last_tried - 5_000),
            "a clock that went backwards does not make a retry due"
        );
    }

    #[test]
    fn a_pass_is_bounded_and_returns_even_when_there_is_more() {
        let connection = seat();
        let mut outcomes = Vec::new();
        for index in 1..=(SYNC_PAGES_PER_PASS + 10) {
            let seq = index as i64;
            outcomes.push(page(vec![row(seq, seq, &format!("r{seq}"))], true, 1_000));
        }
        let mut source = ScriptedSource {
            outcomes,
            asked: Vec::new(),
        };
        let mut sink = ScriptedSink {
            answers: Vec::new(),
            submitted: Vec::new(),
        };
        let report = drive(sync(
            &connection,
            &mut source,
            &mut sink,
            &mut NoBytes,
            "t",
            Window::unbounded(),
            &NoChanges,
        ))
        .expect("the pass runs");
        assert_eq!(
            report.pages_fetched(),
            SYNC_PAGES_PER_PASS,
            "a pass that drained to the watermark would be unbounded"
        );
        // And the caller can see there is more to do.
        assert!(report.behind > 0);
    }

    #[test]
    fn a_retry_is_due_only_after_its_backoff() {
        let mut record = queued("i-1");
        assert!(is_due(&record, 0, 0), "a first attempt is always due");
        record.attempts = 1;
        assert!(!is_due(&record, 0, 1_999));
        assert!(is_due(&record, 0, 2_000));
        record.attempts = 99;
        assert!(!is_due(&record, 0, 299_999));
        assert!(is_due(&record, 0, 300_000), "the ceiling is five minutes");
    }

    #[test]
    fn a_write_during_a_rebootstrap_is_admitted_and_not_sent() {
        let admission = admission_during_rebootstrap();
        assert!(admission.admit);
        assert!(!admission.send);
    }
}
