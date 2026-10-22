//! DOCS' READS, over the model's own tables, one table at a time (#1135).
//!
//! A document is an `entity` of kind `document`; what it is lives on its
//! `document` row (the blob's hash, what the bytes are, the folder it is filed
//! in); a folder is a `container`; a star or a label is a `tagged` edge; a past
//! version is a `revision`; the words extracted from the bytes are the blob's
//! `text` derivative. The paged door's one shape is a keyset page of one table,
//! so a screen is a window of `entity` rows and then, for the ids it returned,
//! one bounded read of each table that decorates them.
//!
//! ## What the drive shows
//!
//! The drive is the newest `limit` documents by when they were made, trashed ones
//! included (the shelves cut them), plus the folders. The window is ordered by
//! `created_at` and not `updated_at`, so a star, a trash or a rename does not
//! move a document in or out of it. **A document that is
//! attached to something and filed in no folder shows only where it is
//! attached**: it is a receipt on a transaction or a file on an event, and
//! listing it at the drive's top level would put somebody else's paper in the
//! member's own cabinet. The exclusion runs after the window, so `truncated` is
//! the vault's own cursor and `documents` may hold fewer rows than `window`
//! while it is true. A document opens by id whatever it is attached to.
//!
//! The three shelves the window does not define (Trash, Starred, Recent) are read
//! for themselves ([`ShelfArm`], Q-1047-7), so a truncated window never cuts
//! them.
//!
//! ## What a version is
//!
//! The current bytes, then each `revision` newest first. A revision is the bytes
//! a replace put down, and its `at` is the instant the next bytes became current;
//! so a version became current when the one before it was replaced, and the
//! first when the document was made. A revision has a `seq`, and that number is
//! the version's number on the screen.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{
    FanOutBound, JOIN_FAN_OUT, PageDoor, Read, read_pages, read_window,
};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::Denial;

/// What the index and the door call a document.
pub const DOCUMENT_KIND: &str = "document";

/// The flag a star is: a `tagged` edge to this concept.
pub const STARRED: &str = "flag:starred";

/// The drive's window, as the manifest declares it.
pub const DRIVE_MIN: usize = 20;
pub const DRIVE_MAX: usize = 2_000;
pub const DRIVE_DEFAULT: usize = 200;

/// How many ranked hits `search` folds.
pub const SEARCH_LIMIT: usize = 100;

/// The newest versions a history draws.
pub const MAX_VERSIONS: usize = 500;

/// The activity rail's length.
pub const ACTIVITY_ROWS: usize = 100;

/// Pages one starred walk may take. A star is the owner's own gesture, so 8 x
/// 500 stars is a bound a member does not reach; past it the read says so rather
/// than answering short.
const STARRED_PAGES: usize = 8;

/// The fan-out a window of documents' decorations may walk.
const BOUND: FanOutBound = JOIN_FAN_OUT;

const ENTITY_COLUMNS: &str = "id, title, created_at, updated_at, deleted_at, purge_at";

fn text(value: &str) -> Vec<PageBindValue> {
    vec![PageBindValue::Text(value.to_owned())]
}

fn denial_of(message: String) -> Denial {
    Denial {
        code: None,
        message: Some(message),
        revoked_at: None,
    }
}

/// A loader's body, with a door's refusal answered as the denial beside the
/// empty shape instead of an `Err`.
fn guarded<T: Default>(body: impl FnOnce() -> KitResult<T>) -> KitResult<(T, Option<Denial>)> {
    match body() {
        Ok(value) => Ok((value, None)),
        Err(KitError::Door(message)) => Ok((T::default(), Some(denial_of(message)))),
        Err(other) => Err(other),
    }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/// The drive's window: documents, newest first, in the trash or not.
#[must_use]
pub fn window_statement() -> PageQuery {
    PageQuery::new(
        "docs.drive.window",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("created_at", "id"),
    )
    .filter("kind = ?", text(DOCUMENT_KIND))
}

/// The newest live documents by when they were made.
#[must_use]
pub fn recent_statement() -> PageQuery {
    PageQuery::new(
        "docs.shelf.recent",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("created_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", text(DOCUMENT_KIND))
}

/// The trash, newest first.
#[must_use]
pub fn trash_statement() -> PageQuery {
    PageQuery::new(
        "docs.shelf.trash",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("deleted_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NOT NULL", text(DOCUMENT_KIND))
}

/// Everything carrying the star, newest star first. A star outlives the trash,
/// and other kinds carry it too, so the entities these name are read after.
#[must_use]
pub fn starred_statement() -> PageQuery {
    PageQuery::new(
        "docs.shelf.starred",
        "from_id, to_id, created_at",
        "edge",
        PageOrder::desc("created_at", "from_id"),
    )
    .filter("rel = ? AND to_id = ?", {
        let mut bind = text("tagged");
        bind.extend(text(STARRED));
        bind
    })
}

/// This document's replaced bytes, newest first.
#[must_use]
pub fn revisions_statement(document_id: &str) -> PageQuery {
    PageQuery::new(
        "docs.history.revisions",
        "entity_id, seq, at, blob, media_type",
        "revision",
        PageOrder::desc("seq", "entity_id"),
    )
    .filter("entity_id = ?", text(document_id))
}

/// The commands that named this document, newest first: the journal is the
/// evidence of what was done to it, and a command names its subject as `id`, or
/// as an edge's two ends.
#[must_use]
pub fn activity_statement(document_id: &str) -> PageQuery {
    PageQuery::new(
        "docs.activity.journal",
        "seq, at, command",
        "journal",
        PageOrder::desc("seq", "seq"),
    )
    .filter(
        "outcome = ? AND (json_extract(input, '$.id') = ? OR json_extract(input, '$.from') = ? \
         OR json_extract(input, '$.to') = ?)",
        {
            let mut bind = text("executed");
            bind.extend(text(document_id));
            bind.extend(text(document_id));
            bind.extend(text(document_id));
            bind
        },
    )
}

/// The folders: live, and the `container` row each sits on.
fn folders_statement() -> PageQuery {
    PageQuery::new(
        "docs.folders",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", text("folder"))
}

// ---------------------------------------------------------------------------
// Rows and payloads
// ---------------------------------------------------------------------------

/// One folder, as the sidebar draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderRow {
    pub folder_id: String,
    pub name: Option<String>,
    /// `None` at the drive's top level.
    pub parent_id: Option<String>,
}

/// One free-form label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelEntry {
    /// The tag concept's id: the key a chip is drawn under.
    pub tag_id: String,
    pub label: String,
}

/// One drive row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentRow {
    pub document_id: String,
    /// The bytes' hash: what the head's bytes are called in the content store.
    pub content_id: String,
    pub title: Option<String>,
    /// `None` is "nothing says what these bytes are", never a default type.
    pub media_type: Option<String>,
    pub byte_size: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub folder_id: Option<String>,
    pub starred: bool,
    pub trashed: bool,
    /// When it went to the trash; `None` on a live row.
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    pub tags: Vec<LabelEntry>,
    /// The hit snippet, on a `search` row only.
    pub snippet: Option<String>,
}

/// What `drive` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DriveData {
    pub folders: Vec<FolderRow>,
    pub documents: Vec<DocumentRow>,
    /// Older documents exist beyond the window: the page's own cursor.
    pub truncated: bool,
    pub window: usize,
}

/// What `search` answers: the same rows, in rank order.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub documents: Vec<DocumentRow>,
}

/// One version, in the history rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRow {
    /// The version's number: a revision's `seq`, and the head's is one more.
    pub number: usize,
    pub content_id: String,
    pub media_type: Option<String>,
    pub byte_size: Option<i64>,
    pub current: bool,
    /// When these bytes became current.
    pub asserted_at: Option<String>,
}

/// What `history` answers, newest version first.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HistoryData {
    pub versions: Vec<VersionRow>,
}

/// One command on the activity rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityEvent {
    pub activity: Option<String>,
    pub occurred_at: Option<String>,
}

/// What `activity` answers. An empty list is honest: nothing has been done yet.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ActivityData {
    pub events: Vec<ActivityEvent>,
}

/// The drive's input, clamped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DriveInput {
    pub limit: Option<usize>,
}

impl DriveInput {
    /// The window this input asks for: a clamp, not a refusal, and a `0` falls
    /// back to the default rather than clamping up to the floor.
    #[must_use]
    pub fn window(self) -> usize {
        self.limit
            .filter(|limit| *limit != 0)
            .unwrap_or(DRIVE_DEFAULT)
            .clamp(DRIVE_MIN, DRIVE_MAX)
    }
}

// ---------------------------------------------------------------------------
// The decorations of a set of documents
// ---------------------------------------------------------------------------

/// Where a document is, and what its bytes are.
struct Held {
    blob: String,
    media_type: String,
    folder_id: Option<String>,
}

fn ids_of(rows: &[Row], column: &str) -> Vec<String> {
    rows.iter().filter_map(|row| text_of(row, column)).collect()
}

fn read_of(
    door: &dyn PageDoor,
    name: &'static str,
    table: &'static str,
    select: &'static str,
    column: &'static str,
    ids: &[String],
    extra: Option<(&str, Vec<PageBindValue>)>,
) -> KitResult<Vec<Row>> {
    Read {
        name,
        table,
        select,
        order: (column, column),
        column,
    }
    .within(BOUND, door, ids, extra)
}

/// The rows documents are, folded from their entities and the tables that hang
/// off them. `entities` keeps its order. A document that is attached to
/// something and filed nowhere is left out unless `with_attached_only`.
fn fold(
    door: &dyn PageDoor,
    entities: &[Row],
    snippets: &BTreeMap<String, String>,
    with_attached_only: bool,
) -> KitResult<Vec<DocumentRow>> {
    let ids = ids_of(entities, "id");
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let held: BTreeMap<String, Held> = read_of(
        door,
        "docs.rows.document",
        "document",
        "id, blob, media_type, folder_id",
        "id",
        &ids,
        None,
    )?
    .iter()
    .filter_map(|row| {
        Some((
            text_of(row, "id")?,
            Held {
                blob: text_of(row, "blob")?,
                media_type: text_of(row, "media_type").unwrap_or_default(),
                folder_id: text_of(row, "folder_id"),
            },
        ))
    })
    .collect();
    let hashes: Vec<String> = held.values().map(|held| held.blob.clone()).collect();
    let sizes: BTreeMap<String, i64> = read_of(
        door,
        "docs.rows.blob",
        "blob",
        "hash, size",
        "hash",
        &hashes,
        None,
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "hash")?, integer_or_zero(row, "size"))))
    .collect();
    let tag_edges = read_of(
        door,
        "docs.rows.tagged",
        "edge",
        "from_id, to_id",
        "from_id",
        &ids,
        Some(("rel = ?", text("tagged"))),
    )?;
    let mut concept_ids = ids_of(&tag_edges, "to_id");
    concept_ids.sort_unstable();
    concept_ids.dedup();
    let labels: BTreeMap<String, String> = read_of(
        door,
        "docs.rows.tags",
        "entity",
        "id, title",
        "id",
        &concept_ids,
        Some(("kind = ?", text("tag"))),
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect();
    let mut starred: BTreeSet<String> = BTreeSet::new();
    let mut tags: BTreeMap<String, Vec<LabelEntry>> = BTreeMap::new();
    for edge in &tag_edges {
        let (Some(from), Some(to)) = (text_of(edge, "from_id"), text_of(edge, "to_id")) else {
            continue;
        };
        if to == STARRED {
            starred.insert(from);
        } else if let Some(label) = labels.get(&to) {
            tags.entry(from).or_default().push(LabelEntry {
                tag_id: to,
                label: label.clone(),
            });
        }
    }
    let attached: BTreeSet<String> = if with_attached_only {
        BTreeSet::new()
    } else {
        ids_of(
            &read_of(
                door,
                "docs.rows.attached",
                "edge",
                "from_id, to_id",
                "to_id",
                &ids,
                Some(("rel = ?", text("attached"))),
            )?,
            "to_id",
        )
        .into_iter()
        .collect()
    };
    Ok(entities
        .iter()
        .filter_map(|entity| {
            let id = text_of(entity, "id")?;
            let held = held.get(&id)?;
            if held.folder_id.is_none() && attached.contains(&id) {
                return None;
            }
            Some(DocumentRow {
                content_id: held.blob.clone(),
                media_type: Some(held.media_type.clone()).filter(|kind| !kind.is_empty()),
                byte_size: sizes.get(&held.blob).copied(),
                folder_id: held.folder_id.clone(),
                starred: starred.contains(&id),
                trashed: text_of(entity, "deleted_at").is_some(),
                tags: tags.remove(&id).unwrap_or_default(),
                snippet: snippets.get(&id).cloned(),
                title: text_of(entity, "title"),
                created_at: text_of(entity, "created_at"),
                updated_at: text_of(entity, "updated_at"),
                deleted_at: text_of(entity, "deleted_at"),
                purge_at: text_of(entity, "purge_at"),
                document_id: id,
            })
        })
        .collect())
}

/// Every live folder, with its parent, by name.
fn read_folders(door: &dyn PageDoor) -> KitResult<Vec<FolderRow>> {
    let entities = read_pages(door, &folders_statement(), BOUND)?;
    let parents: BTreeMap<String, Option<String>> = read_of(
        door,
        "docs.folders.containers",
        "container",
        "id, parent_id",
        "id",
        &ids_of(&entities, "id"),
        None,
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "parent_id"))))
    .collect();
    let mut folders: Vec<FolderRow> = entities
        .iter()
        .filter_map(|row| {
            let folder_id = text_of(row, "id")?;
            Some(FolderRow {
                parent_id: parents.get(&folder_id).cloned().flatten(),
                name: text_of(row, "title"),
                folder_id,
            })
        })
        .collect();
    folders.sort_by(|left, right| {
        left.name
            .as_deref()
            .unwrap_or_default()
            .cmp(right.name.as_deref().unwrap_or_default())
            .then_with(|| left.folder_id.cmp(&right.folder_id))
    });
    Ok(folders)
}

// ---------------------------------------------------------------------------
// `drive`
// ---------------------------------------------------------------------------

/// `drive`: the folders and the newest `limit` documents.
pub fn load_drive(
    door: &dyn PageDoor,
    input: DriveInput,
) -> KitResult<(DriveData, Option<Denial>)> {
    let window = input.window();
    let (mut data, denial) = guarded(|| {
        let folders = read_folders(door)?;
        let newest = read_window(door, &window_statement(), window)?;
        let documents = fold(door, &newest.rows, &BTreeMap::new(), false)?;
        Ok(DriveData {
            folders,
            documents,
            truncated: newest.filled,
            window,
        })
    })?;
    data.window = window;
    Ok((data, denial))
}

// ---------------------------------------------------------------------------
// The three shelves that read for themselves (Q-1047-7)
// ---------------------------------------------------------------------------

/// A shelf that is cut from its own read when the drive's window is truncated.
///
/// The window is the newest `limit` documents made, and these three are not
/// defined by when a document was made: Trash is whatever was trashed, Starred
/// whatever the member starred, Recent the newest *made*. Cut from the window they
/// would inherit its cut, so each reads its own set and the window keeps only the
/// two shelves it defines, All and Folders.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShelfArm {
    Trash,
    Starred,
    Recent,
}

/// What an arm found: its rows, folded as the drive folds them, and whether more
/// exist beyond them.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ArmData {
    pub documents: Vec<DocumentRow>,
    pub filled: bool,
}

/// How many rows an arm holds, read without decorating any of them. `filled`
/// makes `rows` a floor: the arm stopped at its window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ArmCount {
    pub rows: usize,
    pub filled: bool,
}

/// The live starred documents, newest star first, up to `rows`.
///
/// A star survives the trash and other kinds carry it, so the first `rows` stars
/// may name none that is a live document: the walk goes on until `rows + 1` live
/// ones are found (the extra one proves the shelf is longer) or the stars run out.
fn starred_rows(door: &dyn PageDoor, rows: usize) -> KitResult<(Vec<Row>, bool)> {
    let query = starred_statement();
    let mut found: Vec<Row> = Vec::new();
    let mut after = None;
    for _ in 0..STARRED_PAGES {
        let page = door.page(
            &query,
            &PageRequest {
                limit: centraid_apps_kit::page::MAX_PAGE_ROWS,
                after: after.clone(),
            },
        )?;
        let ids = ids_of(&page.rows, "from_id");
        let live = read_of(
            door,
            "docs.shelf.starred.entities",
            "entity",
            ENTITY_COLUMNS,
            "id",
            &ids,
            Some(("kind = ? AND deleted_at IS NULL", text(DOCUMENT_KIND))),
        )?;
        let by_id: BTreeMap<String, Row> = live
            .into_iter()
            .filter_map(|row| Some((text_of(&row, "id")?, row)))
            .collect();
        // Newest star first, the order the page came in.
        found.extend(ids.iter().filter_map(|id| by_id.get(id).cloned()));
        match page.next {
            Some(next) if found.len() <= rows => after = Some(next),
            Some(_) => break,
            None => return Ok((trim(found, rows), false)),
        }
    }
    let filled = found.len() > rows;
    Ok((trim(found, rows), filled))
}

fn trim(mut rows: Vec<Row>, to: usize) -> Vec<Row> {
    rows.truncate(to);
    rows
}

fn arm_entities(door: &dyn PageDoor, arm: ShelfArm, rows: usize) -> KitResult<(Vec<Row>, bool)> {
    let statement = match arm {
        ShelfArm::Starred => return starred_rows(door, rows),
        ShelfArm::Trash => trash_statement(),
        ShelfArm::Recent => recent_statement(),
    };
    let window = read_window(door, &statement, rows)?;
    Ok((window.rows, window.filled))
}

/// One arm's documents, folded as the drive folds them.
pub fn load_shelf_arm(
    door: &dyn PageDoor,
    arm: ShelfArm,
    rows: usize,
) -> KitResult<(ArmData, Option<Denial>)> {
    guarded(|| {
        let (entities, filled) = arm_entities(door, arm, rows)?;
        Ok(ArmData {
            documents: fold(door, &entities, &BTreeMap::new(), false)?,
            filled,
        })
    })
}

/// How many rows an arm holds, with none of them decorated.
pub fn count_shelf_arm(
    door: &dyn PageDoor,
    arm: ShelfArm,
    window: usize,
) -> KitResult<(ArmCount, Option<Denial>)> {
    guarded(|| {
        let (entities, filled) = arm_entities(door, arm, window)?;
        Ok(ArmCount {
            rows: entities.len(),
            filled,
        })
    })
}

// ---------------------------------------------------------------------------
// `search`
// ---------------------------------------------------------------------------

/// `search` from a TERM: the index's hits for documents, laid onto their rows in
/// rank order.
///
/// The index holds live documents only, which is why a trashed document never
/// matches. A term with no searchable word is an answer, no rows, and never an
/// error.
pub fn load_search_term(
    door: &dyn PageDoor,
    search: &dyn centraid_search::Search,
    principal: &centraid_search::Principal,
    term: &str,
    limit: usize,
) -> KitResult<(SearchData, Option<Denial>)> {
    let term = term.trim();
    if term.is_empty() || limit == 0 {
        return Ok((SearchData::default(), None));
    }
    let request = centraid_search::SearchRequest::new(DOCUMENT_KIND, term, limit.min(SEARCH_LIMIT));
    let page = match search.query(principal, &request) {
        Ok(centraid_search::Answer::Data { page, .. }) => page,
        Ok(centraid_search::Answer::Denied(denial)) => {
            return Ok((
                SearchData::default(),
                Some(Denial {
                    code: denial.code,
                    message: denial.message,
                    revoked_at: denial.revoked_at,
                }),
            ));
        }
        Err(centraid_search::SearchError::NoSearchableWords { .. }) => {
            return Ok((SearchData::default(), None));
        }
        Err(other) => return Ok((SearchData::default(), Some(denial_of(other.to_string())))),
    };
    if page.rows.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let ids: Vec<String> = page.rows.iter().map(|target| target.id.clone()).collect();
    let snippets: BTreeMap<String, String> = page
        .rows
        .iter()
        .map(|target| (target.id.clone(), target.snippet.clone()))
        .collect();
    guarded(|| {
        let mut entities: BTreeMap<String, Row> = read_of(
            door,
            "docs.search.entities",
            "entity",
            ENTITY_COLUMNS,
            "id",
            &ids,
            None,
        )?
        .into_iter()
        .filter_map(|row| Some((text_of(&row, "id")?, row)))
        .collect();
        // The rows come back in id order; the hit list's order is the rank.
        let ranked: Vec<Row> = ids.iter().filter_map(|id| entities.remove(id)).collect();
        Ok(SearchData {
            documents: fold(door, &ranked, &snippets, false)?
                .into_iter()
                // v0 ships "" rather than null for a hit with no snippet.
                .map(|mut row| {
                    row.snippet = Some(row.snippet.unwrap_or_default());
                    row
                })
                .collect(),
        })
    })
}

// ---------------------------------------------------------------------------
// `document`
// ---------------------------------------------------------------------------

/// What `document` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DocumentData {
    /// `None` when no such document exists: a state, not an error.
    pub row: Option<DocumentRow>,
    /// The folder chain from the top level down to the document's folder.
    pub path: Vec<FolderRow>,
    /// The words extracted from the head's bytes: `None` is "no text row", and
    /// `Some("")` is an empty text document.
    pub body: Option<String>,
}

/// The folder chain above `folder_id`, top level first. Capped at the number of
/// folders, so a cycle no command can write still terminates.
#[must_use]
pub fn folder_path(folders: &[FolderRow], folder_id: Option<&str>) -> Vec<FolderRow> {
    let mut path = Vec::new();
    let mut at = folder_id.map(str::to_owned);
    while let Some(id) = at {
        if path.len() > folders.len() {
            break;
        }
        let Some(folder) = folders.iter().find(|folder| folder.folder_id == id) else {
            break;
        };
        path.push(folder.clone());
        at = folder.parent_id.clone();
    }
    path.reverse();
    path
}

/// ONE document, as the reader, the viewer and the properties sheet draw it. The
/// same row the drive folds, found by id, so a document beyond the window, or one
/// search found, or one attached to an event, opens exactly as a browsed one does.
pub fn load_document(
    door: &dyn PageDoor,
    document_id: &str,
) -> KitResult<(DocumentData, Option<Denial>)> {
    if document_id.is_empty() {
        return Ok((DocumentData::default(), None));
    }
    guarded(|| {
        let ids = [document_id.to_owned()];
        let entities = read_of(
            door,
            "docs.document.entity",
            "entity",
            ENTITY_COLUMNS,
            "id",
            &ids,
            Some(("kind = ?", text(DOCUMENT_KIND))),
        )?;
        let Some(row) = fold(door, &entities, &BTreeMap::new(), true)?
            .into_iter()
            .next()
        else {
            return Ok(DocumentData::default());
        };
        let folders = read_folders(door)?;
        let body = read_of(
            door,
            "docs.document.body",
            "derivative",
            "blob, text",
            "blob",
            std::slice::from_ref(&row.content_id),
            Some(("variant = ?", text("text"))),
        )?
        .iter()
        .find_map(|derived| text_of(derived, "text"));
        Ok(DocumentData {
            path: folder_path(&folders, row.folder_id.as_deref()),
            row: Some(row),
            body,
        })
    })
}

// ---------------------------------------------------------------------------
// `history` and `activity`
// ---------------------------------------------------------------------------

/// `history`: the head's bytes, then each version a replace put down, newest
/// first.
pub fn load_history(
    door: &dyn PageDoor,
    document_id: &str,
) -> KitResult<(HistoryData, Option<Denial>)> {
    if document_id.is_empty() {
        return Ok((HistoryData::default(), None));
    }
    guarded(|| {
        let ids = [document_id.to_owned()];
        let made = read_of(
            door,
            "docs.history.entity",
            "entity",
            "id, created_at",
            "id",
            &ids,
            Some(("kind = ?", text(DOCUMENT_KIND))),
        )?;
        let Some(created_at) = made.first().and_then(|row| text_of(row, "created_at")) else {
            return Ok(HistoryData::default());
        };
        let head = read_of(
            door,
            "docs.history.document",
            "document",
            "id, blob, media_type",
            "id",
            &ids,
            None,
        )?;
        let Some(head) = head.first() else {
            return Ok(HistoryData::default());
        };
        let revisions = read_window(door, &revisions_statement(document_id), MAX_VERSIONS)?.rows;
        let mut hashes = ids_of(&revisions, "blob");
        hashes.extend(text_of(head, "blob"));
        hashes.sort_unstable();
        hashes.dedup();
        let sizes: BTreeMap<String, i64> = read_of(
            door,
            "docs.history.blobs",
            "blob",
            "hash, size",
            "hash",
            &hashes,
            None,
        )?
        .iter()
        .filter_map(|row| Some((text_of(row, "hash")?, integer_or_zero(row, "size"))))
        .collect();
        // A version became current when the one before it was replaced; the
        // revision `at` is that instant for the NEXT version, so shift by one.
        let replaced_at: BTreeMap<i64, String> = revisions
            .iter()
            .filter_map(|row| Some((row.get("seq")?.integer()?, text_of(row, "at")?)))
            .collect();
        let became_current = |seq: i64| {
            if seq <= 1 {
                Some(created_at.clone())
            } else {
                replaced_at.get(&(seq - 1)).cloned()
            }
        };
        let newest = revisions
            .iter()
            .filter_map(|row| row.get("seq").and_then(|cell| cell.integer()))
            .max()
            .unwrap_or(0);
        let current_blob = text_of(head, "blob").unwrap_or_default();
        let mut versions = vec![VersionRow {
            number: usize::try_from(newest + 1).unwrap_or(1),
            byte_size: sizes.get(&current_blob).copied(),
            content_id: current_blob,
            media_type: text_of(head, "media_type"),
            current: true,
            asserted_at: became_current(newest + 1),
        }];
        for row in &revisions {
            let Some(seq) = row.get("seq").and_then(|cell| cell.integer()) else {
                continue;
            };
            let blob = text_of(row, "blob").unwrap_or_default();
            versions.push(VersionRow {
                number: usize::try_from(seq).unwrap_or(1),
                byte_size: sizes.get(&blob).copied(),
                content_id: blob,
                media_type: text_of(row, "media_type"),
                current: false,
                asserted_at: became_current(seq),
            });
        }
        Ok(HistoryData { versions })
    })
}

/// `activity`: what was done to this document, newest first.
pub fn load_activity(
    door: &dyn PageDoor,
    document_id: &str,
) -> KitResult<(ActivityData, Option<Denial>)> {
    if document_id.is_empty() {
        return Ok((ActivityData::default(), None));
    }
    guarded(|| {
        let rows = read_window(door, &activity_statement(document_id), ACTIVITY_ROWS)?.rows;
        Ok(ActivityData {
            events: rows
                .iter()
                .map(|row| ActivityEvent {
                    activity: text_of(row, "command"),
                    occurred_at: text_of(row, "at"),
                })
                .collect(),
        })
    })
}

/// The statements this module owns, named so a plan snapshot can be compared
/// against one list.
#[must_use]
pub fn statement_names() -> Vec<&'static str> {
    let mut names = vec![
        "docs.drive.window",
        "docs.shelf.recent",
        "docs.shelf.starred",
        "docs.shelf.trash",
        "docs.history.revisions",
        "docs.activity.journal",
        "docs.folders",
    ];
    names.sort_unstable();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A CLAMP, NOT A REFUSAL, and a `0` limit falls back to the default.
    #[test]
    fn the_drive_window_clamps_the_way_v0_clamps() {
        assert_eq!(DriveInput { limit: None }.window(), DRIVE_DEFAULT);
        assert_eq!(DriveInput { limit: Some(0) }.window(), DRIVE_DEFAULT);
        assert_eq!(DriveInput { limit: Some(1) }.window(), DRIVE_MIN);
        assert_eq!(DriveInput { limit: Some(500) }.window(), 500);
        assert_eq!(DriveInput { limit: Some(9_999) }.window(), DRIVE_MAX);
    }

    #[test]
    fn a_folder_path_runs_from_the_top_and_a_cycle_terminates() {
        let folder = |id: &str, parent: Option<&str>| FolderRow {
            folder_id: id.to_owned(),
            name: Some(id.to_owned()),
            parent_id: parent.map(str::to_owned),
        };
        let folders = [
            folder("a", None),
            folder("b", Some("a")),
            folder("c", Some("b")),
        ];
        let path = folder_path(&folders, Some("c"));
        assert_eq!(
            path.iter()
                .map(|f| f.folder_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        let cycle = [folder("x", Some("y")), folder("y", Some("x"))];
        assert!(folder_path(&cycle, Some("x")).len() <= 3);
        assert!(folder_path(&folders, None).is_empty());
    }

    #[test]
    fn every_statement_this_module_names_is_one_it_builds() {
        let built = [
            window_statement().name,
            recent_statement().name,
            starred_statement().name,
            trash_statement().name,
            revisions_statement("d").name,
            activity_statement("d").name,
            folders_statement().name,
        ];
        let mut expected: Vec<String> = built.to_vec();
        expected.sort();
        let named: Vec<String> = statement_names().into_iter().map(str::to_owned).collect();
        assert_eq!(named, expected);
    }
}
