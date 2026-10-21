//! MEMOS — the notes that are about something, read once, and excluded four ways
//! (#834 R-journal).
//!
//! A People-journal entry is a note with an `about` edge to a person, and so is a
//! memo on a task or an event: the note belongs to what it is about. Those notes
//! are **excluded** from the library, the trash shelf, the derived tag chips,
//! `search` and the powerbox — and **reachable by id**, because the People
//! screen opens one ([`crate::queries::load_note`]). The Journal place reads the
//! same set the other way round ([`crate::queries::load_journal`]).
//!
//! **A refused read of this set fails, and that is deliberate.** Answering
//! "empty" would leak memos onto the notes shelf — the exclusion is the safe
//! direction only when the set is known, so the walk's own failure propagates.
//! The caller turns it into the query's own denial payload, so the app's
//! contract ("a denial is a value") holds at the surface while the read still
//! fails closed.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, read_pages};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

/// How far the walk may go: twenty thousand `about` edges. A vault past it is
/// refused with the kit's sentence rather than answered with a shelf that has
/// silently stopped excluding.
pub const MEMO_BOUND: FanOutBound = FanOutBound::new(500, 40);

/// Every `about` edge, as its two ends: the set of ids that are about something.
#[must_use]
pub fn memos_statement() -> PageQuery {
    PageQuery::new(
        "notes.memos",
        "from_id, to_id",
        "edge",
        PageOrder::asc("from_id", "to_id"),
    )
    .filter("rel = ?", vec![PageBindValue::Text("about".to_owned())])
}

/// The ids of everything that is about something (the notes among them are the
/// memos), each once.
///
/// # Errors
///
/// Whatever the door refuses. See the module note for why this one propagates.
pub fn read_memo_ids(door: &dyn PageDoor) -> KitResult<Vec<String>> {
    let mut ids: Vec<String> = read_pages(door, &memos_statement(), MEMO_BOUND)?
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect();
    // The walk is ordered by `from_id`, so a note about two things is adjacent.
    ids.dedup();
    Ok(ids)
}
