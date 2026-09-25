//! THE OCCURRENCE KEY, ONCE (#996 R21, drift ONT-25; #1020 D-1020-S3).
//!
//! A recurrence exception is stored keyed on `original_start_local` — the
//! series-local wall clock of the occurrence it excepts — with
//! `recurrence_semantics` recording which reading that wall clock is under.
//! **Three readers spelled the column `original_start` and one spelled the
//! zone `time_zone`**, so every one of them read `undefined`: a skipped
//! occurrence came back on the phone, on the web agenda and on Tally's
//! template dashboard, silently, because a missing key matches nothing.
//!
//! This module is the ONE place the stored spelling appears
//! ([`OCCURRENCE_LOCAL_START_COLUMN`]). Readers take an [`OccurrenceKey`];
//! writers hand one over; the matcher in [`super::recurrence`] is fed from
//! [`exceptions_of`]. Nothing downstream names a column, so the two spellings
//! cannot drift apart again — and a rename here is a type error at every call
//! site rather than an empty agenda.

use serde_json::Value;

use super::recurrence::{ExceptionAction, ExceptionScope, RecurrenceException, Semantics};
use super::zone::{parse_wall_iso, wall_epoch};

/// **The column an occurrence key is stored under.** Exported so no other
/// module spells it — the one place, by construction (D-1020-S3).
pub const OCCURRENCE_LOCAL_START_COLUMN: &str = "original_start_local";

/// The command-input and query-output property carrying an occurrence key.
/// The same word as the column on purpose: one spelling, end to end.
pub const OCCURRENCE_LOCAL_START_KEY: &str = "original_start_local";

/// The two series kinds `schedule_recurrence_exception.target_type` allows.
/// A CLOSED set, and the schema's own CHECK.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SeriesType {
    /// An `core_event` row — Agenda's.
    Event,
    /// A `tally_recurring_expense` row — Tally's template dashboard.
    RecurringExpense,
}

impl SeriesType {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Event => "core.event",
            Self::RecurringExpense => "tally.recurring_expense",
        }
    }

    #[must_use]
    pub fn from_stored(value: &str) -> Option<Self> {
        match value {
            "core.event" => Some(Self::Event),
            "tally.recurring_expense" => Some(Self::RecurringExpense),
            _ => None,
        }
    }
}

/// Series identity plus recurrence-local identity plus semantics — the whole
/// key, as one value.
///
/// `local_start` is the series' own wall clock, **never a resolved UTC
/// instant**: a rule expands in wall clock, so that is what identifies the
/// occurrence, and re-anchoring the series must not orphan its exceptions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OccurrenceKey {
    pub series_type: SeriesType,
    pub series_id: String,
    pub local_start: String,
    pub semantics: Semantics,
}

impl OccurrenceKey {
    #[must_use]
    pub fn new(
        series_type: SeriesType,
        series_id: &str,
        local_start: &str,
        semantics: Semantics,
    ) -> Self {
        Self {
            series_type,
            series_id: series_id.to_owned(),
            local_start: local_start.to_owned(),
            semantics,
        }
    }

    /// A stable string for map keys and instance ids. **Semantics is part of
    /// it**: the same wall clock under two readings is two occurrences.
    #[must_use]
    pub fn token(&self) -> String {
        format!(
            "{}:{}:{}:{}",
            self.series_type.as_str(),
            self.series_id,
            self.semantics.as_str(),
            self.local_start
        )
    }
}

/// An exception as the readers want it: a key, what it does, and how far.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OccurrenceException {
    pub key: OccurrenceKey,
    pub action: ExceptionAction,
    pub scope: ExceptionScope,
    /// The override payload, parsed. `None` for a skip, and `None` for an
    /// override whose JSON does not read — an unreadable override is not an
    /// invented one.
    pub override_value: Option<Value>,
}

impl OccurrenceException {
    /// A field of the override payload, when there is one.
    #[must_use]
    pub fn override_field(&self, name: &str) -> Option<&Value> {
        self.override_value.as_ref()?.get(name)
    }

    /// A string field of the override payload.
    #[must_use]
    pub fn override_str(&self, name: &str) -> Option<&str> {
        self.override_field(name)?.as_str()
    }
}

/// The stored row, in the ONE place these column names are written.
///
/// A reader that wants an occurrence takes [`OccurrenceException`], not this.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredExceptionRow {
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub original_start_local: Option<String>,
    pub recurrence_semantics: Option<String>,
    pub scope: Option<String>,
    pub action: Option<String>,
    pub override_json: Option<String>,
}

/// Read one stored row.
///
/// Returns `None` for a row missing the key — a row the old readers silently
/// treated as an exception at `undefined`, matching every occurrence or none
/// depending on which side of the comparison it landed.
#[must_use]
pub fn read_exception(row: &StoredExceptionRow) -> Option<OccurrenceException> {
    let local_start = row
        .original_start_local
        .as_deref()
        .filter(|value| !value.is_empty())?;
    let series_id = row.target_id.as_deref()?;
    let series_type = SeriesType::from_stored(row.target_type.as_deref()?)?;
    let override_value = row
        .override_json
        .as_deref()
        .filter(|text| !text.is_empty())
        .and_then(|text| serde_json::from_str::<Value>(text).ok());
    Some(OccurrenceException {
        key: OccurrenceKey::new(
            series_type,
            series_id,
            local_start,
            Semantics::from_stored(row.recurrence_semantics.as_deref()),
        ),
        // The schema's CHECK allows only `skip` and `override`; anything else
        // reads as a skip, which removes rather than invents.
        action: if row.action.as_deref() == Some("override") {
            ExceptionAction::Override
        } else {
            ExceptionAction::Skip
        },
        scope: if row.scope.as_deref() == Some("future") {
            ExceptionScope::Future
        } else {
            ExceptionScope::Occurrence
        },
        override_value,
    })
}

/// Every readable exception for one series, **oldest occurrence first**.
#[must_use]
pub fn exceptions_of(
    rows: &[StoredExceptionRow],
    series_type: SeriesType,
    series_id: &str,
) -> Vec<OccurrenceException> {
    let mut out: Vec<OccurrenceException> = rows
        .iter()
        .filter_map(read_exception)
        .filter(|exception| {
            exception.key.series_type == series_type && exception.key.series_id == series_id
        })
        .collect();
    out.sort_by(|left, right| left.key.local_start.cmp(&right.key.local_start));
    out
}

/// The shape [`super::recurrence::apply_exceptions`] takes.
///
/// The `start` of an override is read from the override payload, which is
/// where the shadow occurrence's own values live.
#[must_use]
pub fn recurrence_exceptions_of(exceptions: &[OccurrenceException]) -> Vec<RecurrenceException> {
    exceptions
        .iter()
        .map(|exception| RecurrenceException {
            original_start: exception.key.local_start.clone(),
            action: exception.action,
            scope: exception.scope,
            start: exception.override_str("start").map(str::to_owned),
        })
        .collect()
}

/// The override in force at `local_start`: the occurrence-scoped one if there
/// is one, else the most recent `future`-scoped one at or before it.
///
/// Inlined in three readers before this, each with its own comparison and its
/// own bug.
#[must_use]
pub fn override_at<'a>(
    exceptions: &'a [OccurrenceException],
    local_start: &str,
) -> Option<&'a Value> {
    let mut future: Option<&'a Value> = None;
    for exception in exceptions {
        if exception.scope == ExceptionScope::Occurrence && exception.key.local_start == local_start
        {
            return exception.override_value.as_ref();
        }
        if exception.scope == ExceptionScope::Future
            && exception.key.local_start.as_str() <= local_start
        {
            future = exception.override_value.as_ref();
        }
    }
    future
}

/// A window wide enough to contain the occurrence a series-local wall clock
/// names, whatever zone the series is read in.
///
/// **A wall clock is NOT an instant**: reading `2026-03-29T09:00:00` as one
/// resolves it in somebody's zone, which is how a writer that took the key for
/// a timestamp turned "skip the 29th" into "skip nothing" on every machine
/// outside UTC. The window is deliberately a bound and not a conversion — two
/// days each way covers every offset on earth plus a DST step — and the caller
/// then matches on `wall_start`, which is the key.
#[must_use]
pub fn search_window(local_start: &str, days: i64) -> Option<(String, String)> {
    let at = parse_wall_iso(local_start)
        .map(wall_epoch)
        .or_else(|| super::recurrence::parse_instant_ms(local_start))?;
    let span = days * 86_400_000;
    Some((
        crate::clock::format_iso_ms(at - span),
        crate::clock::format_iso_ms(at + span),
    ))
}

/// The default width of [`search_window`]: two days each way.
pub const SEARCH_WINDOW_DAYS: i64 = 2;

#[cfg(test)]
mod tests {
    use super::*;

    fn row(
        local_start: &str,
        action: &str,
        scope: &str,
        override_json: Option<&str>,
    ) -> StoredExceptionRow {
        StoredExceptionRow {
            target_type: Some("core.event".to_owned()),
            target_id: Some("event-1".to_owned()),
            original_start_local: Some(local_start.to_owned()),
            recurrence_semantics: Some("zoned".to_owned()),
            scope: Some(scope.to_owned()),
            action: Some(action.to_owned()),
            override_json: override_json.map(str::to_owned),
        }
    }

    #[test]
    fn the_column_is_named_exactly_once() {
        assert_eq!(OCCURRENCE_LOCAL_START_COLUMN, "original_start_local");
        assert_eq!(OCCURRENCE_LOCAL_START_KEY, OCCURRENCE_LOCAL_START_COLUMN);
    }

    #[test]
    fn a_row_with_no_key_is_not_an_exception_at_undefined() {
        let mut missing = row("2026-03-03T09:00:00", "skip", "occurrence", None);
        missing.original_start_local = None;
        assert_eq!(read_exception(&missing), None);
        missing.original_start_local = Some(String::new());
        assert_eq!(read_exception(&missing), None);
    }

    #[test]
    fn a_row_of_another_series_kind_is_refused() {
        let mut alien = row("2026-03-03T09:00:00", "skip", "occurrence", None);
        alien.target_type = Some("knowledge.note".to_owned());
        assert_eq!(read_exception(&alien), None);
    }

    #[test]
    fn exceptions_arrive_oldest_first_and_only_for_their_series() {
        let mut other = row("2026-03-01T09:00:00", "skip", "occurrence", None);
        other.target_id = Some("event-2".to_owned());
        let rows = [
            row("2026-03-05T09:00:00", "skip", "occurrence", None),
            other,
            row("2026-03-03T09:00:00", "skip", "occurrence", None),
        ];
        let found = exceptions_of(&rows, SeriesType::Event, "event-1");
        let keys: Vec<&str> = found
            .iter()
            .map(|exception| exception.key.local_start.as_str())
            .collect();
        assert_eq!(keys, ["2026-03-03T09:00:00", "2026-03-05T09:00:00"]);
    }

    #[test]
    fn the_semantics_is_part_of_the_token() {
        let zoned = OccurrenceKey::new(
            SeriesType::Event,
            "e1",
            "2026-03-03T09:00:00",
            Semantics::Zoned,
        );
        let floating = OccurrenceKey::new(
            SeriesType::Event,
            "e1",
            "2026-03-03T09:00:00",
            Semantics::Floating,
        );
        assert_ne!(zoned.token(), floating.token());
        assert_eq!(zoned.token(), "core.event:e1:zoned:2026-03-03T09:00:00");
    }

    #[test]
    fn a_future_override_applies_from_its_own_key_forward() {
        let rows = [row(
            "2026-03-03T09:00:00",
            "override",
            "future",
            Some(r#"{"summary":"Moved"}"#),
        )];
        let found = exceptions_of(&rows, SeriesType::Event, "event-1");
        assert_eq!(override_at(&found, "2026-03-02T09:00:00"), None);
        assert_eq!(
            override_at(&found, "2026-03-09T09:00:00")
                .and_then(|value| value.get("summary"))
                .and_then(Value::as_str),
            Some("Moved")
        );
    }

    #[test]
    fn an_unreadable_override_is_not_an_invented_one() {
        let rows = [row(
            "2026-03-03T09:00:00",
            "override",
            "occurrence",
            Some("{"),
        )];
        let found = exceptions_of(&rows, SeriesType::Event, "event-1");
        assert_eq!(found[0].override_value, None);
    }

    #[test]
    fn the_search_window_is_a_bound_not_a_conversion() {
        let (from, to) =
            search_window("2026-03-29T09:00:00", SEARCH_WINDOW_DAYS).expect("a window");
        assert_eq!(from, "2026-03-27T09:00:00.000Z");
        assert_eq!(to, "2026-03-31T09:00:00.000Z");
        assert_eq!(search_window("banana", SEARCH_WINDOW_DAYS), None);
    }
}
