//! THE EIGHT QUERIES, as statements-as-data plus pure folds.
//!
//! Ported from `packages/blueprints/apps/locker/queries/*.ts`. Four facts run
//! through all of them and are stated once, here:
//!
//! 1. **[`ITEM_COLUMNS`] is the browsable half, and no sealed cell is on it.**
//!    `password`, `otp_seed`, `card_number`, `cvv` and `content` are absent **by
//!    construction rather than stripped afterwards**, and every shelf — live,
//!    archived, trash, watchtower, search, autofill — projects exactly this
//!    list, so there is one place to read to know what a Locker list can carry
//!    (`queries/items.ts:27`-`:39`).
//! 2. **Listing is not unlocking.** These statements run on a seat's own rows
//!    under the app grant alone. That is why title, url and username are
//!    plaintext at rest at all: a locked seat still lists and searches, which
//!    is the whole reason Locker works on a phone in airplane mode
//!    (`locker-key-plane.ts:21`-`:23`).
//! 3. **A stated window is walked, not clamped** (D-1020-D3-12, R-1020-35).
//!    `MAX_PAGE_ROWS` clamps a page at 500, so v0's four 2,000-row shelves each
//!    asked for their window as one page and got a quarter of it with a `next`
//!    cursor nobody read — *Watchtower audited a quarter of the vault and
//!    reported it as all of it*. v0's own comments now say "WALKED, NOT
//!    CLAMPED" at each of the four, and this port walks with
//!    [`centraid_apps_kit::read_window`], which also **reports whether the
//!    window filled**.
//! 4. **A decoration that did not run is absent, not `false`.**
//!    [`Decorated::watch`] is an `Option` per item and
//!    [`ItemsAnswer::watchtower`] is an `Option` summary, because a zeroed
//!    summary is this query telling the review screen that nothing is weak
//!    (`queries/items.ts` — *"the keys themselves say whether the derivation
//!    ran"*).
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
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Window, in_list, read_by_id, read_window};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::origin::{MatchPolicy, OriginCandidate, matches_origin};
use crate::types::{AUTH_ENTITY_TYPE, ITEM_ENTITY_TYPE, degrade_type, degraded_from};
use crate::watchtower::WatchEntry;

/// THE BROWSABLE HALF OF A LOCKER ITEM (#996 wave 4, R8 and W6-D2).
///
/// A statement names its columns, and **no sealed cell is on this list**.
pub const ITEM_COLUMNS: &str = "item_id, type, title, username, url, url_match_policy, notes, \
     cardholder, expiry, brand, fullname, email, phone, address, network, \
     connection_id, compromised, password_set_at, created_at, updated_at, \
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
/// `WATCH_ROWS` (`watchtower.ts:20`).
pub const WATCH_ROWS: usize = 2_000;
/// `LOGIN_ROWS` (`autofill-candidates.ts:13`).
pub const LOGIN_ROWS: usize = 2_000;
/// `access.ts:20`-`:21` — the default and the ceiling of the audit window.
pub const ACCESS_DEFAULT: usize = 200;
pub const ACCESS_MAX: usize = 2_000;

/// The vocabulary and tag joins are `(item, concept)` pairs over a window of at
/// most 2,000 items: 500 × 32 = 16,000 rows, stated, and an error at the cap.
pub const TAG_BOUND: FanOutBound = FanOutBound::new(500, 32);

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

/// The review shelf: every non-trashed item, archived included.
///
/// Note the difference from [`Shelf::Live`]: Watchtower reviews **archived**
/// items too, because an archived login's password is still a password
/// somebody reused.
#[must_use]
pub fn watchtower_statement() -> PageQuery {
    PageQuery::new(
        "locker.watchtower.items",
        ITEM_COLUMNS,
        "locker_item",
        PageOrder::desc("updated_at", "item_id"),
    )
    .filter("deleted_at IS NULL", Vec::new())
}

/// Every live login, for the Companion's candidate list.
#[must_use]
pub fn autofill_logins_statement() -> PageQuery {
    PageQuery::new(
        "locker.autofill.logins",
        ITEM_COLUMNS,
        "locker_item",
        PageOrder::desc("updated_at", "item_id"),
    )
    .filter(
        "type = ? AND deleted_at IS NULL",
        vec![PageBindValue::Text("login".to_owned())],
    )
}

/// One live login by id, for a single fill.
#[must_use]
pub fn autofill_item_statement(item_id: &str) -> PageQuery {
    PageQuery::new(
        "locker.autofill.item",
        ITEM_COLUMNS,
        "locker_item",
        PageOrder::asc("item_id", "item_id"),
    )
    .filter(
        "item_id = ? AND type = ? AND deleted_at IS NULL",
        vec![
            PageBindValue::Text(item_id.to_owned()),
            PageBindValue::Text("login".to_owned()),
        ],
    )
}

/// THE AUDIT WINDOW, AND THE INNER OF ITS TWO WALLS (census §A8).
///
/// The manifest's `rowFilter` on `object_type` is the outer wall, carried per
/// call as the gateway's execution clamp. This predicate names the same two
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
    pub url_match_policy: MatchPolicy,
    pub notes: Option<String>,
    pub cardholder: Option<String>,
    pub expiry: Option<String>,
    pub brand: Option<String>,
    pub fullname: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address: Option<String>,
    pub network: Option<String>,
    pub connection_id: Option<String>,
    /// The **one stored security fact**. Weak and reused are derived.
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
            url_match_policy: MatchPolicy::of(text_of(row, "url_match_policy").as_deref()),
            notes: text_of(row, "notes"),
            cardholder: text_of(row, "cardholder"),
            expiry: text_of(row, "expiry"),
            brand: text_of(row, "brand"),
            fullname: text_of(row, "fullname"),
            email: text_of(row, "email"),
            phone: text_of(row, "phone"),
            address: text_of(row, "address"),
            network: text_of(row, "network"),
            connection_id: text_of(row, "connection_id"),
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
    /// Derived: weak or reused.
    Warn,
    /// Nothing to say.
    None,
}

impl Severity {
    /// v0's spelling — `""` for none, which a renderer uses as a class name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Danger => "danger",
            Self::Warn => "warn",
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
    /// A **secret-free** subtitle. A card's is `•••• 1234`, which comes from
    /// the Watchtower derivation and therefore only when it ran.
    pub subtitle: String,
    pub favorite: bool,
    pub tags: Vec<String>,
    /// ABSENT, not `false`, when the derivation did not run: *checked and found
    /// nothing* and *not asked* are different sentences, and `servedFields`
    /// reads exactly this difference off the row.
    pub watch: Option<WatchEntry>,
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

impl Decorated {
    /// `weak`, but only as an answer — `None` when nothing derived it.
    #[must_use]
    pub fn weak(&self) -> Option<bool> {
        self.watch.as_ref().map(|entry| entry.weak)
    }

    /// `reused`, same rule.
    #[must_use]
    pub fn reused(&self) -> Option<bool> {
        self.watch.as_ref().map(|entry| entry.reused)
    }

    /// Whether the review shelf lists this row. A row whose derivation did not
    /// run is listed only if its **stored** flag says so.
    #[must_use]
    pub fn needs_attention(&self) -> bool {
        self.compromised || self.weak().unwrap_or(false) || self.reused().unwrap_or(false)
    }
}

/// A safe, secret-free subtitle for a list row (`items.ts`'s `subtitleOf`).
#[must_use]
pub fn subtitle_of(row: &ItemRow, watch: Option<&WatchEntry>) -> String {
    let or_dash = |value: &Option<String>| {
        value
            .as_deref()
            .filter(|text| !text.is_empty())
            .unwrap_or("—")
            .to_owned()
    };
    match row.item_type.as_str() {
        "login" => or_dash(&row.username),
        "card" => match watch.and_then(|entry| entry.last4.as_deref()) {
            Some(last4) => format!("•••• {last4}"),
            None => "Card".to_owned(),
        },
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
    /// `None` means **the derivation did not run**, which is not the same
    /// answer as an empty map: a caller that folded the two together would
    /// report an all-clear it never checked.
    pub watch: Option<BTreeMap<String, WatchEntry>>,
    pub alias: BTreeMap<String, String>,
}

/// `decorate`, ported. Pure.
#[must_use]
pub fn decorate(rows: &[ItemRow], decorations: &Decorations) -> Vec<Decorated> {
    rows.iter()
        .map(|row| {
            let watch = decorations
                .watch
                .as_ref()
                .map(|map| map.get(&row.item_id).cloned().unwrap_or_default());
            let weak = watch.as_ref().is_some_and(|entry| entry.weak);
            let reused = watch.as_ref().is_some_and(|entry| entry.reused);
            let severity = if row.compromised {
                Severity::Danger
            } else if weak || reused {
                Severity::Warn
            } else {
                Severity::None
            };
            Decorated {
                item_id: row.item_id.clone(),
                item_type: row.item_type.clone(),
                title: row.title.clone(),
                subtitle: subtitle_of(row, watch.as_ref()),
                favorite: decorations.starred.contains(&row.item_id),
                tags: decorations
                    .tags
                    .get(&row.item_id)
                    .cloned()
                    .unwrap_or_default(),
                watch,
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
    /// ABSENT when the derivation did not run. A zeroed summary would be this
    /// query telling the review screen that nothing is weak.
    pub watchtower: Option<crate::watchtower::Summary>,
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
        watchtower: crate::watchtower::summarise(&items, decorations.watch.is_some()),
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
/// **There is no reveal here** (#996 R13, W6-D2). This query used to hand the
/// gateway a session token and an item token and take plaintext off the answer.
/// The gateway no longer unseals a Locker row for a client at all — the *seat*
/// does, with `K`, behind the member's unlock — so what comes back is the
/// browsable half plus the shape of each secret. That is also why this pane
/// paints **while the Locker is locked**, which the permit could never allow.
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

/// ONE CANDIDATE FOR THE COMPANION — **secret-free live login metadata**.
///
/// *OTP presence is a boolean; no password or OTP seed is returned*
/// (`locker/app.json`'s own description of the query). `has_totp` is therefore
/// derived from whether the sealed cell is non-null, which the browsable
/// projection cannot see — so the statement for this one query projects
/// `otp_seed`'s **presence** and never its value: see
/// [`AutofillCandidate::of`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutofillCandidate {
    pub item_id: String,
    pub title: String,
    pub username: Option<String>,
    pub url: String,
    pub policy: MatchPolicy,
    pub has_totp: bool,
    pub compromised: bool,
    /// Compromised, weak or reused — the one bit the picker shows.
    pub warning: bool,
}

impl AutofillCandidate {
    /// Build a candidate from a row, its OTP presence and the warned set.
    ///
    /// `has_totp` is passed in rather than read off the row because
    /// [`ITEM_COLUMNS`] does not carry `otp_seed` **and must not**: the
    /// presence of a sealed cell is a fact the vault answers, not a column an
    /// app projects.
    #[must_use]
    pub fn of(row: &ItemRow, has_totp: bool, warned: &BTreeSet<String>) -> Option<Self> {
        let url = row.url.clone().filter(|url| !url.is_empty())?;
        Some(Self {
            item_id: row.item_id.clone(),
            title: row.title.clone(),
            username: row.username.clone(),
            url,
            policy: row.url_match_policy,
            has_totp,
            compromised: row.compromised,
            warning: row.compromised || warned.contains(&row.item_id),
        })
    }
}

/// WHY A FILL DID NOT HAPPEN — and each of these is a different sentence.
///
/// A blank answer and "the page does not match" are different facts, and the
/// Companion renders them differently: one is a bug report and the other is the
/// policy working.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FillRefusal {
    /// The caller sent no id, or an origin that is not an origin.
    Malformed,
    /// No live login of that id.
    NoSuchLogin,
    /// The login has no stored address to match against.
    NoStoredOrigin,
    /// The origin does not match this login. **The policy working.**
    OriginMismatch,
    /// The seat that holds `K` is not this process. The extension is not a
    /// seat and must never become one (census §E seam 5).
    NotThisSeat,
}

impl FillRefusal {
    /// The member-facing sentence, v0's own wording where v0 had one.
    #[must_use]
    pub const fn sentence(self) -> &'static str {
        match self {
            Self::Malformed => "A login id and normalized page origin are required.",
            Self::NoSuchLogin => "That login is not in this vault.",
            Self::NoStoredOrigin => "This login has no stored origin to match against.",
            Self::OriginMismatch => "Page origin does not match this login.",
            Self::NotThisSeat => {
                "Filling needs the seat that holds this vault's key — unlock Centraid on this \
                 device and try again."
            }
        }
    }
}

/// WHICH LOGIN WOULD BE FILLED, decided here; the value comes from the seat.
///
/// This is the app's half of D-1020-L8 and it is deliberately the **whole** of
/// the app's half. The origin match runs here — defence in depth, over the
/// vault's own stored policy, so a forged `page_origin` is refused by the row
/// rather than by the caller — and the answer is an **address**, which
/// `crates/seat::locker`'s `reveal_for_fill` turns into a value with a 30-second
/// life and a receipt. An app crate that could return the password would be an
/// app crate holding a secret, which is the thing W6-D2 forbids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FillMatch {
    pub item_id: String,
    pub username: Option<String>,
    /// The normalised origin, for the receipt.
    pub origin: String,
}

/// Decide a fill. `Ok` names the row to reveal; `Err` says why not.
pub fn fill_match(
    row: Option<&ItemRow>,
    raw_origin: Option<&str>,
) -> Result<FillMatch, FillRefusal> {
    let origin = raw_origin
        .and_then(crate::origin::page_origin)
        .ok_or(FillRefusal::Malformed)?;
    let row = row.ok_or(FillRefusal::NoSuchLogin)?;
    if row.item_id.is_empty() {
        return Err(FillRefusal::Malformed);
    }
    let stored = row
        .url
        .as_deref()
        .filter(|url| !url.is_empty())
        .ok_or(FillRefusal::NoStoredOrigin)?;
    if !matches_origin(&OriginCandidate::new(stored, row.url_match_policy), &origin) {
        return Err(FillRefusal::OriginMismatch);
    }
    Ok(FillMatch {
        item_id: row.item_id.clone(),
        username: row.username.clone(),
        origin,
    })
}

/// One audit entry, and which of the three things it records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessKind {
    /// An unlock. `object_type = locker.auth`.
    Auth,
    /// A reveal in the app.
    Reveal,
    /// A fill into a page, which is the only kind that carries an origin.
    Fill,
}

impl AccessKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Reveal => "reveal",
            Self::Fill => "fill",
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
    /// Only on a fill.
    pub origin: Option<String>,
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
            } else if detail["context"]["kind"] == "fill" {
                AccessKind::Fill
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
                origin: if kind == AccessKind::Fill {
                    detail["context"]["origin"].as_str().map(str::to_owned)
                } else {
                    None
                },
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
            watchtower_statement(),
            autofill_logins_statement(),
            autofill_item_statement("x"),
        ] {
            assert_eq!(query.select, ITEM_COLUMNS, "{} drifted", query.name);
            assert_eq!(query.from, "locker_item");
        }
    }

    /// The review shelf reviews ARCHIVED items and the live shelf does not
    /// show them — two different predicates over one table, and collapsing
    /// them would either hide an archived login's reused password or put
    /// archived rows back in the list.
    #[test]
    fn archived_is_reviewed_and_not_listed() {
        assert_eq!(
            items_statement(Shelf::Live).r#where.as_deref(),
            Some("deleted_at IS NULL AND archived_at IS NULL")
        );
        assert_eq!(
            watchtower_statement().r#where.as_deref(),
            Some("deleted_at IS NULL")
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

    /// A DECORATION THAT DID NOT RUN IS ABSENT, and the summary refuses to
    /// exist. This is the assertion that stops an all-clear nobody checked.
    #[test]
    fn an_undecorated_shelf_has_no_watchtower_summary_and_no_weak_bit() {
        let rows = vec![ItemRow {
            item_id: "i1".to_owned(),
            item_type: "login".to_owned(),
            title: "Bank".to_owned(),
            ..ItemRow::default()
        }];
        let bare = decorate(&rows, &Decorations::default());
        assert_eq!(bare[0].weak(), None);
        assert_eq!(bare[0].reused(), None);
        assert!(!bare[0].needs_attention());
        assert_eq!(bare[0].severity, Severity::None);

        let mut watch = BTreeMap::new();
        watch.insert(
            "i1".to_owned(),
            WatchEntry {
                weak: true,
                reused: false,
                last4: None,
            },
        );
        let decorated = decorate(
            &rows,
            &Decorations {
                watch: Some(watch),
                ..Decorations::default()
            },
        );
        assert_eq!(decorated[0].weak(), Some(true));
        assert!(decorated[0].needs_attention());
        assert_eq!(decorated[0].severity, Severity::Warn);
    }

    /// The breach flag outranks the derivation, because it is the one STORED
    /// fact and the loudest thing the screen can say.
    #[test]
    fn compromised_outranks_weak_and_reused() {
        let rows = vec![ItemRow {
            item_id: "i1".to_owned(),
            item_type: "login".to_owned(),
            compromised: true,
            ..ItemRow::default()
        }];
        let mut watch = BTreeMap::new();
        watch.insert(
            "i1".to_owned(),
            WatchEntry {
                weak: true,
                reused: true,
                last4: None,
            },
        );
        let decorated = decorate(
            &rows,
            &Decorations {
                watch: Some(watch),
                ..Decorations::default()
            },
        );
        assert_eq!(decorated[0].severity, Severity::Danger);
    }

    /// A card's subtitle needs the derivation; without it the row still draws.
    #[test]
    fn a_card_subtitle_needs_the_derivation_and_degrades_to_a_word() {
        let card = ItemRow {
            item_type: "card".to_owned(),
            ..ItemRow::default()
        };
        assert_eq!(subtitle_of(&card, None), "Card");
        assert_eq!(
            subtitle_of(
                &card,
                Some(&WatchEntry {
                    weak: false,
                    reused: false,
                    last4: Some("4242".to_owned()),
                })
            ),
            "•••• 4242"
        );
        let login = ItemRow {
            item_type: "login".to_owned(),
            username: None,
            ..ItemRow::default()
        };
        assert_eq!(subtitle_of(&login, None), "—");
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
    fn a_fill_refusal_says_which_refusal_it_is() {
        let row = ItemRow {
            item_id: "i1".to_owned(),
            url: Some("https://login.example.com".to_owned()),
            ..ItemRow::default()
        };
        assert_eq!(
            fill_match(Some(&row), Some("https://www.example.com")),
            Ok(FillMatch {
                item_id: "i1".to_owned(),
                username: None,
                origin: "https://www.example.com".to_owned()
            })
        );
        assert_eq!(
            fill_match(Some(&row), Some("https://attacker.test")),
            Err(FillRefusal::OriginMismatch)
        );
        // A URL is not an origin.
        assert_eq!(
            fill_match(Some(&row), Some("https://www.example.com/login")),
            Err(FillRefusal::Malformed)
        );
        assert_eq!(
            fill_match(None, Some("https://a.example")),
            Err(FillRefusal::NoSuchLogin)
        );
        let no_url = ItemRow {
            item_id: "i2".to_owned(),
            ..ItemRow::default()
        };
        assert_eq!(
            fill_match(Some(&no_url), Some("https://a.example")),
            Err(FillRefusal::NoStoredOrigin)
        );
    }

    /// An exact-host login does not fill a sibling, over the vault's own
    /// stored policy rather than the caller's word for it.
    #[test]
    fn the_stored_policy_decides_not_the_caller() {
        let pinned = ItemRow {
            item_id: "i1".to_owned(),
            url: Some("https://accounts.example.com".to_owned()),
            url_match_policy: MatchPolicy::ExactHost,
            ..ItemRow::default()
        };
        assert_eq!(
            fill_match(Some(&pinned), Some("https://www.example.com")),
            Err(FillRefusal::OriginMismatch)
        );
    }

    #[test]
    fn a_fill_receipt_is_the_only_entry_that_carries_an_origin() {
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
                    r#"{"context":{"kind":"fill","origin":"https://bank.example"},"columns":["password"]}"#,
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
        assert_eq!(answer.entries[0].kind, AccessKind::Fill);
        assert_eq!(
            answer.entries[0].origin.as_deref(),
            Some("https://bank.example")
        );
        assert_eq!(
            answer.entries[0].columns.as_deref(),
            Some(&["password".to_owned()][..])
        );
        assert_eq!(answer.entries[0].item_id.as_deref(), Some("i1"));
        assert_eq!(answer.entries[1].kind, AccessKind::Auth);
        assert!(!answer.entries[1].allowed);
        // An auth receipt names no item, because it is about the vault.
        assert_eq!(answer.entries[1].item_id, None);
        assert_eq!(answer.entries[1].origin, None);
        assert!(!answer.truncated);
    }

    /// A reveal that is not a fill carries no origin even when the detail has
    /// one, because the *kind* is what the surface branches on.
    #[test]
    fn a_reveal_is_not_a_fill() {
        let rows = vec![row(&[
            ("receipt_id", "r1"),
            ("action", "reveal"),
            ("object_type", "locker.item"),
            ("object_id", "i1"),
            ("decision", "allow"),
            ("occurred_at", "2026-01-01T00:00:00.000Z"),
            (
                "detail_json",
                r#"{"context":{"origin":"https://bank.example"}}"#,
            ),
        ])];
        let answer = access_answer(200, &rows);
        assert_eq!(answer.entries[0].kind, AccessKind::Reveal);
        assert_eq!(answer.entries[0].origin, None);
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

    #[test]
    fn an_autofill_candidate_needs_a_stored_address() {
        let warned = BTreeSet::new();
        let bare = ItemRow {
            item_id: "i1".to_owned(),
            ..ItemRow::default()
        };
        assert_eq!(AutofillCandidate::of(&bare, false, &warned), None);
        let with_url = ItemRow {
            item_id: "i1".to_owned(),
            title: "Bank".to_owned(),
            url: Some("https://bank.example".to_owned()),
            compromised: true,
            ..ItemRow::default()
        };
        let candidate = AutofillCandidate::of(&with_url, true, &warned).expect("a candidate");
        assert!(candidate.has_totp);
        assert!(candidate.warning);
        assert_eq!(candidate.policy, MatchPolicy::RegistrableDomain);
    }
}
