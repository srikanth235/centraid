//! v0's QUERIES — less the retired autofill pair and Watchtower — as
//! statements-as-data plus pure folds.
//!
//! Four facts run through all of them and are stated once, here:
//!
//! 1. **[`ITEM_COLUMNS`] is the browsable half, and no sealed cell is on it.**
//!    `password`, `otp_seed`, `card_number`, `cvv` and `content` are absent **by
//!    construction rather than stripped afterwards**, and every shelf — live,
//!    archived, trash, search — projects exactly this
//!    list, so there is one place to read to know what a Locker list can carry
//!    (`queries/items.ts:27`-`:39`).
//! 2. **Listing is not unlocking.** These statements run on the phone's own
//!    rows under the app grant alone. That is why title, url and username are
//!    plaintext at rest at all: listing and search need no `K`
//!    (`locker-key-plane.ts:21`-`:23`).
//! 3. **A stated window is walked, not clamped** (D-1020-D3-12, R-1020-35).
//!    `MAX_PAGE_ROWS` clamps a page at 500, so v0's four 2,000-row shelves each
//!    asked for their window as one page and got a quarter of it with a `next`
//!    cursor nobody read — *v0's review audited a quarter of the vault and
//!    reported it as all of it*. v0's own comments now say "WALKED, NOT
//!    CLAMPED" at each of the four, and this port walks with
//!    [`centraid_apps_kit::read_window`], which also **reports whether the
//!    window filled**.
//!
//! ## The nullable sort key, and why these windows are honest about it
//!
//! Every shelf orders by `updated_at DESC, item_id`. `locker_item.updated_at`
//! is `NOT NULL DEFAULT (strftime(…))`, so unlike Photos' `captured_at` the
//! keyset walk is total and a 2,000-row window is genuinely reachable. The one
//! statement that does order by a nullable column is nobody's: `access`'s
//! `occurred_at` is `NOT NULL` too. So the kit's `NullableSortKey` refusal is
//! not in Locker's path, and the walks above are the real thing rather than
//! one page with a flag.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, Window, in_list, read_by_id, read_window};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::types::{AUTH_ENTITY_TYPE, ITEM_ENTITY_TYPE, degrade_type, degraded_from};

/// THE BROWSABLE HALF OF A LOCKER ITEM (#996 wave 4, R8 and W6-D2).
///
/// A statement names its columns, and **no sealed cell is on this list**.
pub const ITEM_COLUMNS: &str = "item_id, type, title, username, url, notes, \
     cardholder, expiry, brand, fullname, email, phone, address, network, \
     compromised, password_set_at, created_at, updated_at, \
     archived_at, deleted_at, purge_at";

/// The five columns of `locker_item` that hold ciphertext under `K`, named here
/// only so [`tests`] can assert none of them is in [`ITEM_COLUMNS`].
pub const SEALED_ITEM_COLUMNS: [&str; 5] =
    ["password", "otp_seed", "card_number", "cvv", "content"];

/// The default and the bounds of the `items` window (`items.ts`, and the
/// manifest's own input schema: 20…2,000, default 300).
pub const ITEMS_DEFAULT: usize = 300;
pub const ITEMS_MIN: usize = 20;
pub const ITEMS_MAX: usize = 2_000;

/// `SEARCH_ROWS` (`search.ts:26`). The shelf the term is matched over.
pub const SEARCH_ROWS: usize = 500;
/// `TRASH_ROWS` (`trash.ts:18`).
pub const TRASH_ROWS: usize = 2_000;
/// `access.ts:20`-`:21` — the default and the ceiling of the audit window.
pub const ACCESS_DEFAULT: usize = 200;
pub const ACCESS_MAX: usize = 2_000;

/// The two concept schemes, and the star's notation.
///
/// Restated here because `_shared/concept-scheme-kit.ts` is an import-free leaf
/// on the v0 side too. **The two URIs are spelled differently and that is
/// deliberate**: the flags scheme is an `https` URI because flag SQL fragments
/// are interpolated into condition SQL, where a `urn:`-style `:flags` reads as
/// a NAMED PARAMETER (#258, the colon-literal trap).
pub const FLAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/flags";
pub const LOCKER_TAGS_SCHEME_URI: &str = "https://centraid.dev/schemes/locker-tags";
pub const STARRED_NOTATION: &str = "starred";

/// Clamp a caller's `limit` the way v0 does: `min(max(limit || default, min), max)`.
#[must_use]
pub fn items_window(limit: Option<i64>) -> usize {
    let asked = match limit {
        Some(value) if value > 0 => usize::try_from(value).unwrap_or(ITEMS_MAX),
        _ => ITEMS_DEFAULT,
    };
    asked.clamp(ITEMS_MIN, ITEMS_MAX)
}

/// The same clamp for the audit window (`access.ts:22`-`:25`).
#[must_use]
pub fn access_window(limit: Option<i64>) -> usize {
    let asked = match limit {
        Some(value) if value > 0 => usize::try_from(value).unwrap_or(ACCESS_MAX),
        _ => ACCESS_DEFAULT,
    };
    asked.clamp(ITEMS_MIN, ACCESS_MAX)
}

/// Which shelf the `items` query is showing.
///
/// Archived is *"keep forever, hide from lists"* and the schema's own CHECK
/// makes archived-and-trashed unrepresentable, so the shelf is **asked for
/// explicitly** rather than filtered client-side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Shelf {
    #[default]
    Live,
    Archived,
}

impl Shelf {
    const fn statement_name(self) -> &'static str {
        match self {
            Self::Live => "locker.items.live",
            Self::Archived => "locker.items.archived",
        }
    }

    const fn predicate(self) -> &'static str {
        match self {
            Self::Live => "deleted_at IS NULL AND archived_at IS NULL",
            Self::Archived => "deleted_at IS NULL AND archived_at IS NOT NULL",
        }
    }
}

/// The item shelf statement, for either shelf.
#[must_use]
pub fn items_statement(shelf: Shelf) -> PageQuery {
    PageQuery::new(
        shelf.statement_name(),
        ITEM_COLUMNS,
        "locker_item",
        PageOrder::desc("updated_at", "item_id"),
    )
    .filter(shelf.predicate(), Vec::new())
}

/// The search shelf: every live item, matched in the fold.
///
/// **The matching runs over the rows, not in SQL, and that is v0's answer, not
/// an oversight.** `username` and `url` participate in the match and do **not**
/// ride the answer's subtitle for a non-login, so a member finds a login by a
/// username that never leaves the vault in a list.
#[must_use]
pub fn search_statement() -> PageQuery {
    PageQuery::new(
        "locker.search.items",
        ITEM_COLUMNS,
        "locker_item",
        PageOrder::desc("updated_at", "item_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// The trash shelf.
#[must_use]
pub fn trash_statement() -> PageQuery {
    PageQuery::new(
        "locker.trash.items",
        ITEM_COLUMNS,
        "locker_item",
        PageOrder::desc("updated_at", "item_id"),
    )
    .filter("deleted_at IS NOT NULL", Vec::new())
}

/// THE AUDIT WINDOW, AND THE INNER OF ITS TWO WALLS (census §A8).
///
/// The manifest's `rowFilter` on `object_type` is the outer wall, carried per
/// call as the page door's execution clamp. This predicate names the same two
/// types **in the statement**, so the page is filtered *before* the window
/// rather than after — without it a busy vault's newest 200 receipts could be
/// entirely someone else's and the clamp would hand this screen an empty
/// history.
pub fn access_statement(item_id: Option<&str>) -> KitResult<PageQuery> {
    let types = in_list(
        "object_type",
        &[ITEM_ENTITY_TYPE.to_owned(), AUTH_ENTITY_TYPE.to_owned()],
    )?;
    let (predicate, mut bind) = match item_id {
        Some(id) if !id.is_empty() => (format!("{} AND object_id = ?", types.sql), {
            let mut bind = types.bind;
            bind.push(PageBindValue::Text(id.to_owned()));
            bind
        }),
        _ => (types.sql, types.bind),
    };
    bind.shrink_to_fit();
    Ok(PageQuery::new(
        "locker.access.receipts",
        "receipt_id, action, object_type, object_id, decision, occurred_at, detail_json",
        "access_receipt",
        PageOrder::desc("occurred_at", "receipt_id"),
    )
    .filter(&predicate, bind))
}

/// One raw `locker_item` row, in the browsable projection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ItemRow {
    pub item_id: String,
    pub item_type: String,
    pub title: String,
    pub username: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
    pub cardholder: Option<String>,
    pub expiry: Option<String>,
    pub brand: Option<String>,
    pub fullname: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub network: Option<String>,
    /// The **one stored security fact** (weak and reused are not scored,
    /// Q-1047-16).
    pub compromised: bool,
    /// When the CURRENT password was set. `None` honestly says "unknown"
    /// rather than claiming an age Review would then reason from.
    pub password_set_at: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

impl ItemRow {
    /// Read one row of [`ITEM_COLUMNS`].
    #[must_use]
    pub fn of(row: &Row) -> Self {
        Self {
            item_id: text_of(row, "item_id").unwrap_or_default(),
            item_type: text_of(row, "type").unwrap_or_default(),
            title: text_of(row, "title").unwrap_or_default(),
            username: text_of(row, "username"),
            url: text_of(row, "url"),
            notes: text_of(row, "notes"),
            cardholder: text_of(row, "cardholder"),
            expiry: text_of(row, "expiry"),
            brand: text_of(row, "brand"),
            fullname: text_of(row, "fullname"),
            email: text_of(row, "email"),
            phone: text_of(row, "phone"),
            address: text_of(row, "address"),
            network: text_of(row, "network"),
            compromised: truthy(row, "compromised"),
            password_set_at: text_of(row, "password_set_at"),
            created_at: text_of(row, "created_at"),
            updated_at: text_of(row, "updated_at"),
            archived_at: text_of(row, "archived_at"),
            deleted_at: text_of(row, "deleted_at"),
            purge_at: text_of(row, "purge_at"),
        }
    }

    /// Whether the term matches this row, over the three columns v0 matches
    /// over — title, username and url — case-insensitively.
    #[must_use]
    pub fn matches(&self, term: &str) -> bool {
        let hit = |value: &str| value.to_lowercase().contains(term);
        hit(&self.title)
            || self.username.as_deref().is_some_and(hit)
            || self.url.as_deref().is_some_and(hit)
    }
}

fn truthy(row: &Row, column: &str) -> bool {
    match row.get(column) {
        Some(centraid_apps_kit::row::Cell::Integer(value)) => *value == 1,
        Some(centraid_apps_kit::row::Cell::Text(value)) => value == "1" || value == "true",
        _ => false,
    }
}

/// How loud a row is on the review shelf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    /// The breach flag. The one stored fact, and the loudest.
    Danger,
    /// Nothing to say.
    None,
}

impl Severity {
    /// v0's spelling — `""` for none, which a renderer uses as a class name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Danger => "danger",
            Self::None => "",
        }
    }
}

/// A decorated list row — the shape every Locker shelf returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decorated {
    pub item_id: String,
    pub item_type: String,
    pub title: String,
    /// A **secret-free** subtitle. A card's is the word `Card`: its last four
    /// digits are sealed with the rest of the number.
    pub subtitle: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub compromised: bool,
    pub severity: Severity,
    pub url: Option<String>,
    pub expiry: Option<String>,
    pub updated_at: Option<String>,
    pub purge_at: Option<String>,
    /// The connector alias, read back from `locker_item_alias`.
    pub alias: Option<String>,
    pub archived: bool,
    pub password_set_at: Option<String>,
}

/// A safe, secret-free subtitle for a list row (`items.ts`'s `subtitleOf`).
#[must_use]
pub fn subtitle_of(row: &ItemRow) -> String {
    let or_dash = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|text| !text.is_empty())
            .unwrap_or("—")
            .to_owned()
    };
    match row.item_type.as_str() {
        "login" => or_dash(&row.username),
        "card" => "Card".to_owned(),
        "note" => "Secure note".to_owned(),
        "identity" => or_dash(&row.email),
        "wifi" => or_dash(&row.network),
        _ => "Password".to_owned(),
    }
}

/// The decorations a shelf folds over its rows.
#[derive(Debug, Clone, Default)]
pub struct Decorations {
    pub tags: BTreeMap<String, Vec<String>>,
    pub starred: BTreeSet<String>,
    pub alias: BTreeMap<String, String>,
}

/// `decorate`, ported. Pure.
#[must_use]
pub fn decorate(rows: &[ItemRow], decorations: &Decorations) -> Vec<Decorated> {
    rows.iter()
        .map(|row| {
            let severity = if row.compromised {
                Severity::Danger
            } else {
                Severity::None
            };
            Decorated {
                item_id: row.item_id.clone(),
                item_type: row.item_type.clone(),
                title: row.title.clone(),
                subtitle: subtitle_of(row),
                favorite: decorations.starred.contains(&row.item_id),
                tags: decorations
                    .tags
                    .get(&row.item_id)
                    .cloned()
                    .unwrap_or_default(),
                compromised: row.compromised,
                severity,
                url: row.url.clone(),
                expiry: row.expiry.clone(),
                updated_at: row.updated_at.clone(),
                purge_at: row.purge_at.clone(),
                alias: decorations.alias.get(&row.item_id).cloned(),
                archived: row.archived_at.is_some(),
                password_set_at: row.password_set_at.clone(),
            }
        })
        .collect()
}

/// The vault's own counts, for "300 of 312".
///
/// Counted **inside** the vault rather than by reading the ceiling back and
/// taking its length: the foot line's whole job is to say how much is beyond
/// the window, so deriving it from the window would be circular. Every field is
/// an `Option` because a count that failed soft must make the foot line say
/// **nothing**, never a wrong number.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Counts {
    pub live: Option<i64>,
    pub archived: Option<i64>,
    pub trashed: Option<i64>,
    pub by_type: Option<Vec<(String, i64)>>,
}

/// What the `items` query answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemsAnswer {
    pub items: Vec<Decorated>,
    /// The window is longer than what was read.
    pub truncated: bool,
    pub window: usize,
    pub archived: bool,
    pub total: Option<i64>,
    pub by_type: Option<Vec<(String, i64)>>,
    pub archived_count: Option<i64>,
    pub trashed_count: Option<i64>,
}

/// Fold the `items` answer. Pure — the reads happened above it.
#[must_use]
pub fn items_answer(
    shelf: Shelf,
    window: usize,
    read: &Window,
    decorations: &Decorations,
    counts: Option<&Counts>,
) -> ItemsAnswer {
    let rows: Vec<ItemRow> = read.rows.iter().map(ItemRow::of).collect();
    let items = decorate(&rows, decorations);
    let archived = shelf == Shelf::Archived;
    ItemsAnswer {
        truncated: read.filled,
        window,
        archived,
        total: counts.and_then(|counts| {
            if archived {
                counts.archived
            } else {
                counts.live
            }
        }),
        by_type: counts.and_then(|counts| counts.by_type.clone()),
        archived_count: counts.and_then(|counts| counts.archived),
        trashed_count: counts.and_then(|counts| counts.trashed),
        items,
    }
}

/// Walk a shelf to its stated window.
pub fn read_shelf(door: &dyn PageDoor, query: &PageQuery, rows: usize) -> KitResult<Window> {
    read_window(door, query, rows)
}

/// item_id → the connector alias, over a bounded set of ids.
pub fn alias_statement(ids: &[String]) -> KitResult<PageQuery> {
    let items = in_list("item_id", ids)?;
    Ok(PageQuery::new(
        "locker.items.aliases",
        "alias, item_id",
        "locker_item_alias",
        PageOrder::asc("alias", "alias"),
    )
    .filter(&items.sql, items.bind))
}

/// The tag statement over a bounded set of ids.
pub fn tags_statement(ids: &[String]) -> KitResult<PageQuery> {
    let targets = in_list("target_id", ids)?;
    let mut bind = vec![PageBindValue::Text(ITEM_ENTITY_TYPE.to_owned())];
    bind.extend(targets.bind);
    Ok(PageQuery::new(
        "locker.items.tags",
        "tag_id, target_type, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(&format!("target_type = ? AND {}", targets.sql), bind))
}

/// The two SKOS vocabulary statements, read once and shared by tags and stars
/// (#404) — not a second full read and a second receipted unseal.
#[must_use]
pub fn concepts_statement() -> PageQuery {
    PageQuery::new(
        "locker.items.concepts",
        "concept_id, scheme_id, pref_label, notation",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
}

#[must_use]
pub fn schemes_statement() -> PageQuery {
    PageQuery::new(
        "locker.items.schemes",
        "scheme_id, uri",
        "core_concept_scheme",
        PageOrder::asc("scheme_id", "scheme_id"),
    )
}

/// The two vocabulary tables, as read.
#[derive(Debug, Clone, Default)]
pub struct Vocabulary {
    /// `concept_id` → `(scheme_id, pref_label, notation)`.
    pub concepts: Vec<(String, String, Option<String>, Option<String>)>,
    /// `scheme_id` → `uri`.
    pub schemes: BTreeMap<String, String>,
}

impl Vocabulary {
    /// Read the two statements' rows.
    #[must_use]
    pub fn of(concepts: &[Row], schemes: &[Row]) -> Self {
        Self {
            concepts: concepts
                .iter()
                .map(|row| {
                    (
                        text_of(row, "concept_id").unwrap_or_default(),
                        text_of(row, "scheme_id").unwrap_or_default(),
                        text_of(row, "pref_label"),
                        text_of(row, "notation"),
                    )
                })
                .collect(),
            schemes: schemes
                .iter()
                .filter_map(|row| Some((text_of(row, "scheme_id")?, text_of(row, "uri")?)))
                .collect(),
        }
    }

    fn scheme_id(&self, uri: &str) -> Option<&str> {
        self.schemes
            .iter()
            .find(|(_, known)| known.as_str() == uri)
            .map(|(id, _)| id.as_str())
    }

    /// The tag labels of the locker-tags scheme, by concept id.
    #[must_use]
    pub fn tag_labels(&self) -> BTreeMap<String, String> {
        let Some(scheme) = self.scheme_id(LOCKER_TAGS_SCHEME_URI) else {
            return BTreeMap::new();
        };
        self.concepts
            .iter()
            .filter(|(_, scheme_id, _, _)| scheme_id == scheme)
            .filter_map(|(concept_id, _, label, _)| Some((concept_id.clone(), label.clone()?)))
            .collect()
    }

    /// The star's concept id, if the flags scheme carries one.
    #[must_use]
    pub fn starred_concept(&self) -> Option<String> {
        let scheme = self.scheme_id(FLAGS_SCHEME_URI)?;
        self.concepts
            .iter()
            .find(|(_, scheme_id, _, notation)| {
                scheme_id == scheme && notation.as_deref() == Some(STARRED_NOTATION)
            })
            .map(|(concept_id, _, _, _)| concept_id.clone())
    }
}

/// Fold tag rows into `item_id` → labels, sorted, **dropping a concept that is
/// not a tag** — a flags-scheme star rides the same table and is not a label.
#[must_use]
pub fn fold_tags(rows: &[Row], vocabulary: &Vocabulary) -> BTreeMap<String, Vec<String>> {
    let labels = vocabulary.tag_labels();
    let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for row in rows {
        let Some(target) = text_of(row, "target_id") else {
            continue;
        };
        let Some(concept) = text_of(row, "concept_id") else {
            continue;
        };
        if let Some(label) = labels.get(&concept) {
            map.entry(target).or_default().push(label.clone());
        }
    }
    for labels in map.values_mut() {
        labels.sort_unstable();
    }
    map
}

/// Fold tag rows into the starred set.
#[must_use]
pub fn fold_starred(rows: &[Row], starred_concept: &str) -> BTreeSet<String> {
    rows.iter()
        .filter(|row| text_of(row, "concept_id").as_deref() == Some(starred_concept))
        .filter_map(|row| text_of(row, "target_id"))
        .collect()
}

/// What the `item` query answers: one item's full detail, sealed cells at rest.
///
/// **There is no reveal here** (#996 R13, W6-D2). In v0 this query handed the
/// gateway a session token and an item token and took plaintext off the
/// answer. Nothing but the phone's core unseals a Locker cell — with `K`,
/// derived from the seed, behind the biometric presence gate (D-5) — so what
/// comes back is the browsable half plus the shape of each secret. That is
/// also why this pane paints **while the Locker is locked**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemDetail {
    pub row: ItemRow,
    /// The type the pane renders. An unknown type reads as a note.
    pub rendered_type: String,
    /// What it degraded from, or `None`.
    pub degraded_from: Option<String>,
    pub favorite: bool,
    pub tags: Vec<String>,
    pub trashed: bool,
    pub archived: bool,
    pub alias: Option<String>,
    pub fields: Vec<crate::sidecars::Field>,
    pub addresses: Vec<crate::sidecars::Address>,
    pub passkey: Option<crate::sidecars::Passkey>,
    pub history: Vec<crate::sidecars::Revision>,
    pub attachments: Vec<crate::sidecars::Attachment>,
}

/// Read one item's own row. A missing or wrong id is `None`, never an error.
pub fn read_item_row(door: &dyn PageDoor, item_id: &str) -> KitResult<Option<ItemRow>> {
    Ok(read_by_id(
        door,
        "locker.item.row",
        ITEM_COLUMNS,
        "locker_item",
        "item_id",
        item_id,
    )?
    .as_ref()
    .map(ItemRow::of))
}

/// Fold the detail pane.
#[must_use]
pub fn item_detail(
    row: ItemRow,
    favorite: bool,
    tags: Vec<String>,
    alias: Option<String>,
    sidecars: crate::sidecars::Sidecars,
) -> ItemDetail {
    ItemDetail {
        rendered_type: degrade_type(&row.item_type).to_owned(),
        degraded_from: degraded_from(&row.item_type).map(str::to_owned),
        favorite,
        tags,
        trashed: row.deleted_at.is_some(),
        archived: row.archived_at.is_some(),
        alias,
        fields: sidecars.fields,
        addresses: sidecars.addresses,
        passkey: sidecars.passkey,
        history: sidecars.history,
        attachments: sidecars.attachments,
        row,
    }
}

/// One audit entry, and which of the two things it records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    /// An unlock. `object_type = locker.auth`.
    Auth,
    /// A reveal in the app.
    Reveal,
}

impl AccessKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Reveal => "reveal",
        }
    }
}

/// One row of the access history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessEntry {
    pub receipt_id: String,
    pub kind: AccessKind,
    pub action: String,
    /// `allow` or `deny`, and **anything that is not `deny` reads as `allow`**
    /// — v0's own coercion, kept because a third value must not read as a
    /// refusal that did not happen.
    pub allowed: bool,
    pub item_id: Option<String>,
    pub occurred_at: Option<String>,
    pub columns: Option<Vec<String>>,
    pub reason: Option<String>,
}

/// What the `access` query answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessAnswer {
    pub entries: Vec<AccessEntry>,
    pub window: usize,
    pub truncated: bool,
}

/// Fold the audit window.
///
/// The re-sort is v0's and is kept: the page already comes back
/// `occurred_at DESC`, and the fold sorts again by the same key so two receipts
/// in one millisecond land in a stable order rather than the keyset's.
#[must_use]
pub fn access_answer(window: usize, rows: &[Row]) -> AccessAnswer {
    let mut entries: Vec<AccessEntry> = rows
        .iter()
        .map(|row| {
            let object_type = text_of(row, "object_type").unwrap_or_default();
            let detail = text_of(row, "detail_json")
                .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
                .unwrap_or(serde_json::Value::Null);
            let kind = if object_type == AUTH_ENTITY_TYPE {
                AccessKind::Auth
            } else {
                AccessKind::Reveal
            };
            AccessEntry {
                receipt_id: text_of(row, "receipt_id").unwrap_or_default(),
                kind,
                action: text_of(row, "action").unwrap_or_default(),
                allowed: text_of(row, "decision").as_deref() != Some("deny"),
                item_id: if object_type == ITEM_ENTITY_TYPE {
                    text_of(row, "object_id")
                } else {
                    None
                },
                occurred_at: text_of(row, "occurred_at"),
                columns: detail["columns"].as_array().map(|columns| {
                    columns
                        .iter()
                        .map(|column| match column.as_str() {
                            Some(text) => text.to_owned(),
                            None => column.to_string(),
                        })
                        .collect()
                }),
                reason: detail["failing"].as_str().map(str::to_owned),
            }
        })
        .collect();
    entries.sort_by(|left, right| {
        right
            .occurred_at
            .cmp(&left.occurred_at)
            .then_with(|| left.receipt_id.cmp(&right.receipt_id))
    });
    AccessAnswer {
        truncated: rows.len() >= window,
        window,
        entries,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_apps_kit::row::Cell;

    fn row(pairs: &[(&str, &str)]) -> Row {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), Cell::Text((*value).to_owned())))
            .collect()
    }

    /// THE LIST PAYLOAD CANNOT CARRY A SECRET, and this is the assertion that
    /// says so about the projection rather than about a handler's behaviour.
    #[test]
    fn no_sealed_column_is_in_the_browsable_projection() {
        for column in SEALED_ITEM_COLUMNS {
            assert!(
                !ITEM_COLUMNS.split(", ").any(|named| named.trim() == column),
                "{column} is a sealed cell and it is in ITEM_COLUMNS"
            );
        }
        // The two sidecar sealed columns are not on it either.
        for column in ["value_sealed", "private_key"] {
            assert!(
                !ITEM_COLUMNS.contains(column),
                "{column} is in ITEM_COLUMNS"
            );
        }
        // …and the browsable half is still the browsable half.
        for column in ["title", "username", "url", "notes", "email", "network"] {
            assert!(ITEM_COLUMNS.contains(column), "{column} is missing");
        }
    }

    /// Every shelf projects the same list, so there is one place to read.
    #[test]
    fn every_shelf_projects_exactly_the_browsable_half() {
        for query in [
            items_statement(Shelf::Live),
            items_statement(Shelf::Archived),
            search_statement(),
            trash_statement(),
        ] {
            assert_eq!(query.select, ITEM_COLUMNS, "{} drifted", query.name);
            assert_eq!(query.from, "locker_item");
        }
    }

    /// The live shelf does not show archived items and the archived shelf
    /// shows only them — two predicates over one table.
    #[test]
    fn archived_is_its_own_shelf() {
        assert_eq!(
            items_statement(Shelf::Live).r#where.as_deref(),
            Some("deleted_at IS NULL AND archived_at IS NULL")
        );
        assert_eq!(
            items_statement(Shelf::Archived).r#where.as_deref(),
            Some("deleted_at IS NULL AND archived_at IS NOT NULL")
        );
    }

    /// THE INNER WALL. Without the predicate the clamp filters AFTER the
    /// window and a busy vault's newest 200 receipts are someone else's.
    #[test]
    fn the_audit_statement_names_both_object_types_in_sql() {
        let query = access_statement(None).expect("the statement builds");
        let predicate = query.r#where.clone().expect("a predicate");
        assert_eq!(predicate, "object_type IN (?, ?)");
        assert_eq!(query.bind.len(), 2);
        let pinned = access_statement(Some("item-1")).expect("the statement builds");
        assert_eq!(
            pinned.r#where.as_deref(),
            Some("object_type IN (?, ?) AND object_id = ?")
        );
        assert_eq!(pinned.bind.len(), 3);
        // An empty id is not a filter, it is no filter.
        assert_eq!(access_statement(Some("")).expect("builds").bind.len(), 2);
    }

    #[test]
    fn the_windows_clamp_the_way_v0_clamps() {
        assert_eq!(items_window(None), 300);
        assert_eq!(items_window(Some(0)), 300);
        assert_eq!(items_window(Some(5)), 20);
        assert_eq!(items_window(Some(400)), 400);
        assert_eq!(items_window(Some(99_999)), 2_000);
        assert_eq!(access_window(None), 200);
        assert_eq!(access_window(Some(1)), 20);
        assert_eq!(access_window(Some(9_999)), 2_000);
    }

    /// The breach flag is the one stored fact, and the only severity.
    #[test]
    fn only_the_breach_flag_raises_a_row() {
        let rows = vec![
            ItemRow {
                item_id: "i1".to_owned(),
                item_type: "login".to_owned(),
                compromised: true,
                ..ItemRow::default()
            },
            ItemRow {
                item_id: "i2".to_owned(),
                item_type: "login".to_owned(),
                ..ItemRow::default()
            },
        ];
        let decorated = decorate(&rows, &Decorations::default());
        assert_eq!(decorated[0].severity, Severity::Danger);
        assert_eq!(decorated[1].severity, Severity::None);
    }

    /// A card's subtitle is a word: its last four digits are sealed.
    #[test]
    fn a_card_subtitle_is_a_word_and_a_bare_login_a_dash() {
        let card = ItemRow {
            item_type: "card".to_owned(),
            ..ItemRow::default()
        };
        assert_eq!(subtitle_of(&card), "Card");
        let login = ItemRow {
            item_type: "login".to_owned(),
            username: None,
            ..ItemRow::default()
        };
        assert_eq!(subtitle_of(&login), "—");
    }

    #[test]
    fn the_search_fold_matches_title_username_and_url_only() {
        let row = ItemRow {
            item_id: "i1".to_owned(),
            title: "Bank".to_owned(),
            username: Some("ada@example.com".to_owned()),
            url: Some("https://bank.example".to_owned()),
            notes: Some("a memorable note".to_owned()),
            ..ItemRow::default()
        };
        assert!(row.matches("bank"));
        assert!(row.matches("ada@"));
        assert!(row.matches("bank.example"));
        // `notes` is plaintext and is NOT matched, exactly as v0 does not.
        assert!(!row.matches("memorable"));
    }

    #[test]
    fn an_auth_receipt_names_no_item_and_a_reveal_names_its_cell() {
        let rows = vec![
            row(&[
                ("receipt_id", "r2"),
                ("action", "reveal"),
                ("object_type", "locker.item"),
                ("object_id", "i1"),
                ("decision", "allow"),
                ("occurred_at", "2026-01-02T00:00:00.000Z"),
                (
                    "detail_json",
                    r#"{"context":{"kind":"reveal"},"columns":["password"]}"#,
                ),
            ]),
            row(&[
                ("receipt_id", "r1"),
                ("action", "unlock"),
                ("object_type", "locker.auth"),
                ("decision", "deny"),
                ("occurred_at", "2026-01-01T00:00:00.000Z"),
                (
                    "detail_json",
                    r#"{"failing":"the passphrase did not match"}"#,
                ),
            ]),
        ];
        let answer = access_answer(200, &rows);
        assert_eq!(answer.entries.len(), 2);
        assert_eq!(answer.entries[0].kind, AccessKind::Reveal);
        assert_eq!(
            answer.entries[0].columns.as_deref(),
            Some(&["password".to_owned()][..])
        );
        assert_eq!(answer.entries[0].item_id.as_deref(), Some("i1"));
        assert_eq!(answer.entries[1].kind, AccessKind::Auth);
        assert!(!answer.entries[1].allowed);
        // An auth receipt names no item, because it is about the vault.
        assert_eq!(answer.entries[1].item_id, None);
        assert!(!answer.truncated);
    }

    #[test]
    fn a_full_window_says_it_is_truncated() {
        let rows: Vec<Row> = (0..3)
            .map(|index| {
                row(&[
                    ("receipt_id", "r"),
                    ("action", "reveal"),
                    ("object_type", "locker.item"),
                    ("decision", "allow"),
                    ("occurred_at", "2026-01-01T00:00:00.000Z"),
                ])
                .into_iter()
                .chain([("object_id".to_owned(), Cell::Text(format!("i{index}")))])
                .collect()
            })
            .collect();
        assert!(access_answer(3, &rows).truncated);
        assert!(!access_answer(4, &rows).truncated);
    }

    #[test]
    fn a_star_is_not_a_tag_even_though_it_rides_the_same_table() {
        let vocabulary = Vocabulary {
            concepts: vec![
                (
                    "c-tag".to_owned(),
                    "s-tags".to_owned(),
                    Some("work".to_owned()),
                    None,
                ),
                (
                    "c-star".to_owned(),
                    "s-flags".to_owned(),
                    Some("Starred".to_owned()),
                    Some("starred".to_owned()),
                ),
            ],
            schemes: [
                ("s-tags".to_owned(), LOCKER_TAGS_SCHEME_URI.to_owned()),
                ("s-flags".to_owned(), FLAGS_SCHEME_URI.to_owned()),
            ]
            .into_iter()
            .collect(),
        };
        let rows = vec![
            row(&[
                ("tag_id", "t1"),
                ("target_id", "i1"),
                ("concept_id", "c-tag"),
            ]),
            row(&[
                ("tag_id", "t2"),
                ("target_id", "i1"),
                ("concept_id", "c-star"),
            ]),
        ];
        let tags = fold_tags(&rows, &vocabulary);
        assert_eq!(tags.get("i1"), Some(&vec!["work".to_owned()]));
        let starred_concept = vocabulary.starred_concept().expect("the flags scheme");
        assert_eq!(starred_concept, "c-star");
        let starred = fold_starred(&rows, &starred_concept);
        assert!(starred.contains("i1"));
    }

    /// A vault with no flags scheme has no stars, and the fold says so without
    /// reading every tag as one.
    #[test]
    fn a_vault_with_no_flags_scheme_has_no_stars() {
        let vocabulary = Vocabulary::default();
        assert_eq!(vocabulary.starred_concept(), None);
        assert!(vocabulary.tag_labels().is_empty());
    }
}
