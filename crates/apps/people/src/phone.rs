//! THE PHONE'S READINGS OF THE FOLDS (#1046) — the chips, the sort, and every
//! civil-date and cadence fact a shell would otherwise compute itself.
//!
//! `people.proto` is the wire shape; `crates/core`'s `app_query` converts. What
//! lives here is what a screen draws that the v0 folds left to the client
//! (`people-model.ts`'s `applyRosterFilter`, `isOverdue`, `daysUntil`): the
//! shell's shared layer has no calendar, so a birthday's distance and a
//! person's "due" are answered here, against `today` in the device's zone and
//! the vault clock's instant — never the host's.

use crate::dates::{CivilDate, DAYS_UNSET, days_since_contact, days_until_month_day, is_overdue};
use crate::roster::RosterRow;

/// The roster's chips. No sharing chips: v1 has no sharing (#1029).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RosterFilter {
    #[default]
    All,
    Starred,
    Due,
}

/// The roster's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RosterSort {
    /// Newest-added first — the window's own order.
    #[default]
    Recent,
    /// By name, case-insensitively, ties by party id.
    Name,
}

/// The cadence facts of one person, at `now_ms`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cadence {
    /// Last contact — or added, when never — strictly more than the cadence
    /// ago; a cadence of 0 is never due.
    pub due: bool,
    pub days_since_contact: i64,
}

/// [`Cadence`] of one person.
#[must_use]
pub fn cadence(
    cadence_days: i64,
    last_contacted_at: Option<&str>,
    created_at: &str,
    now_ms: i64,
) -> Cadence {
    let created = (!created_at.is_empty()).then_some(created_at);
    Cadence {
        due: is_overdue(cadence_days, last_contacted_at, created, now_ms),
        days_since_contact: days_since_contact(last_contacted_at, created, now_ms),
    }
}

/// Days from `today` to an annual `MM-DD`, across the year boundary; `None`
/// where the date does not parse.
#[must_use]
pub fn in_days(today: CivilDate, month_day: &str) -> Option<i64> {
    let days = days_until_month_day(today, month_day);
    (days != DAYS_UNSET).then_some(days)
}

/// The chips' counts, over the whole window before the filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RosterCounts {
    pub all: usize,
    pub starred: usize,
    pub due: usize,
}

/// Filter and order a roster window, and count its chips.
#[must_use]
pub fn arrange(
    people: Vec<RosterRow>,
    filter: RosterFilter,
    sort: RosterSort,
    now_ms: i64,
) -> (Vec<RosterRow>, RosterCounts) {
    let is_due = |row: &RosterRow| {
        cadence(
            row.cadence_days,
            row.last_contacted_at.as_deref(),
            &row.created_at,
            now_ms,
        )
        .due
    };
    let counts = RosterCounts {
        all: people.len(),
        starred: people.iter().filter(|row| row.starred).count(),
        due: people.iter().filter(|row| is_due(row)).count(),
    };
    let mut kept: Vec<RosterRow> = people
        .into_iter()
        .filter(|row| match filter {
            RosterFilter::All => true,
            RosterFilter::Starred => row.starred,
            RosterFilter::Due => is_due(row),
        })
        .collect();
    if sort == RosterSort::Name {
        kept.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then_with(|| left.party_id.cmp(&right.party_id))
        });
    }
    (kept, counts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dates::parse_instant;

    fn row(party_id: &str, name: &str, starred: bool, cadence_days: i64) -> RosterRow {
        RosterRow {
            party_id: party_id.to_owned(),
            name: name.to_owned(),
            role: String::new(),
            avatar_color: None,
            cadence_days,
            last_contacted_at: None,
            created_at: "2099-01-01T00:00:00.000Z".to_owned(),
            list_id: None,
            starred,
            reminders: Vec::new(),
            snippet: None,
        }
    }

    #[test]
    fn the_chips_filter_and_count_over_the_whole_window() {
        let now = parse_instant("2099-03-01T00:00:00.000Z").expect("an instant");
        let people = vec![
            row("p-1", "zed", true, 0),
            row("p-2", "Ada", false, 30),
            row("p-3", "bo", false, 90),
        ];
        let (due, counts) = arrange(people.clone(), RosterFilter::Due, RosterSort::Recent, now);
        assert_eq!(
            counts,
            RosterCounts {
                all: 3,
                starred: 1,
                due: 1
            }
        );
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].party_id, "p-2", "59 days against a 30-day cadence");
        let (starred, _) = arrange(
            people.clone(),
            RosterFilter::Starred,
            RosterSort::Recent,
            now,
        );
        assert_eq!(starred[0].party_id, "p-1");
        let (named, _) = arrange(people, RosterFilter::All, RosterSort::Name, now);
        assert_eq!(
            named
                .iter()
                .map(|row| row.name.as_str())
                .collect::<Vec<_>>(),
            ["Ada", "bo", "zed"]
        );
    }

    #[test]
    fn a_date_across_the_year_boundary_is_days_ahead_not_behind() {
        let new_years_eve = CivilDate::new(2099, 12, 31);
        assert_eq!(in_days(new_years_eve, "01-02"), Some(2));
        assert_eq!(in_days(new_years_eve, "12-31"), Some(0));
        assert_eq!(in_days(new_years_eve, "13-01"), None);
    }
}
