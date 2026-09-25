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
//! ## A NOTEBOOK IS A COLLECTION OF KIND `notebook`
//!
//! `core_collection` holds Photos' albums too, and says which a row is
//! (`kind`, rung six). [`spine_statement`] reads notebooks only, so nothing
//! here counts, hides or guesses at an album.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{JOIN_FAN_OUT, PageDoor, in_list, read_pages};
use centraid_apps_kit::row::{integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageOrder, PageQuery};

use crate::Denial;
use crate::cards::CardDoor;
use crate::journal::read_journal_note_ids;
use crate::queries::{
    LibraryData, LibraryRow, NOTE_TARGET_TYPE, WINDOW_MIN, load_library, notebook_kind_bind,
};

/// How the shelf is ordered. Pinned notes lead under every order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sort {
    /// Newest `updated_at` first — the library's own order.
    #[default]
    Updated,
    /// Newest `created_at` first.
    Created,
    /// Title, case-insensitively.
    Title,
}

/// What the screen narrows the library to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LibraryFilter {
    pub sort: Sort,
    pub pinned_only: bool,
    /// Only notes filed here.
    pub notebook_id: Option<String>,
    /// Only notes filed nowhere. Ignored when `notebook_id` is set.
    pub unfiled_only: bool,
    /// Only notes carrying EVERY one of these concepts.
    pub tag_concept_ids: Vec<String>,
}

/// The library, narrowed and ordered. The trash shelf is dropped: it is its
/// own query ([`load_trash`]).
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
        .filter(|row| !filter.pinned_only || row.pinned == 1)
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
    // STABLE, and pinned first under every order: the fold's own order is the
    // tie-break, so two notes with one instant keep their page order.
    match filter.sort {
        Sort::Updated => {
            notes.sort_by(|left, right| {
                right
                    .pinned
                    .cmp(&left.pinned)
                    .then_with(|| right.updated_at.cmp(&left.updated_at))
            });
        }
        Sort::Created => {
            notes.sort_by(|left, right| {
                right
                    .pinned
                    .cmp(&left.pinned)
                    .then_with(|| right.created_at.cmp(&left.created_at))
            });
        }
        Sort::Title => {
            notes.sort_by(|left, right| {
                right.pinned.cmp(&left.pinned).then_with(|| {
                    title_key(left.title.as_deref()).cmp(&title_key(right.title.as_deref()))
                })
            });
        }
    }
    LibraryData {
        notes,
        trash: Vec::new(),
        ..data
    }
}

fn title_key(title: Option<&str>) -> String {
    title.unwrap_or_default().trim().to_lowercase()
}

/// The trash shelf: newest `deleted_at` first, at most
/// [`crate::queries::SHELF_ROWS`], journal entries excluded (D-1020-N3).
///
/// It is the library fold's own `trash`, read with the SMALLEST recent window
/// the manifest allows, so the decorations (notebooks, tags, cards) are the
/// ones the library would draw and the recent window costs as little as it
/// can.
///
/// # Errors
///
/// The kit's own refusals; a denial is the tuple's second element.
pub fn load_trash(
    door: &dyn PageDoor,
    cards: &dyn CardDoor,
) -> KitResult<(Vec<LibraryRow>, Option<Denial>)> {
    let window = i64::try_from(WINDOW_MIN).unwrap_or(i64::MAX);
    let (data, denial) = load_library(door, cards, Some(window))?;
    Ok((data.trash, denial))
}

/// One collection on the spine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotebookEntry {
    pub notebook_id: String,
    pub name: Option<String>,
    pub sort_order: i64,
    pub parent_notebook_id: Option<String>,
    /// Live, non-journal notes filed here.
    pub note_count: usize,
}

/// What `notebooks` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotebooksData {
    pub notebooks: Vec<NotebookEntry>,
}

/// Every notebook, with its parent — `kind = 'notebook'`, never an album.
#[must_use]
pub fn spine_statement() -> PageQuery {
    PageQuery::new(
        "notes.notebooks.collections",
        "collection_id, name, sort_order, parent_collection_id",
        "core_collection",
        PageOrder::asc("collection_id", "collection_id"),
    )
    .filter("kind = ?", notebook_kind_bind())
}

/// The notebooks, by `sort_order` then id, with their counts.
///
/// # Errors
///
/// The kit's own refusals — a fan-out past its cap included. A denial is the
/// tuple's second element.
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
    let collections = read_pages(door, &spine_statement(), JOIN_FAN_OUT)?;
    let ids: Vec<String> = collections
        .iter()
        .filter_map(|row| text_of(row, "collection_id"))
        .collect();
    if ids.is_empty() {
        return Ok(NotebooksData::default());
    }
    let fragment = in_list("collection_id", &ids)?;
    let entries = read_pages(
        door,
        &PageQuery::new(
            "notes.notebooks.entries",
            "entry_id, collection_id, target_type, target_id",
            "core_collection_entry",
            PageOrder::asc("entry_id", "entry_id"),
        )
        .filter(&fragment.sql, fragment.bind),
        JOIN_FAN_OUT,
    )?;
    let mut note_ids: Vec<String> = entries
        .iter()
        .filter(|row| text_of(row, "target_type").as_deref() == Some(NOTE_TARGET_TYPE))
        .filter_map(|row| text_of(row, "target_id"))
        .collect();
    note_ids.sort_unstable();
    note_ids.dedup();
    // A NOTE COUNTS WHEN IT IS ON THE SHELF: live, and not a journal entry
    // (D-1020-N3) — the same rows the library would draw in this notebook.
    let live: BTreeSet<String> = if note_ids.is_empty() {
        BTreeSet::new()
    } else {
        let journal: BTreeSet<String> = read_journal_note_ids(door)?.into_iter().collect();
        let fragment = in_list("note_id", &note_ids)?;
        read_pages(
            door,
            &PageQuery::new(
                "notes.notebooks.live",
                "note_id",
                "knowledge_note",
                PageOrder::asc("note_id", "note_id"),
            )
            .filter(
                &format!("{} AND deleted_at IS NULL", fragment.sql),
                fragment.bind,
            ),
            JOIN_FAN_OUT,
        )?
        .iter()
        .filter_map(|row| text_of(row, "note_id"))
        .filter(|id| !journal.contains(id))
        .collect()
    };
    let mut notes: BTreeMap<String, usize> = BTreeMap::new();
    for entry in &entries {
        let Some(collection) = text_of(entry, "collection_id") else {
            continue;
        };
        if text_of(entry, "target_type").as_deref() == Some(NOTE_TARGET_TYPE)
            && text_of(entry, "target_id").is_some_and(|id| live.contains(&id))
        {
            *notes.entry(collection).or_default() += 1;
        }
    }
    let mut notebooks: Vec<NotebookEntry> = collections
        .iter()
        .filter_map(|row| {
            let notebook_id = text_of(row, "collection_id")?;
            Some(NotebookEntry {
                name: text_of(row, "name"),
                sort_order: integer_or_zero(row, "sort_order"),
                parent_notebook_id: text_of(row, "parent_collection_id"),
                note_count: notes.get(&notebook_id).copied().unwrap_or_default(),
                notebook_id,
            })
        })
        .collect();
    // `sort_order` is sibling-scoped, so it is a sort, not a key; the id read
    // order is the tie-break.
    notebooks.sort_by_key(|notebook| notebook.sort_order);
    Ok(NotebooksData { notebooks })
}
