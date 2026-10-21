//! THE PHONE'S SHELVES over the library fold: the sort and the filters a
//! screen asks for, the trash shelf on its own, and the notebook spine with
//! its counts (#1046).
//!
//! v0's phone read the whole replica and sorted and filtered it in
//! TypeScript (`notes-model.ts`: pinned first, then newest). A v1 shell holds
//! no replica of the library, so the same narrowing happens here, over what
//! [`load_library`] folded.
//!
//! ## A FILTER NARROWS THE WINDOW, NOT THE VAULT
//!
//! [`shape_library`] filters the rows the window returned. A notebook or tag
//! filter over a `truncated` window can miss an older note, and `truncated`
//! stays what the window said so the screen can offer a wider one. The pinned
//! filter is complete, because every pinned note is read beside the window.
//!
//! ## A NOTEBOOK HOLDS NOTES BY ONE COLUMN
//!
//! A note names its notebook (`note.notebook_id`), so a notebook's count is the
//! live shelf notes that name it, and the "Unfiled" row is the ones that name
//! none. A trashed notebook took its notes to the trash with it, so a live note
//! never names one.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{PageDoor, read_window};
use centraid_apps_kit::row::text_of;
use centraid_apps_kit::statement::PageBindValue;

use crate::Denial;
use crate::journal::read_memo_ids;
use crate::queries::{
    LibraryData, LibraryRow, Read, WINDOW_DEFAULT, WINDOW_MIN, load_library, note_rows, notebooks,
    pinned_ids, recent_statement, texts,
};

/// How the library's shelf is ordered. PINNED NOTES LEAD under every order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sort {
    #[default]
    Updated,
    Created,
    Title,
}

/// What the screen narrows the shelf by.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LibraryFilter {
    pub sort: Sort,
    pub pinned_only: bool,
    /// Only notes filed in this notebook.
    pub notebook_id: Option<String>,
    /// Only notes filed in no notebook; ignored when `notebook_id` is set.
    pub unfiled_only: bool,
    /// Only notes carrying every one of these tags.
    pub tag_concept_ids: Vec<String>,
}

/// Narrow and order what [`load_library`] folded. The trash is not part of it.
#[must_use]
pub fn shape_library(data: LibraryData, filter: &LibraryFilter) -> LibraryData {
    let wanted_tags: BTreeSet<&str> = filter
        .tag_concept_ids
        .iter()
        .map(String::as_str)
        .filter(|id| !id.is_empty())
        .collect();
    let mut notes: Vec<LibraryRow> = data
        .notes
        .into_iter()
        .filter(|row| !filter.pinned_only || row.pinned)
        .filter(|row| match (&filter.notebook_id, filter.unfiled_only) {
            (Some(notebook), _) => row.notebook_ids.iter().any(|id| id == notebook),
            (None, true) => row.notebook_ids.is_empty(),
            (None, false) => true,
        })
        .filter(|row| {
            wanted_tags.iter().all(|wanted| {
                row.tags
                    .iter()
                    .any(|tag| tag.concept_id.as_str() == *wanted)
            })
        })
        .collect();
    match filter.sort {
        Sort::Updated => notes.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then_with(|| right.updated_at.cmp(&left.updated_at))
        }),
        Sort::Created => notes.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then_with(|| right.created_at.cmp(&left.created_at))
        }),
        Sort::Title => notes.sort_by(|left, right| {
            right.pinned.cmp(&left.pinned).then_with(|| {
                title_key(left.title.as_deref()).cmp(&title_key(right.title.as_deref()))
            })
        }),
    }
    LibraryData {
        notes,
        trash: Vec::new(),
        ..data
    }
}

/// A title as the shelf sorts it: trimmed, case-folded.
fn title_key(title: Option<&str>) -> String {
    title.unwrap_or_default().trim().to_lowercase()
}

/// The trash shelf: trashed notes, newest deleted first, memos left out.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is the tuple's second element.
pub fn load_trash(door: &dyn PageDoor) -> KitResult<(Vec<LibraryRow>, Option<Denial>)> {
    let window = i64::try_from(WINDOW_MIN).unwrap_or(i64::MAX);
    let (data, denial) = load_library(door, Some(window))?;
    Ok((data.trash, denial))
}

/// One notebook on the spine, with the live notes filed in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotebookEntry {
    pub notebook_id: String,
    pub name: Option<String>,
    pub sort_order: i64,
    pub parent_notebook_id: Option<String>,
    pub note_count: usize,
}

/// What `notes.notebooks` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotebooksData {
    pub notebooks: Vec<NotebookEntry>,
    /// The "Unfiled" row's count, over the same window the library reads.
    pub unfiled_count: usize,
    /// The window filled, so more unfiled notes may exist.
    pub unfiled_truncated: bool,
}

/// The notebook spine with its counts.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is the tuple's second element.
pub fn load_notebooks(door: &dyn PageDoor) -> KitResult<(NotebooksData, Option<Denial>)> {
    match notebooks_body(door) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((
            NotebooksData::default(),
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}

fn notebooks_body(door: &dyn PageDoor) -> KitResult<NotebooksData> {
    let books = notebooks(door)?;
    let memos: BTreeSet<String> = read_memo_ids(door)?.into_iter().collect();
    let book_ids: Vec<String> = books.iter().map(|book| book.notebook_id.clone()).collect();
    // Which notes name a notebook, then which of those are live shelf notes.
    let filed = Read {
        name: "notes.notebooks.filed",
        table: "note",
        select: "id, notebook_id",
        order: ("id", "id"),
        column: "notebook_id",
    }
    .of(door, &book_ids, None)?;
    let live: BTreeSet<String> = Read {
        name: "notes.notebooks.live",
        table: "entity",
        select: "id",
        order: ("id", "id"),
        column: "id",
    }
    .of(
        door,
        &texts(&filed, "id"),
        Some((
            "kind = ? AND deleted_at IS NULL",
            vec![PageBindValue::Text("note".to_owned())],
        )),
    )?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .filter(|id| !memos.contains(id))
    .collect();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for row in &filed {
        if let (Some(id), Some(book)) = (text_of(row, "id"), text_of(row, "notebook_id"))
            && live.contains(&id)
        {
            *counts.entry(book).or_default() += 1;
        }
    }
    let (unfiled_count, unfiled_truncated) = unfiled(door, &memos)?;
    Ok(NotebooksData {
        notebooks: books
            .into_iter()
            .map(|book| NotebookEntry {
                note_count: counts.get(&book.notebook_id).copied().unwrap_or_default(),
                notebook_id: book.notebook_id,
                name: book.name,
                sort_order: book.sort_order,
                parent_notebook_id: book.parent_notebook_id,
            })
            .collect(),
        unfiled_count,
        unfiled_truncated,
    })
}

/// The "Unfiled" row: the shelf's notes (the window and every pin) filed in no
/// notebook, memos left out.
fn unfiled(door: &dyn PageDoor, memos: &BTreeSet<String>) -> KitResult<(usize, bool)> {
    let recent = read_window(door, &recent_statement(), WINDOW_DEFAULT)?;
    let mut shelf: BTreeSet<String> = texts(&recent.rows, "id").into_iter().collect();
    shelf.extend(pinned_ids(door)?);
    shelf.retain(|id| !memos.contains(id));
    let ids: Vec<String> = shelf.into_iter().collect();
    let count = note_rows(door, &ids)?
        .values()
        .filter(|note| note.deleted_at.is_none() && note.notebook_id.is_none())
        .count();
    Ok((count, recent.filled))
}
