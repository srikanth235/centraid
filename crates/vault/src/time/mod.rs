//! CIVIL TIME AND RECURRENCE — one engine, in the vault (#1020, lane Schedule).
//!
//! It lives in `crates/vault` for one reason: **the task lifecycle is a vault
//! operation** ([`crate::operations::task_lifecycle`]) and the recurrence
//! rollover is part of it, so the engine sits beside the operations that call
//! it rather than a crate away. It holds NO SQL — the module is pure — and
//! the stored spellings it does know are named once, in [`occurrence`].
//!
//! ## The modules, and the seam each one owns
//!
//! | Module | The seam |
//! |---|---|
//! | [`zone`] | THE vault's zone, resolved in two tiers with v0's host-local third DELETED; the DST policy; all civil arithmetic |
//! | [`rrule`] | ONE parser for every day-or-coarser RFC 5545 rule, three call shapes, a refused-never-dropped remainder, and the rule's structural [`shape`](rrule::shape) (its words are the core strings') |
//! | `period` | the days an RFC 5545 rule selects in one period of its frequency: the `BYxxx` expand and limit, `BYSETPOS`, weeks under `WKST` (crate-private; the expander calls it) |
//! | [`repeat`] | [`RepeatSpec`], the repeat editor's view of a rule, to and from RRULE text |
//! | [`recurrence`] | the expander, the exception matcher, the next occurrence and the missed-period collapse |
//! | [`occurrence`] | `original_start_local` — the ONE place the stored spelling appears (#996 R21, drift ONT-25) |
//! | [`temporal`] | which of the four readings a temporal column is holding (#996 R21, drift ONT-31) |
//!
//! ## The three sentences of the DST policy
//!
//! Every reader of civil time — the task lifecycle's rollover here, Agenda's
//! expansion and its local days (`crates/apps/calendar`, `crates/apps/reminders`) — goes through them:
//!
//! 1. A **nonexistent** wall time moves FORWARD by the gap, as RFC 5545 section
//!    3.3.5 reads it (02:30 New York on the spring-forward day is 03:30 EDT),
//!    and it COUNTS toward `COUNT` (owner decision on #1173: a two-way sync
//!    with EventKit and CalendarContract has to expand exactly the phone's
//!    occurrences, and both do this). One reading everywhere:
//!    [`zone::FireZone::resolve_wall_time_forward`], which
//!    `civil::parse_civil_ms` shares. Its exception key stays the series' own
//!    wall clock (02:30).
//! 2. An **overlapping** wall time occurs ONCE, at the EARLIER instant.
//! 3. A per-instance exception keys off the **unmodified original**
//!    occurrence, even when an override moves what the member sees.
//!
//! The two departures from RFC 5545 that this engine used to keep, skipping a
//! gap and clamping an implied 31st, are gone: see [`rrule`]'s subset section
//! and `contracts/time/README.md`.
//!
//! ## One zone source
//!
//! [`zone::FireZone`] and [`zone::ZoneUnset`] are the one resolution of a
//! zone name, and every crate above the vault that needs civil time reads it
//! from here. A second reader would be the drift this module exists to
//! prevent.

pub mod civil;
pub mod occurrence;
pub(crate) mod period;
pub mod recurrence;
pub mod repeat;
pub mod rrule;
pub mod temporal;
pub mod zone;

pub use civil::{has_zone_designator, parse_civil_ms};
pub use occurrence::{
    OCCURRENCE_LOCAL_START_COLUMN, OCCURRENCE_LOCAL_START_KEY, OccurrenceException, OccurrenceKey,
    SeriesType, StoredExceptionRow, exceptions_of, override_at, read_exception,
    recurrence_exceptions_of, search_window,
};
pub use recurrence::{
    Collapsed, ExceptionAction, ExceptionScope, ExpandInput, NextOccurrenceInput, Occurrence,
    RecurrenceAnchor, RecurrenceException, Semantics, apply_exceptions, collapse_missed, expand,
    next_occurrence, parse_instant_ms, shift_temporal,
};
pub use repeat::{MonthlyBasis, RepeatEnd, RepeatSpec, Weekday};
pub use rrule::{
    DayRule, Freq, ParsedRrule, Refusal, RuleShape, ShapeEnd, Until, assert_supported,
    canonicalize, inspect, normalize, shape,
};
pub use temporal::{Kind as TemporalKind, classify as classify_temporal};
pub use zone::{FireZone, WallClock, WallTime, ZoneUnset, sunday_zero};
