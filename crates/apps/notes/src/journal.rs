//! THE JOURNAL MARKER SET — read once, and excluded four ways (#834 R-journal).
//!
//! A People-journal entry is a `knowledge.note` carrying a tag from the
//! people-journal concept scheme. Those notes are **excluded** from the library,
//! the trash shelf, the derived tag chips, `search` and the powerbox — and
//! **reachable by id**, because the People screen opens one
//! (`queries/library.ts:1`-`:7`). The Journal place reads the same set the other
//! way round ([`crate::queries::load_journal`]).
//!
//! **A denied read of this set THROWS, and that is deliberate.** Answering
//! "empty" would leak journal notes onto the notes shelf — the exclusion is the
//! safe direction only when the set is known, so the walk's own failure has to
//! propagate (`_shared/journal-scheme.ts:33`-`:36`). Every other read in this
//! app answers a denial as a value; this one is the exception, and the reason is
//! that here the value would be wrong rather than merely absent.
//!
//! The port keeps that as an `Err`, which [`crate::queries`] turns into the
//! query's own `vaultDenied` payload — so the app's own contract ("a denial is a
//! value") holds at the SURFACE while the read below still fails closed.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{JOIN_FAN_OUT, PageDoor, read_pages};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

/// The scheme a journal marker lives in. `_shared/concept-scheme-kit.ts:15`.
pub const JOURNAL_SCHEME_URI: &str = "https://centraid.dev/schemes/people-journal";

/// The marker concept's notation. `_shared/concept-scheme-kit.ts:26`.
pub const JOURNAL_ENTRY_NOTATION: &str = "entry";

/// The statement names are v0's, so a plan snapshot taken on either side names
/// the same read.
const SCHEME_STATEMENT: &str = "_shared/journal.scheme";
const CONCEPTS_STATEMENT: &str = "_shared/journal.concepts";
const TAGS_STATEMENT: &str = "_shared/journal.tags";

/// The ids of every journal entry this vault holds.
///
/// Three bounded walks: the scheme, its concepts, then the tag edges onto
/// `knowledge.note`. Each is `readPages` — a walk with a stated ceiling, not a
/// window — because the set is owner-curated and small, and a short answer here
/// is an exclusion that silently stopped excluding.
///
/// # Errors
///
/// Whatever the door refuses. See the module note for why this one propagates.
pub fn read_journal_note_ids(door: &dyn PageDoor) -> KitResult<Vec<String>> {
    let schemes = read_pages(
        door,
        &PageQuery::new(
            SCHEME_STATEMENT,
            "scheme_id, uri",
            "core_concept_scheme",
            PageOrder::asc("scheme_id", "scheme_id"),
        )
        .filter(
            "uri = ?",
            vec![PageBindValue::Text(JOURNAL_SCHEME_URI.to_owned())],
        ),
        JOIN_FAN_OUT,
    )?;
    // RE-NARROWED IN MEMORY: a read may answer wider than it was asked, and
    // this is the one set whose over-wideness would ADD exclusions rather than
    // drop them — a scheme that is not the journal's must not hide a note.
    let Some(scheme_id) = schemes
        .iter()
        .find(|row| text_of(row, "uri").as_deref() == Some(JOURNAL_SCHEME_URI))
        .and_then(|row| text_of(row, "scheme_id"))
    else {
        return Ok(Vec::new());
    };

    let concepts = read_pages(
        door,
        &PageQuery::new(
            CONCEPTS_STATEMENT,
            "concept_id, scheme_id, notation",
            "core_concept",
            PageOrder::asc("concept_id", "concept_id"),
        )
        .filter(
            "scheme_id = ?",
            vec![PageBindValue::Text(scheme_id.clone())],
        ),
        JOIN_FAN_OUT,
    )?;
    let Some(marker) = concepts
        .iter()
        .filter(|row| text_of(row, "scheme_id").as_deref() == Some(scheme_id.as_str()))
        .find(|row| text_of(row, "notation").as_deref() == Some(JOURNAL_ENTRY_NOTATION))
        .and_then(|row| text_of(row, "concept_id"))
    else {
        return Ok(Vec::new());
    };

    let tags = read_pages(
        door,
        &PageQuery::new(
            TAGS_STATEMENT,
            "tag_id, target_id, concept_id",
            "core_tag",
            PageOrder::asc("tag_id", "tag_id"),
        )
        .filter(
            "target_type = ? AND concept_id = ?",
            vec![
                PageBindValue::Text(crate::queries::NOTE_TARGET_TYPE.to_owned()),
                PageBindValue::Text(marker.clone()),
            ],
        ),
        JOIN_FAN_OUT,
    )?;
    let mut ids: Vec<String> = tags
        .iter()
        .filter(|row| text_of(row, "concept_id").as_deref() == Some(marker.as_str()))
        .filter_map(|row| text_of(row, "target_id"))
        .collect();
    // Sorted and deduped so the set is a VALUE: two notes tagged twice must not
    // make an `IN` list longer than the set it stands for.
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}
