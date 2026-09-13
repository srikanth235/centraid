//! # Agenda — four queries, seven actions, and the one recurrence engine
//!
//! 7,818 lines of v0 TypeScript, 4 queries, 7 actions, **13 scopes — the
//! smallest scope set of any app** (#1020, wave 4 census §A6). Its doctrine,
//! from the manifest's own description (`manifest.json`, copied verbatim from
//! v0's `app.json`):
//!
//! - **A REPEATING EVENT IS ONE ROW AND MANY OCCURRENCES.** `upcoming`
//!   materialises a series into one row per occurrence inside the visible
//!   range, each carrying the SERIES' real `event_id` — so reschedule, cancel,
//!   RSVP and attach all still target the series — plus an `instance_key` for
//!   list render.
//! - **THE OCCURRENCE'S IDENTITY IS ITS WALL CLOCK** (#996 R21, drift ONT-25).
//!   `instance_key` and `original_start_local` are the series-local wall clock,
//!   never the resolved instant, and the spelling appears once, in
//!   [`centraid_vault::time::occurrence`].
//! - **THE RECURRENCE SUBSET IS REFUSED, NEVER DROPPED.** A rule outside
//!   `FREQ ∈ DAILY|WEEKLY|MONTHLY|YEARLY` with `INTERVAL/COUNT/UNTIL/BYDAY`
//!   expands to nothing, and the anchor stays visible rather than the event
//!   vanishing from the agenda ([`expansion`], D-1020-S1).
//! - **CIVIL TIME IS THE VAULT'S, NEVER THE HOST'S.** A gateway on a VPS runs
//!   UTC; a series expands in its own `start_tz`, resolved through the one
//!   [`centraid_vault::time::zone::FireZone`] cron already used.
//! - **TWO WINDOWS, ONE RANGE.** Events are fetched from BEFORE `from` so
//!   multi-day spans arrive, and the filter re-applies the true lower bound;
//!   recurring anchors live in the past and are fetched separately
//!   ([`queries::load_upcoming`], D-1020-S4).
//! - **NO DATA OF ITS OWN** — revoke the grant and the app goes dark.
//!
//! ## What this crate is allowed to contain, and what stops the rest
//!
//! | Not allowed | What stops it |
//! |---|---|
//! | SQL, in any form | `cargo xtask rules`' `sql-confinement` scans this crate; a statement here is a [`centraid_apps_kit::PageQuery`] — a projection, a `from`, a predicate and an order, as data |
//! | A second recurrence engine | there is no expander here: [`expansion`] calls [`centraid_vault::time::recurrence`], which is the one v0 has and the one `crates/automations` shares a DST policy with |
//! | A write from a query | [`queries`] holds statements and a [`centraid_apps_kit::PageDoor`], whose one method reads |
//! | An invocation with no `invoke_key` | the field is required on [`commands::Invocation`] (D-1020-D3-5) |
//! | A denial turned into an error | [`Denial`] is a value every query answers beside its payload |
//! | A raw RRULE shown to a member | `recurrence_summary` is [`centraid_vault::time::rrule::describe`]'s sentence, resolved here; a second summariser is the defect that function exists to prevent (#834) |

pub mod commands;
pub mod expansion;
pub mod manifest;
pub mod queries;

pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use expansion::{
    DEFAULT_EXPAND_MS, MAX_TOTAL_INSTANCES, SPAN_BUFFER_MS, expand_recurring_events,
};
pub use manifest::{APP_ID, manifest};
pub use queries::{
    DayContextData, EVENT_WINDOW_CAP, MAX_RANGE_DAYS, PARTY_CAP, PartiesData, RECURRING_ANCHOR_CAP,
    SHELF_CAP, SearchData, TAG_CAP, TASK_CAP, UpcomingData, load_day_context, load_parties,
    load_search, load_upcoming,
};

/// A CONSENT DENIAL, as the payload carries it.
///
/// Every v0 Agenda query wraps its body and answers `{…empty, vaultDenied:
/// {code, message}}` rather than throwing (`queries/upcoming.ts:620`-`:628`,
/// and the same in all four). `revoked_at` comes from the HOST, because a
/// revoked app cannot read the consent tables to date its own revocation
/// (`packages/server/src/engine/handlers/vault-bridge.ts:29`-`:36`) — so it is
/// an `Option` this crate never fills in.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Denial {
    pub code: Option<String>,
    pub message: Option<String>,
    pub revoked_at: Option<String>,
}

/// THE THREE STATES OF A READ, once, for every surface in this app.
///
/// `Option<T>` collapses two of the three (census §A seam 5): "not asked yet"
/// and "asked and refused" both become `None`, and the failure mode is an
/// empty list where the honest answer is *unknown*. On Agenda that failure has
/// a name: **a day with no birthday and a day whose party plane was refused
/// look identical** on a calendar grid, and only one of them is worth asking
/// the owner about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading<T> {
    /// The read has not happened yet. A surface renders a skeleton.
    Loading,
    /// The vault refused, or the door was not there. A surface renders the ask.
    Denied(Denial),
    /// The answer.
    Data(T),
}

impl<T> Reading<T> {
    /// The data, when there is data. **Not** a default.
    pub const fn data(&self) -> Option<&T> {
        match self {
            Self::Data(value) => Some(value),
            Self::Loading | Self::Denied(_) => None,
        }
    }

    /// Whether this reading is a refusal a surface should offer to fix.
    pub const fn denied(&self) -> bool {
        matches!(self, Self::Denied(_))
    }

    /// `true` where the fact is KNOWN, whatever it turned out to be.
    pub const fn known(&self) -> bool {
        matches!(self, Self::Data(_))
    }
}

/// A door error, as the payload's denial.
#[must_use]
pub fn denial_of(message: String) -> Denial {
    Denial {
        code: None,
        message: Some(message),
        revoked_at: None,
    }
}
