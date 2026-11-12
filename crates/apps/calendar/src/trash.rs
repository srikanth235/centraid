//! `trash` — the events and calendars in the trash, most recently trashed first (#1185).
//!
//! An event is an entity of kind `event`; trashing one (`entity.trash`) stamps
//! `deleted_at` and `purge_at` on the entity row and nothing else, so the shelf
//! is a read of those rows. A recurring event is ONE entity: it is in the trash
//! whole, every occurrence with it, and a restore brings the whole series back.
//! The page door cannot read it (the grid and the agenda read live events), so
//! this is a read of its own, bounded by [`TRASH_ROWS`] with the truncation
//! reported.

use std::collections::BTreeMap;

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{PageDoor, read_window};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::{Denial, denial_of};

fn text(word: &str) -> PageBindValue {
    PageBindValue::Text(word.to_owned())
}

/// The shelf's window.
pub const TRASH_ROWS: usize = 500;

/// One trashed event or calendar: its title and the two instants the vault stamped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub event_id: String,
    pub title: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    /// The row is a calendar, not an event: the shelf names it so.
    pub calendar: bool,
    /// For a calendar: how many events went to the trash with it. They are not rows of their own.
    pub members: u32,
}

/// The shelf, and whether it is longer than its window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrashData {
    pub events: Vec<TrashRow>,
    pub truncated: bool,
}

/// `trash`: the trashed events.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_trash(door: &dyn PageDoor) -> KitResult<(TrashData, Option<Denial>)> {
    let query = PageQuery::new(
        "calendar.trash",
        "id, title, kind, deleted_at, purge_at",
        "entity",
        PageOrder::desc("deleted_at", "id"),
    )
    .filter(
        "kind IN (?, ?) AND deleted_at IS NOT NULL",
        vec![text("event"), text("calendar")],
    );
    let window = match read_window(door, &query, TRASH_ROWS) {
        Ok(window) => window,
        Err(KitError::Door(message)) => {
            return Ok((TrashData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let mut events: Vec<TrashRow> = window
        .rows
        .iter()
        .filter_map(|row| {
            Some(TrashRow {
                event_id: text_of(row, "id")?,
                title: text_of(row, "title").unwrap_or_default(),
                deleted_at: text_of(row, "deleted_at"),
                purge_at: text_of(row, "purge_at"),
                calendar: text_of(row, "kind").as_deref() == Some("calendar"),
                members: 0,
            })
        })
        .collect();
    // THE EVENTS THAT WENT WITH A CALENDAR ARE ITS MEMBERS, NOT ROWS OF THEIR OWN: an event whose
    // calendar is in the trash under the very stamp the event carries is hidden from the shelf and
    // counted on the calendar's row (one restore of the calendar brings exactly those back; an
    // event trashed on its own, before or after, is still a row).
    let stamps: BTreeMap<String, Option<String>> = events
        .iter()
        .filter(|row| row.calendar)
        .map(|row| (row.event_id.clone(), row.deleted_at.clone()))
        .collect();
    if !stamps.is_empty() {
        let ids: Vec<String> = events
            .iter()
            .filter(|row| !row.calendar)
            .map(|row| row.event_id.clone())
            .collect();
        let homes = calendars_of(door, &ids)?;
        let mut counts: BTreeMap<String, u32> = BTreeMap::new();
        events.retain(|row| {
            let Some(home) = homes.get(&row.event_id) else {
                return true;
            };
            let with_it = stamps
                .get(home)
                .is_some_and(|stamp| *stamp == row.deleted_at);
            if with_it {
                *counts.entry(home.clone()).or_default() += 1;
            }
            !with_it
        });
        for row in events.iter_mut().filter(|row| row.calendar) {
            row.members = counts.get(&row.event_id).copied().unwrap_or_default();
        }
    }
    Ok((
        TrashData {
            events,
            truncated: window.filled,
        },
        None,
    ))
}

/// The calendar each of `events` is on, by event id: one read of the `event` rows, in the shelf's
/// window (so no more binds than [`TRASH_ROWS`]).
fn calendars_of(door: &dyn PageDoor, events: &[String]) -> KitResult<BTreeMap<String, String>> {
    if events.is_empty() {
        return Ok(BTreeMap::new());
    }
    let marks = vec!["?"; events.len()].join(", ");
    let query = PageQuery::new(
        "calendar.trash.homes",
        "id, calendar_id",
        "event",
        PageOrder::asc("id", "id"),
    )
    .filter(
        &format!("id IN ({marks})"),
        events.iter().map(|id| text(id)).collect(),
    );
    let window = match read_window(door, &query, TRASH_ROWS) {
        Ok(window) => window,
        Err(KitError::Door(_)) => return Ok(BTreeMap::new()),
        Err(other) => return Err(other),
    };
    Ok(window
        .rows
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "calendar_id")?)))
        .collect())
}
