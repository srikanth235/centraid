//! THE SIX QUERIES: `library`, `note`, `search`, `history`, `journal`,
//! `link-targets`.
//!
//! A note is an `entity` (its title, its trash, its clock) and a `note` row (its
//! words, its format, its notebook); a notebook is an `entity` and a `container`;
//! a pin and a tag are `tagged` edges; a link, a memo and an attachment are
//! `links`, `about` and `attached` edges; a version is a `revision`. Every read
//! here is one table at a time — a window over `entity`, then the rows each
//! decoration needs, bounded by the ids the window already returned — because
//! the paged door's one shape is a keyset page of one table.
//!
//! ## The shelf is the notes that are about nothing
//!
//! A **memo** is a note with an `about` edge: a People journal entry, a note on a
//! task. It belongs to what it is about, so the library, the trash shelf, the
//! tag chips, `search` and the powerbox leave it out, the Journal place shows
//! it, and `note` opens it by id all the same ([`crate::journal`]). The
//! exclusion runs after the window, so `truncated` is measured on what the vault
//! returned, and `notes` may hold fewer rows than `window` while it is true.
//!
//! ## Pinned is read beside the window, not out of it
//!
//! The library is a bounded recent window **plus every pinned note**: a pin
//! survives the note ageing out of the window, so the pinned shelf is read
//! beside the recent one.
//!
//! ## A list row carries a preview, never a body
//!
//! Six lines, 200 characters and a checklist tally ([`crate::derive`]); the
//! editor pulls the whole text lazily through `note`.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{JOIN_FAN_OUT, PageDoor, Read, in_list, read_pages, read_window};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_search::{Answer, Principal, Search, SearchError, SearchRequest, Target};

use crate::Denial;
use crate::cards::{self, RefCard};
use crate::derive::{CheckTally, check_of, preview_of};
use crate::journal::read_memo_ids;

/// The `library` and `journal` window, as the manifest declares it.
pub const WINDOW_MIN: usize = 20;
pub const WINDOW_MAX: usize = 2_000;
/// v0's `Number(input?.limit) || 200` (`library.ts:184`).
pub const WINDOW_DEFAULT: usize = 200;

/// The pinned and trash shelves are what the screen shows, so that is the read.
pub const SHELF_ROWS: usize = 200;

/// How many ranked hits `search` folds (`search.ts:157`).
pub const SEARCH_ROWS: usize = 100;

/// How many targets one powerbox probe returns per kind
/// (`queries/link-targets.ts:17`).
pub const LINK_TARGET_ROWS: usize = 8;

/// How many versions `history` shows, newest first. A long-lived note collects a
/// version per save, so the list is a window and says when it is not the whole.
pub const HISTORY_ROWS: usize = 200;

/// The flag a pinned note carries: a `tagged` edge to this concept.
pub const PINNED: &str = "flag:pinned";

/// The caller's window, clamped exactly as v0 clamps it.
#[must_use]
pub fn window_of(limit: Option<i64>) -> usize {
    let asked = limit
        .and_then(|value| usize::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(WINDOW_DEFAULT);
    asked.clamp(WINDOW_MIN, WINDOW_MAX)
}

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

pub use centraid_apps_kit::attached::Attachment;

/// One tag on a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagChip {
    pub concept_id: String,
    pub label: String,
}

/// One chip in the library's derived tag list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagFacet {
    pub concept_id: String,
    pub label: String,
}

/// A reference out of a note, and the card its far end draws as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceEntry {
    /// The edge's anchor, shipped as data: **resolving it is presentation**
    /// (#282). A wikilink's anchor names the title; a link made by hand names a
    /// range of the text.
    pub selector: Option<serde_json::Value>,
    pub card: RefCard,
}

/// A reference INTO a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BacklinkEntry {
    pub card: RefCard,
}

/// A notebook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notebook {
    pub notebook_id: String,
    pub name: Option<String>,
    pub sort_order: i64,
    pub parent_notebook_id: Option<String>,
}

/// One library row: a preview and a tally, never a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryRow {
    pub note_id: String,
    pub title: Option<String>,
    pub format: Option<String>,
    pub pinned: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    pub preview: String,
    pub check: CheckTally,
    pub notebook_ids: Vec<String>,
    pub notebook_names: Vec<String>,
    pub attachments: Vec<Attachment>,
    pub references: Vec<ReferenceEntry>,
    pub backlinks: Vec<BacklinkEntry>,
    pub tags: Vec<TagChip>,
}

/// What `library` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LibraryData {
    pub notes: Vec<LibraryRow>,
    pub trash: Vec<LibraryRow>,
    pub notebooks: Vec<Notebook>,
    pub tags: Vec<TagFacet>,
    pub truncated: bool,
    pub window: usize,
}

/// What `note` answers: the editor's on-open pull.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteData {
    pub note_id: String,
    pub body: String,
    pub format: Option<String>,
}

/// One ranked search hit, in the library row shape plus a snippet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchRow {
    pub note_id: String,
    pub title: Option<String>,
    pub format: Option<String>,
    pub pinned: bool,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub preview: String,
    pub check: CheckTally,
    pub notebook_ids: Vec<String>,
    pub notebook_names: Vec<String>,
    pub attachments: Vec<Attachment>,
    pub snippet: String,
}

/// What `search` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchData {
    pub notes: Vec<SearchRow>,
}

/// One version of a note's body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    /// The revision's `seq`, which `note.restore_version` takes; 0 for the
    /// current words, which no revision holds.
    pub seq: i64,
    pub body: String,
    /// A POSITION, never a stored flag: the first of the list.
    pub current: bool,
    /// When these words became the note's: the moment the words before them were
    /// replaced, or the note's creation for its first.
    pub asserted_at: String,
}

/// What `history` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryData {
    pub versions: Vec<Version>,
    /// More versions exist than [`HISTORY_ROWS`].
    pub truncated: bool,
}

/// One Journal entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JournalEntry {
    pub note_id: String,
    pub title: Option<String>,
    pub format: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    /// Always `None`: the Journal place reads LIVE entries only.
    pub deleted_at: Option<String>,
    pub preview: String,
    pub check: CheckTally,
}

/// What `journal` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct JournalData {
    pub entries: Vec<JournalEntry>,
    pub truncated: bool,
    pub window: usize,
}

/// What `link-targets` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LinkTargetsData {
    pub targets: Vec<Target>,
}

/// One note as the reads see it: the entity's columns and the kind row's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteRow {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    pub version: i64,
    pub body: String,
    pub format: String,
    pub notebook_id: Option<String>,
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

const ENTITY_COLUMNS: &str = "id, title, created_at, updated_at, deleted_at, purge_at, version";

fn note_kind() -> Vec<PageBindValue> {
    vec![PageBindValue::Text("note".to_owned())]
}

/// The window: live notes, newest `updated_at` first.
#[must_use]
pub fn recent_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.recent",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("updated_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", note_kind())
}

/// The trash shelf, newest `deleted_at` first.
#[must_use]
pub fn trash_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.trash",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("deleted_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NOT NULL", note_kind())
}

/// Every thing carrying the pinned flag: the edges to `flag:pinned`.
#[must_use]
pub fn pinned_edges_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.pinned",
        "from_id, to_id",
        "edge",
        PageOrder::asc("from_id", "to_id"),
    )
    .filter(
        "rel = ? AND to_id = ?",
        vec![
            PageBindValue::Text("tagged".to_owned()),
            PageBindValue::Text(PINNED.to_owned()),
        ],
    )
}

/// Notebooks. Owner-curated and small, so a WALK with a stated ceiling rather
/// than a window.
#[must_use]
pub fn notebooks_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.notebooks",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter(
        "kind = ? AND deleted_at IS NULL",
        vec![PageBindValue::Text("notebook".to_owned())],
    )
}

/// This note's replaced words, newest first.
#[must_use]
pub fn revisions_statement(note_id: &str) -> PageQuery {
    PageQuery::new(
        "notes.history.revisions",
        "entity_id, seq, at, body",
        "revision",
        PageOrder::desc("seq", "entity_id"),
    )
    .filter(
        "entity_id = ?",
        vec![PageBindValue::Text(note_id.to_owned())],
    )
}

pub(crate) fn texts(rows: &[Row], column: &str) -> Vec<String> {
    rows.iter().filter_map(|row| text_of(row, column)).collect()
}

fn denial(message: String) -> Denial {
    Denial {
        code: None,
        message: Some(message),
        revoked_at: None,
    }
}

/// A door's refusal is a value the surface renders; the kit's own errors stay
/// errors.
fn settle<T: Default>(answer: KitResult<T>) -> KitResult<(T, Option<Denial>)> {
    match answer {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((T::default(), Some(denial(message)))),
        Err(other) => Err(other),
    }
}

// ---------------------------------------------------------------------------
// The readers every query shares
// ---------------------------------------------------------------------------

/// The notes among `ids` as rows: the entity's columns and the kind row's.
pub(crate) fn note_rows(
    door: &dyn PageDoor,
    ids: &[String],
) -> KitResult<BTreeMap<String, NoteRow>> {
    let entities = Read {
        name: "notes.rows.entity",
        table: "entity",
        select: ENTITY_COLUMNS,
        order: ("id", "id"),
        column: "id",
    }
    .of(door, ids, Some(("kind = ?", note_kind())))?;
    let kind_rows = Read {
        name: "notes.rows.note",
        table: "note",
        select: "id, body, format, notebook_id",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &texts(&entities, "id"), None)?;
    let by_id: BTreeMap<String, &Row> = kind_rows
        .iter()
        .filter_map(|row| text_of(row, "id").map(|id| (id, row)))
        .collect();
    Ok(entities
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            let kind_row = by_id.get(&id)?;
            Some((
                id.clone(),
                NoteRow {
                    title: text_of(row, "title").unwrap_or_default(),
                    created_at: text_of(row, "created_at").unwrap_or_default(),
                    updated_at: text_of(row, "updated_at").unwrap_or_default(),
                    deleted_at: text_of(row, "deleted_at"),
                    purge_at: text_of(row, "purge_at"),
                    version: integer_or_zero(row, "version"),
                    body: text_of(kind_row, "body").unwrap_or_default(),
                    format: text_of(kind_row, "format").unwrap_or_default(),
                    notebook_id: text_of(kind_row, "notebook_id"),
                    id,
                },
            ))
        })
        .collect())
}

/// One note by id, for the by-id doors: live or trashed, memo or not.
pub(crate) fn read_note(door: &dyn PageDoor, id: &str) -> KitResult<Option<NoteRow>> {
    Ok(note_rows(door, &[id.to_owned()])?.remove(id))
}

/// Who carries the pinned flag.
pub(crate) fn pinned_ids(door: &dyn PageDoor) -> KitResult<BTreeSet<String>> {
    Ok(read_pages(door, &pinned_edges_statement(), JOIN_FAN_OUT)?
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect())
}

/// Every live notebook, in the member's order.
pub(crate) fn notebooks(door: &dyn PageDoor) -> KitResult<Vec<Notebook>> {
    let entities = read_pages(door, &notebooks_statement(), JOIN_FAN_OUT)?;
    let containers = Read {
        name: "notes.library.containers",
        table: "container",
        select: "id, parent_id, position",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &texts(&entities, "id"), None)?;
    let by_id: BTreeMap<String, &Row> = containers
        .iter()
        .filter_map(|row| text_of(row, "id").map(|id| (id, row)))
        .collect();
    let mut books: Vec<Notebook> = entities
        .iter()
        .filter_map(|row| {
            let notebook_id = text_of(row, "id")?;
            let container = by_id.get(&notebook_id)?;
            Some(Notebook {
                name: text_of(row, "title"),
                sort_order: real_or_zero(container, "position"),
                parent_notebook_id: text_of(container, "parent_id"),
                notebook_id,
            })
        })
        .collect();
    books.sort_by(|left, right| {
        left.sort_order
            .cmp(&right.sort_order)
            .then_with(|| left.notebook_id.cmp(&right.notebook_id))
    });
    Ok(books)
}

/// A REAL column as the whole number it is: a position is placed by whole steps
/// and a notebook's `sort_order` is an integer.
#[expect(
    clippy::cast_possible_truncation,
    reason = "a notebook's position is a small whole number the container verbs mint"
)]
fn real_or_zero(row: &Row, column: &str) -> i64 {
    match row.get(column) {
        Some(centraid_apps_kit::row::Cell::Real(value)) => *value as i64,
        Some(centraid_apps_kit::row::Cell::Integer(value)) => *value,
        _ => 0,
    }
}

/// The tags on a set of notes: the `tagged` edges that lead to a `tag` (the
/// flags are the other kind), with the tag's own label.
fn tags_of(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeMap<String, Vec<TagChip>>> {
    let edges = Read {
        name: "notes.library.tags",
        table: "edge",
        select: "from_id, to_id",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .of(
        door,
        ids,
        Some(("rel = ?", vec![PageBindValue::Text("tagged".to_owned())])),
    )?;
    let mut tag_ids = texts(&edges, "to_id");
    tag_ids.sort_unstable();
    tag_ids.dedup();
    let labels: BTreeMap<String, String> = Read {
        name: "notes.library.concepts",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .of(
        door,
        &tag_ids,
        Some(("kind = ?", vec![PageBindValue::Text("tag".to_owned())])),
    )?
    .iter()
    .filter_map(|row| {
        Some((
            text_of(row, "id")?,
            text_of(row, "title").unwrap_or_default(),
        ))
    })
    .collect();
    let mut by_note: BTreeMap<String, Vec<TagChip>> = BTreeMap::new();
    for edge in &edges {
        let (Some(note), Some(concept_id)) = (text_of(edge, "from_id"), text_of(edge, "to_id"))
        else {
            continue;
        };
        if let Some(label) = labels.get(&concept_id) {
            by_note.entry(note).or_default().push(TagChip {
                label: label.clone(),
                concept_id,
            });
        }
    }
    Ok(by_note)
}

/// The references out of a set of notes and the references into them, each with
/// the card of the other end.
#[expect(
    clippy::type_complexity,
    reason = "two maps keyed by note id, read together because one card read serves both"
)]
fn links_of(
    door: &dyn PageDoor,
    ids: &[String],
) -> KitResult<(
    BTreeMap<String, Vec<ReferenceEntry>>,
    BTreeMap<String, Vec<BacklinkEntry>>,
)> {
    let links = Some(("rel = ?", vec![PageBindValue::Text("links".to_owned())]));
    let out = Read {
        name: "notes.library.links",
        table: "edge",
        select: "from_id, to_id, anchor",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .of(door, ids, links.clone())?;
    let back = Read {
        name: "notes.library.backlinks",
        table: "edge",
        select: "from_id, to_id",
        order: ("to_id", "from_id"),
        column: "to_id",
    }
    .of(door, ids, links)?;
    let mut others: Vec<String> = texts(&out, "to_id");
    others.extend(texts(&back, "from_id"));
    let cards = cards::resolve(door, &others)?;
    let card = |id: &str| {
        cards
            .get(id)
            .cloned()
            .unwrap_or_else(|| RefCard::missing(id))
    };
    let mut references: BTreeMap<String, Vec<ReferenceEntry>> = BTreeMap::new();
    for row in &out {
        if let (Some(from), Some(to)) = (text_of(row, "from_id"), text_of(row, "to_id")) {
            references.entry(from).or_default().push(ReferenceEntry {
                // An unreadable anchor is just an unanchored reference.
                selector: text_of(row, "anchor").and_then(|json| serde_json::from_str(&json).ok()),
                card: card(&to),
            });
        }
    }
    let mut backlinks: BTreeMap<String, Vec<BacklinkEntry>> = BTreeMap::new();
    for row in &back {
        if let (Some(from), Some(to)) = (text_of(row, "from_id"), text_of(row, "to_id")) {
            backlinks
                .entry(to)
                .or_default()
                .push(BacklinkEntry { card: card(&from) });
        }
    }
    Ok((references, backlinks))
}

fn notebook_names(books: &[Notebook], note: &NoteRow) -> (Vec<String>, Vec<String>) {
    let Some(id) = &note.notebook_id else {
        return (Vec::new(), Vec::new());
    };
    let name = books
        .iter()
        .find(|book| &book.notebook_id == id)
        .and_then(|book| book.name.clone())
        // A notebook the walk did not reach still draws.
        .unwrap_or_else(|| "Notebook".to_owned());
    (vec![id.clone()], vec![name])
}

// ---------------------------------------------------------------------------
// `library`
// ---------------------------------------------------------------------------

/// The library: a bounded recent window plus **every** pinned note, the trash
/// shelf, the notebooks and the tag chips the window saw.
///
/// # Errors
///
/// The kit's own refusals — a fan-out past its cap, an empty `IN` list. A door's
/// refusal comes back as the second element of the tuple, with the empty shape
/// beside it.
pub fn load_library(
    door: &dyn PageDoor,
    limit: Option<i64>,
) -> KitResult<(LibraryData, Option<Denial>)> {
    let window = window_of(limit);
    match library_body(door, window) {
        Err(KitError::Door(message)) => Ok((
            LibraryData {
                window,
                ..LibraryData::default()
            },
            Some(denial(message)),
        )),
        other => Ok((other?, None)),
    }
}

fn library_body(door: &dyn PageDoor, window: usize) -> KitResult<LibraryData> {
    let recent = read_window(door, &recent_statement(), window)?;
    let pinned = pinned_ids(door)?;
    let pinned_ids_list: Vec<String> = pinned.iter().cloned().collect();
    let pinned_rows = Read {
        name: "notes.library.pinned_notes",
        table: "entity",
        select: ENTITY_COLUMNS,
        order: ("id", "id"),
        column: "id",
    }
    .of(
        door,
        &pinned_ids_list,
        Some(("kind = ? AND deleted_at IS NULL", note_kind())),
    )?;
    let trashed = door.page(&trash_statement(), &PageRequest::first(SHELF_ROWS))?;
    let memos: BTreeSet<String> = read_memo_ids(door)?.into_iter().collect();
    let books = notebooks(door)?;

    // MEASURED PRE-EXCLUSION ON PURPOSE (#834): the window is what the vault
    // returned, so `notes` may hold fewer rows than `window` while this is true.
    let truncated = recent.filled;

    // Recent, then pinned (the shelf's own order), then trashed; deduplicated.
    let mut ids: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for row in recent
        .rows
        .iter()
        .chain(pinned_rows.iter().take(SHELF_ROWS))
        .chain(trashed.rows.iter())
    {
        if let Some(id) = text_of(row, "id")
            && !memos.contains(&id)
            && seen.insert(id.clone())
        {
            ids.push(id);
        }
    }
    if ids.is_empty() {
        return Ok(LibraryData {
            notebooks: books,
            truncated,
            window,
            ..LibraryData::default()
        });
    }

    let notes = note_rows(door, &ids)?;
    let mut tags = tags_of(door, &ids)?;
    let mut attachments = centraid_apps_kit::attached::of(door, &ids)?;
    let (mut references, mut backlinks) = links_of(door, &ids)?;

    let mut facets: BTreeMap<String, String> = BTreeMap::new();
    let mut rows: Vec<LibraryRow> = ids
        .iter()
        .filter_map(|id| notes.get(id))
        .map(|note| {
            let chips = tags.remove(&note.id).unwrap_or_default();
            facets.extend(
                chips
                    .iter()
                    .map(|chip| (chip.concept_id.clone(), chip.label.clone())),
            );
            let (notebook_ids, notebook_names) = notebook_names(&books, note);
            LibraryRow {
                note_id: note.id.clone(),
                title: Some(note.title.clone()),
                format: Some(note.format.clone()),
                pinned: pinned.contains(&note.id),
                created_at: Some(note.created_at.clone()),
                updated_at: Some(note.updated_at.clone()),
                deleted_at: note.deleted_at.clone(),
                purge_at: note.purge_at.clone(),
                preview: preview_of(&note.body),
                check: check_of(&note.body),
                notebook_ids,
                notebook_names,
                attachments: attachments.remove(&note.id).unwrap_or_default(),
                references: references.remove(&note.id).unwrap_or_default(),
                backlinks: backlinks.remove(&note.id).unwrap_or_default(),
                tags: chips,
            }
        })
        .collect();
    // Pinned first, then newest. STABLE, so ties keep the read order above.
    rows.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });
    let mut all_tags: Vec<TagFacet> = facets
        .into_iter()
        .map(|(concept_id, label)| TagFacet { concept_id, label })
        .collect();
    all_tags.sort_by(|left, right| left.label.cmp(&right.label));

    let (trash, notes): (Vec<LibraryRow>, Vec<LibraryRow>) =
        rows.into_iter().partition(|row| row.deleted_at.is_some());
    Ok(LibraryData {
        notes,
        trash,
        notebooks: books,
        tags: all_tags,
        truncated,
        window,
    })
}

// ---------------------------------------------------------------------------
// `note`
// ---------------------------------------------------------------------------

/// One note's body — the editor's on-open pull.
///
/// **THIS IS THE BY-ID DOOR, AND IT DOES NO MEMO READ** (D-1020-N3). A memo is
/// excluded from the library, search and the powerbox and **reachable here**,
/// because the People screen opens one. The asymmetry is the absence of a
/// filter in this function.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is the tuple's second element.
pub fn load_note(door: &dyn PageDoor, note_id: &str) -> KitResult<(NoteData, Option<Denial>)> {
    let note_id = note_id.trim().to_owned();
    let empty = || NoteData {
        note_id: note_id.clone(),
        ..NoteData::default()
    };
    if note_id.is_empty() {
        return Ok((empty(), None));
    }
    settle(read_note(door, &note_id).map(|found| {
        found.map_or_else(empty, |note| NoteData {
            note_id: note.id,
            body: note.body,
            format: Some(note.format),
        })
    }))
}

// ---------------------------------------------------------------------------
// `search`
// ---------------------------------------------------------------------------

/// Full-text note search: the ranked hits in the library row shape, plus the
/// index's own snippet.
///
/// The FTS door does the matching, so this app never pulls the note table to
/// grep it. Memos drop out of the ranked hits **inside the door**, so no memo
/// body is previewed.
///
/// # Errors
///
/// The kit's own refusals. A search the door cannot run at all — a query with no
/// searchable words — answers the empty shape.
pub fn load_search(
    door: &dyn PageDoor,
    search: &dyn Search,
    principal: &Principal,
    term: &str,
) -> KitResult<(SearchData, Option<Denial>)> {
    let term = term.trim();
    if term.is_empty() {
        return Ok((SearchData::default(), None));
    }
    settle(search_body(door, search, principal, term))
}

fn search_body(
    door: &dyn PageDoor,
    search: &dyn Search,
    principal: &Principal,
    term: &str,
) -> KitResult<SearchData> {
    let request = SearchRequest::new("note", term, SEARCH_ROWS).excluding(read_memo_ids(door)?);
    let answer = match search.query(principal, &request) {
        Ok(answer) => answer,
        // A term of punctuation is not a refusal: the member typed `---`.
        Err(SearchError::NoSearchableWords { .. }) => return Ok(SearchData::default()),
        Err(SearchError::NotSearchable { kind, count }) => {
            return Err(KitError::Door(format!(
                "`{kind}` is not one of the {count} kinds the vault searches"
            )));
        }
        Err(other) => return Err(KitError::Door(other.to_string())),
    };
    let Answer::Data { page, .. } = answer else {
        return Err(KitError::Door(
            "the vault refused to search your notes".to_owned(),
        ));
    };
    if page.rows.is_empty() {
        return Ok(SearchData::default());
    }
    // VAULT ORDER IS RANK ORDER (best match first) — keep it.
    let ranked: Vec<(String, String)> = page
        .rows
        .iter()
        .map(|target| (target.id.clone(), target.snippet.clone()))
        .collect();
    let hit_ids: Vec<String> = ranked.iter().map(|(id, _)| id.clone()).collect();
    let notes = note_rows(door, &hit_ids)?;
    let pinned = pinned_ids(door)?;
    let books = notebooks(door)?;
    let mut attachments = centraid_apps_kit::attached::of(door, &hit_ids)?;
    Ok(SearchData {
        notes: ranked
            .into_iter()
            .filter_map(|(id, snippet)| {
                let note = notes.get(&id)?;
                let (notebook_ids, notebook_names) = notebook_names(&books, note);
                Some(SearchRow {
                    title: Some(note.title.clone()),
                    format: Some(note.format.clone()),
                    pinned: pinned.contains(&id),
                    created_at: Some(note.created_at.clone()),
                    updated_at: Some(note.updated_at.clone()),
                    preview: preview_of(&note.body),
                    check: check_of(&note.body),
                    notebook_ids,
                    notebook_names,
                    attachments: attachments.remove(&id).unwrap_or_default(),
                    snippet,
                    note_id: id,
                })
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// `history`
// ---------------------------------------------------------------------------

/// The note's words, newest first: the current ones, then each version they
/// replaced.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is the tuple's second element.
pub fn load_history(
    door: &dyn PageDoor,
    note_id: &str,
) -> KitResult<(HistoryData, Option<Denial>)> {
    if note_id.is_empty() {
        return Ok((HistoryData::default(), None));
    }
    settle(history_body(door, note_id))
}

fn history_body(door: &dyn PageDoor, note_id: &str) -> KitResult<HistoryData> {
    let Some(note) = read_note(door, note_id)? else {
        return Ok(HistoryData::default());
    };
    let page = door.page(
        &revisions_statement(note_id),
        &PageRequest::first(HISTORY_ROWS),
    )?;
    // A revision is stamped when its words were REPLACED, so words became the
    // note's when the version before them was: the next older revision's stamp,
    // or the note's birth for the first.
    let stamps: Vec<String> = page
        .rows
        .iter()
        .map(|row| text_of(row, "at").unwrap_or_default())
        .collect();
    let mut versions = vec![Version {
        seq: 0,
        body: note.body,
        current: true,
        asserted_at: stamps
            .first()
            .cloned()
            .unwrap_or_else(|| note.created_at.clone()),
    }];
    for (index, row) in page.rows.iter().enumerate() {
        versions.push(Version {
            seq: integer_or_zero(row, "seq"),
            body: text_of(row, "body").unwrap_or_default(),
            current: false,
            asserted_at: stamps
                .get(index + 1)
                .cloned()
                .unwrap_or_else(|| note.created_at.clone()),
        });
    }
    Ok(HistoryData {
        versions,
        truncated: page.next.is_some(),
    })
}

// ---------------------------------------------------------------------------
// `journal`
// ---------------------------------------------------------------------------

/// The Journal place: the memos the library leaves out, read the other way
/// round (#834 R-journal). Live entries only, newest by `updated_at`.
///
/// # Errors
///
/// The kit's own refusals; a door's refusal is the tuple's second element.
pub fn load_journal(
    door: &dyn PageDoor,
    limit: Option<i64>,
) -> KitResult<(JournalData, Option<Denial>)> {
    let window = window_of(limit);
    match journal_body(door, window) {
        Err(KitError::Door(message)) => Ok((
            JournalData {
                window,
                ..JournalData::default()
            },
            Some(denial(message)),
        )),
        other => Ok((other?, None)),
    }
}

fn journal_body(door: &dyn PageDoor, window: usize) -> KitResult<JournalData> {
    let memos = read_memo_ids(door)?;
    let empty = JournalData {
        window,
        ..JournalData::default()
    };
    if memos.is_empty() {
        return Ok(empty);
    }
    let fragment = in_list("id", &memos)?;
    let mut bind = note_kind();
    bind.extend(fragment.bind);
    let entries = read_window(
        door,
        &PageQuery::new(
            "notes.journal.entries",
            ENTITY_COLUMNS,
            "entity",
            PageOrder::desc("updated_at", "id"),
        )
        .filter(
            &format!("kind = ? AND deleted_at IS NULL AND {}", fragment.sql),
            bind,
        ),
        window,
    )?;
    let notes = note_rows(door, &texts(&entries.rows, "id"))?;
    Ok(JournalData {
        entries: entries
            .rows
            .iter()
            .filter_map(|row| notes.get(&text_of(row, "id")?))
            .map(|note| JournalEntry {
                note_id: note.id.clone(),
                title: Some(note.title.clone()),
                format: Some(note.format.clone()),
                created_at: Some(note.created_at.clone()),
                updated_at: Some(note.updated_at.clone()),
                deleted_at: None,
                preview: preview_of(&note.body),
                check: check_of(&note.body),
            })
            .collect(),
        truncated: entries.filled,
        window,
    })
}

// ---------------------------------------------------------------------------
// `link-targets` — the powerbox
// ---------------------------------------------------------------------------

/// THE POWERBOX: one bounded probe per linkable kind, secret-free (Locker is not
/// indexed).
///
/// Each probe is **isolated**, so a kind the index refuses leaves its column
/// absent rather than emptying the sheet. The memo read rides inside the NOTE
/// probe, because that is the only kind it narrows.
///
/// # Errors
///
/// Only the memo read's own refusal, which fails closed: answering "no memos"
/// would leak them into the sheet.
pub fn load_link_targets(
    door: &dyn PageDoor,
    search: &dyn Search,
    principal: &Principal,
    term: &str,
) -> KitResult<(LinkTargetsData, Option<Denial>)> {
    let term = term.trim();
    if term.is_empty() {
        return Ok((LinkTargetsData::default(), None));
    }
    let memos = match read_memo_ids(door) {
        Ok(ids) => ids,
        Err(KitError::Door(message)) => {
            return Ok((LinkTargetsData::default(), Some(denial(message))));
        }
        Err(other) => return Err(other),
    };
    let mut targets: Vec<Target> = Vec::new();
    // ONE QUERY PER KIND, so each kind keeps its own column of the sheet.
    for kind in centraid_vault::commands::note::LINKABLE {
        let mut request = SearchRequest::new(kind.as_str(), term, LINK_TARGET_ROWS);
        if kind == centraid_vault::model::Kind::Note {
            request = request.excluding(memos.clone());
        }
        if let Ok(Answer::Data { page, .. }) = search.query(principal, &request) {
            targets.extend(page.rows);
        }
    }
    Ok((LinkTargetsData { targets }, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_clamps_exactly_as_the_manifest_declares() {
        assert_eq!(window_of(None), WINDOW_DEFAULT);
        assert_eq!(window_of(Some(0)), WINDOW_DEFAULT);
        assert_eq!(window_of(Some(1)), WINDOW_MIN);
        assert_eq!(window_of(Some(20)), WINDOW_MIN);
        assert_eq!(window_of(Some(500)), 500);
        assert_eq!(window_of(Some(2_000)), WINDOW_MAX);
        assert_eq!(window_of(Some(9_000)), WINDOW_MAX);
        assert_eq!(window_of(Some(-5)), WINDOW_DEFAULT);
    }

    #[test]
    fn the_shelves_order_on_a_not_null_column_each() {
        assert_eq!(recent_statement().order.sort_column, "updated_at");
        // The trash shelf orders by `deleted_at`, which is NULLABLE — and every
        // row it can return has it set, because the predicate says so. The kit's
        // refusal is about a CONTINUED page, and the shelf is one page.
        let trash = trash_statement();
        assert_eq!(trash.order.sort_column, "deleted_at");
        assert!(
            trash
                .r#where
                .as_deref()
                .is_some_and(|w| w.contains("deleted_at IS NOT NULL"))
        );
    }

    #[test]
    fn the_revisions_statement_is_scoped_to_one_note() {
        let statement = revisions_statement("note-1");
        assert_eq!(statement.r#where.as_deref(), Some("entity_id = ?"));
        assert_eq!(
            statement.bind,
            vec![PageBindValue::Text("note-1".to_owned())]
        );
    }
}
