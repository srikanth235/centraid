//! # Calendar — events, invites and the one recurrence engine
//!
//! Agenda became two apps (#1173, round 10): Calendar owns events and invites, and
//! `centraid-apps-reminders` owns tasks and lists. Calendar reads a task's title, due and state only
//! ([`dated`]) and never writes one. The event half (#1020, wave 4 census §A6) has this doctrine,
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
//!   multi-day spans arrive, and the filter re-applies the true lower bound to
//!   every row, an expanded occurrence included; recurring anchors live in the
//!   past and are fetched separately ([`queries::load_upcoming`], D-1020-S4).
//! - **A SCREEN'S CIVIL TIME IS THE DEVICE'S ZONE, AND THE CORE COMPUTES IT.**
//!   Which local days an occurrence occupies, its wall clock, today and now
//!   are answered in the zone the request states ([`local`], #1046), because a
//!   shell's shared layer has no calendar to compute them with.
//! - **NO DATA OF ITS OWN** — the app reads and writes the personal vault.
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
//! | A raw RRULE shown to a member | a row carries the stored rule for the editor and never a sentence: the one sentence is built in the core strings from [`centraid_vault::time::rrule::shape`] (`crates/screens`, `agenda::rule_words`); a second summariser is the defect that seam exists to prevent (#834) |

pub mod attachments;
pub mod commands;
pub mod dated;
pub mod detail;
pub mod expansion;
pub mod local;
pub mod manifest;
pub mod queries;
pub mod trash;
pub mod window;

pub use attachments::{ATTACHMENTS_PAGE_MAX, AttachmentRow, AttachmentsData, load_attachments};
pub use commands::{ACTIONS, Commands, Invocation, Outcome};
pub use dated::{DatedReminder, load_dated_reminders};
pub use detail::{
    EventDetailData, FollowedGuest, NEXT_OCCURRENCE_REACH_DAYS, load_event, next_occurrence,
};
pub use expansion::{
    DEFAULT_EXPAND_MS, MAX_TOTAL_INSTANCES, SPAN_BUFFER_MS, expand_recurring_events,
};
pub use local::{Placement, place};
pub use manifest::{APP_ID, manifest};
pub use queries::{
    DayContextData, EVENT_WINDOW_CAP, MAX_RANGE_DAYS, PARTY_CAP, PartiesData, RECURRING_ANCHOR_CAP,
    SEARCH_LIMIT, SearchData, UpcomingData, load_day_context, load_parties, load_search,
    load_search_term, load_upcoming, load_upcoming_among,
};
pub use trash::{TRASH_ROWS, TrashData, TrashRow, load_trash};
pub use window::{Occurrence, occurrences};

/// A read refusal, as the payload carries it: the kit's one type, shared by
/// every app so the core settles all of them through one door.
pub use centraid_apps_kit::{Denial, Reading, denial_of};
