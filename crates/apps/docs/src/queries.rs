//! THE FOUR QUERIES: `drive`, `search`, `history` and `activity`.
//!
//! `queries/drive.ts` is the one to read first (287 lines). Its doctrine, in
//! its own words: *"A BOUNDED recent window (#262): documents arrive
//! newest-filed-first via their folders-scheme tags, never a whole-table pull.
//! Identity is the core.document wrapper (#352), not the content item it points
//! at, and every decoration is `IN`-bounded by the same window."*
//!
//! ## The three reads that DISCOVER rows, and the seven that decorate them
//!
//! | Read | What it is |
//! |---|---|
//! | `docs.drive.filed` | **the drive's window is a PAGE.** One page of `core_tag`, newest `tagged_at` first, sized by the caller. Everything below joins over what it returned |
//! | `docs.origins.subscriptions` | the SECOND door in ([`crate::origins`]): a delivered copy carries no folders-scheme tag, so the tag window cannot see it |
//! | `ctx.vault.search` | `search`'s own FTS read, which is `crates/search`'s and not a [`PageQuery`] — the hits arrive here in RANK ORDER and the fold keeps that order |
//!
//! Everything else — the documents themselves, the stars, the labels, the
//! content rows, the custody states, the representations and the whole share
//! fold — is bounded by ids one of those three already returned.
//!
//! ## `truncated` IS THE PAGE'S OWN CURSOR, NOT A GUESS AT IT
//!
//! `rows.length >= window` cannot tell a window that filled exactly from one
//! that ran out; a cursor exists or it does not, and it is also where to carry
//! on from (`drive.ts:266`-`:269`).
//!
//! ## The taxonomy pair, and a v0 column that is not selected
//!
//! `_shared/taxonomy-reads.ts` selects `concept_id, scheme_id, pref_label,
//! notation` — **and not `broader_concept_id`**, which `drive.ts` reads for
//! `folders[].parent_id` and `_shared.ts` reads to build the folder chain a
//! share walks up. On the gateway's paged door the row is a plain object, so
//! the unselected column reads as `undefined` and the two consequences are
//! silent: every folder reports as top-level, and **a share on a grandparent
//! folder never reaches the document**. This port selects the column
//! ([`taxonomy_concepts_statement`]) and the divergence is R-1020-35 finding 1
//! in this lane's receipt, with the one-line v0 fix quoted.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{MAX_PAGE_ROWS, PageRequest};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages, read_window};
use centraid_apps_kit::representations::{RepresentationIndex, read_representations};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::origins::{SharedFromEntry, read_origins_by_document};
use crate::shares::{DOCUMENT_TARGET_TYPE, ShareWindow, SharedWithEntry, read_shares_by_document};
use crate::{Denial, Reading};

/// The folders scheme. **An `https` URI, not a `urn:`, and that is not drift**:
/// the literal is interpolated into condition SQL on the command side, where
/// `:folders` reads as a NAMED PARAMETER (#258, the colon-literal trap) and no
/// parameter name can start with a slash. The tags scheme, never interpolated,
/// is `centraid:tags:v1`.
pub const FOLDER_SCHEME_URI: &str = "https://centraid.dev/schemes/folders";
pub const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
pub const TAGS_SCHEME_URI: &str = "centraid:tags:v1";
pub const STARRED_NOTATION: &str = "starred";
/// Not a folder a member can rename.
pub const ROOT_FOLDER_NOTATION: &str = "root";

/// The drive's declared window, from the manifest's input schema: `limit`
/// 20…2,000 with a default of 200 (`drive.ts:48`).
pub const DRIVE_MIN: usize = 20;
pub const DRIVE_MAX: usize = 2_000;
pub const DRIVE_DEFAULT: usize = 200;

/// FTS answers at most this many matches (`search.ts:55`).
pub const SEARCH_LIMIT: usize = 100;

/// Caps a malformed version chain; a well-formed one terminates on a null
/// parent (`history.ts:23`).
pub const MAX_CHAIN_STEPS: usize = 500;

/// A join per windowed document: 500 × 8 = 4,000 rows, the kit's default. The
/// share fold's own bound is the same number and is named separately, because
/// it is the one v0 states at its call sites.
pub const DOC_JOIN_BOUND: FanOutBound = FanOutBound::new(500, 8);

/// Tags are `(document, concept)` pairs over a 2,000-document window, and a
/// document carries a folder tag, maybe a star and any number of labels:
/// 500 × 32 = 16,000 rows, stated.
pub const DOC_PAIR_BOUND: FanOutBound = FanOutBound::new(500, 32);

/// The blob route a `blob:` content URI becomes (`drive.ts:216`).
pub const BLOB_ROUTE: &str = "/centraid/_vault/blobs";

// ---------------------------------------------------------------------------
// Statements.
// ---------------------------------------------------------------------------

/// `_shared/taxonomy.concepts` — a vault's vocabulary, which is what bounds the
/// rest. Owner-curated and small, so the walk is honest.
///
/// **`broader_concept_id` is in the projection and is not in v0's**; see the
/// module note.
#[must_use]
pub fn taxonomy_concepts_statement() -> PageQuery {
    PageQuery::new(
        "_shared/taxonomy.concepts",
        "concept_id, scheme_id, pref_label, notation, broader_concept_id",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
}

/// `_shared/taxonomy.schemes` — the other half of the pair. Two reads, not one:
/// they are different tables, and each is walked to the end of itself.
#[must_use]
pub fn taxonomy_schemes_statement() -> PageQuery {
    PageQuery::new(
        "_shared/taxonomy.schemes",
        "scheme_id, uri, title",
        "core_concept_scheme",
        PageOrder::asc("scheme_id", "scheme_id"),
    )
}

/// `docs.drive.filed` — THE DRIVE'S WINDOW, as a page.
///
/// Newest-filed-first by `tagged_at`, which is `NOT NULL` on `core_tag`, so the
/// page is continuable and `truncated` is its cursor.
pub fn filed_statement(folder_concept_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("concept_id", folder_concept_ids)?;
    let mut bind = vec![PageBindValue::Text(DOCUMENT_TARGET_TYPE.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "docs.drive.filed",
        "tag_id, target_id, concept_id, target_type, tagged_at",
        "core_tag",
        PageOrder::desc("tagged_at", "tag_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `docs.drive.documents` — the wrappers the window named.
pub fn documents_statement(document_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("document_id", document_ids)?;
    Ok(PageQuery::new(
        "docs.drive.documents",
        "document_id, current_content_id, current_revision_id, title, \
         created_at, updated_at, deleted_at, purge_at",
        "core_document",
        PageOrder::asc("document_id", "document_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `docs.drive.starred` — the star, which is a flags-scheme tag on the WRAPPER.
pub fn starred_statement(concept_id: &str, document_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", document_ids)?;
    let mut bind = vec![
        PageBindValue::Text(concept_id.to_owned()),
        PageBindValue::Text(DOCUMENT_TARGET_TYPE.to_owned()),
    ];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "docs.drive.starred",
        "tag_id, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(
        &format!("concept_id = ? AND target_type = ? AND {}", fragment.sql),
        bind,
    ))
}

/// `docs.labels.tags` — every tag on the windowed documents, so the labels and
/// the star are two readings of one read.
///
/// Each entry carries its `tag_id` because `untag` removes **by tag_id, never
/// by label** (`_shared.ts:52`-`:54`).
pub fn labels_statement(document_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", document_ids)?;
    let mut bind = vec![PageBindValue::Text(DOCUMENT_TARGET_TYPE.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "docs.labels.tags",
        "tag_id, target_id, concept_id, target_type",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `docs.drive.contents` — the byte rows the wrappers' heads name.
///
/// No `media_type`: the byte row carries none since #996 R20(b), and THIS
/// document's representation says what it reads those bytes as.
pub fn contents_statement(name: &str, content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        name,
        "content_id, byte_size, content_uri, created_at",
        "core_content_item",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `docs.custody.byContent` — where the bytes actually are.
///
/// An ABSENT content id means inline bytes custody cannot track, or a sweep
/// that has not run; callers render nothing rather than claim a state the vault
/// never asserted (`_shared.ts:94`-`:97`).
pub fn custody_statement(content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        "docs.custody.byContent",
        "content_id, custody_state",
        "blob_custody_state",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `docs.history.revisions` — every occurrence of THIS document, newest first.
///
/// ONE READ: the chain is walked in memory over ids the same read returned, so
/// a long history costs one round trip rather than one per version.
pub fn revisions_statement(document_id: &str) -> PageQuery {
    PageQuery::new(
        "docs.history.revisions",
        "revision_id, content_id, parent_revision_id, recorded_at",
        "core_entity_revision",
        PageOrder::desc("recorded_at", "revision_id"),
    )
    .filter(
        "entity_type = ? AND entity_id = ?",
        vec![
            PageBindValue::Text(DOCUMENT_TARGET_TYPE.to_owned()),
            PageBindValue::Text(document_id.to_owned()),
        ],
    )
}

/// `docs.activity.provenance` — THE TRAIL OF ONE DOCUMENT IS A WALK, NOT A
/// WINDOW (#996 wave 4, R8).
///
/// The read said "accept truncation", which on a long-lived document meant the
/// rail showed whichever end of its history the reader's default happened to
/// reach — and a trail that silently omits events is worse than one that says
/// it cannot be shown (`activity.ts:4`-`:8`).
pub fn provenance_statement(document_id: &str) -> PageQuery {
    PageQuery::new(
        "docs.activity.provenance",
        "prov_id, prov_activity, agent_kind, occurred_at",
        "access_provenance",
        PageOrder::desc("occurred_at", "prov_id"),
    )
    .filter(
        "entity_type = ? AND entity_id = ?",
        vec![
            PageBindValue::Text(DOCUMENT_TARGET_TYPE.to_owned()),
            PageBindValue::Text(document_id.to_owned()),
        ],
    )
}

// ---------------------------------------------------------------------------
// Rows and payloads.
// ---------------------------------------------------------------------------

/// One folder, as the sidebar draws it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderRow {
    pub folder_id: String,
    pub name: Option<String>,
    /// `None` at the drive's top level — which is both "no parent" and "the
    /// root concept is the parent", because the root is the drive and not a
    /// folder.
    pub parent_id: Option<String>,
}

/// One free-form label, with the edge that removes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LabelEntry {
    pub tag_id: String,
    pub label: String,
}

/// One drive row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentRow {
    pub document_id: String,
    pub content_id: String,
    pub title: Option<String>,
    /// From the representation index, keyed on `(core.document, document_id)`.
    /// `None` is "nothing says what these bytes are", never a default type.
    pub media_type: Option<String>,
    pub byte_size: Option<i64>,
    pub content_uri: Option<String>,
    pub poster_uri: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub folder_id: Option<String>,
    pub starred: bool,
    pub trashed: bool,
    pub purge_at: Option<String>,
    pub tags: Vec<LabelEntry>,
    pub custody_state: Option<String>,
    /// **`Denied` is "we cannot see"; `Data(vec![])` is "shared with nobody".**
    pub shared_with: Reading<Vec<SharedWithEntry>>,
    /// The placement that brought it here, where it arrived from elsewhere.
    pub shared_from: Option<SharedFromEntry>,
    /// The hit snippet, on a `search` row only.
    pub snippet: Option<String>,
}

/// What `drive` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct DriveData {
    pub folders: Vec<FolderRow>,
    pub documents: Vec<DocumentRow>,
    pub root_folder_id: Option<String>,
    /// Older documents exist beyond the window. **The page's own cursor**, not
    /// a row count.
    pub truncated: bool,
    pub window: usize,
    /// ABSENT IS NOT EMPTY: whether the origin plane could be read at all.
    pub shared_from_known: bool,
}

/// What `search` answers: the same rows, in **vault rank order**.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub documents: Vec<DocumentRow>,
}

/// One version, in the history rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionRow {
    pub content_id: String,
    pub media_type: Option<String>,
    pub byte_size: Option<i64>,
    pub content_uri: Option<String>,
    pub poster_uri: Option<String>,
    pub current: bool,
    /// The OCCURRENCE's own instant — when this version became current — never
    /// the content item's `created_at`, because restoring an old version reads
    /// as the newest entry even though its bytes are old.
    pub asserted_at: Option<String>,
}

/// What `history` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HistoryData {
    pub versions: Vec<VersionRow>,
}

/// One event on the activity rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivityEvent {
    pub activity: Option<String>,
    pub agent_kind: Option<String>,
    pub occurred_at: Option<String>,
}

/// What `activity` answers.
///
/// AN EMPTY LIST IS HONEST: no activity has been recorded yet (a freshly
/// recreated schema), not an error.
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
    /// The window this input asks for.
    ///
    /// A CLAMP, NOT A REFUSAL, and in v0's own order:
    /// `min(max(limit || 200, 20), 2000)` (`drive.ts:48`) — so a `0` falls back
    /// to the default rather than clamping up to the floor, which is what
    /// `||` does and `??` would not.
    #[must_use]
    pub fn window(self) -> usize {
        self.limit
            .filter(|limit| *limit != 0)
            .unwrap_or(DRIVE_DEFAULT)
            .clamp(DRIVE_MIN, DRIVE_MAX)
    }
}

/// `srcOf` / `posterOf`, ported (`drive.ts:213`-`:221`).
///
/// Blob bytes (#296) serve as SAME-ORIGIN URLs so Range and caching work;
/// `data:` URIs pass through and have no poster, because there is no derivative
/// to ask for.
#[must_use]
fn uris_of(content: Option<&ContentRow>) -> (Option<String>, Option<String>) {
    let Some(uri) = content.and_then(|content| content.content_uri.as_deref()) else {
        return (None, None);
    };
    if !uri.starts_with("blob:") {
        return (Some(uri.to_owned()), None);
    }
    let content_id = content
        .map(|content| content.content_id.as_str())
        .unwrap_or("");
    (
        Some(format!("{BLOB_ROUTE}/{content_id}")),
        Some(format!("{BLOB_ROUTE}/{content_id}?variant=poster")),
    )
}

/// One `core_content_item` row, as the drive reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentRow {
    pub content_id: String,
    pub byte_size: Option<i64>,
    pub content_uri: Option<String>,
    pub created_at: Option<String>,
}

impl ContentRow {
    #[must_use]
    pub fn of(row: &Row) -> Option<Self> {
        Some(Self {
            content_id: text_of(row, "content_id")?,
            byte_size: row.get("byte_size").and_then(Cell::integer),
            content_uri: text_of(row, "content_uri"),
            created_at: text_of(row, "created_at"),
        })
    }
}

/// The vault's vocabulary, read once and handed to everything that folds it.
#[derive(Debug, Clone, Default)]
pub struct Taxonomy {
    pub concepts: Vec<Row>,
    pub schemes: Vec<Row>,
}

impl Taxonomy {
    /// A scheme's id, by URI.
    #[must_use]
    pub fn scheme_id(&self, uri: &str) -> Option<String> {
        self.schemes
            .iter()
            .find(|row| text_of(row, "uri").as_deref() == Some(uri))
            .and_then(|row| text_of(row, "scheme_id"))
    }

    /// Every concept in one scheme.
    #[must_use]
    pub fn concepts_in(&self, uri: &str) -> Vec<&Row> {
        let Some(scheme_id) = self.scheme_id(uri) else {
            return Vec::new();
        };
        self.concepts
            .iter()
            .filter(|row| text_of(row, "scheme_id").as_deref() == Some(scheme_id.as_str()))
            .collect()
    }

    /// One concept in one scheme, by notation.
    #[must_use]
    pub fn concept(&self, uri: &str, notation: &str) -> Option<String> {
        self.concepts_in(uri)
            .into_iter()
            .find(|row| text_of(row, "notation").as_deref() == Some(notation))
            .and_then(|row| text_of(row, "concept_id"))
    }

    /// `concept_id -> broader_concept_id`, over the folders scheme.
    #[must_use]
    pub fn folder_parents(&self) -> BTreeMap<String, Option<String>> {
        self.concepts_in(FOLDER_SCHEME_URI)
            .into_iter()
            .filter_map(|row| {
                text_of(row, "concept_id").map(|id| (id, text_of(row, "broader_concept_id")))
            })
            .collect()
    }
}

/// Read the taxonomy pair.
pub fn read_taxonomy(door: &dyn PageDoor) -> KitResult<Taxonomy> {
    Ok(Taxonomy {
        concepts: read_pages(door, &taxonomy_concepts_statement(), DOC_PAIR_BOUND)?,
        schemes: read_pages(door, &taxonomy_schemes_statement(), DOC_JOIN_BOUND)?,
    })
}

/// The folder rail: every folder in the owner's scheme except the root.
///
/// Sorted by name. v0 sorts with `String(a.name).localeCompare(…)`; for the
/// ASCII folder names in the fixtures byte order agrees, and the parity
/// manifest carries `order: "set"` for the case it does not (apps seam 4).
#[must_use]
pub fn fold_folders(taxonomy: &Taxonomy) -> (Vec<FolderRow>, Option<String>) {
    let root = taxonomy.concept(FOLDER_SCHEME_URI, ROOT_FOLDER_NOTATION);
    let mut folders: Vec<FolderRow> = taxonomy
        .concepts_in(FOLDER_SCHEME_URI)
        .into_iter()
        .filter_map(|row| {
            let folder_id = text_of(row, "concept_id")?;
            if Some(&folder_id) == root.as_ref() {
                return None;
            }
            let broader = text_of(row, "broader_concept_id");
            Some(FolderRow {
                folder_id,
                name: text_of(row, "pref_label"),
                // THE ROOT IS THE DRIVE, NOT A FOLDER: a folder filed under it
                // is top-level, and saying so as `null` is what keeps the rail
                // from drawing a folder called "Documents" above everything.
                parent_id: match (&broader, &root) {
                    (None, _) => None,
                    (Some(parent), Some(root)) if parent == root => None,
                    (Some(parent), _) => Some(parent.clone()),
                },
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
    (folders, root)
}

/// The labels on a window of documents, split from the same tag read.
///
/// A tag whose concept is not in the TAGS scheme is skipped — it is a
/// folders-scheme or flags-scheme tag on the same document, and printing it as
/// a label would put "Leases" and "Starred" in the chip rail.
#[must_use]
pub fn fold_labels(taxonomy: &Taxonomy, tags: &[Row]) -> BTreeMap<String, Vec<LabelEntry>> {
    let label_of: BTreeMap<String, String> = taxonomy
        .concepts_in(TAGS_SCHEME_URI)
        .into_iter()
        .filter_map(|row| {
            let concept_id = text_of(row, "concept_id")?;
            let label = text_of(row, "pref_label").or_else(|| text_of(row, "notation"))?;
            Some((concept_id, label))
        })
        .collect();
    let mut by_document: BTreeMap<String, Vec<LabelEntry>> = BTreeMap::new();
    for row in tags {
        let (Some(tag_id), Some(target_id), Some(concept_id)) = (
            text_of(row, "tag_id"),
            text_of(row, "target_id"),
            text_of(row, "concept_id"),
        ) else {
            continue;
        };
        let Some(label) = label_of.get(&concept_id) else {
            continue;
        };
        by_document.entry(target_id).or_default().push(LabelEntry {
            tag_id,
            label: label.clone(),
        });
    }
    by_document
}

/// `content_id -> custody_state`, from the bounded custody read.
#[must_use]
pub fn fold_custody(rows: &[Row]) -> BTreeMap<String, String> {
    rows.iter()
        .filter_map(|row| Some((text_of(row, "content_id")?, text_of(row, "custody_state")?)))
        .collect()
}

/// Everything the row fold needs that is not the wrapper itself.
struct Decorations {
    folder_by_document: BTreeMap<String, String>,
    root_folder_id: Option<String>,
    starred: BTreeSet<String>,
    labels: BTreeMap<String, Vec<LabelEntry>>,
    custody: BTreeMap<String, String>,
    representations: RepresentationIndex,
    contents: BTreeMap<String, ContentRow>,
    shares: Reading<BTreeMap<String, Vec<SharedWithEntry>>>,
    origins: BTreeMap<String, SharedFromEntry>,
    snippets: BTreeMap<String, String>,
}

/// One drive row, out of the wrapper and its decorations.
fn fold_row(wrapper: &Row, decorations: &Decorations) -> Option<DocumentRow> {
    let document_id = text_of(wrapper, "document_id")?;
    let content_id = text_of(wrapper, "current_content_id")?;
    let content = decorations.contents.get(&content_id);
    let (content_uri, poster_uri) = uris_of(content);
    let folder = decorations.folder_by_document.get(&document_id);
    Some(DocumentRow {
        media_type: decorations
            .representations
            .owner(DOCUMENT_TARGET_TYPE, &document_id)
            .map(str::to_owned),
        byte_size: content.and_then(|content| content.byte_size),
        content_uri,
        poster_uri,
        title: text_of(wrapper, "title"),
        created_at: text_of(wrapper, "created_at"),
        updated_at: text_of(wrapper, "updated_at"),
        folder_id: match (folder, &decorations.root_folder_id) {
            (None, _) => None,
            (Some(folder), Some(root)) if folder == root => None,
            (Some(folder), _) => Some(folder.clone()),
        },
        starred: decorations.starred.contains(&document_id),
        trashed: text_of(wrapper, "deleted_at").is_some(),
        purge_at: text_of(wrapper, "purge_at"),
        tags: decorations
            .labels
            .get(&document_id)
            .cloned()
            .unwrap_or_default(),
        custody_state: decorations.custody.get(&content_id).cloned(),
        // `Denied` is "reads denied"; `Data(vec![])` is "shared with nobody".
        shared_with: match &decorations.shares {
            Reading::Denied(denial) => Reading::Denied(denial.clone()),
            Reading::Loading => Reading::Loading,
            Reading::Data(by_document) => {
                Reading::Data(by_document.get(&document_id).cloned().unwrap_or_default())
            }
        },
        shared_from: decorations.origins.get(&document_id).cloned(),
        snippet: decorations.snippets.get(&document_id).cloned(),
        document_id,
        content_id,
    })
}

/// A walk that answers a denial as a value.
enum Walked {
    Rows(Vec<Row>),
    Denied(Denial),
}

fn walk(door: &dyn PageDoor, statement: &PageQuery, bound: FanOutBound) -> KitResult<Walked> {
    match read_pages(door, statement, bound) {
        Ok(rows) => Ok(Walked::Rows(rows)),
        Err(KitError::Door(message)) => Ok(Walked::Denied(Denial {
            code: None,
            message: Some(message),
            revoked_at: None,
        })),
        Err(other) => Err(other),
    }
}

/// Read and fold the decorations a window of documents needs.
fn read_decorations(
    door: &dyn PageDoor,
    taxonomy: &Taxonomy,
    wrappers: &[Row],
    folder_by_document: BTreeMap<String, String>,
    root_folder_id: Option<String>,
    now: &str,
) -> KitResult<Result<Decorations, Denial>> {
    let document_ids: Vec<String> = wrappers
        .iter()
        .filter_map(|row| text_of(row, "document_id"))
        .collect();
    let content_ids: Vec<String> = wrappers
        .iter()
        .filter_map(|row| text_of(row, "current_content_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();

    let starred_concept = taxonomy.concept(FLAGS_SCHEME_URI, STARRED_NOTATION);
    // NO CONCEPT, NEVER STARRED (#274): the flags scheme is created on first
    // use, so a vault where nothing was ever starred has none — and reading
    // that as "every document is starred" is the inverse mistake.
    let starred = match &starred_concept {
        None => BTreeSet::new(),
        Some(concept_id) if document_ids.is_empty() => {
            let _ = concept_id;
            BTreeSet::new()
        }
        Some(concept_id) => {
            match walk(
                door,
                &starred_statement(concept_id, &document_ids)?,
                DOC_JOIN_BOUND,
            )? {
                Walked::Denied(denial) => return Ok(Err(denial)),
                Walked::Rows(rows) => rows
                    .iter()
                    .filter_map(|row| text_of(row, "target_id"))
                    .collect(),
            }
        }
    };

    let labels = if document_ids.is_empty() {
        BTreeMap::new()
    } else {
        match walk(door, &labels_statement(&document_ids)?, DOC_PAIR_BOUND)? {
            Walked::Denied(denial) => return Ok(Err(denial)),
            Walked::Rows(rows) => fold_labels(taxonomy, &rows),
        }
    };

    let contents = if content_ids.is_empty() {
        BTreeMap::new()
    } else {
        match walk(
            door,
            &contents_statement("docs.drive.contents", &content_ids)?,
            DOC_JOIN_BOUND,
        )? {
            Walked::Denied(denial) => return Ok(Err(denial)),
            Walked::Rows(rows) => rows
                .iter()
                .filter_map(ContentRow::of)
                .map(|content| (content.content_id.clone(), content))
                .collect(),
        }
    };

    let custody = if content_ids.is_empty() {
        BTreeMap::new()
    } else {
        match walk(door, &custody_statement(&content_ids)?, DOC_JOIN_BOUND)? {
            // Custody is a DECORATION: a denial leaves the field absent rather
            // than taking the drive down. v0's helper does not catch, so this
            // is a narrowing in the port's favour and it is named in the receipt.
            Walked::Denied(_) => BTreeMap::new(),
            Walked::Rows(rows) => fold_custody(&rows),
        }
    };

    // The representation index answers with an empty map for a door that
    // refuses: a row with no media type is what "we may not read that" looks
    // like on a tile.
    let representations =
        read_representations(door, &content_ids, DOC_JOIN_BOUND).unwrap_or_default();

    let shares = read_shares_by_document(
        door,
        &ShareWindow {
            document_ids: &document_ids,
            folder_by_document: &folder_by_document,
            parent_of: &taxonomy.folder_parents(),
            now,
        },
    )?;

    Ok(Ok(Decorations {
        folder_by_document,
        root_folder_id,
        starred,
        labels,
        custody,
        representations,
        contents,
        shares,
        origins: BTreeMap::new(),
        snippets: BTreeMap::new(),
    }))
}

/// A denied query's payload: the empty answer plus the denial.
fn denied_drive(denial: Denial, window: usize) -> (DriveData, Option<Denial>) {
    (
        DriveData {
            window,
            ..DriveData::default()
        },
        Some(denial),
    )
}

/// `drive` — the whole projection.
///
/// Returns the payload and, separately, the denial v0 ships as `vaultDenied`:
/// a caller renders both, and a denial is never an `Err`.
pub fn load_drive(
    door: &dyn PageDoor,
    input: DriveInput,
    now: &str,
) -> KitResult<(DriveData, Option<Denial>)> {
    let window = input.window();
    let taxonomy = match read_taxonomy(door) {
        Ok(taxonomy) => taxonomy,
        Err(KitError::Door(message)) => {
            return Ok(denied_drive(
                Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                },
                window,
            ));
        }
        Err(other) => return Err(other),
    };
    let (folders, root_folder_id) = fold_folders(&taxonomy);

    // READ BEFORE THE FOLDERS-SCHEME GATE (`drive.ts:76`-`:80`). The scheme is
    // created on first use, so a member who has never filed a document of their
    // own has none — and returning early there told someone who HAD received one
    // that nothing arrived, which is the exact claim this door exists to
    // prevent.
    let origins = read_origins_by_document(door, window)?;

    let folder_concept_ids: Vec<String> = taxonomy
        .concepts_in(FOLDER_SCHEME_URI)
        .into_iter()
        .filter_map(|row| text_of(row, "concept_id"))
        .collect();
    // An `IN` filter with an empty array is a refusal in the kit's grammar: no
    // scheme means no filed documents, and asking is the error.
    // THE DECLARED WINDOW IS WALKED TO ITS STATED SIZE (D-1020-DC10, and the
    // second half of D-1020-D3-12).
    //
    // `MAX_PAGE_ROWS` clamps a PAGE to 500, and v0 asks for its 2,000-row
    // window as one page and takes `.rows` — so a drive declaring `limit: 2000`
    // answers 500 documents and discards the cursor that says there are more.
    // Measured at the year-3 profile: 500 of 7,600 live documents
    // (`crates/apps/docs/tests/year3.rs`).
    //
    // The drive is a LIST, and a list is where a clamp is defensible — but the
    // clamp has to be the one the caller ASKED for, not one the page contract
    // imposed behind it. `core_tag.tagged_at` is `NOT NULL`, so the keyset walk
    // is continuable and the stated window is reachable; Photos' library takes
    // one page instead because its own sort column is nullable and a walk there
    // would silently drop every NULL (D-1020-P11). `filled` is the same claim
    // v0's `next !== undefined` makes, so `truncated` still comes from the read
    // rather than from a row count.
    let filed = if folder_concept_ids.is_empty() {
        None
    } else {
        match read_window(door, &filed_statement(&folder_concept_ids)?, window) {
            Ok(walked) => Some(walked),
            Err(KitError::Door(message)) => {
                return Ok(denied_drive(
                    Denial {
                        code: None,
                        message: Some(message),
                        revoked_at: None,
                    },
                    window,
                ));
            }
            Err(other) => return Err(other),
        }
    };
    let truncated = filed.as_ref().is_some_and(|walked| walked.filled);
    let mut folder_by_document: BTreeMap<String, String> = BTreeMap::new();
    for row in filed.iter().flat_map(|walked| walked.rows.iter()) {
        if let (Some(target_id), Some(concept_id)) =
            (text_of(row, "target_id"), text_of(row, "concept_id"))
        {
            folder_by_document.insert(target_id, concept_id);
        }
    }

    let origin_map = origins.data().cloned().unwrap_or_default();
    let windowed: Vec<String> = folder_by_document
        .keys()
        .chain(origin_map.keys())
        .cloned()
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    if windowed.is_empty() {
        return Ok((
            DriveData {
                folders,
                documents: Vec::new(),
                root_folder_id,
                truncated: false,
                window,
                shared_from_known: origins.known(),
            },
            None,
        ));
    }

    let wrappers = match walk(door, &documents_statement(&windowed)?, DOC_JOIN_BOUND)? {
        Walked::Denied(denial) => return Ok(denied_drive(denial, window)),
        Walked::Rows(rows) => rows,
    };
    let mut decorations = match read_decorations(
        door,
        &taxonomy,
        &wrappers,
        folder_by_document,
        root_folder_id.clone(),
        now,
    )? {
        Err(denial) => return Ok(denied_drive(denial, window)),
        Ok(decorations) => decorations,
    };
    decorations.origins = origin_map;

    let mut documents: Vec<DocumentRow> = wrappers
        .iter()
        .filter_map(|wrapper| fold_row(wrapper, &decorations))
        .collect();
    // NEWEST FIRST BY `created_at`, the wrapper's own mint. v0 compares the
    // strings (`String(b.created_at).localeCompare(…)`) and these are ISO
    // instants, where byte order and collation agree.
    documents.sort_by(|left, right| {
        right
            .created_at
            .as_deref()
            .unwrap_or_default()
            .cmp(left.created_at.as_deref().unwrap_or_default())
            .then_with(|| left.document_id.cmp(&right.document_id))
    });

    Ok((
        DriveData {
            folders,
            documents,
            root_folder_id,
            truncated,
            window,
            shared_from_known: origins.known(),
        },
        None,
    ))
}

/// `search` — the same rows, in the order the index ranked them.
///
/// The FTS read is `ctx.vault.search`, which is not a [`PageQuery`] and belongs
/// to `crates/search`; the hits arrive here as the rows the index answered, **in
/// rank order**, and the fold keeps that order.
///
/// ONLY WRAPPERS CARRYING A FOLDERS-SCHEME TAG COME BACK, which is also why
/// trashed documents never match: a trashed document keeps its folder tag, so
/// the filter that drops an untagged hit is not what excludes it — the index is
/// (`search.ts:5`). A port that re-derived the exclusion from `deleted_at`
/// would drop a document the index was right to return.
pub fn load_search(
    door: &dyn PageDoor,
    hits: &[Row],
    now: &str,
) -> KitResult<(SearchData, Option<Denial>)> {
    if hits.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let document_ids: Vec<String> = hits
        .iter()
        .filter_map(|row| text_of(row, "document_id"))
        .collect();
    if document_ids.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let taxonomy = match read_taxonomy(door) {
        Ok(taxonomy) => taxonomy,
        Err(KitError::Door(message)) => {
            return Ok((
                SearchData::default(),
                Some(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }),
            ));
        }
        Err(other) => return Err(other),
    };
    let (_, root_folder_id) = fold_folders(&taxonomy);
    let folder_concepts: BTreeSet<String> = taxonomy
        .concepts_in(FOLDER_SCHEME_URI)
        .into_iter()
        .filter_map(|row| text_of(row, "concept_id"))
        .collect();

    let tags = match walk(door, &labels_statement(&document_ids)?, DOC_PAIR_BOUND)? {
        Walked::Denied(denial) => return Ok((SearchData::default(), Some(denial))),
        Walked::Rows(rows) => rows,
    };
    let mut folder_by_document: BTreeMap<String, String> = BTreeMap::new();
    for row in &tags {
        if let (Some(target_id), Some(concept_id)) =
            (text_of(row, "target_id"), text_of(row, "concept_id"))
            && folder_concepts.contains(&concept_id)
        {
            folder_by_document.insert(target_id, concept_id);
        }
    }
    // A match with no folders-scheme tag is not a document of this drive.
    let matched: Vec<&Row> = hits
        .iter()
        .filter(|row| {
            text_of(row, "document_id")
                .is_some_and(|document_id| folder_by_document.contains_key(&document_id))
        })
        .collect();
    if matched.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let wrappers: Vec<Row> = matched.iter().map(|row| (*row).clone()).collect();
    let mut decorations = match read_decorations(
        door,
        &taxonomy,
        &wrappers,
        folder_by_document,
        root_folder_id,
        now,
    )? {
        Err(denial) => return Ok((SearchData::default(), Some(denial))),
        Ok(decorations) => decorations,
    };
    decorations.snippets = hits
        .iter()
        .filter_map(|row| Some((text_of(row, "document_id")?, text_of(row, "_snippet")?)))
        .collect();

    // VAULT ORDER IS RANK ORDER (best match first) — keep it. No sort here, and
    // that absence is the behaviour.
    let documents: Vec<DocumentRow> = wrappers
        .iter()
        .filter_map(|wrapper| fold_row(wrapper, &decorations))
        .map(|mut row| {
            // v0 ships `""` rather than `null` for a hit with no snippet, so a
            // renderer never prints "null".
            row.snippet = Some(row.snippet.unwrap_or_default());
            row
        })
        .collect();
    Ok((SearchData { documents }, None))
}

/// `history` — a document's version chain.
///
/// Walked from `current_revision_id` through `parent_revision_id`, newest
/// first, each occurrence naming the content that became current at that moment
/// — so a document that returns to bytes it already held reads as two versions
/// rather than one node a content-keyed walk had to collapse (#996 R20(a)).
pub fn load_history(
    door: &dyn PageDoor,
    document_id: &str,
) -> KitResult<(HistoryData, Option<Denial>)> {
    if document_id.is_empty() {
        return Ok((HistoryData::default(), None));
    }
    // ONE ROW, ASKED FOR AS ONE ROW: a page's window is part of its type, so
    // the document read says `limit: 1` and means it.
    let wrapper = match door.page(
        &documents_statement(&[document_id.to_owned()])?,
        &PageRequest::first(1),
    ) {
        Ok(page) => page.rows.into_iter().next(),
        Err(KitError::Door(message)) => {
            return Ok((
                HistoryData::default(),
                Some(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }),
            ));
        }
        Err(other) => return Err(other),
    };
    let Some(wrapper) = wrapper else {
        return Ok((HistoryData::default(), None));
    };

    let revisions = match door.page(
        &revisions_statement(document_id),
        &PageRequest::first(MAX_CHAIN_STEPS.min(MAX_PAGE_ROWS)),
    ) {
        Ok(page) => page.rows,
        Err(KitError::Door(message)) => {
            return Ok((
                HistoryData::default(),
                Some(Denial {
                    code: None,
                    message: Some(message),
                    revoked_at: None,
                }),
            ));
        }
        Err(other) => return Err(other),
    };

    let (chain, asserted_at) = walk_chain(&wrapper, &revisions);
    let chain = if chain.is_empty() {
        // A DOCUMENT MINTED BEFORE ITS WRAPPER CARRIED A POINTER still has one
        // version: the bytes it is currently made of. Honest absence, not a hole.
        text_of(&wrapper, "current_content_id")
            .map(|content_id| vec![content_id])
            .unwrap_or_default()
    } else {
        chain
    };
    if chain.is_empty() {
        return Ok((HistoryData::default(), None));
    }

    let unique: Vec<String> = chain
        .iter()
        .cloned()
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let contents: BTreeMap<String, ContentRow> = match walk(
        door,
        &contents_statement("docs.history.contents", &unique)?,
        DOC_JOIN_BOUND,
    )? {
        Walked::Denied(denial) => return Ok((HistoryData::default(), Some(denial))),
        Walked::Rows(rows) => rows
            .iter()
            .filter_map(ContentRow::of)
            .map(|content| (content.content_id.clone(), content))
            .collect(),
    };
    // Bytes carry no media type since #996 R20(b). A SUPERSEDED version has no
    // representation of its own — the document's moved with the head — and an
    // edit never changes the format, so the head's answer covers the whole
    // chain, with the content index as the fallback for a version some other
    // owner also reads.
    let representations = read_representations(door, &unique, DOC_JOIN_BOUND).unwrap_or_default();
    let head_type = representations
        .owner(DOCUMENT_TARGET_TYPE, document_id)
        .map(str::to_owned);

    let versions = chain
        .iter()
        .enumerate()
        .map(|(index, content_id)| {
            let content = contents.get(content_id);
            let (content_uri, poster_uri) = uris_of(content);
            VersionRow {
                media_type: representations
                    .content(content_id)
                    .map(str::to_owned)
                    .or_else(|| head_type.clone()),
                byte_size: content.and_then(|content| content.byte_size),
                content_uri,
                poster_uri,
                current: index == 0,
                // The occurrence's own instant; a pre-#996 document with no
                // occurrence falls back to the content's mint, then the
                // document's.
                asserted_at: asserted_at
                    .get(content_id)
                    .cloned()
                    .or_else(|| content.and_then(|content| content.created_at.clone()))
                    .or_else(|| text_of(&wrapper, "created_at")),
                content_id: content_id.clone(),
            }
        })
        .collect();
    Ok((HistoryData { versions }, None))
}

/// Walk the occurrence chain in memory, over ids one read returned.
///
/// Returns the content ids newest-first and, per content id, the instant it
/// FIRST became current — because a content id can appear twice and the date
/// shown is the occurrence's.
#[must_use]
pub fn walk_chain(wrapper: &Row, revisions: &[Row]) -> (Vec<String>, BTreeMap<String, String>) {
    let by_id: BTreeMap<String, &Row> = revisions
        .iter()
        .filter_map(|row| text_of(row, "revision_id").map(|id| (id, row)))
        .collect();
    let mut chain: Vec<String> = Vec::new();
    let mut asserted_at: BTreeMap<String, String> = BTreeMap::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut at = text_of(wrapper, "current_revision_id");
    for _ in 0..MAX_CHAIN_STEPS {
        let Some(revision_id) = at.clone() else { break };
        if !seen.insert(revision_id.clone()) {
            break;
        }
        let Some(revision) = by_id.get(&revision_id) else {
            break;
        };
        let Some(content_id) = text_of(revision, "content_id") else {
            break;
        };
        chain.push(content_id.clone());
        if let Some(recorded_at) = text_of(revision, "recorded_at") {
            asserted_at.entry(content_id).or_insert(recorded_at);
        }
        at = text_of(revision, "parent_revision_id");
    }
    (chain, asserted_at)
}

/// `activity` — the app-plane read over `access.provenance`.
///
/// The vault's ACTUAL audit trail, one row per command write, scoped to exactly
/// this document. **Never a synthesized guess from `created_at`/`updated_at`.**
pub fn load_activity(
    door: &dyn PageDoor,
    document_id: &str,
) -> KitResult<(ActivityData, Option<Denial>)> {
    if document_id.is_empty() {
        return Ok((ActivityData::default(), None));
    }
    let rows = match walk(door, &provenance_statement(document_id), DOC_PAIR_BOUND)? {
        Walked::Denied(denial) => return Ok((ActivityData::default(), Some(denial))),
        Walked::Rows(rows) => rows,
    };
    let mut events: Vec<ActivityEvent> = rows
        .iter()
        .map(|row| ActivityEvent {
            activity: text_of(row, "prov_activity"),
            agent_kind: text_of(row, "agent_kind"),
            occurred_at: text_of(row, "occurred_at"),
        })
        .collect();
    // The walk already ordered by `occurred_at`; the sort survives because the
    // rail's order is the RAIL'S OWN CLAIM, not a page boundary's.
    events.sort_by(|left, right| {
        right
            .occurred_at
            .as_deref()
            .unwrap_or_default()
            .cmp(left.occurred_at.as_deref().unwrap_or_default())
    });
    Ok((ActivityData { events }, None))
}

/// The nine windows the whole app walks under [`SHARE_FAN_OUT`], plus the
/// statements this module owns — named so a plan snapshot and a parity fixture
/// can be compared against one list.
#[must_use]
pub fn statement_names() -> Vec<&'static str> {
    let mut names = vec![
        "_shared/taxonomy.concepts",
        "_shared/taxonomy.schemes",
        "_shared/representations",
        "docs.drive.filed",
        "docs.drive.documents",
        "docs.drive.starred",
        "docs.drive.contents",
        "docs.labels.tags",
        "docs.custody.byContent",
        "docs.history.revisions",
        "docs.history.contents",
        "docs.activity.provenance",
        "docs.origins.subscriptions",
        "docs.origins.lineage",
    ];
    names.extend(crate::shares::SHARE_WINDOWS);
    names.sort_unstable();
    names.dedup();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pairs: &[(&str, &str)]) -> Row {
        let mut row = Row::new();
        for (column, value) in pairs {
            row.insert((*column).to_owned(), Cell::Text((*value).to_owned()));
        }
        row
    }

    /// A CLAMP, NOT A REFUSAL, and in v0's own order: a `0` limit falls back to
    /// the default because v0 writes `Number(input?.limit) || 200`, which `??`
    /// would not do.
    #[test]
    fn the_drive_window_clamps_the_way_v0_clamps() {
        assert_eq!(DriveInput { limit: None }.window(), DRIVE_DEFAULT);
        assert_eq!(DriveInput { limit: Some(0) }.window(), DRIVE_DEFAULT);
        assert_eq!(DriveInput { limit: Some(1) }.window(), DRIVE_MIN);
        assert_eq!(DriveInput { limit: Some(500) }.window(), 500);
        assert_eq!(DriveInput { limit: Some(9_000) }.window(), DRIVE_MAX);
    }

    /// THE ROOT IS THE DRIVE, NOT A FOLDER. It is out of the rail, and a folder
    /// filed under it is top-level.
    #[test]
    fn the_root_concept_is_not_a_folder_and_its_children_are_top_level() {
        let taxonomy = Taxonomy {
            schemes: vec![row(&[("scheme_id", "s1"), ("uri", FOLDER_SCHEME_URI)])],
            concepts: vec![
                row(&[
                    ("concept_id", "root-1"),
                    ("scheme_id", "s1"),
                    ("notation", ROOT_FOLDER_NOTATION),
                    ("pref_label", "Documents"),
                ]),
                row(&[
                    ("concept_id", "leases"),
                    ("scheme_id", "s1"),
                    ("notation", "leases"),
                    ("pref_label", "Leases"),
                    ("broader_concept_id", "root-1"),
                ]),
                row(&[
                    ("concept_id", "2024"),
                    ("scheme_id", "s1"),
                    ("notation", "2024"),
                    ("pref_label", "2024"),
                    ("broader_concept_id", "leases"),
                ]),
            ],
        };
        let (folders, root) = fold_folders(&taxonomy);
        assert_eq!(root.as_deref(), Some("root-1"));
        assert_eq!(folders.len(), 2, "the root is not in the rail");
        // Sorted by name: "2024" before "Leases".
        assert_eq!(folders[0].folder_id, "2024");
        assert_eq!(folders[0].parent_id.as_deref(), Some("leases"));
        assert_eq!(folders[1].folder_id, "leases");
        assert_eq!(
            folders[1].parent_id, None,
            "a folder under the root is top-level"
        );
    }

    /// THE COLUMN v0 DOES NOT SELECT. Without `broader_concept_id` in the
    /// projection every folder reads as top-level AND the folder chain a share
    /// walks up is one step long — so a share on a grandparent never reaches
    /// the document. This is the red for R-1020-35 finding 1.
    #[test]
    fn the_taxonomy_read_selects_the_column_the_folder_chain_needs() {
        let select = taxonomy_concepts_statement().select;
        assert!(
            select.contains("broader_concept_id"),
            "v0's projection is `concept_id, scheme_id, pref_label, notation` and the two \
             readers of `broader_concept_id` then see undefined: {select}"
        );
        // And the chain is what would be one step long without it.
        let taxonomy = Taxonomy {
            schemes: vec![row(&[("scheme_id", "s1"), ("uri", FOLDER_SCHEME_URI)])],
            concepts: vec![
                row(&[
                    ("concept_id", "root-1"),
                    ("scheme_id", "s1"),
                    ("notation", "root"),
                ]),
                row(&[
                    ("concept_id", "leases"),
                    ("scheme_id", "s1"),
                    ("broader_concept_id", "root-1"),
                ]),
                row(&[
                    ("concept_id", "2024"),
                    ("scheme_id", "s1"),
                    ("broader_concept_id", "leases"),
                ]),
            ],
        };
        let chain = crate::shares::folder_chain(Some("2024"), &taxonomy.folder_parents());
        assert_eq!(
            chain,
            ["2024", "leases", "root-1"],
            "a share on `root-1` has to reach a document filed in `2024`"
        );
    }

    /// A tag from another scheme is not a label. Printing one would put
    /// "Leases" and "Starred" in the chip rail.
    #[test]
    fn only_tags_scheme_concepts_are_labels() {
        let taxonomy = Taxonomy {
            schemes: vec![
                row(&[("scheme_id", "tags"), ("uri", TAGS_SCHEME_URI)]),
                row(&[("scheme_id", "folders"), ("uri", FOLDER_SCHEME_URI)]),
            ],
            concepts: vec![
                row(&[
                    ("concept_id", "c-appliances"),
                    ("scheme_id", "tags"),
                    ("pref_label", "Appliances"),
                ]),
                row(&[
                    ("concept_id", "c-leases"),
                    ("scheme_id", "folders"),
                    ("pref_label", "Leases"),
                ]),
            ],
        };
        let labels = fold_labels(
            &taxonomy,
            &[
                row(&[
                    ("tag_id", "t1"),
                    ("target_id", "d1"),
                    ("concept_id", "c-appliances"),
                ]),
                row(&[
                    ("tag_id", "t2"),
                    ("target_id", "d1"),
                    ("concept_id", "c-leases"),
                ]),
            ],
        );
        assert_eq!(labels["d1"].len(), 1);
        assert_eq!(labels["d1"][0].label, "Appliances");
        // The tag_id is carried because `untag` removes by the edge.
        assert_eq!(labels["d1"][0].tag_id, "t1");
    }

    /// A label falls back to its NOTATION where the concept has no preferred
    /// label, so a tag written by an importer still prints as a word.
    #[test]
    fn a_label_falls_back_to_its_notation() {
        let taxonomy = Taxonomy {
            schemes: vec![row(&[("scheme_id", "tags"), ("uri", TAGS_SCHEME_URI)])],
            concepts: vec![row(&[
                ("concept_id", "c1"),
                ("scheme_id", "tags"),
                ("notation", "warranty"),
            ])],
        };
        let labels = fold_labels(
            &taxonomy,
            &[row(&[
                ("tag_id", "t1"),
                ("target_id", "d1"),
                ("concept_id", "c1"),
            ])],
        );
        assert_eq!(labels["d1"][0].label, "warranty");
    }

    /// #296: BLOB BYTES SERVE AS SAME-ORIGIN URLs so Range and caching work;
    /// a `data:` URI passes through and has no poster, because there is no
    /// derivative to ask for.
    #[test]
    fn a_blob_uri_becomes_a_route_and_a_data_uri_passes_through() {
        let blob = ContentRow {
            content_id: "c1".to_owned(),
            byte_size: Some(9),
            content_uri: Some("blob:sha256-ab".to_owned()),
            created_at: None,
        };
        let (src, poster) = uris_of(Some(&blob));
        assert_eq!(src.as_deref(), Some("/centraid/_vault/blobs/c1"));
        assert_eq!(
            poster.as_deref(),
            Some("/centraid/_vault/blobs/c1?variant=poster")
        );

        let inline = ContentRow {
            content_uri: Some("data:text/plain,hi".to_owned()),
            ..blob.clone()
        };
        let (src, poster) = uris_of(Some(&inline));
        assert_eq!(src.as_deref(), Some("data:text/plain,hi"));
        assert_eq!(poster, None);

        // NO URI IS NOT A BLANK SRC: a tile with no bytes is a state.
        let empty = ContentRow {
            content_uri: None,
            ..blob
        };
        assert_eq!(uris_of(Some(&empty)), (None, None));
        assert_eq!(uris_of(None), (None, None));
    }

    /// #996 R20(a): A CONTENT ID CAN APPEAR TWICE IN ONE CHAIN, and the date
    /// shown is the OCCURRENCE's — its first, walking back from the head.
    #[test]
    fn the_chain_walks_occurrences_and_dates_each_by_its_own() {
        let wrapper = row(&[
            ("document_id", "d1"),
            ("current_content_id", "cb"),
            ("current_revision_id", "r4"),
        ]);
        // A -> B -> A -> B, newest last written.
        let revisions = vec![
            row(&[
                ("revision_id", "r1"),
                ("content_id", "ca"),
                ("recorded_at", "2099-06-01T00:00:00.000Z"),
            ]),
            row(&[
                ("revision_id", "r2"),
                ("content_id", "cb"),
                ("parent_revision_id", "r1"),
                ("recorded_at", "2099-06-02T00:00:00.000Z"),
            ]),
            row(&[
                ("revision_id", "r3"),
                ("content_id", "ca"),
                ("parent_revision_id", "r2"),
                ("recorded_at", "2099-06-03T00:00:00.000Z"),
            ]),
            row(&[
                ("revision_id", "r4"),
                ("content_id", "cb"),
                ("parent_revision_id", "r3"),
                ("recorded_at", "2099-06-04T00:00:00.000Z"),
            ]),
        ];
        let (chain, asserted_at) = walk_chain(&wrapper, &revisions);
        assert_eq!(chain, ["cb", "ca", "cb", "ca"], "four versions, not two");
        // The FIRST occurrence walking back from the head is the one dated.
        assert_eq!(
            asserted_at["cb"].as_str(),
            "2099-06-04T00:00:00.000Z",
            "the newest occurrence of those bytes"
        );
        assert_eq!(asserted_at["ca"].as_str(), "2099-06-03T00:00:00.000Z");
    }

    /// A CYCLE IN THE OCCURRENCE CHAIN TERMINATES rather than hanging the rail,
    /// and a chain longer than the cap stops at the cap.
    #[test]
    fn a_malformed_chain_is_capped_and_a_cycle_terminates() {
        let wrapper = row(&[("document_id", "d1"), ("current_revision_id", "r1")]);
        let cyclic = vec![
            row(&[
                ("revision_id", "r1"),
                ("content_id", "c1"),
                ("parent_revision_id", "r2"),
            ]),
            row(&[
                ("revision_id", "r2"),
                ("content_id", "c2"),
                ("parent_revision_id", "r1"),
            ]),
        ];
        let (chain, _) = walk_chain(&wrapper, &cyclic);
        assert_eq!(chain, ["c1", "c2"]);

        let long: Vec<Row> = (0..600)
            .map(|index| {
                let mut row = Row::new();
                row.insert("revision_id".to_owned(), Cell::Text(format!("r{index}")));
                row.insert("content_id".to_owned(), Cell::Text(format!("c{index}")));
                row.insert(
                    "parent_revision_id".to_owned(),
                    Cell::Text(format!("r{}", index + 1)),
                );
                row
            })
            .collect();
        let (chain, _) = walk_chain(&row(&[("current_revision_id", "r0")]), &long);
        assert_eq!(chain.len(), MAX_CHAIN_STEPS);
    }

    /// An occurrence whose content was purged TRUNCATES the chain rather than
    /// dangling: `core_entity_revision.content_id` is `ON DELETE SET NULL`
    /// precisely so a purge does not wedge a delete, and a legible short answer
    /// beats a hole.
    #[test]
    fn an_occurrence_with_no_content_ends_the_walk() {
        let mut purged = row(&[("revision_id", "r2"), ("parent_revision_id", "r3")]);
        purged.insert("content_id".to_owned(), Cell::Null);
        let revisions = vec![
            row(&[
                ("revision_id", "r1"),
                ("content_id", "c1"),
                ("parent_revision_id", "r2"),
            ]),
            purged,
            row(&[("revision_id", "r3"), ("content_id", "c3")]),
        ];
        let (chain, _) = walk_chain(&row(&[("current_revision_id", "r1")]), &revisions);
        assert_eq!(chain, ["c1"]);
    }

    /// Every statement this app runs is named once, and the nine share windows
    /// are among them.
    #[test]
    fn every_statement_is_named_and_the_share_windows_are_included() {
        let names = statement_names();
        assert_eq!(names.len(), 14 + crate::shares::SHARE_WINDOWS.len());
        for window in crate::shares::SHARE_WINDOWS {
            assert!(names.contains(&window), "{window}");
        }
        for name in &names {
            assert!(
                name.starts_with("docs.") || name.starts_with("_shared/"),
                "{name} is not a Docs statement"
            );
        }
    }

    /// The activity rail reads the vault's own audit trail, scoped by the
    /// polymorphic `(entity_type, entity_id)` pair — the seam D-1020-DC6 asks
    /// about, and the answer is YES, Docs depends on it.
    #[test]
    fn the_activity_rail_is_scoped_by_the_polymorphic_pair() {
        let statement = provenance_statement("d1");
        assert_eq!(statement.from, "access_provenance");
        assert_eq!(
            statement.r#where.as_deref(),
            Some("entity_type = ? AND entity_id = ?")
        );
        assert_eq!(
            statement.bind.first(),
            Some(&PageBindValue::Text(DOCUMENT_TARGET_TYPE.to_owned()))
        );
        assert!(statement.order.descending, "newest first");
    }
}
