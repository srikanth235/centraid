//! `trash` — the workouts in the trash, most recently trashed first (#1185).
//!
//! A workout is an `activity` entity with its `workout` row beside it; trashing one
//! (`entity.trash`) stamps `deleted_at` and `purge_at` on the entity row and nothing else, so the
//! shelf is a read of those rows. The page door cannot read it (the lists read live workouts), so
//! this is a read of its own, bounded by [`TRASH_ROWS`] with the truncation reported. A trashed
//! activity that has no workout row is not a workout and is left out. The rows carry the kind and
//! the start, so the screen names a workout as the list does ("Morning run").

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, read_window};
use centraid_apps_kit::row::text_of;

use crate::door;

/// The shelf's window.
pub const TRASH_ROWS: usize = 500;

/// One trashed workout: what names it and the two instants the vault stamped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub activity_id: String,
    /// The workout kind's key (`run`), empty when the kind is gone.
    pub kind_key: String,
    pub started_at: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

/// The shelf, and whether it is longer than its window.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TrashData {
    pub workouts: Vec<TrashRow>,
    pub truncated: bool,
}

/// `trash`: the trashed workouts.
///
/// # Errors
///
/// A door failure.
pub fn load_trash(door: &dyn PageDoor) -> KitResult<TrashData> {
    let window = read_window(door, &door::trashed_activities_statement(), TRASH_ROWS)?;
    let ids: Vec<String> = window
        .rows
        .iter()
        .filter_map(|row| text_of(row, "id"))
        .collect();
    if ids.is_empty() {
        return Ok(TrashData::default());
    }
    let spans = door::activities(door, &ids)?;
    let measures = door::measures(door, &ids)?;
    let kinds = door::kinds(door)?;
    let workouts = window
        .rows
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            measures.get(&id)?;
            let span = spans.get(&id)?;
            Some(TrashRow {
                kind_key: kinds
                    .iter()
                    .find(|kind| kind.concept_id == span.kind_concept_id)
                    .map(|kind| kind.key.clone())
                    .unwrap_or_default(),
                started_at: span.started_at.clone(),
                deleted_at: text_of(row, "deleted_at"),
                purge_at: text_of(row, "purge_at"),
                activity_id: id,
            })
        })
        .collect();
    Ok(TrashData {
        workouts,
        truncated: window.filled,
    })
}
