//! CIVIL TIME AND RECURRENCE — one engine, in the vault (#1020, lane Schedule).
//!
//! v0 keeps this in `packages/core/src/time/` (1,400 lines plus a zone
//! database). It lives in `crates/vault` here for one reason: **the task
//! lifecycle is a vault operation** ([`crate::operations::task_lifecycle`]) and
//! the recurrence rollover is part of it, so the engine sits beside the
//! operations that call it rather than a crate away. It holds NO SQL — the
//! module is pure — and the stored spellings it does know are named once, in
//! [`occurrence`].
//!
//! ## The five modules, and the seam each one owns
//!
//! | Module | The seam |
//! |---|---|
//! | [`zone`] | THE vault's zone, resolved in two tiers with v0's host-local third DELETED; the DST policy shared with cron; all civil arithmetic |
//! | [`rrule`] | ONE parser, three call shapes, a refused-never-dropped subset, and the ONE member-facing summariser |
//! | [`recurrence`] | the expander, the exception matcher, the next occurrence and the missed-period collapse |
//! | [`occurrence`] | `original_start_local` — the ONE place the stored spelling appears (#996 R21, drift ONT-25) |
//! | [`temporal`] | which of the four readings a temporal column is holding (#996 R21, drift ONT-31) |
//!
//! ## The three sentences of the DST policy
//!
//! Shared with `crates/automations::cron`, which is the other half of the same
//! contract (`docs/cron-timezone.md`):
//!
//! 1. A **nonexistent** wall time is SKIPPED — it exists at no instant, so
//!    nothing can deliver it.
//! 2. An **overlapping** wall time occurs ONCE, at the EARLIER instant.
//! 3. A per-instance exception keys off the **unmodified original**
//!    occurrence, even when an override moves what the member sees.
//!
//! ## One zone source
//!
//! [`zone::FireZone`] and [`zone::ZoneUnset`] were `crates/automations::cron`'s
//! and are re-exported from there unchanged. A second reader would be the
//! drift this module exists to prevent, and the crate graph
//! (`automations → assist → vault`) means the shared type can only live here.

pub mod occurrence;
pub mod recurrence;
pub mod rrule;
pub mod temporal;
pub mod zone;

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
pub use rrule::{Freq, ParsedRrule, Refusal, assert_supported, canonicalize, describe, inspect};
pub use temporal::{Kind as TemporalKind, classify as classify_temporal};
pub use zone::{FireZone, WallClock, WallTime, ZoneUnset, sunday_zero};
