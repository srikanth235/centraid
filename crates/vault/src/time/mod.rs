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
//! | [`rrule`] | ONE parser for every day-or-coarser RFC 5545 rule, three call shapes, a refused-never-dropped remainder, and the ONE member-facing summariser |
//! | `period` | the days an RFC 5545 rule selects in one period of its frequency: the `BYxxx` expand and limit, `BYSETPOS`, weeks under `WKST` (crate-private; the expander calls it) |
//! | [`repeat`] | [`RepeatSpec`], the repeat editor's view of a rule, to and from RRULE text |
//! | [`recurrence`] | the expander, the exception matcher, the next occurrence and the missed-period collapse |
//! | [`occurrence`] | `original_start_local` — the ONE place the stored spelling appears (#996 R21, drift ONT-25) |
//! | [`temporal`] | which of the four readings a temporal column is holding (#996 R21, drift ONT-31) |
//!
//! ## The three sentences of the DST policy
//!
//! Every reader of civil time — the task lifecycle's rollover here, Agenda's
//! expansion and its local days (`crates/apps/agenda`) — goes through them:
//!
//! 1. A **nonexistent** wall time is SKIPPED — it exists at no instant, so
//!    nothing can deliver it, and `COUNT` does not count it. (RFC 5545 section
//!    3.3.5 would read it after the gap, 02:30 as 03:30; a series skips it
//!    instead. `civil::parse_civil_ms`, which reads ONE typed time, takes the
//!    RFC's reading because a single time has to land somewhere.)
//! 2. An **overlapping** wall time occurs ONCE, at the EARLIER instant.
//! 3. A per-instance exception keys off the **unmodified original**
//!    occurrence, even when an override moves what the member sees.
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
    DayRule, Freq, ParsedRrule, Refusal, Until, assert_supported, canonicalize, describe, inspect,
    normalize,
};
pub use temporal::{Kind as TemporalKind, classify as classify_temporal};
pub use zone::{FireZone, WallClock, WallTime, ZoneUnset, sunday_zero};
