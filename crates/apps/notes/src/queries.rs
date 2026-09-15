//! THE SIX QUERIES: `library`, `note`, `search`, `history`, `journal`,
//! `link-targets`.
//!
//! `queries/library.ts` is the one to read first (575 lines). Its doctrine, in
//! its own words: *"The notes projection as a BOUNDED recent window (#262):
//! newest by updated_at plus every pinned note, never the whole table;
//! `truncated` tells the UI to offer a wider one. People-journal entries are
//! EXCLUDED (#834 R-journal) — they must never reach the library, the trash
//! shelf, or the tag chips derived from it, though opening one by id still
//! works. A consent denial is a first-class outcome, not an error."*
//!
//! ## The three reads that DISCOVER notes, and the ten that decorate them
//!
//! | Read | What it is |
//! |---|---|
//! | `notes.library.recent` | the window: newest `updated_at` first, sized by the caller |
//! | `notes.library.pinned` | **beside** the window, not out of it: a pin survives the note ageing out |
//! | `notes.library.trash` | the trash shelf, newest `deleted_at` first |
//!
//! Everything below — placements, attachments, links, backlinks, tags,
//! concepts, anchors, content rows, representations and the reference cards —
//! is `IN`-bounded by ids one of those three already returned (#272).
//!
//! ## `truncated` IS THE PAGE'S OWN CURSOR, AND IT IS MEASURED PRE-EXCLUSION
//!
//! `rows.len() >= window` cannot tell a window that filled exactly from one
//! that ran out. And the window is what the VAULT returned, so `notes` may hold
//! fewer rows than `window` while `truncated` is true — the journal exclusion
//! runs after (`library.ts:459`-`:463`).
//!
//! ## The declared window is WALKED, not clamped (D-1020-D3-12)
//!
//! v0 asks for its 2,000-row window as ONE page and takes `.rows`, and
//! `MAX_PAGE_ROWS` clamps a page to 500 — so a v0 library at `limit: 2000`
//! reads **500 notes while declaring 2,000**. [`load_library`] walks it with
//! [`read_window`]. The divergence is invisible under 500 notes (every parity
//! fixture) and is a named row in this lane's receipt with the year-3 number.
//!
//! ## Two divergences from v0's own `search`, both narrowings
//!
//! 1. **The FTS door answers TARGETS, not rows.** v0's `ctx.vault.search`
//!    returns the whole `knowledge_note` row through the index join; this port
//!    takes ids in rank order from [`centraid_search`] and reads the note rows
//!    through the paged door. A search result therefore cannot carry a column
//!    the door would not have served (D-1020-N1).
//! 2. **The snippet comes from the door**, which is where the index is. Same
//!    value, one owner.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{
    JOIN_FAN_OUT, PageDoor, in_list, read_by_id, read_pages, read_window,
};
use centraid_apps_kit::representations::{RepresentationIndex, read_representations};
use centraid_apps_kit::row::{Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_search::{Answer, Principal, Search, SearchError, SearchRequest, Target};

use crate::cards::{CardDoor, Ref, RefCard};
use crate::derive::{CheckTally, check_of, decode_note_body, preview_of};
use crate::journal::read_journal_note_ids;
use crate::version_chain::{Occurrence, VersionChainError, note_version_chain};
use crate::{Denial, MAX_CHAIN_STEPS};

/// The note wrapper's logical entity type, in one place.
pub const NOTE_TARGET_TYPE: &str = "knowledge.note";

/// The `library` and `journal` window, as the manifest declares it.
pub const WINDOW_MIN: usize = 20;
pub const WINDOW_MAX: usize = 2_000;
/// v0's `Number(input?.limit) || 200` (`library.ts:184`).
pub const WINDOW_DEFAULT: usize = 200;

/// The pinned and trash shelves are what the screen shows, so that is the read
/// (`library.ts:182`).
pub const SHELF_ROWS: usize = 200;

/// How many ranked hits `search` folds (`search.ts:157`).
pub const SEARCH_ROWS: usize = 100;

/// How many targets one powerbox probe returns per domain
/// (`queries/link-targets.ts:17`).
pub const LINK_TARGET_ROWS: usize = 8;

/// One note row, as all three of the library's windows project it
/// (`library.ts:178`-`:180`).
const NOTE_COLUMNS: &str = "note_id, title, format, pinned, body_content_id, created_at, \
                            updated_at, deleted_at, purge_at";

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

/// One attachment, as the shared projection ships it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub attachment_id: String,
    pub content_id: String,
    pub role: Option<String>,
    pub is_primary: i64,
    /// The ATTACHMENT's own reading of the bytes (#996 R20(b)), falling back to
    /// the oldest reading of them and then to the honest default.
    pub media_type: String,
    pub content_uri: String,
    pub byte_size: i64,
}

/// One tag edge on a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagChip {
    pub tag_id: String,
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
    pub link_id: String,
    /// The standoff selector, shipped as data: **resolving it is presentation**
    /// (#282). An unreadable selector is just an unanchored reference.
    pub selector: Option<serde_json::Value>,
    pub card: RefCard,
}

/// A reference INTO a note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BacklinkEntry {
    pub link_id: String,
    pub card: RefCard,
}

/// A notebook, which is a `core_collection` (#274).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notebook {
    pub notebook_id: String,
    pub name: Option<String>,
    pub sort_order: i64,
}

/// One library row: a preview and a tally, never a body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibraryRow {
    pub note_id: String,
    pub title: Option<String>,
    pub format: Option<String>,
    pub pinned: i64,
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
    pub pinned: i64,
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
    pub content_id: String,
    pub body: String,
    pub media_type: Option<String>,
    /// A POSITION, never a stored flag: index 0 of the walk.
    pub current: bool,
    pub asserted_at: String,
}

/// What `history` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryData {
    pub versions: Vec<Version>,
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

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

/// The window: live notes, newest `updated_at` first.
#[must_use]
pub fn recent_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.recent",
        NOTE_COLUMNS,
        "knowledge_note",
        PageOrder::desc("updated_at", "note_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// Every pinned note, read BESIDE the window: a pin survives the note ageing
/// out (`library.ts:190`).
#[must_use]
pub fn pinned_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.pinned",
        NOTE_COLUMNS,
        "knowledge_note",
        PageOrder::desc("updated_at", "note_id"),
    )
    .filter(
        "pinned = ? AND deleted_at IS NULL",
        vec![PageBindValue::Integer(1)],
    )
}

/// The trash shelf, newest `deleted_at` first.
#[must_use]
pub fn trash_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.trash",
        NOTE_COLUMNS,
        "knowledge_note",
        PageOrder::desc("deleted_at", "note_id"),
    )
    .filter("deleted_at IS NOT NULL", Vec::new())
}

/// Notebooks. Owner-curated and small, so a WALK with a stated ceiling rather
/// than a window (`library.ts:236`).
#[must_use]
pub fn notebooks_statement() -> PageQuery {
    PageQuery::new(
        "notes.library.notebooks",
        "collection_id, name, sort_order",
        "core_collection",
        PageOrder::asc("collection_id", "collection_id"),
    )
}

/// One note's row, by id. The editor's on-open pull reads three columns.
fn note_row(door: &dyn PageDoor, note_id: &str) -> KitResult<Option<Row>> {
    read_by_id(
        door,
        "notes.note.row",
        "note_id, body_content_id, format",
        "knowledge_note",
        "note_id",
        note_id,
    )
}

/// This note's occurrences, newest first. **The chain's own length is the
/// window**: `MAX_CHAIN_STEPS` caps a malformed chain and a well-formed one
/// terminates on a null parent long before it (`history.ts:49`).
#[must_use]
pub fn revisions_statement(note_id: &str) -> PageQuery {
    PageQuery::new(
        "notes.history.revisions",
        "revision_id, entity_type, entity_id, content_id, parent_revision_id, recorded_at",
        "core_entity_revision",
        PageOrder::desc("recorded_at", "revision_id"),
    )
    .filter(
        "entity_type = ? AND entity_id = ?",
        vec![
            PageBindValue::Text(NOTE_TARGET_TYPE.to_owned()),
            PageBindValue::Text(note_id.to_owned()),
        ],
    )
}

/// A bounded read over one `IN` list.
fn bounded(
    door: &dyn PageDoor,
    name: &str,
    select: &str,
    from: &str,
    order_column: &str,
    predicate: &str,
    bind: Vec<PageBindValue>,
) -> KitResult<Vec<Row>> {
    read_pages(
        door,
        &PageQuery::new(
            name,
            select,
            from,
            PageOrder::asc(order_column, order_column),
        )
        .filter(predicate, bind),
        JOIN_FAN_OUT,
    )
}

/// One note-scoped join: where its rows live, and which two columns carry the
/// polymorphic reference.
struct NoteScoped {
    name: &'static str,
    select: &'static str,
    from: &'static str,
    order_column: &'static str,
    /// The column holding `knowledge.note`.
    type_column: &'static str,
    /// The column holding the note id.
    id_column: &'static str,
    /// Anything the join adds beyond the reference, e.g. ` AND valid_to IS NULL`.
    extra: &'static str,
}

/// `target_type = ? AND <column> IN (…)`, the shape six of the joins take.
fn note_scoped(door: &dyn PageDoor, join: &NoteScoped, note_ids: &[String]) -> KitResult<Vec<Row>> {
    let fragment = in_list(join.id_column, note_ids)?;
    let mut bind = vec![PageBindValue::Text(NOTE_TARGET_TYPE.to_owned())];
    bind.extend(fragment.bind);
    bounded(
        door,
        join.name,
        join.select,
        join.from,
        join.order_column,
        &format!(
            "{} = ? AND {}{}",
            join.type_column, fragment.sql, join.extra
        ),
        bind,
    )
}

/// The six note-scoped joins, named once so the two callers cannot drift.
const PLACEMENTS: NoteScoped = NoteScoped {
    name: "notes.library.placements",
    select: "entry_id, target_type, target_id, collection_id",
    from: "core_collection_entry",
    order_column: "entry_id",
    type_column: "target_type",
    id_column: "target_id",
    extra: "",
};
const ATTACHMENTS: NoteScoped = NoteScoped {
    name: "notes.library.attachments",
    select: "attachment_id, target_type, target_id, content_id, role, is_primary",
    from: "core_attachment",
    order_column: "attachment_id",
    type_column: "target_type",
    id_column: "target_id",
    extra: "",
};
const LINKS: NoteScoped = NoteScoped {
    name: "notes.library.links",
    select: "link_id, from_type, from_id, to_type, to_id",
    from: "core_link",
    order_column: "link_id",
    type_column: "from_type",
    id_column: "from_id",
    extra: " AND valid_to IS NULL",
};
const BACKLINKS: NoteScoped = NoteScoped {
    name: "notes.library.backlinks",
    select: "link_id, from_type, from_id, to_type, to_id",
    from: "core_link",
    order_column: "link_id",
    type_column: "to_type",
    id_column: "to_id",
    extra: " AND valid_to IS NULL",
};
const TAGS: NoteScoped = NoteScoped {
    name: "notes.library.tags",
    select: "tag_id, target_type, target_id, concept_id",
    from: "core_tag",
    order_column: "tag_id",
    type_column: "target_type",
    id_column: "target_id",
    extra: "",
};
const SEARCH_PLACEMENTS: NoteScoped = NoteScoped {
    name: "notes.search.placements",
    ..PLACEMENTS
};
const SEARCH_ATTACHMENTS: NoteScoped = NoteScoped {
    name: "notes.search.attachments",
    ..ATTACHMENTS
};

// ---------------------------------------------------------------------------
// `library`
// ---------------------------------------------------------------------------

/// The library: a bounded recent window plus **every** pinned note, the trash
/// shelf, the notebooks and the tag chips the window saw.
///
/// # Errors
///
/// The kit's own refusals — a fan-out past its cap, an empty `IN` list. A
/// consent DENIAL is not one of those: it comes back as the second element of
/// the tuple, with the empty shape beside it.
pub fn load_library(
    door: &dyn PageDoor,
    cards: &dyn CardDoor,
    limit: Option<i64>,
) -> KitResult<(LibraryData, Option<Denial>)> {
    let window = window_of(limit);
    match library_body(door, cards, window) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((
            // v0's catch answers `{notes: [], trash: [], notebooks: [],
            // vaultDenied}` — and NOT `tags`, `truncated` or `window`
            // (`library.ts:471`-`:479`). The port ships the whole empty shape
            // because a missing field is a silent `undefined` on the wire.
            LibraryData {
                window,
                ..LibraryData::default()
            },
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "one fold, one reading order — the three discovering reads and the ten that decorate them, as v0 lays them out"
)]
fn library_body(
    door: &dyn PageDoor,
    cards: &dyn CardDoor,
    window: usize,
) -> KitResult<LibraryData> {
    let recent = read_window(door, &recent_statement(), window)?;
    let pinned = door.page(&pinned_statement(), &PageRequest::first(SHELF_ROWS))?;
    let trashed = door.page(&trash_statement(), &PageRequest::first(SHELF_ROWS))?;
    let notebook_rows = read_pages(door, &notebooks_statement(), JOIN_FAN_OUT)?;
    let journal_ids = read_journal_note_ids(door)?;

    // MEASURED PRE-EXCLUSION ON PURPOSE (#834): the window is what the vault
    // returned, so `notes` may hold fewer rows than `window` while this is
    // true. The page's own cursor says it, rather than a row count that cannot
    // tell a window that filled exactly from one that ran out.
    let truncated = recent.filled;

    // A collection may also hold photos and documents; this surface renders
    // notes. `sort_order` is nullable, so the SORT is in memory and the READ is
    // by the primary key — the kit refuses a continued page over a nullable
    // column (D-1020-D3-10), and this walk continues.
    let mut books: Vec<Notebook> = notebook_rows
        .iter()
        .filter_map(|row| {
            Some(Notebook {
                notebook_id: text_of(row, "collection_id")?,
                name: text_of(row, "name"),
                sort_order: integer_or_zero(row, "sort_order"),
            })
        })
        .collect();
    books.sort_by_key(|notebook| notebook.sort_order);

    // The union, in v0's own insertion order: recent, then pinned, then
    // trashed. The final sort is STABLE, so ties fall back to this order and a
    // map keyed by id would answer a different page.
    let mut windowed: Vec<Row> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for row in recent
        .rows
        .into_iter()
        .chain(pinned.rows)
        .chain(trashed.rows)
    {
        let Some(note_id) = text_of(&row, "note_id") else {
            continue;
        };
        // JOURNAL IDS MUST NEVER REACH THE JOINS BELOW (#834 R-journal).
        if journal_ids.contains(&note_id) || !seen.insert(note_id) {
            continue;
        }
        windowed.push(row);
    }
    if windowed.is_empty() {
        return Ok(LibraryData {
            notebooks: books,
            truncated,
            window,
            ..LibraryData::default()
        });
    }
    let note_ids: Vec<String> = windowed
        .iter()
        .filter_map(|row| text_of(row, "note_id"))
        .collect();

    let placements = note_scoped(door, &PLACEMENTS, &note_ids)?;
    let attachment_rows = note_scoped(door, &ATTACHMENTS, &note_ids)?;
    let link_rows = note_scoped(door, &LINKS, &note_ids)?;
    let backlink_rows = note_scoped(door, &BACKLINKS, &note_ids)?;
    let tag_rows = note_scoped(door, &TAGS, &note_ids)?;

    // RE-NARROWED IN MEMORY: tag→concept→chip is where a journal-only concept
    // would leak back in, so the exclusion is enforced here, not trusted
    // (`library.ts:317`-`:319`).
    let surviving: BTreeSet<&String> = note_ids.iter().collect();
    let tags: Vec<&Row> = tag_rows
        .iter()
        .filter(|row| text_of(row, "target_id").is_some_and(|id| surviving.contains(&id)))
        .collect();
    let mut concept_ids: Vec<String> = tags
        .iter()
        .filter_map(|row| text_of(row, "concept_id"))
        .collect();
    concept_ids.sort_unstable();
    concept_ids.dedup();
    let concept_rows = if concept_ids.is_empty() {
        Vec::new()
    } else {
        let fragment = in_list("concept_id", &concept_ids)?;
        bounded(
            door,
            "notes.library.concepts",
            "concept_id, pref_label",
            "core_concept",
            "concept_id",
            &fragment.sql,
            fragment.bind,
        )?
    };
    // Same re-narrowing one link on: a read may answer wider than it was asked.
    let wanted: BTreeSet<&String> = concept_ids.iter().collect();
    let label_by_concept: BTreeMap<String, String> = concept_rows
        .iter()
        .filter_map(|row| {
            let concept_id = text_of(row, "concept_id")?;
            wanted
                .contains(&concept_id)
                .then(|| (concept_id, text_of(row, "pref_label").unwrap_or_default()))
        })
        .collect();
    let mut tags_by_note: BTreeMap<String, Vec<TagChip>> = BTreeMap::new();
    for row in &tags {
        let Some(target_id) = text_of(row, "target_id") else {
            continue;
        };
        let Some(concept_id) = text_of(row, "concept_id") else {
            continue;
        };
        tags_by_note.entry(target_id).or_default().push(TagChip {
            tag_id: text_of(row, "tag_id").unwrap_or_default(),
            label: label_by_concept
                .get(&concept_id)
                .cloned()
                // v0's `?? "?"`: a chip with no concept row still draws, and it
                // draws as unknown rather than as an empty label.
                .unwrap_or_else(|| "?".to_owned()),
            concept_id,
        });
    }
    let mut all_tags: Vec<TagFacet> = label_by_concept
        .iter()
        .map(|(concept_id, label)| TagFacet {
            concept_id: concept_id.clone(),
            label: label.clone(),
        })
        .collect();
    // `localeCompare` on the label. Non-ASCII labels are where a byte sort and
    // a locale sort diverge, which is why the parity manifest marks this case
    // `order: "set"` (the common brief's rule 5).
    all_tags.sort_by(|left, right| left.label.cmp(&right.label));

    // RESOLVABLE-IF-LINKED: no media or finance read scope is needed here, and
    // the decision is the card door's.
    let mut refs: Vec<Ref> = Vec::new();
    for row in &link_rows {
        if let (Some(entity), Some(id)) = (text_of(row, "to_type"), text_of(row, "to_id")) {
            let reference = Ref::new(entity, id);
            if !refs.contains(&reference) {
                refs.push(reference);
            }
        }
    }
    for row in &backlink_rows {
        if let (Some(entity), Some(id)) = (text_of(row, "from_type"), text_of(row, "from_id")) {
            let reference = Ref::new(entity, id);
            if !refs.contains(&reference) {
                refs.push(reference);
            }
        }
    }
    let resolved = if refs.is_empty() {
        Vec::new()
    } else {
        cards.resolve(&refs)?
    };
    let card_by_ref: BTreeMap<Ref, RefCard> = resolved
        .into_iter()
        .map(|card| (Ref::new(card.entity.clone(), card.id.clone()), card))
        .collect();

    // Standoff anchors (#282): ship the selector; resolving it is presentation.
    let link_ids: Vec<String> = link_rows
        .iter()
        .filter_map(|row| text_of(row, "link_id"))
        .collect();
    let anchor_rows = if link_ids.is_empty() {
        Vec::new()
    } else {
        let fragment = in_list("link_id", &link_ids)?;
        bounded(
            door,
            "notes.library.anchors",
            "anchor_id, link_id, selector_json",
            "core_link_anchor",
            "anchor_id",
            &fragment.sql,
            fragment.bind,
        )?
    };
    let selector_by_link: BTreeMap<String, serde_json::Value> = anchor_rows
        .iter()
        .filter_map(|row| {
            let link_id = text_of(row, "link_id")?;
            let json = text_of(row, "selector_json")?;
            // An unreadable selector is just an unanchored reference.
            serde_json::from_str(&json)
                .ok()
                .map(|value| (link_id, value))
        })
        .collect();

    let mut references_by_note: BTreeMap<String, Vec<ReferenceEntry>> = BTreeMap::new();
    for row in &link_rows {
        let Some(from_id) = text_of(row, "from_id") else {
            continue;
        };
        let link_id = text_of(row, "link_id").unwrap_or_default();
        let reference = Ref::new(
            text_of(row, "to_type").unwrap_or_default(),
            text_of(row, "to_id").unwrap_or_default(),
        );
        references_by_note
            .entry(from_id)
            .or_default()
            .push(ReferenceEntry {
                selector: selector_by_link.get(&link_id).cloned(),
                card: card_by_ref.get(&reference).cloned().unwrap_or_else(|| {
                    RefCard::unresolved(
                        &reference.entity,
                        &reference.id,
                        crate::cards::CardStatus::Unknown,
                    )
                }),
                link_id,
            });
    }
    let mut backlinks_by_note: BTreeMap<String, Vec<BacklinkEntry>> = BTreeMap::new();
    for row in &backlink_rows {
        let Some(to_id) = text_of(row, "to_id") else {
            continue;
        };
        let reference = Ref::new(
            text_of(row, "from_type").unwrap_or_default(),
            text_of(row, "from_id").unwrap_or_default(),
        );
        backlinks_by_note
            .entry(to_id)
            .or_default()
            .push(BacklinkEntry {
                link_id: text_of(row, "link_id").unwrap_or_default(),
                card: card_by_ref.get(&reference).cloned().unwrap_or_else(|| {
                    RefCard::unresolved(
                        &reference.entity,
                        &reference.id,
                        crate::cards::CardStatus::Unknown,
                    )
                }),
            });
    }

    let (content_by_id, representations) =
        read_bodies_and_attachment_bytes(door, &windowed, &attachment_rows)?;
    let attachments_by_note =
        attachments_by_subject(&attachment_rows, &content_by_id, &representations);

    let name_by_notebook: BTreeMap<&str, Option<&str>> = books
        .iter()
        .map(|notebook| (notebook.notebook_id.as_str(), notebook.name.as_deref()))
        .collect();
    let mut notebooks_by_note: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &placements {
        if let (Some(target_id), Some(collection_id)) =
            (text_of(row, "target_id"), text_of(row, "collection_id"))
        {
            notebooks_by_note
                .entry(target_id)
                .or_default()
                .push(collection_id);
        }
    }

    let mut rows: Vec<LibraryRow> = windowed
        .iter()
        .filter_map(|row| {
            let note_id = text_of(row, "note_id")?;
            let notebook_ids = notebooks_by_note.get(&note_id).cloned().unwrap_or_default();
            let body = decode_note_body(
                text_of(row, "body_content_id")
                    .and_then(|content_id| content_by_id.get(&content_id).cloned())
                    .and_then(|content| text_of(&content, "content_uri"))
                    .as_deref(),
            );
            Some(LibraryRow {
                title: text_of(row, "title"),
                format: text_of(row, "format"),
                pinned: integer_or_zero(row, "pinned"),
                created_at: text_of(row, "created_at"),
                updated_at: text_of(row, "updated_at"),
                deleted_at: text_of(row, "deleted_at"),
                purge_at: text_of(row, "purge_at"),
                preview: preview_of(&body),
                check: check_of(&body),
                notebook_names: notebook_ids
                    .iter()
                    .map(|id| {
                        name_by_notebook
                            .get(id.as_str())
                            .copied()
                            .flatten()
                            // v0's `?? "Notebook"`: a placement into a
                            // collection the walk did not reach still draws.
                            .unwrap_or("Notebook")
                            .to_owned()
                    })
                    .collect(),
                notebook_ids,
                attachments: attachments_by_note
                    .get(&note_id)
                    .cloned()
                    .unwrap_or_default(),
                references: references_by_note
                    .get(&note_id)
                    .cloned()
                    .unwrap_or_default(),
                backlinks: backlinks_by_note.get(&note_id).cloned().unwrap_or_default(),
                tags: tags_by_note.get(&note_id).cloned().unwrap_or_default(),
                note_id,
            })
        })
        .collect();
    // Pinned first, then newest. STABLE, so ties keep the read order above.
    rows.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });

    Ok(LibraryData {
        notes: rows
            .iter()
            .filter(|row| row.deleted_at.is_none())
            .cloned()
            .collect(),
        trash: rows
            .iter()
            .filter(|row| row.deleted_at.is_some())
            .cloned()
            .collect(),
        notebooks: books,
        tags: all_tags,
        truncated,
        window,
    })
}

/// One bounded pull covers both the note bodies and any attachment bytes.
fn read_bodies_and_attachment_bytes(
    door: &dyn PageDoor,
    notes: &[Row],
    attachments: &[Row],
) -> KitResult<(BTreeMap<String, Row>, RepresentationIndex)> {
    let mut content_ids: Vec<String> = notes
        .iter()
        .filter_map(|row| text_of(row, "body_content_id"))
        .chain(
            attachments
                .iter()
                .filter_map(|row| text_of(row, "content_id")),
        )
        .collect();
    content_ids.sort_unstable();
    content_ids.dedup();
    if content_ids.is_empty() {
        return Ok((BTreeMap::new(), RepresentationIndex::default()));
    }
    let fragment = in_list("content_id", &content_ids)?;
    let contents = bounded(
        door,
        "notes.library.contents",
        "content_id, content_uri, byte_size",
        "core_content_item",
        "content_id",
        &fragment.sql,
        fragment.bind,
    )?;
    let by_id: BTreeMap<String, Row> = contents
        .into_iter()
        .filter_map(|row| text_of(&row, "content_id").map(|id| (id, row)))
        .collect();
    let representations = read_representations(door, &content_ids, JOIN_FAN_OUT)?;
    Ok((by_id, representations))
}

/// The shared attachment projection, keyed by subject.
///
/// Blob-backed bytes serve as SAME-ORIGIN urls (#296): a `blob:` uri becomes
/// `/centraid/_vault/blobs/<content_id>`, because the seat serves those bytes
/// itself and the raw uri means nothing to a browser.
fn attachments_by_subject(
    attachments: &[Row],
    content_by_id: &BTreeMap<String, Row>,
    representations: &RepresentationIndex,
) -> BTreeMap<String, Vec<Attachment>> {
    let mut by_subject: BTreeMap<String, Vec<Attachment>> = BTreeMap::new();
    for row in attachments {
        if text_of(row, "target_type").as_deref() != Some(NOTE_TARGET_TYPE) {
            continue;
        }
        let Some(target_id) = text_of(row, "target_id") else {
            continue;
        };
        let attachment_id = text_of(row, "attachment_id").unwrap_or_default();
        let content_id = text_of(row, "content_id").unwrap_or_default();
        let content = content_by_id.get(&content_id);
        let uri = content.and_then(|row| text_of(row, "content_uri"));
        by_subject.entry(target_id).or_default().push(Attachment {
            role: text_of(row, "role"),
            is_primary: integer_or_zero(row, "is_primary"),
            media_type: representations
                .by_owner
                .get(&("core.attachment".to_owned(), attachment_id.clone()))
                .or_else(|| representations.by_content.get(&content_id))
                .cloned()
                .unwrap_or_else(|| "application/octet-stream".to_owned()),
            content_uri: match uri {
                Some(uri) if uri.starts_with("blob:") => {
                    format!("/centraid/_vault/blobs/{content_id}")
                }
                Some(uri) => uri,
                // v0's `srcOf(content) ?? ""`.
                None => String::new(),
            },
            byte_size: content.map_or(0, |row| integer_or_zero(row, "byte_size")),
            attachment_id,
            content_id,
        });
    }
    for list in by_subject.values_mut() {
        // Primary first. STABLE, so the read's `attachment_id` order survives.
        list.sort_by(|left, right| right.is_primary.cmp(&left.is_primary));
    }
    by_subject
}

// ---------------------------------------------------------------------------
// `note`
// ---------------------------------------------------------------------------

/// One note's canonical body, decoded — the editor's on-open pull.
///
/// **THIS IS THE BY-ID DOOR, AND IT DOES NO JOURNAL READ** (D-1020-N3). A
/// journal entry is excluded from the library, search and the powerbox and
/// **reachable here**, because the People screen opens one. The asymmetry is
/// the absence of a filter in this function, and
/// `crates/apps/notes/tests/asymmetry.rs` is what keeps it.
///
/// # Errors
///
/// The kit's own refusals; a denial is the tuple's second element.
pub fn load_note(door: &dyn PageDoor, note_id: &str) -> KitResult<(NoteData, Option<Denial>)> {
    let note_id = note_id.trim().to_owned();
    if note_id.is_empty() {
        // v0 answers `{note_id, body: ""}` with NO `format` key at all
        // (`note.ts:15`); the port ships `None`, which is the same absence.
        return Ok((
            NoteData {
                note_id,
                ..NoteData::default()
            },
            None,
        ));
    }
    match note_body(door, &note_id) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((
            NoteData {
                note_id,
                ..NoteData::default()
            },
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}

fn note_body(door: &dyn PageDoor, note_id: &str) -> KitResult<NoteData> {
    let Some(note) = note_row(door, note_id)? else {
        return Ok(NoteData {
            note_id: note_id.to_owned(),
            body: String::new(),
            format: None,
        });
    };
    let content = match text_of(&note, "body_content_id") {
        Some(content_id) => read_by_id(
            door,
            "notes.note.body",
            "content_id, content_uri",
            "core_content_item",
            "content_id",
            &content_id,
        )?,
        None => None,
    };
    Ok(NoteData {
        note_id: note_id.to_owned(),
        body: decode_note_body(
            content
                .as_ref()
                .and_then(|row| text_of(row, "content_uri"))
                .as_deref(),
        ),
        format: text_of(&note, "format"),
    })
}

// ---------------------------------------------------------------------------
// `search`
// ---------------------------------------------------------------------------

/// Full-text note search: the ranked hits in the library row shape, plus the
/// index's own snippet.
///
/// The FTS door does the matching, so this app never pulls the note table to
/// grep it. Journal entries drop out of the ranked hits **inside the door**
/// (#834 R-journal), so no journal body is decoded or previewed.
///
/// # Errors
///
/// The kit's own refusals. A search the door cannot run at all — a query with
/// no searchable words — answers the empty shape, which is v0's own
/// short-circuit for an empty term.
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
    match search_body(door, search, principal, term) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((
            SearchData::default(),
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}

fn search_body(
    door: &dyn PageDoor,
    search: &dyn Search,
    principal: &Principal,
    term: &str,
) -> KitResult<SearchData> {
    let journal_ids = read_journal_note_ids(door)?;
    let request = SearchRequest::new(NOTE_TARGET_TYPE, term, SEARCH_ROWS).excluding(journal_ids);
    let answer = match search.query(principal, &request) {
        Ok(answer) => answer,
        // A TERM WITH NO SEARCHABLE WORD is v0's own empty answer, reached one
        // step earlier: `searchHandler` short-circuits an empty term and the
        // gateway throws `contract` for a term of punctuation, which the
        // handler's catch turns into `{notes: []}` plus a denial. The port
        // answers the empty shape with no denial, because a member who typed
        // `---` was not refused anything.
        Err(SearchError::NoSearchableWords { .. }) => return Ok(SearchData::default()),
        Err(SearchError::NotADomain { entity, count }) => {
            return Err(KitError::Door(format!(
                "`{entity}` is not one of the {count} search domains"
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
    // VAULT ORDER IS RANK ORDER (best match first) — keep it. The rows below
    // come back in primary-key order and are re-ordered onto this one.
    let ranked: Vec<(String, String)> = page
        .rows
        .iter()
        .map(|target| (target.id.clone(), target.snippet.clone()))
        .collect();
    let hit_ids: Vec<String> = ranked.iter().map(|(id, _)| id.clone()).collect();

    let fragment = in_list("note_id", &hit_ids)?;
    let note_rows = bounded(
        door,
        "notes.search.notes",
        NOTE_COLUMNS,
        "knowledge_note",
        "note_id",
        &fragment.sql,
        fragment.bind,
    )?;
    let placements = note_scoped(door, &SEARCH_PLACEMENTS, &hit_ids)?;
    let notebook_rows = read_pages(
        door,
        &PageQuery::new(
            "notes.search.notebooks",
            "collection_id, name",
            "core_collection",
            PageOrder::asc("collection_id", "collection_id"),
        ),
        JOIN_FAN_OUT,
    )?;
    let attachment_rows = note_scoped(door, &SEARCH_ATTACHMENTS, &hit_ids)?;
    let (content_by_id, representations) =
        read_bodies_and_attachment_bytes(door, &note_rows, &attachment_rows)?;
    let attachments_by_note =
        attachments_by_subject(&attachment_rows, &content_by_id, &representations);
    let name_by_notebook: BTreeMap<String, Option<String>> = notebook_rows
        .iter()
        .filter_map(|row| Some((text_of(row, "collection_id")?, text_of(row, "name"))))
        .collect();
    let mut notebooks_by_note: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in &placements {
        if let (Some(target_id), Some(collection_id)) =
            (text_of(row, "target_id"), text_of(row, "collection_id"))
        {
            notebooks_by_note
                .entry(target_id)
                .or_default()
                .push(collection_id);
        }
    }
    let by_id: BTreeMap<String, &Row> = note_rows
        .iter()
        .filter_map(|row| text_of(row, "note_id").map(|id| (id, row)))
        .collect();

    Ok(SearchData {
        notes: ranked
            .into_iter()
            .filter_map(|(note_id, snippet)| {
                let row = by_id.get(&note_id)?;
                let notebook_ids = notebooks_by_note.get(&note_id).cloned().unwrap_or_default();
                let body = decode_note_body(
                    text_of(row, "body_content_id")
                        .and_then(|content_id| content_by_id.get(&content_id).cloned())
                        .and_then(|content| text_of(&content, "content_uri"))
                        .as_deref(),
                );
                Some(SearchRow {
                    title: text_of(row, "title"),
                    format: text_of(row, "format"),
                    pinned: integer_or_zero(row, "pinned"),
                    created_at: text_of(row, "created_at"),
                    updated_at: text_of(row, "updated_at"),
                    preview: preview_of(&body),
                    check: check_of(&body),
                    notebook_names: notebook_ids
                        .iter()
                        .map(|id| {
                            name_by_notebook
                                .get(id)
                                .cloned()
                                .flatten()
                                .unwrap_or_else(|| "Notebook".to_owned())
                        })
                        .collect(),
                    notebook_ids,
                    attachments: attachments_by_note
                        .get(&note_id)
                        .cloned()
                        .unwrap_or_default(),
                    snippet,
                    note_id,
                })
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// `history`
// ---------------------------------------------------------------------------

/// The selected note's append-only body version chain, newest first.
///
/// # Errors
///
/// The kit's own refusals, and a malformed chain: a CYCLE IS A REFUSAL, not a
/// truncated list (D-1020-N2). [`VersionChainError`] arrives here as
/// [`KitError::Door`] carrying the chain's own sentence, so the surface renders
/// the failure rather than a partial history drawn as a whole one.
pub fn load_history(
    door: &dyn PageDoor,
    note_id: &str,
) -> KitResult<(HistoryData, Option<Denial>)> {
    if note_id.is_empty() {
        return Ok((HistoryData::default(), None));
    }
    match history_body(door, note_id) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((
            HistoryData::default(),
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}

/// The chain walk on its own, so a caller can tell a MALFORMED chain from a
/// denied read: [`load_history`] folds both onto the payload's `vaultDenied`,
/// which is what a screen renders, and this is what a test asserts on.
///
/// # Errors
///
/// The kit's refusals, and [`VersionChainError`] verbatim.
pub fn walk_history(
    door: &dyn PageDoor,
    note_id: &str,
) -> KitResult<Result<crate::version_chain::ChainWalk, VersionChainError>> {
    let Some(note) = read_by_id(
        door,
        "notes.history.note",
        "note_id, body_content_id, current_revision_id, created_at",
        "knowledge_note",
        "note_id",
        note_id,
    )?
    else {
        return Ok(Ok(crate::version_chain::ChainWalk::default()));
    };
    let revisions = door.page(
        &revisions_statement(note_id),
        &PageRequest::first(MAX_CHAIN_STEPS),
    )?;
    let occurrences: Vec<Occurrence> = revisions
        .rows
        .iter()
        .filter_map(|row| {
            Some(Occurrence {
                revision_id: text_of(row, "revision_id")?,
                entity_type: text_of(row, "entity_type")?,
                entity_id: text_of(row, "entity_id")?,
                content_id: text_of(row, "content_id").unwrap_or_default(),
                parent_revision_id: text_of(row, "parent_revision_id"),
                recorded_at: text_of(row, "recorded_at").unwrap_or_default(),
            })
        })
        .collect();
    Ok(note_version_chain(
        note_id,
        &text_of(&note, "body_content_id").unwrap_or_default(),
        text_of(&note, "current_revision_id").as_deref(),
        &occurrences,
    ))
}

fn history_body(door: &dyn PageDoor, note_id: &str) -> KitResult<HistoryData> {
    let Some(note) = read_by_id(
        door,
        "notes.history.note",
        "note_id, body_content_id, current_revision_id, created_at",
        "knowledge_note",
        "note_id",
        note_id,
    )?
    else {
        return Ok(HistoryData::default());
    };
    let walk = match walk_history(door, note_id)? {
        Ok(walk) => walk,
        Err(refusal) => return Err(KitError::Door(refusal.to_string())),
    };
    if walk.content_ids.is_empty() {
        return Ok(HistoryData::default());
    }
    let mut chain_ids = walk.content_ids.clone();
    chain_ids.sort_unstable();
    chain_ids.dedup();
    let fragment = in_list("content_id", &chain_ids)?;
    let contents = bounded(
        door,
        "notes.history.contents",
        "content_id, content_uri, created_at",
        "core_content_item",
        "content_id",
        &fragment.sql,
        fragment.bind,
    )?;
    // Bytes carry no media type since #996 R20(b). A superseded version has no
    // representation of its own — the note's moved with the head — and an edit
    // changes the words, never the format.
    let representations = read_representations(door, &chain_ids, JOIN_FAN_OUT)?;
    let note_media_type = representations
        .by_owner
        .get(&(NOTE_TARGET_TYPE.to_owned(), note_id.to_owned()))
        .cloned();
    let by_id: BTreeMap<String, &Row> = contents
        .iter()
        .filter_map(|row| text_of(row, "content_id").map(|id| (id, row)))
        .collect();
    let created_at = text_of(&note, "created_at").unwrap_or_default();

    Ok(HistoryData {
        versions: walk
            .content_ids
            .iter()
            .enumerate()
            .map(|(index, content_id)| {
                let content = by_id.get(content_id);
                Version {
                    body: decode_note_body(
                        content
                            .and_then(|row| text_of(row, "content_uri"))
                            .as_deref(),
                    ),
                    media_type: representations
                        .by_content
                        .get(content_id)
                        .cloned()
                        .or_else(|| note_media_type.clone()),
                    current: index == 0,
                    asserted_at: walk
                        .asserted(content_id)
                        .map(str::to_owned)
                        .or_else(|| content.and_then(|row| text_of(row, "created_at")))
                        .unwrap_or_else(|| created_at.clone()),
                    content_id: content_id.clone(),
                }
            })
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// `journal`
// ---------------------------------------------------------------------------

/// The Journal place: the same marker set the library excludes, read the other
/// way round (#834 R-journal). Live entries only, newest by `updated_at`.
///
/// # Errors
///
/// The kit's own refusals; a denial is the tuple's second element.
pub fn load_journal(
    door: &dyn PageDoor,
    limit: Option<i64>,
) -> KitResult<(JournalData, Option<Denial>)> {
    let window = window_of(limit);
    match journal_body(door, window) {
        Ok(data) => Ok((data, None)),
        Err(KitError::Door(message)) => Ok((
            JournalData {
                window,
                ..JournalData::default()
            },
            Some(Denial {
                code: None,
                message: Some(message),
                revoked_at: None,
            }),
        )),
        Err(other) => Err(other),
    }
}

fn journal_body(door: &dyn PageDoor, window: usize) -> KitResult<JournalData> {
    let journal_ids = read_journal_note_ids(door)?;
    if journal_ids.is_empty() {
        return Ok(JournalData {
            window,
            ..JournalData::default()
        });
    }
    let fragment = in_list("note_id", &journal_ids)?;
    let statement = PageQuery::new(
        "notes.journal.entries",
        "note_id, title, format, body_content_id, created_at, updated_at, deleted_at",
        "knowledge_note",
        PageOrder::desc("updated_at", "note_id"),
    )
    .filter(
        // live rows, not the library's trash shelf
        &format!("{} AND deleted_at IS NULL", fragment.sql),
        fragment.bind,
    );
    let entries = read_window(door, &statement, window)?;
    // INCLUDE-ONLY IS THIS QUERY'S WHOLE CONTRACT: re-narrow in memory so an
    // over-wide read cannot put a non-journal note in the Journal place.
    let marker: BTreeSet<&String> = journal_ids.iter().collect();
    let rows: Vec<&Row> = entries
        .rows
        .iter()
        .filter(|row| text_of(row, "note_id").is_some_and(|id| marker.contains(&id)))
        .filter(|row| text_of(row, "deleted_at").is_none())
        .collect();
    if rows.is_empty() {
        return Ok(JournalData {
            window,
            ..JournalData::default()
        });
    }
    let mut content_ids: Vec<String> = rows
        .iter()
        .filter_map(|row| text_of(row, "body_content_id"))
        .collect();
    content_ids.sort_unstable();
    content_ids.dedup();
    let bodies = if content_ids.is_empty() {
        Vec::new()
    } else {
        let fragment = in_list("content_id", &content_ids)?;
        bounded(
            door,
            "notes.journal.bodies",
            "content_id, content_uri",
            "core_content_item",
            "content_id",
            &fragment.sql,
            fragment.bind,
        )?
    };
    let uri_by_id: BTreeMap<String, Option<String>> = bodies
        .iter()
        .filter_map(|row| Some((text_of(row, "content_id")?, text_of(row, "content_uri"))))
        .collect();

    Ok(JournalData {
        entries: rows
            .iter()
            .filter_map(|row| {
                let note_id = text_of(row, "note_id")?;
                let body = decode_note_body(
                    text_of(row, "body_content_id")
                        .and_then(|content_id| uri_by_id.get(&content_id).cloned())
                        .flatten()
                        .as_deref(),
                );
                Some(JournalEntry {
                    title: text_of(row, "title"),
                    format: text_of(row, "format"),
                    created_at: text_of(row, "created_at"),
                    updated_at: text_of(row, "updated_at"),
                    deleted_at: None,
                    preview: preview_of(&body),
                    check: check_of(&body),
                    note_id,
                })
            })
            .collect(),
        truncated: entries.filled,
        window,
    })
}

// ---------------------------------------------------------------------------
// `link-targets` — the powerbox
// ---------------------------------------------------------------------------

/// THE POWERBOX: one bounded probe per domain, over seven domains, secret-free.
///
/// Each probe is **isolated**, so a denied scope leaves its column absent
/// rather than emptying the sheet (`queries/link-targets.ts:1`-`:4`) — v0 runs
/// them through `Promise.allSettled` and flat-maps only the fulfilled ones, and
/// the port skips a domain whose probe refused.
///
/// The journal read rides inside the NOTES probe, because that is the only
/// domain it narrows.
///
/// # Errors
///
/// Only the journal read's own refusal, which fails closed for the reason
/// [`crate::journal`] states: answering "no journal entries" would leak them
/// into the sheet.
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
    let journal_ids = match read_journal_note_ids(door) {
        Ok(ids) => ids,
        Err(KitError::Door(message)) => {
            return Ok((
                LinkTargetsData::default(),
                Some(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }),
            ));
        }
        Err(other) => return Err(other),
    };
    let mut targets: Vec<Target> = Vec::new();
    for domain in centraid_search::DOMAINS {
        let mut request = SearchRequest::new(domain.entity, term, LINK_TARGET_ROWS);
        if domain.entity == NOTE_TARGET_TYPE {
            request = request.excluding(journal_ids.clone());
        }
        // ISOLATED: a refusal drops THIS domain's column, never the sheet.
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
    fn the_three_shelves_order_on_a_not_null_column_each() {
        assert_eq!(recent_statement().order.sort_column, "updated_at");
        assert_eq!(pinned_statement().order.sort_column, "updated_at");
        // The trash shelf orders by `deleted_at`, which is NULLABLE — and every
        // row it can return has it set, because the predicate says so. The
        // kit's refusal is about a CONTINUED page, and the shelf is one page.
        let trash = trash_statement();
        assert_eq!(trash.order.sort_column, "deleted_at");
        assert_eq!(trash.r#where.as_deref(), Some("deleted_at IS NOT NULL"));
    }

    #[test]
    fn the_revisions_statement_is_scoped_to_one_note() {
        let statement = revisions_statement("note-1");
        assert_eq!(
            statement.r#where.as_deref(),
            Some("entity_type = ? AND entity_id = ?")
        );
        assert_eq!(
            statement.bind,
            vec![
                PageBindValue::Text(NOTE_TARGET_TYPE.to_owned()),
                PageBindValue::Text("note-1".to_owned()),
            ]
        );
    }
}
