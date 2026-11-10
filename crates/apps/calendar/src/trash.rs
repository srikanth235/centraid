//! `trash` — the events in the trash, most recently trashed first (#1185).
//!
//! An event is an entity of kind `event`; trashing one (`entity.trash`) stamps
//! `deleted_at` and `purge_at` on the entity row and nothing else, so the shelf
//! is a read of those rows. A recurring event is ONE entity: it is in the trash
//! whole, every occurrence with it, and a restore brings the whole series back.
//! The page door cannot read it (the grid and the agenda read live events), so
//! this is a read of its own, bounded by [`TRASH_ROWS`] with the truncation
//! reported.

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

/// One trashed event: its title and the two instants the vault stamped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub event_id: String,
    pub title: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
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
        "id, title, deleted_at, purge_at",
        "entity",
        PageOrder::desc("deleted_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NOT NULL", vec![text("event")]);
    let window = match read_window(door, &query, TRASH_ROWS) {
        Ok(window) => window,
        Err(KitError::Door(message)) => {
            return Ok((TrashData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let events = window
        .rows
        .iter()
        .filter_map(|row| {
            Some(TrashRow {
                event_id: text_of(row, "id")?,
                title: text_of(row, "title").unwrap_or_default(),
                deleted_at: text_of(row, "deleted_at"),
                purge_at: text_of(row, "purge_at"),
            })
        })
        .collect();
    Ok((
        TrashData {
            events,
            truncated: window.filled,
        },
        None,
    ))
}
