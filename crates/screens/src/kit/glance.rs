//! THE GLANCE LEDGER (#1185): what every app's widget service shares, so a second app's snapshot
//! behaves exactly as Agenda's does.
//!
//! A glance service is a view-less screen (`Runtime::with_services`) that keeps one JSON document
//! current for the platform's widgets, which never open the vault. What differs per app is the
//! document and what a tap opens; what is the same is here:
//!
//! - **When to read**: on start, on every commit (the backup ledger's own pseudo-table aside), when
//!   the locale or zone changes, on a lifecycle change, when the roster of held vaults moves, when
//!   a tab's root opens again with another vault in front, and when the rollover timer fires
//!   ([`Ledger::wants_read`]).
//! - **When to emit**: only when the bytes differ from the last emitted, and at most once per read
//!   ([`Ledger::changed`]). A refused write forgets those bytes, so the next change tries again
//!   ([`Ledger::answered`]).
//! - **The rollover** is the runtime's timer, set from the core's own span between the document's
//!   `now_local` and `refresh_after`, never a device clock ([`arm`]).
//! - **The file** (a second app's) is named by Rust and travels in the effect, so a shell holds no
//!   constant for it.

use std::collections::VecDeque;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use wire::screen_event::Kind as E;

use crate::screen::Ctx;

/// The timer that rebuilds the document when it goes stale.
pub const ROLLOVER: &str = "glance.rollover";
/// The rollover's floor and ceiling.
const MIN_ROLLOVER: Duration = Duration::from_secs(60);
const MAX_ROLLOVER: Duration = Duration::from_secs(24 * 60 * 60);

/// The pseudo-table the core announces when the backup ledger moved: it holds nothing a widget
/// draws.
const LEDGER_TABLE: &str = "backup";

/// What an outstanding effect will be answered as; a shell answers in order.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Asked {
    /// A snapshot write.
    Glance,
    /// A route the service opened.
    Route,
}

/// The bookkeeping every glance service keeps.
#[derive(Default)]
pub struct Ledger {
    /// The bytes last emitted and not refused.
    last: Option<Vec<u8>>,
    outstanding: VecDeque<Asked>,
    /// The vault in front when the document was last built.
    front: Option<String>,
}

fn front_of(ctx: &Ctx) -> Option<String> {
    ctx.vaults().and_then(|vaults| vaults.foreground_id())
}

impl Ledger {
    /// Does this event call for a fresh read of the vault in front?
    #[must_use]
    pub fn wants_read(&self, event: &wire::ScreenEvent, ctx: &Ctx) -> bool {
        match event.kind.as_ref() {
            Some(
                E::Appeared(_) | E::EnvironmentChanged(_) | E::Lifecycle(_) | E::TimerFired(_),
            ) => true,
            Some(E::DataChanged(changed)) => {
                !changed.tables.iter().all(|table| table == LEDGER_TABLE)
            }
            // A VAULT SWITCH reopens every tab's root, and the services are told of each opening:
            // the front vault is the thing to look at.
            Some(E::ScreenOpened(_)) => self.front != front_of(ctx),
            Some(E::ShellFact(fact)) => matches!(fact.fact, Some(wire::shell_fact::Fact::Held(_))),
            _ => false,
        }
    }

    /// A read is starting: remember the vault in front.
    pub fn reading(&mut self, ctx: &Ctx) {
        self.front = front_of(ctx);
    }

    /// Is `document` new? When it is, it is remembered and a write is counted as outstanding, so
    /// the caller must emit it.
    pub fn changed(&mut self, document: &[u8]) -> bool {
        if self.last.as_deref() == Some(document) {
            return false;
        }
        self.last = Some(document.to_vec());
        self.outstanding.push_back(Asked::Glance);
        true
    }

    /// A route effect was emitted.
    pub fn asked_route(&mut self) {
        self.outstanding.push_back(Asked::Route);
    }

    /// The shell answered the oldest outstanding effect.
    pub fn answered(&mut self, result: &wire::EffectResult) {
        if self.outstanding.pop_front() == Some(Asked::Glance)
            && matches!(
                result.outcome,
                Some(wire::effect_result::Outcome::Failed(_))
            )
        {
            // A REFUSED WRITE IS NOT THE LAST DOCUMENT: the next change sends it again.
            self.last = None;
        }
    }
}

/// Set the rollover for `seconds` (the span the core's clock puts before the document goes
/// stale), clamped; no span (the unavailable document) cancels it.
pub fn arm(ctx: &Ctx, seconds: Option<u64>) {
    match seconds {
        Some(seconds) => {
            ctx.start_timer(
                ROLLOVER,
                Duration::from_secs(seconds).clamp(MIN_ROLLOVER, MAX_ROLLOVER),
            );
        }
        None => ctx.cancel_timer(ROLLOVER),
    }
}
