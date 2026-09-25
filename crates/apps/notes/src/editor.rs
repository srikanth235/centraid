//! THE EDITOR'S NOTE: one note, whole, with the base its autosave compares
//! against (#1015 D3 — autosave everywhere).
//!
//! [`crate::queries::load_note`] is v0's `note` query, the parity fixture's,
//! and answers only `{note_id, body, format}`. An editor that autosaves needs
//! more than the text: the title and pin it shows, whether the note is in the
//! trash (`knowledge.edit_note` refuses a trashed note, `note_is_live`), and
//! the two values that say whether somebody else wrote since it opened —
//!
//! - **`current_revision_id`**, which moves only when the BODY changes:
//!   `knowledge.edit_note` records an occurrence only when the body resolves
//!   to a new content id (`crates/vault/src/commands/knowledge.rs`,
//!   `edit_note`'s handler), so a title, pin or format edit leaves it alone;
//! - **`row_version`**, which every write to the row bumps.
//!
//! The command itself takes no base and does no compare; the check is the
//! editor's, against these two.
//!
//! Like `load_note`, this does NO journal read (D-1020-N3): a People-journal
//! entry opens by id.

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{PageDoor, read_by_id};
use centraid_apps_kit::row::{integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::Denial;
use crate::queries::{NOTE_TARGET_TYPE, load_note};

/// What the editor opens on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EditorNote {
    /// `false` is an id nothing answers to — never an empty note a save would
    /// write over.
    pub found: bool,
    pub note_id: String,
    pub title: String,
    pub format: String,
    pub pinned: bool,
    pub body: String,
    pub body_content_id: String,
    pub current_revision_id: Option<String>,
    pub row_version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    /// The one notebook the note is filed in; v1 keeps one placement
    /// (`knowledge.move_note`'s `note_singly_placed`).
    pub notebook_id: Option<String>,
}

/// The note's placement, which is at most one row.
#[must_use]
pub fn placement_statement(note_id: &str) -> PageQuery {
    PageQuery::new(
        "notes.editor.placement",
        "entry_id, collection_id",
        "core_collection_entry",
        PageOrder::asc("entry_id", "entry_id"),
    )
    .filter(
        "target_type = ? AND target_id = ?",
        vec![
            PageBindValue::Text(NOTE_TARGET_TYPE.to_owned()),
            PageBindValue::Text(note_id.to_owned()),
        ],
    )
}

/// One note for the editor.
///
/// # Errors
///
/// The kit's own refusals; a denial is the tuple's second element.
pub fn load_editor_note(
    door: &dyn PageDoor,
    note_id: &str,
) -> KitResult<(EditorNote, Option<Denial>)> {
    let note_id = note_id.trim().to_owned();
    let empty = || EditorNote {
        note_id: note_id.clone(),
        ..EditorNote::default()
    };
    if note_id.is_empty() {
        return Ok((empty(), None));
    }
    match editor_body(door, &note_id) {
        Ok(note) => Ok((note, None)),
        Err(KitError::Door(message)) => Ok((
            empty(),
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}

fn editor_body(door: &dyn PageDoor, note_id: &str) -> KitResult<EditorNote> {
    let Some(row) = read_by_id(
        door,
        "notes.editor.row",
        "note_id, title, format, pinned, body_content_id, current_revision_id, row_version, \
         created_at, updated_at, deleted_at, purge_at",
        "knowledge_note",
        "note_id",
        note_id,
    )?
    else {
        return Ok(EditorNote {
            note_id: note_id.to_owned(),
            ..EditorNote::default()
        });
    };
    // THE BODY THROUGH THE ONE DECODER `note` uses, so the editor and the
    // parity-pinned query cannot read the same bytes two ways.
    let (text, denial) = load_note(door, note_id)?;
    if let Some(denial) = denial {
        return Err(KitError::Door(denial.message.unwrap_or_default()));
    }
    let placement = door.page(&placement_statement(note_id), &PageRequest::first(1))?;
    Ok(EditorNote {
        found: true,
        note_id: note_id.to_owned(),
        title: text_of(&row, "title").unwrap_or_default(),
        format: text_of(&row, "format").unwrap_or_default(),
        pinned: integer_or_zero(&row, "pinned") == 1,
        body: text.body,
        body_content_id: text_of(&row, "body_content_id").unwrap_or_default(),
        current_revision_id: text_of(&row, "current_revision_id"),
        row_version: integer_or_zero(&row, "row_version"),
        created_at: text_of(&row, "created_at").unwrap_or_default(),
        updated_at: text_of(&row, "updated_at").unwrap_or_default(),
        deleted_at: text_of(&row, "deleted_at"),
        purge_at: text_of(&row, "purge_at"),
        notebook_id: placement
            .rows
            .first()
            .and_then(|entry| text_of(entry, "collection_id")),
    })
}
