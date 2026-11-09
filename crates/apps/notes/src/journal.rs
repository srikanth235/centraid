//! THE JOURNAL — the notes that are about the owner, read once, and left out of the
//! library four ways (#834 R-journal, #1173 item 19).
//!
//! A People-journal entry is a note with an `about` edge to **the owner**. Those
//! notes are **excluded** from the library, the trash shelf, the derived tag chips,
//! `search` and the powerbox — and **reachable by id**, because the People screen
//! opens one ([`crate::queries::load_note`]). The Journal place reads the same set
//! the other way round ([`crate::queries::load_journal`]).
//!
//! **A note about anything else is on the shelf.** A note about a person, an event,
//! a task or a document is the member's note: the library shows it with an
//! "About · subject" chip, and the Journal does not. (Until #1173 every `about` edge
//! made a memo; the set was every `about` edge in the vault, which a document, a
//! line or a Locker item joined to a person would have made unbounded.) The read is
//! one indexed lookup on `edge_to`: the edges that end at the owner.
//!
//! **A refused read of this set fails, and that is deliberate.** Answering
//! "empty" would leak journal entries onto the notes shelf — the exclusion is the
//! safe direction only when the set is known, so the walk's own failure propagates.
//! The caller turns it into the query's own denial payload, so the app's
//! contract ("a denial is a value") holds at the surface while the read still
//! fails closed.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::graph;
use centraid_apps_kit::reads::{FanOutBound, PageDoor};

/// How far the walk may go: twenty thousand journal entries. A vault past it is
/// refused with the kit's sentence rather than answered with a shelf that has
/// silently stopped excluding.
pub const MEMO_BOUND: FanOutBound = FanOutBound::new(500, 40);

/// The ids of the journal entries (the notes about the owner), each once. Anything else
/// that is about the owner (a task, an event) is not a note and is not here.
///
/// # Errors
///
/// Whatever the door refuses. See the module note for why this one propagates.
pub fn read_journal_ids(door: &dyn PageDoor) -> KitResult<Vec<String>> {
    let Some(owner) = graph::owner(door)? else {
        return Ok(Vec::new());
    };
    let mut ids: Vec<String> = graph::incoming(door, MEMO_BOUND, &owner, "person", &["about"])?
        .into_iter()
        .map(|joined| joined.from)
        .collect();
    ids.sort();
    ids.dedup();
    Ok(ids)
}
