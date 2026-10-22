//! THE EDITOR'S NOTE: one note, whole, with the base its autosave compares
//! against (#1015 D3 — autosave everywhere).
//!
//! [`crate::queries::load_note`] answers only `{note_id, body, format}`. An editor
//! that autosaves needs more than the text: the title and pin it shows, whether
//! the note is in the trash (`note.edit` refuses a trashed note), the notebook
//! it is filed in, and **`row_version`**, which every write to the note bumps
//! and which says whether somebody else wrote since it opened. The command
//! itself takes no base and does no compare; the check is the editor's.
//!
//! Like `load_note`, this does NO memo read (D-1020-N3): a People-journal entry
//! opens by id.

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::PageDoor;
use centraid_apps_kit::statement::PageBindValue;

use crate::Denial;
use crate::queries::{PINNED, read_note};
use centraid_apps_kit::reads::Read;

/// The editor's note.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EditorNote {
    /// False when no note has the id: an empty page is not an empty note.
    pub found: bool,
    pub note_id: String,
    pub title: String,
    pub format: String,
    pub pinned: bool,
    pub body: String,
    pub row_version: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    pub notebook_id: Option<String>,
}

/// One note, whole, by id — live or trashed, memo or not.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is the tuple's second element.
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
        Ok(Some(note)) => Ok((note, None)),
        Ok(None) => Ok((empty(), None)),
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

fn editor_body(door: &dyn PageDoor, note_id: &str) -> KitResult<Option<EditorNote>> {
    let Some(note) = read_note(door, note_id)? else {
        return Ok(None);
    };
    let pinned = !Read {
        name: "notes.editor.pinned",
        table: "edge",
        select: "from_id, to_id",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .of(
        door,
        std::slice::from_ref(&note.id),
        Some((
            "rel = ? AND to_id = ?",
            vec![
                PageBindValue::Text("tagged".to_owned()),
                PageBindValue::Text(PINNED.to_owned()),
            ],
        )),
    )?
    .is_empty();
    Ok(Some(EditorNote {
        found: true,
        note_id: note.id,
        title: note.title,
        format: note.format,
        pinned,
        body: note.body,
        row_version: note.version,
        created_at: note.created_at,
        updated_at: note.updated_at,
        deleted_at: note.deleted_at,
        purge_at: note.purge_at,
        notebook_id: note.notebook_id,
    }))
}
