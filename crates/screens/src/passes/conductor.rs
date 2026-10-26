//! THE CONDUCTOR: when a pass runs, over which vaults, in which rounds, and what
//! the shell is asked to do around it (#1080 "The phone core"; #1135).
//!
//! A pass is one `drain` through the core: it takes a snapshot if one is due,
//! seals what waits into the spool under the member's rule, moves sealed parts
//! to the reachable gateway until the deadline, and settles what the gateway
//! acknowledged. Everything about WHEN is here, as a state machine with no I/O:
//! each input (a trigger, a finished call, a timer) returns the [`Action`]s the
//! pass service performs, and the service feeds the answers back. The Backup
//! screen reads [`Facts`] from the same object.
//!
//! ## Two rules it keeps that are not obvious
//!
//! * **A second pass on a vault whose pass is running is REFUSED, not queued**
//!   ([`Pass::Busy`]). The triggers fire together all the time (the app becomes
//!   active while a background window is still running) and a pass already
//!   running moves what the second would have. It is also the core's own rule
//!   (`phone.proto`). The one exception is a pass that is OWED a snapshot
//!   (`Reason::wants_snapshot`): it waits for the running one, inside its
//!   budget, because a lost snapshot is a promise not kept.
//! * **The next window is asked for on every path**, refusals included: a
//!   `BGTaskRequest` is one-shot, and a pass that only resubmitted on success
//!   would stop for good the first time the gateway was off.
//!
//! ## Every held vault, and the deadline is divided
//!
//! A window backs up the device, not the screen the member left open, and a
//! window that spent its whole budget on the first vault would leave a second
//! one never backed up on a phone that never gets a long window. A RESTING
//! holding (no core) and a FROZEN one (moved to another phone) are skipped:
//! waking one opens SQLite inside a background window, and the gateway refuses
//! the other's writes. "No deadline" (`0`) is passed through, not divided.
//!
//! ## A pass may take more than one round
//!
//! When the spool is empty but the core names items whose bytes only the OS
//! library holds ([`Answer::need_bytes`]), the shell streams them in
//! ([`Action::Stream`]) and the pass runs again inside the same budget, and
//! only while the ask changes or the last round moved parts, so a library that
//! will not produce a photograph cannot spin. A window that keeps moving still
//! ends at [`MAX_ROUNDS`].
//!
//! ## The iOS mover
//!
//! The OS moves bytes while the app is suspended, through a background
//! `URLSession` fed from the same spool (`phone.proto`'s `handoff`). After every
//! vault's pass, and whenever the OS says its session drained, the order is the
//! contract's: `reconcile` once (the gateway is PROBED, because a session whose
//! tasks keep failing is throttled by iOS), then `handoff`, then enqueue. An
//! unreachable gateway enqueues nothing and asks for the next window instead.
//! The batch sizes are protocol constants: modest, because iOS throttles a
//! session whose tasks fail ([`BATCH_PARTS`], [`BATCH_BYTES`], [`MAX_IN_FLIGHT`]).
//!
//! The OS can relaunch the app just to deliver finished tasks, before any vault
//! is open; the shell holds those reports until the runtime exists and then
//! sends them as facts (`UploadSettled`, `UploadsDrained`). That wait is the
//! only part of the mover that has to be native; every decision is here.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;

use super::conditions::{Conditions, Link, Reason};
use super::rule::Rules;
use crate::strings::{self, Locale};

/// No deadline: the member is watching and the pass runs until the spool is empty.
pub const FOREGROUND_DEADLINE_MS: u64 = 0;
/// Five seconds: a burst of typing is one pass, and a member who writes
/// something and locks the phone has it moving before they put it down. A
/// commit or a link change inside the window arms ONE timer for its end, so the
/// last of a burst is moved without a pass per keystroke.
pub const DEBOUNCE: Duration = Duration::from_secs(5);
/// Passes (the first and its rounds of "stream what was asked, pass again") one
/// vault's run may take.
pub const MAX_ROUNDS: u32 = 8;
/// Below this much budget a further round would be killed mid-part.
pub const MIN_ROUND_MS: u64 = 2_000;
/// What the app is granted after leaving the screen: under the ~30 seconds iOS
/// grants a background task, with room for the part in flight to finish.
pub const BACKGROUND_GRACE_MS: u64 = 20_000;
/// The window name the shell is told ended when the pass of a background entry
/// ends, so it can release the grace it holds.
pub const BACKGROUND_WINDOW: &str = "entered-background";
/// Modest batches, because iOS throttles a session whose tasks fail and a batch
/// is only as good as the probe before it: 16 parts, at most 512 MiB, and never
/// more than 32 tasks in the OS's hands at once.
pub const BATCH_PARTS: u32 = 16;
pub const BATCH_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_IN_FLIGHT: u32 = 32;
/// The services a wake reaches (see [`Conductor::wake`]): the pass service takes
/// what the screens asked, and the vault service tells Home the line moved.
const WAKES: [&str; 2] = [super::service::NAME, crate::vault::service::NAME];
/// How many asked doors [`Conductor::take_issued`] keeps.
const ISSUED_KEPT: usize = 64;

/// One vault the phone holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Held {
    pub vault_id: String,
    /// Open (not resting) and not frozen: the core can be asked for a pass.
    pub drainable: bool,
}

/// Where the held vaults come from when the shell has not said: the Rust shelf
/// implements this.
pub trait Holdings: Send + Sync {
    /// Every vault this device holds, foreground first.
    fn held(&self) -> Vec<Held>;

    /// The core of one held vault, when the shelf has it open; `None` runs the
    /// call on the core the screens run on.
    fn core(&self, _vault_id: &str) -> Option<centraid_core::Handle> {
        None
    }
}

/// Why a pass stopped (`DrainStop`), plus the one refusal that is an answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// The spool is empty.
    Empty,
    /// The window ran out. The next one resumes where this stopped.
    Deadline,
    /// No gateway answered. Nothing was lost; nothing was sent.
    Unreachable,
    /// The machine that answered is not the gateway this phone pinned.
    Untrusted,
    /// The gateway answered and refused a write for its own reason (disk full,
    /// quota): the member's backup device has to make room, so this is not
    /// `Unreachable`'s "try again later".
    Refused,
    /// A gateway refused this phone's writes: the vault was restored onto
    /// another phone. The vault is frozen read-only; nothing is deleted.
    Moved,
}

/// What a `drain` answered. **Every time here is the GATEWAY's clock**
/// ([`Answer::acked_at_ms`]), which is what lets a line say "backed up" at all.
#[derive(Clone, Debug, PartialEq)]
pub struct Answer {
    pub pending_bytes: u64,
    pub stopped: Stopped,
    pub acked_at_ms: Option<i64>,
    pub confirmed_parts: u32,
    pub waiting_bytes_parts: u32,
    pub need_bytes: Vec<wire::NeedBytes>,
    /// When the gateway says the vault moved; set only with [`Stopped::Moved`].
    pub moved_at_ms: Option<i64>,
}

impl Answer {
    /// Whether this pass left the spool empty.
    #[must_use]
    pub fn drained(&self) -> bool {
        self.stopped == Stopped::Empty
    }
}

/// What the core said to a `drain`, before the conductor reads it.
#[derive(Clone, Debug, PartialEq)]
pub enum Drained {
    /// The core answered.
    Response(wire::DrainResponse),
    /// The core refused with `VAULT_MOVED`: another phone claimed the vault.
    /// The one refusal that is an answer.
    Moved { at_ms: i64 },
    /// There was no core to ask, or it refused the pass outright (including
    /// "a drain is already running"). Not a sentence a member reads.
    Unavailable,
}

impl Drained {
    /// Read a door's answer. A refusal other than `VAULT_MOVED` is
    /// [`Self::Unavailable`].
    #[must_use]
    pub fn of(call: Result<wire::Response, wire::Error>) -> Self {
        match call {
            Ok(wire::Response {
                kind: Some(wire::response::Kind::Drain(response)),
            }) => Self::Response(response),
            Ok(_) => Self::Unavailable,
            Err(error) if error.code == wire::ErrorCode::VaultMoved as i32 => Self::Moved {
                at_ms: error.moved.map_or(0, |moved| moved.moved_at_ms),
            },
            Err(_) => Self::Unavailable,
        }
    }

    fn pass(&self) -> Pass {
        match self {
            Self::Response(response) => {
                let stopped = match wire::DrainStop::try_from(response.stopped) {
                    Ok(wire::DrainStop::Empty) => Stopped::Empty,
                    Ok(wire::DrainStop::Deadline) => Stopped::Deadline,
                    Ok(wire::DrainStop::Untrusted) => Stopped::Untrusted,
                    Ok(wire::DrainStop::Refused) => Stopped::Refused,
                    // UNSPECIFIED IS READ AS UNREACHABLE, DELIBERATELY: the
                    // safe reading of "I do not know why it stopped" leaves
                    // the claim behind rather than ahead.
                    Ok(wire::DrainStop::Unreachable | wire::DrainStop::Unspecified) | Err(_) => {
                        Stopped::Unreachable
                    }
                };
                Pass::Ran(Answer {
                    pending_bytes: response.pending_bytes,
                    stopped,
                    acked_at_ms: response.acked_at_ms,
                    confirmed_parts: response.confirmed_parts,
                    waiting_bytes_parts: response.waiting_bytes_parts,
                    // A HASH OF THE WRONG LENGTH IS DROPPED, never streamed against:
                    // the stage must hash to the BLAKE3 of the whole plaintext.
                    need_bytes: response
                        .need_bytes
                        .iter()
                        .filter(|need| need.content_hash.len() == 32)
                        .cloned()
                        .collect(),
                    moved_at_ms: None,
                })
            }
            Self::Moved { at_ms } => Pass::Ran(Answer {
                pending_bytes: 0,
                stopped: Stopped::Moved,
                acked_at_ms: None,
                confirmed_parts: 0,
                waiting_bytes_parts: 0,
                need_bytes: Vec::new(),
                moved_at_ms: Some(*at_ms),
            }),
            Self::Unavailable => Pass::Unavailable,
        }
    }
}

/// What one vault's pass did.
#[derive(Clone, Debug, PartialEq)]
pub enum Pass {
    /// The core answered; [`Answer`] is the whole of what happened.
    Ran(Answer),
    /// A pass was already running. Nothing was sent and nothing is queued.
    Busy,
    /// No core to ask, or it refused the pass outright.
    Unavailable,
}

/// What one vault's run did, and why it ran.
#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub vault_id: String,
    pub pass: Pass,
    pub reason: Reason,
}

/// Whether every vault's pass ran and left its spool empty: what a background
/// task reports. A run with nothing to send drained.
#[must_use]
pub fn all_drained(outcomes: &[Outcome]) -> bool {
    outcomes
        .iter()
        .all(|outcome| matches!(&outcome.pass, Pass::Ran(answer) if answer.drained()))
}

/// What the OS said about the windows it was asked to keep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Registration {
    /// The short, no-charger window was taken.
    pub short: bool,
    /// The long window that waits for the charger was taken.
    pub long: bool,
}

impl Registration {
    #[must_use]
    pub fn registered(self) -> bool {
        self.short || self.long
    }

    /// The platform's verdict in words a member can read. **Observable rather
    /// than assumed**: "Background App Refresh is off" is a sentence a member
    /// reads rather than a silent absence of passes. Which one was refused is
    /// what a member is owed: a phone that will prepare and seal but not settle
    /// early, or the reverse, is a different product to use.
    #[must_use]
    pub fn sentence(self, locale: Locale, platform: &str) -> String {
        match (self.short, self.long) {
            (true, true) => strings::passes::background_both(locale),
            (false, true) => strings::passes::background_long_only(locale),
            (true, false) => strings::passes::background_short_only(locale),
            (false, false) if platform == "android" => {
                strings::passes::background_none_android(locale)
            }
            (false, false) => strings::passes::background_none_ios(locale),
        }
    }
}

/// What the conductor knows, for the screens that draw it. **Facts, not
/// strings**: the Backup screen words them.
#[derive(Clone, Debug, PartialEq)]
pub struct Facts {
    /// A "Back up now" run is in progress (the walk of the roll included).
    pub backing_up: bool,
    /// Any run is in progress.
    pub running: bool,
    /// The vaults a pass is in flight on.
    pub busy: BTreeSet<String>,
    /// What the pass in flight on each vault was asked (its deadline, rule and link).
    pub in_flight: BTreeMap<String, wire::DrainRequest>,
    /// Each vault's last pass, in this process.
    pub last: BTreeMap<String, Pass>,
    /// The vaults whose last answer was `MOVED`: the shelf freezes them.
    pub moved: BTreeSet<String>,
    /// What the OS said to the last request for windows; none before one.
    pub registration: Option<Registration>,
    /// The platform's last reading of the radio and the charger.
    pub link: Link,
}

/// Work the pass service performs for the conductor.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    /// Walk the camera roll to its end (`CameraRoll{IMPORT_NOW}`), then
    /// [`Conductor::walked`].
    Walk,
    /// One `drain` on `vault`, then [`Conductor::drained`].
    Drain {
        vault: String,
        request: wire::DrainRequest,
    },
    /// Stream these items from the OS library into `vault`, then
    /// [`Conductor::streamed`] with how many landed.
    Stream {
        vault: String,
        needs: Vec<wire::NeedBytes>,
    },
    /// Probe `vault`'s gateway, then [`Conductor::reconciled`].
    Reconcile {
        vault: String,
    },
    /// Ask the OS how many tasks it holds, then [`Conductor::pending`].
    UploadsPending,
    /// Ask `vault`'s core for the next batch, then [`Conductor::handed_off`].
    Handoff {
        vault: String,
        max_bytes: u64,
        max_parts: u32,
    },
    /// Give these whole requests to the OS.
    UploadsEnqueue(Vec<wire::HandoffPart>),
    /// Let go of every task the OS holds.
    UploadsCancelAll,
    /// Record what the OS reported for one finished task in `vault`'s ledger.
    Settle {
        vault: String,
        settled: wire::Settled,
    },
    /// Keep the standing windows scheduled under the rule now held.
    Schedule,
    /// One more window soon.
    Nudge,
    /// The long run behind "Back up now" starts or ends.
    LongRun(bool),
    /// The pass a window started has ended.
    WindowDone {
        window: String,
        drained: bool,
    },
    /// Start (or restart) a timer; its name comes back as [`Conductor::timer`].
    Timer {
        name: String,
        after: Duration,
    },
    CancelTimer {
        name: String,
    },
    /// The facts moved: wake the services ([`Conductor::wake`]).
    Changed,
}

#[derive(Debug)]
enum Stage {
    /// About to take the vault's turn.
    Start,
    /// A snapshot is owed and a pass is running: waiting for it.
    Idle,
    /// A pass is in flight.
    Draining,
    /// Waiting for the stream lane / the OS library.
    Streaming,
}

#[derive(Debug)]
struct Cur {
    vault: String,
    started: u64,
    asked: BTreeSet<Vec<u8>>,
    rounds: u32,
    stage: Stage,
    /// The latest outcome of this vault's run: the one that is reported.
    outcome: Option<Pass>,
}

#[derive(Debug)]
struct Run {
    reason: Reason,
    deadline_ms: u64,
    window: Option<String>,
    vaults: Vec<String>,
    at: usize,
    each: u64,
    walking: bool,
    cur: Option<Cur>,
    outcomes: Vec<Outcome>,
}

#[derive(Debug)]
enum Handoff {
    Reconciling(String),
    Counting(String),
    Fetching(String),
}

struct Inner {
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    debounce: Duration,
    holdings: Option<Arc<dyn Holdings>>,
    held: Option<Vec<Held>>,
    rules: Rules,
    link: Link,
    /// iOS only: the OS carries sealed parts while the app is suspended.
    uploads: bool,
    next_run: u64,
    runs: BTreeMap<u64, Run>,
    busy: BTreeSet<String>,
    last: BTreeMap<String, Pass>,
    moved: BTreeSet<String>,
    registration: Option<Registration>,
    last_commit: Option<u64>,
    commit_armed: bool,
    last_link: Option<u64>,
    link_armed: bool,
    walking: bool,
    streaming: Option<u64>,
    stream_queue: VecDeque<u64>,
    handoff: Option<Handoff>,
    handoff_queue: VecDeque<String>,
    inbox: VecDeque<wire::pass_asked::Ask>,
    /// The pass in flight on each vault and what it was asked.
    in_flight: BTreeMap<String, wire::DrainRequest>,
    /// The last doors asked of the core, newest last, for diagnostics and tests.
    issued: VecDeque<(String, wire::Request)>,
}

/// The pass conductor. Cheap to clone: every clone is the same state, so the
/// pass service and the Backup screen drive and read one object.
#[derive(Clone)]
pub struct Conductor {
    inner: Arc<Mutex<Inner>>,
}

impl Default for Conductor {
    fn default() -> Self {
        let origin = Instant::now();
        Self::with_clock(DEBOUNCE, move || {
            u64::try_from(origin.elapsed().as_millis()).unwrap_or(u64::MAX)
        })
    }
}

impl std::fmt::Debug for Conductor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Conductor({:?})", self.facts())
    }
}

impl Conductor {
    /// A conductor on a monotonic millisecond clock. **Never a backup claim**:
    /// it times the debounces and round budgets only.
    pub fn with_clock(debounce: Duration, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                clock: Arc::new(clock),
                debounce,
                holdings: None,
                held: None,
                rules: Rules::default(),
                link: Link::UNKNOWN,
                uploads: false,
                next_run: 1,
                runs: BTreeMap::new(),
                busy: BTreeSet::new(),
                last: BTreeMap::new(),
                moved: BTreeSet::new(),
                registration: None,
                last_commit: None,
                commit_armed: false,
                last_link: None,
                link_armed: false,
                walking: false,
                streaming: None,
                stream_queue: VecDeque::new(),
                handoff: None,
                handoff_queue: VecDeque::new(),
                inbox: VecDeque::new(),
                in_flight: BTreeMap::new(),
                issued: VecDeque::new(),
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    // ---- what the service tells it --------------------------------------------

    /// The pass on `vault` was asked with `request`.
    pub(crate) fn record_pass(&self, vault: &str, request: &wire::DrainRequest) {
        self.lock().in_flight.insert(vault.to_owned(), *request);
    }

    /// A door was asked of the core under `tag`.
    pub(crate) fn record_call(&self, tag: &str, request: &centraid_core::screens::VaultRequest) {
        let mut inner = self.lock();
        inner
            .issued
            .push_back((tag.to_owned(), request.clone().into_request()));
        while inner.issued.len() > ISSUED_KEPT {
            inner.issued.pop_front();
        }
    }

    /// The core of `vault`, when the shelf has one.
    pub(crate) fn core_of(&self, vault: &str) -> Option<centraid_core::Handle> {
        let holdings = self.lock().holdings.clone()?;
        holdings.core(vault)
    }

    /// The doors asked of the core since this was last called, oldest first.
    /// For diagnostics and tests: production never reads it, and it keeps only
    /// the last [`ISSUED_KEPT`].
    #[must_use]
    pub fn take_issued(&self) -> Vec<(String, wire::Request)> {
        self.lock().issued.drain(..).collect()
    }

    /// How long a commit or a link change is held back by the debounce.
    pub fn set_debounce(&self, debounce: Duration) {
        self.lock().debounce = debounce;
    }

    /// Where the held vaults come from (the Rust shelf).
    pub fn use_holdings(&self, holdings: Arc<dyn Holdings>) {
        self.lock().holdings = Some(holdings);
    }

    /// The shell said which vaults the phone holds.
    pub fn set_held(&self, held: Vec<Held>) {
        self.lock().held = Some(held);
    }

    /// The rule and "Include videos" as the device store holds them now. Read
    /// before EVERY pass and never cached across passes.
    pub fn set_rules(&self, rules: Rules) {
        self.lock().rules = rules;
    }

    /// Whether the OS carries sealed parts while the app is suspended (iOS).
    pub fn set_uploads(&self, on: bool) {
        self.lock().uploads = on;
    }

    /// What the OS said to a request for windows.
    pub fn set_registration(&self, registration: Registration) -> Vec<Action> {
        self.lock().registration = Some(registration);
        vec![Action::Changed]
    }

    /// A screen asks for something of the pass service ("Back up now", a rule
    /// that changed, a finished restore) and wakes it. The service does it on
    /// its next turn: a screen cannot perform the pass's effects, and the
    /// service owns the answers.
    pub fn ask(&self, ctx: &crate::screen::Ctx, ask: wire::pass_asked::Ask) {
        self.lock().inbox.push_back(ask);
        Self::wake(ctx);
    }

    /// Tell the services that something the conductor holds moved, as
    /// `Signalled`. A screen is never woken by its own post, so the pass service
    /// waking the services wakes only the other one.
    pub(crate) fn wake(ctx: &crate::screen::Ctx) {
        for name in WAKES {
            ctx.post(
                name,
                wire::ScreenEvent {
                    kind: Some(wire::screen_event::Kind::Signalled(wire::Signalled {})),
                },
            );
        }
    }

    /// What the screens asked since the service last looked.
    pub(crate) fn take_asks(&self) -> Vec<wire::pass_asked::Ask> {
        self.lock().inbox.drain(..).collect()
    }

    // ---- what the screens read -------------------------------------------------

    #[must_use]
    pub fn facts(&self) -> Facts {
        let inner = self.lock();
        Facts {
            backing_up: inner
                .runs
                .values()
                .any(|run| run.reason == Reason::BackUpNow),
            running: !inner.runs.is_empty(),
            busy: inner.busy.clone(),
            in_flight: inner.in_flight.clone(),
            last: inner.last.clone(),
            moved: inner.moved.clone(),
            registration: inner.registration,
            link: inner.link,
        }
    }

    /// The shelf froze `vault` (or it was forgotten): the conductor forgets
    /// that it moved.
    pub fn forget(&self, vault: &str) {
        let mut inner = self.lock();
        inner.moved.remove(vault);
        inner.last.remove(vault);
    }

    // ---- triggers ---------------------------------------------------------------

    /// Run one pass over every held vault. `deadline_ms` `0` is "no deadline".
    /// A "Back up now" while one runs JOINS it, so the member's two taps are
    /// one backup.
    #[must_use]
    pub fn trigger(&self, reason: Reason, deadline_ms: u64) -> Vec<Action> {
        self.trigger_in(reason, deadline_ms, None)
    }

    /// A background window the OS granted, with its own budget; the shell is
    /// told when the pass ends ([`Action::WindowDone`]).
    #[must_use]
    pub fn window_granted(&self, window: &str, deadline_ms: u64) -> Vec<Action> {
        self.trigger_in(Reason::Scheduled, deadline_ms, Some(window.to_owned()))
    }

    /// The app left the screen, with the platform's grace. Forces a snapshot; a
    /// pass already running is waited for inside the grace rather than refused.
    #[must_use]
    pub fn entered_background(&self) -> Vec<Action> {
        let mut out = self.trigger_in(
            Reason::EnteredBackground,
            BACKGROUND_GRACE_MS,
            Some(BACKGROUND_WINDOW.to_owned()),
        );
        // A BGTaskRequest IS ONE-SHOT: leaving the app is what arms the night.
        out.push(Action::Schedule);
        out
    }

    fn trigger_in(&self, reason: Reason, deadline_ms: u64, window: Option<String>) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        if reason == Reason::BackUpNow
            && inner
                .runs
                .values()
                .any(|run| run.reason == Reason::BackUpNow)
        {
            return out;
        }
        let id = inner.next_run;
        inner.next_run += 1;
        let walking = reason.walks_first();
        inner.runs.insert(
            id,
            Run {
                reason,
                deadline_ms,
                window,
                vaults: Vec::new(),
                at: 0,
                each: 0,
                walking,
                cur: None,
                outcomes: Vec::new(),
            },
        );
        if reason == Reason::BackUpNow {
            out.push(Action::LongRun(true));
        }
        out.push(Action::Changed);
        if walking {
            // THE ROLL FIRST: "Back up now" means the photograph the member just
            // took, and the asked pass is what lets its original through. A walk
            // already running serves every run that asked while it ran.
            if !inner.walking {
                inner.walking = true;
                out.push(Action::Walk);
            }
        } else {
            inner.begin(id, &mut out);
        }
        out
    }

    /// The camera roll's walk ended (or failed: the pass runs either way).
    #[must_use]
    pub fn walked(&self) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        inner.walking = false;
        let waiting: Vec<u64> = inner
            .runs
            .iter()
            .filter(|(_, run)| run.walking)
            .map(|(id, _)| *id)
            .collect();
        for id in waiting {
            if let Some(run) = inner.runs.get_mut(&id) {
                run.walking = false;
            }
            inner.begin(id, &mut out);
        }
        out
    }

    /// A commit landed. **Debounced**: the first runs, one inside the window
    /// arms one timer for its end.
    #[must_use]
    pub fn commit_landed(&self) -> Vec<Action> {
        let mut inner = self.lock();
        let now = inner.now();
        let window = u64::try_from(inner.debounce.as_millis()).unwrap_or(u64::MAX);
        if let Some(last) = inner.last_commit.filter(|last| now - last < window) {
            if inner.commit_armed {
                return Vec::new();
            }
            inner.commit_armed = true;
            return vec![Action::Timer {
                name: COMMIT_TIMER.to_owned(),
                after: Duration::from_millis(window - (now - last)),
            }];
        }
        inner.last_commit = Some(now);
        drop(inner);
        self.trigger(Reason::AfterCommit, FOREGROUND_DEADLINE_MS)
    }

    /// The radio moved. Only a link that is UP is worth a pass, and a link that
    /// flaps runs at most one per debounce, on its own clock, so a commit a
    /// moment ago does not swallow the move from cellular to Wi-Fi.
    #[must_use]
    pub fn link_changed(&self, fact: &wire::LinkChanged) -> Vec<Action> {
        let mut inner = self.lock();
        inner.link = Link::of(fact);
        let mut out = vec![Action::Changed];
        if !fact.online {
            return out;
        }
        let now = inner.now();
        let window = u64::try_from(inner.debounce.as_millis()).unwrap_or(u64::MAX);
        if let Some(last) = inner.last_link.filter(|last| now - last < window) {
            if !inner.link_armed {
                inner.link_armed = true;
                out.push(Action::Timer {
                    name: LINK_TIMER.to_owned(),
                    after: Duration::from_millis(window - (now - last)),
                });
            }
            return out;
        }
        inner.last_link = Some(now);
        drop(inner);
        out.extend(self.trigger(Reason::Connectivity, FOREGROUND_DEADLINE_MS));
        out
    }

    /// A timer the conductor asked for elapsed.
    #[must_use]
    pub fn timer(&self, name: &str) -> Vec<Action> {
        let mut inner = self.lock();
        match name {
            COMMIT_TIMER => {
                inner.commit_armed = false;
                inner.last_commit = Some(inner.now());
                drop(inner);
                self.trigger(Reason::AfterCommit, FOREGROUND_DEADLINE_MS)
            }
            LINK_TIMER => {
                inner.link_armed = false;
                inner.last_link = Some(inner.now());
                drop(inner);
                self.trigger(Reason::Connectivity, FOREGROUND_DEADLINE_MS)
            }
            _ => {
                let Some(id) = name
                    .strip_prefix(IDLE_TIMER)
                    .and_then(|id| id.parse::<u64>().ok())
                else {
                    return Vec::new();
                };
                // THE BUDGET RAN OUT WAITING: the running pass is the answer.
                let mut out = Vec::new();
                let waiting = inner
                    .runs
                    .get(&id)
                    .and_then(|run| run.cur.as_ref())
                    .is_some_and(|cur| matches!(cur.stage, Stage::Idle));
                if waiting {
                    inner.end_vault(id, Pass::Busy, &mut out);
                    inner.advance(id, &mut out);
                }
                out
            }
        }
    }

    /// A pass finished on `vault`.
    #[must_use]
    pub fn drained(&self, vault: &str, drained: &Drained) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        inner.busy.remove(vault);
        inner.in_flight.remove(vault);
        // THE NEXT WINDOW IS ASKED FOR ON EVERY PATH.
        out.push(Action::Schedule);
        let Some(id) = inner.runs.iter().find_map(|(id, run)| {
            run.cur
                .as_ref()
                .is_some_and(|cur| cur.vault == vault && matches!(cur.stage, Stage::Draining))
                .then_some(*id)
        }) else {
            return out;
        };
        let pass = drained.pass();
        inner.after_pass(id, pass, &mut out);
        // A pass that is OWED a snapshot was waiting for this one.
        inner.wake_idle(vault, &mut out);
        out
    }

    /// The items the core asked for were streamed in; `landed` is how many.
    #[must_use]
    pub fn streamed(&self, landed: u32) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        let Some(id) = inner.streaming.take() else {
            return out;
        };
        if landed == 0 {
            // A FEED THAT LANDED NOTHING ENDS THE PASS AT ONCE.
            inner.finish_cur(id, &mut out);
        } else {
            inner.next_round(id, &mut out);
        }
        inner.pump_stream(&mut out);
        out
    }

    // ---- the iOS mover ----------------------------------------------------------

    /// One upload the OS ran finished. A vault this phone no longer holds
    /// settles nowhere: nothing is waiting on it, and `reconcile` squares any
    /// ledger from the gateway.
    #[must_use]
    pub fn upload_settled(&self, settled: &wire::UploadSettled) -> Vec<Action> {
        let inner = self.lock();
        if !inner.drainable().contains(&settled.vault_id) {
            return Vec::new();
        }
        vec![Action::Settle {
            vault: settled.vault_id.clone(),
            settled: wire::Settled {
                name: settled.name.clone(),
                http_status: settled.http_status,
                error: settled.error.clone(),
                gateway_id: settled.gateway_id.clone(),
                vault_id: settled.vault_id.clone(),
            },
        }]
    }

    /// The OS delivered every event for its session: hand the next batch off
    /// before iOS suspends the app again.
    #[must_use]
    pub fn uploads_drained(&self) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        for vault in inner.drainable() {
            inner.queue_handoff(vault);
        }
        inner.pump_handoff(&mut out);
        out
    }

    /// The member changed the rule: every task the OS holds keeps the cellular
    /// flag of the rule it was handed off under, so they are all let go; the
    /// core requeues their parts and the next pass hands them off under the new
    /// rule. The windows are asked for again under the new constraints.
    #[must_use]
    pub fn rule_changed(&self) -> Vec<Action> {
        let inner = self.lock();
        let mut out = vec![Action::Schedule];
        if inner.uploads {
            out.push(Action::UploadsCancelAll);
        }
        out.push(Action::Changed);
        out
    }

    /// `vault`'s probe answered: `None` is no core or an arm not yet available
    /// (nothing to do, never a reason to enqueue what nobody vouched for).
    #[must_use]
    pub fn reconciled(&self, vault: &str, reachable: Option<bool>) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        if !matches!(&inner.handoff, Some(Handoff::Reconciling(active)) if active == vault) {
            return out;
        }
        match reachable {
            None => inner.handoff = None,
            Some(false) => {
                inner.handoff = None;
                out.push(Action::Schedule);
            }
            Some(true) => {
                inner.handoff = Some(Handoff::Counting(vault.to_owned()));
                out.push(Action::UploadsPending);
            }
        }
        inner.pump_handoff(&mut out);
        out
    }

    /// The OS holds `count` unfinished tasks.
    #[must_use]
    pub fn pending(&self, count: u32) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        let Some(Handoff::Counting(vault)) = inner.handoff.take() else {
            return out;
        };
        let room = MAX_IN_FLIGHT.saturating_sub(count);
        if room == 0 {
            inner.pump_handoff(&mut out);
        } else {
            out.push(Action::Handoff {
                vault: vault.clone(),
                max_bytes: BATCH_BYTES,
                max_parts: room.min(BATCH_PARTS),
            });
            inner.handoff = Some(Handoff::Fetching(vault));
        }
        out
    }

    /// The core answered the next batch (empty is nothing to hand off).
    #[must_use]
    pub fn handed_off(&self, vault: &str, parts: Vec<wire::HandoffPart>) -> Vec<Action> {
        let mut inner = self.lock();
        let mut out = Vec::new();
        if !matches!(&inner.handoff, Some(Handoff::Fetching(active)) if active == vault) {
            return out;
        }
        inner.handoff = None;
        if !parts.is_empty() {
            out.push(Action::UploadsEnqueue(parts));
        }
        inner.pump_handoff(&mut out);
        out
    }
}

pub(crate) const COMMIT_TIMER: &str = "commit";
pub(crate) const LINK_TIMER: &str = "link";
pub(crate) const IDLE_TIMER: &str = "idle:";

impl Inner {
    fn now(&self) -> u64 {
        (self.clock)()
    }

    fn held(&self) -> Vec<Held> {
        if let Some(holdings) = &self.holdings {
            return holdings.held();
        }
        // BEFORE THE SHELL SAYS, the core the screens run on is the one vault.
        self.held.clone().unwrap_or_else(|| {
            vec![Held {
                vault_id: String::new(),
                drainable: true,
            }]
        })
    }

    fn drainable(&self) -> Vec<String> {
        self.held()
            .into_iter()
            .filter(|held| held.drainable)
            .map(|held| held.vault_id)
            .collect()
    }

    fn conditions(&self) -> Conditions {
        Conditions {
            rules: self.rules,
            link: self.link,
        }
    }

    /// The run starts its vaults (after the walk, when it walks): the held list
    /// is read now, and the budget is divided over it.
    fn begin(&mut self, id: u64, out: &mut Vec<Action>) {
        let vaults = self.drainable();
        let Some(run) = self.runs.get_mut(&id) else {
            return;
        };
        run.each = if run.deadline_ms == 0 {
            0
        } else {
            run.deadline_ms / vaults.len().max(1) as u64
        };
        run.vaults = vaults;
        self.advance(id, out);
    }

    /// Take the run as far as it goes without waiting on anything.
    fn advance(&mut self, id: u64, out: &mut Vec<Action>) {
        enum Step {
            Return,
            Again,
            Finish,
            EndBusy,
            Idle(u64),
            Drain(String, wire::DrainRequest),
        }
        loop {
            let now = self.now();
            let conditions = self.conditions();
            let step = {
                let Some(run) = self.runs.get_mut(&id) else {
                    return;
                };
                if run.walking {
                    return;
                }
                match run.cur.as_mut() {
                    None => match run.vaults.get(run.at).cloned() {
                        None => Step::Finish,
                        Some(vault) => {
                            run.cur = Some(Cur {
                                vault,
                                started: now,
                                asked: BTreeSet::new(),
                                rounds: 0,
                                stage: Stage::Start,
                                outcome: None,
                            });
                            Step::Again
                        }
                    },
                    Some(cur) => match cur.stage {
                        Stage::Start => {
                            let vault = cur.vault.clone();
                            if self.busy.contains(&vault) {
                                if run.reason.wants_snapshot() {
                                    cur.stage = Stage::Idle;
                                    Step::Idle(run.each)
                                } else {
                                    Step::EndBusy
                                }
                            } else {
                                cur.stage = Stage::Draining;
                                cur.rounds = 1;
                                Step::Drain(vault, conditions.request(run.each, run.reason))
                            }
                        }
                        Stage::Idle | Stage::Draining | Stage::Streaming => Step::Return,
                    },
                }
            };
            match step {
                Step::Return => return,
                Step::Again => {}
                Step::Finish => {
                    self.finish(id, out);
                    return;
                }
                Step::EndBusy => self.end_vault(id, Pass::Busy, out),
                Step::Idle(each) => {
                    if each > 0 {
                        out.push(Action::Timer {
                            name: format!("{IDLE_TIMER}{id}"),
                            after: Duration::from_millis(each),
                        });
                    }
                    return;
                }
                Step::Drain(vault, request) => {
                    self.busy.insert(vault.clone());
                    out.push(Action::Drain { vault, request });
                    return;
                }
            }
        }
    }

    /// A pass answered inside run `id`.
    fn after_pass(&mut self, id: u64, pass: Pass, out: &mut Vec<Action>) {
        let now = self.now();
        let Some(run) = self.runs.get_mut(&id) else {
            return;
        };
        let each = run.each;
        let Some(cur) = run.cur.as_mut() else {
            return;
        };
        cur.outcome = Some(pass.clone());
        let rounds_left = cur.rounds < MAX_ROUNDS;
        let Pass::Ran(answer) = &pass else {
            self.finish_cur(id, out);
            return;
        };
        if answer.stopped != Stopped::Empty || answer.need_bytes.is_empty() || !rounds_left {
            self.finish_cur(id, out);
            return;
        }
        let ask: BTreeSet<Vec<u8>> = answer
            .need_bytes
            .iter()
            .map(|need| need.content_hash.clone())
            .collect();
        // THE SAME ASK TWICE IS NO PROGRESS: the library would not produce those
        // bytes, and asking again would spin the window away, unless the round
        // moved parts. An original larger than the spool is asked for again, for
        // its next window, once the last one moved (R-1080-C39).
        if ask == cur.asked && answer.confirmed_parts == 0 {
            self.finish_cur(id, out);
            return;
        }
        cur.asked = ask;
        let started = cur.started;
        if each > 0 && remaining(each, started, now) <= MIN_ROUND_MS {
            self.finish_cur(id, out);
            return;
        }
        cur.stage = Stage::Streaming;
        self.stream_queue.push_back(id);
        self.pump_stream(out);
    }

    /// Start the next stream when none is in flight.
    fn pump_stream(&mut self, out: &mut Vec<Action>) {
        while self.streaming.is_none() {
            let Some(id) = self.stream_queue.pop_front() else {
                return;
            };
            let Some(cur) = self.runs.get(&id).and_then(|run| run.cur.as_ref()) else {
                continue;
            };
            let needs = match &cur.outcome {
                Some(Pass::Ran(answer)) => answer.need_bytes.clone(),
                _ => Vec::new(),
            };
            self.streaming = Some(id);
            out.push(Action::Stream {
                vault: cur.vault.clone(),
                needs,
            });
        }
    }

    /// The items landed: the pass runs again, without a second snapshot. The
    /// member's ask covers the whole pass, so `asked` rides every round.
    fn next_round(&mut self, id: u64, out: &mut Vec<Action>) {
        let now = self.now();
        let conditions = self.conditions();
        let Some(run) = self.runs.get_mut(&id) else {
            return;
        };
        let reason = run.reason;
        let each = run.each;
        let Some(cur) = run.cur.as_mut() else {
            return;
        };
        let vault = cur.vault.clone();
        if self.busy.contains(&vault) {
            cur.outcome = Some(Pass::Busy);
            self.finish_cur(id, out);
            return;
        }
        cur.stage = Stage::Draining;
        cur.rounds += 1;
        let mut request = conditions.request(remaining(each, cur.started, now), reason);
        // THE SNAPSHOT WAS TAKEN IN THE FIRST ROUND.
        request.wants_snapshot = false;
        self.busy.insert(vault.clone());
        out.push(Action::Drain { vault, request });
    }

    /// The run is done with this vault: report the latest outcome, take the next.
    fn finish_cur(&mut self, id: u64, out: &mut Vec<Action>) {
        let outcome = self
            .runs
            .get(&id)
            .and_then(|run| run.cur.as_ref())
            .and_then(|cur| cur.outcome.clone())
            .unwrap_or(Pass::Unavailable);
        self.end_vault(id, outcome, out);
        self.advance(id, out);
    }

    fn end_vault(&mut self, id: u64, pass: Pass, out: &mut Vec<Action>) {
        let Some(run) = self.runs.get_mut(&id) else {
            return;
        };
        let Some(cur) = run.cur.take() else {
            return;
        };
        run.at += 1;
        run.outcomes.push(Outcome {
            vault_id: cur.vault.clone(),
            pass: pass.clone(),
            reason: run.reason,
        });
        // ONE VAULT'S PASS ENDED: its answer is what the status line is read
        // from, and a `MOVED` vault is frozen by the shelf.
        if matches!(&pass, Pass::Ran(answer) if answer.stopped == Stopped::Moved) {
            self.moved.insert(cur.vault.clone());
        }
        self.last.insert(cur.vault.clone(), pass);
        out.push(Action::Changed);
        // EVERY iOS PASS ENDS WITH RECONCILE, THEN HANDOFF, THEN ENQUEUE: what
        // the pass sealed but did not move goes to the OS to carry while the app
        // is suspended. Android moves its parts in the pass.
        if self.uploads && !self.moved.contains(&cur.vault) {
            self.queue_handoff(cur.vault);
            self.pump_handoff(out);
        }
    }

    fn finish(&mut self, id: u64, out: &mut Vec<Action>) {
        let Some(run) = self.runs.remove(&id) else {
            return;
        };
        if let Some(window) = run.window {
            out.push(Action::WindowDone {
                window,
                drained: all_drained(&run.outcomes),
            });
        }
        if run.reason == Reason::BackUpNow {
            out.push(Action::LongRun(false));
        }
        out.push(Action::Changed);
    }

    fn wake_idle(&mut self, vault: &str, out: &mut Vec<Action>) {
        let now = self.now();
        let waiting = self.runs.iter().find_map(|(id, run)| {
            run.cur
                .as_ref()
                .is_some_and(|cur| cur.vault == vault && matches!(cur.stage, Stage::Idle))
                .then_some(*id)
        });
        let Some(id) = waiting else {
            return;
        };
        if self.busy.contains(vault) {
            return;
        }
        out.push(Action::CancelTimer {
            name: format!("{IDLE_TIMER}{id}"),
        });
        let conditions = self.conditions();
        let Some(run) = self.runs.get_mut(&id) else {
            return;
        };
        let each = run.each;
        let reason = run.reason;
        let Some(cur) = run.cur.as_mut() else {
            return;
        };
        if each > 0 && remaining(each, cur.started, now) <= MIN_ROUND_MS {
            // TOO LITTLE LEFT to start a pass that would be killed mid-part.
            self.end_vault(id, Pass::Busy, out);
            self.advance(id, out);
            return;
        }
        cur.stage = Stage::Draining;
        cur.rounds = 1;
        let request = conditions.request(remaining(each, cur.started, now), reason);
        self.busy.insert(vault.to_owned());
        out.push(Action::Drain {
            vault: vault.to_owned(),
            request,
        });
    }

    fn queue_handoff(&mut self, vault: String) {
        let active = matches!(
            &self.handoff,
            Some(Handoff::Reconciling(v) | Handoff::Counting(v) | Handoff::Fetching(v)) if *v == vault
        );
        if !active && !self.handoff_queue.contains(&vault) {
            self.handoff_queue.push_back(vault);
        }
    }

    /// One vault's hand-off at a time: the OS's count of unfinished tasks is not
    /// attributed to a vault, so two flows at once would race it.
    fn pump_handoff(&mut self, out: &mut Vec<Action>) {
        if self.handoff.is_some() {
            return;
        }
        let Some(vault) = self.handoff_queue.pop_front() else {
            return;
        };
        self.handoff = Some(Handoff::Reconciling(vault.clone()));
        out.push(Action::Reconcile { vault });
    }
}

/// What is left of a vault's share of the budget; `0` is "no deadline".
fn remaining(each: u64, started: u64, now: u64) -> u64 {
    if each == 0 {
        return 0;
    }
    // NEVER 0: that would read as "no deadline" to the core.
    each.saturating_sub(now.saturating_sub(started)).max(1)
}
