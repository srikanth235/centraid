//! THE KEEP-IN-TOUCH DASHBOARD: who is overdue to reconnect with, whose date is
//! coming, and the latest touches.
//!
//! One window over the circle, and the counts are a fold over it, so the window
//! is walked to its stated size and `truncated` says whether it filled. Last
//! contact is computed from the activities `with` each person; a person with
//! no touch is measured from when they were added, and one with no cadence is
//! never overdue. `today` is the vault's own civil date and `now_ms` the instant
//! the cadence is measured against, both the caller's: a handler that could
//! read a clock would read the host's.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::PageDoor;

use crate::Denial;
use crate::dates::{CivilDate, days_since_contact, days_until_month_day, is_overdue};
use crate::queries::{
    DASHBOARD_WINDOW, DEFAULT_TOUCH_LABEL, PersonCard, RECENT_TOUCH_ROWS, asked, dates, describe,
    last_contacts, read_circle, starred, touch_stubs,
};

/// One row of the Upcoming rail: a person's card plus the date itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpcomingRow {
    pub card: PersonCard,
    pub date_id: String,
    pub label: String,
    pub month_day: String,
    /// Days until the next occurrence, in the vault's zone.
    pub in_days: i64,
}

/// One row of the Recent rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentRow {
    pub card: PersonCard,
    pub interaction_id: String,
    /// The kind concept's title, or [`DEFAULT_TOUCH_LABEL`]. (The person sheet
    /// shows its key; the two are one concept.)
    pub kind: String,
    pub text: String,
    pub occurred_at: String,
}

/// The headline counts.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Counts {
    pub all: usize,
    pub reconnect: usize,
    pub upcoming: usize,
    pub starred: usize,
}

/// What `dashboard` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DashboardData {
    pub reconnect: Vec<PersonCard>,
    pub upcoming: Vec<UpcomingRow>,
    pub recent: Vec<RecentRow>,
    pub counts: Counts,
    /// More live people exist than the window read.
    pub truncated: bool,
    /// The window the counts were folded over.
    pub window: usize,
    /// Whole days past the cadence, for every person on [`Self::reconnect`]: the
    /// number the rail is sorted by, kept so a surface prints it rather than
    /// recomputing it against a second clock.
    pub days_over: BTreeMap<String, i64>,
}

/// `dashboard` — the summary.
pub fn load_dashboard(
    door: &dyn PageDoor,
    today: CivilDate,
    now_ms: i64,
) -> KitResult<(DashboardData, Option<Denial>)> {
    let empty = DashboardData {
        window: DASHBOARD_WINDOW,
        ..DashboardData::default()
    };
    let circle = asked!(read_circle(door, DASHBOARD_WINDOW), empty.clone());
    let ids: Vec<String> = circle
        .members
        .iter()
        .map(|person| person.id.clone())
        .collect();
    let stars = asked!(starred(door, &ids), empty.clone());
    let stubs = asked!(touch_stubs(door, &ids), empty.clone());
    let found = asked!(
        dates(door, &circle.members.iter().collect::<Vec<_>>()),
        empty.clone()
    );
    let last = last_contacts(&stubs);
    let cards: BTreeMap<&str, PersonCard> = circle
        .members
        .iter()
        .map(|person| (person.id.as_str(), PersonCard::of(person)))
        .collect();
    let card = |id: &str| {
        cards
            .get(id)
            .cloned()
            .unwrap_or_else(|| PersonCard::unknown(id))
    };

    // RECONNECT: overdue, most overdue first, ties by id so the rail does not
    // reshuffle between two reads.
    let mut overdue: Vec<(i64, &str)> = circle
        .members
        .iter()
        .filter_map(|person| {
            let (last, created) = (
                last.get(&person.id).map(String::as_str),
                Some(person.created_at.as_str()),
            );
            is_overdue(person.cadence_days, last, created, now_ms).then(|| {
                (
                    days_since_contact(last, created, now_ms) - person.cadence_days,
                    person.id.as_str(),
                )
            })
        })
        .collect();
    overdue.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(right.1)));
    let reconnect: Vec<PersonCard> = overdue.iter().map(|(_, id)| card(id)).collect();

    // UPCOMING: the reminders that are on, nearest first.
    let mut soon: Vec<(i64, &crate::queries::DateRow)> = found
        .iter()
        .filter(|date| date.reminder_on)
        .map(|date| (days_until_month_day(today, &date.month_day), date))
        .collect();
    soon.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.date_id.cmp(&right.1.date_id))
    });
    let upcoming: Vec<UpcomingRow> = soon
        .into_iter()
        .map(|(in_days, date)| UpcomingRow {
            card: card(&date.person_id),
            date_id: date.date_id.clone(),
            label: date.label.clone(),
            month_day: date.month_day.clone(),
            in_days,
        })
        .collect();

    // RECENT: the newest touches (the stubs are newest first) of the circle.
    let latest: Vec<_> = stubs
        .iter()
        .filter(|stub| cards.contains_key(stub.person_id.as_str()))
        .take(RECENT_TOUCH_ROWS)
        .cloned()
        .collect();
    let recent: Vec<RecentRow> = asked!(describe(door, &latest), empty)
        .into_iter()
        .map(|touch| RecentRow {
            card: card(&touch.person_id),
            kind: if touch.label.is_empty() {
                DEFAULT_TOUCH_LABEL.to_owned()
            } else {
                touch.label
            },
            text: touch.text,
            occurred_at: touch.at,
            interaction_id: touch.id,
        })
        .collect();

    let counts = Counts {
        all: circle.members.len(),
        reconnect: reconnect.len(),
        upcoming: upcoming.len(),
        starred: stars.len(),
    };
    Ok((
        DashboardData {
            reconnect,
            upcoming,
            recent,
            counts,
            truncated: circle.filled,
            window: DASHBOARD_WINDOW,
            days_over: overdue
                .into_iter()
                .map(|(over, id)| (id.to_owned(), over))
                .collect(),
        },
        None,
    ))
}
