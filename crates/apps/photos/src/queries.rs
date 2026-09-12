//! `library` and `search`, plus the bounded joins both fold.
//!
//! `queries/library.ts` is the library projection as bounded windows: the
//! newest live assets by `captured_at` plus the newest 200 trashed, with every
//! join `IN`-bounded by the same window — **never a whole-table pull**, because
//! bytes ride inline as `data:` URIs and a table scan over
//! `core_content_item` is the library in memory (#264).
//!
//! Four facts the port keeps verbatim:
//!
//! 1. **`before` is a keyset cursor** (#599): only assets captured strictly
//!    earlier, and a NULL `captured_at` fails that comparison — so undated
//!    assets ride the first window only, and `tail` is the next `before`.
//! 2. **Archived assets are in neither shelf** (#419). Archived and trashed are
//!    different answers and the table's own CHECK refuses a row claiming both.
//! 3. **A live asset whose BYTES are released is not library.** The join drops
//!    an asset whose content item carries a `deleted_at`, because "live" means
//!    the bytes are live too (`library.ts:258-260`).
//! 4. **`truncated` is the page's own cursor**, not a row count — a count
//!    cannot tell a window that filled exactly from one that ran out.
//!
//! **The favourite is DERIVED, never a column** (#916, ONT-03): the star is the
//! `starred` concept in the flags scheme, and `media_asset.favorite` does not
//! exist. [`AssetJoins`] reads the windowed assets' tags once and splits them
//! by scheme — the label rail and the star are two readings of the same rows.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages, read_window};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::places::{PlaceRow, places_statement};

/// The trash and memory shelves are what the screen shows (`library.ts:26`).
pub const SHELF_ROWS: usize = 200;

/// The search shelf shows this many matches (`search.ts:18`).
pub const MATCH_ROWS: usize = 300;

/// The library window's own bounds, from the manifest's input schema:
/// `limit` 20…2,000 with a default of 500 (`library.ts:63`).
pub const LIBRARY_MIN: usize = 20;
pub const LIBRARY_MAX: usize = 2_000;
pub const LIBRARY_DEFAULT: usize = 500;

/// A join per windowed asset: 500 × 8 = 4,000 rows, the kit's `JOIN_FAN_OUT`.
/// A window of 2,000 assets can carry more than one album entry each, so the
/// tag and entry walks get the wider bound below and report it when reached.
pub const ASSET_JOIN_BOUND: FanOutBound = FanOutBound::new(500, 8);

/// Tags and album entries are `(asset, concept)` and `(asset, collection)`
/// pairs over a 2,000-asset window: 500 × 32 = 16,000 rows, stated.
pub const ASSET_PAIR_BOUND: FanOutBound = FanOutBound::new(500, 32);

/// The blob route a `blob:` content URI becomes (`_shared.ts:73`).
pub const BLOB_ROUTE: &str = "/centraid/_vault/blobs";

/// The flags and tags scheme URIs, and the star's notation. Restated here
/// because `_shared/concept-scheme-kit.ts` is an import-free leaf on the v0
/// side too; the values are asserted against the fixture in the parity test.
pub const FLAGS_SCHEME_URI: &str = "centraid:flags:v1";
pub const TAGS_SCHEME_URI: &str = "centraid:tags:v1";
pub const STARRED_NOTATION: &str = "starred";

/// Tags target the ASSET, never the content item.
pub const TAG_TARGET_TYPE: &str = "media.asset";

/// The four URIs a tile can paint from. `None` throughout when the content item
/// carries no readable URI — a tile with no bytes is a state, not a blank src.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SourceUris {
    pub src: Option<String>,
    pub thumb: Option<String>,
    pub preview: Option<String>,
    pub poster: Option<String>,
}

/// `srcOf`, ported (`_shared.ts:75-87`). A `blob:` URI becomes a same-origin
/// serve URL with three variant queries beside it; a `data:` URI passes
/// through and has no variants, because there is no derivative to ask for.
#[must_use]
pub fn src_of(content: Option<&ContentRow>) -> SourceUris {
    let Some(content) = content else {
        return SourceUris::default();
    };
    let Some(uri) = content.content_uri.as_deref() else {
        return SourceUris::default();
    };
    if !uri.starts_with("blob:") {
        return SourceUris {
            src: Some(uri.to_owned()),
            ..SourceUris::default()
        };
    }
    let src = format!("{BLOB_ROUTE}/{}", content.content_id);
    SourceUris {
        thumb: Some(format!("{src}?variant=thumb")),
        preview: Some(format!("{src}?variant=preview")),
        poster: Some(format!("{src}?variant=poster")),
        src: Some(src),
    }
}

/// One `core_content_item` row, as the library reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentRow {
    pub content_id: String,
    pub content_uri: Option<String>,
    pub byte_size: Option<i64>,
    pub created_at: Option<String>,
    /// The bytes were released. A live asset over released bytes is NOT
    /// library.
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

impl ContentRow {
    #[must_use]
    pub fn of(row: &Row) -> Option<Self> {
        Some(Self {
            content_id: text_of(row, "content_id")?,
            content_uri: text_of(row, "content_uri"),
            byte_size: row.get("byte_size").and_then(Cell::integer),
            created_at: text_of(row, "created_at"),
            deleted_at: text_of(row, "deleted_at"),
            purge_at: text_of(row, "purge_at"),
        })
    }
}

/// One `media_asset` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRow {
    pub asset_id: String,
    pub content_id: String,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub captured_at: Option<String>,
    pub tz_offset_min: Option<i64>,
    pub capture_group_id: Option<String>,
    pub place_id: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub source_asset_id: Option<String>,
    pub archived_at: Option<String>,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    pub created_at: Option<String>,
}

impl AssetRow {
    #[must_use]
    pub fn of(row: &Row) -> Option<Self> {
        Some(Self {
            asset_id: text_of(row, "asset_id")?,
            content_id: text_of(row, "content_id")?,
            kind: text_of(row, "kind"),
            title: text_of(row, "title"),
            captured_at: text_of(row, "captured_at"),
            tz_offset_min: row.get("tz_offset_min").and_then(Cell::integer),
            capture_group_id: text_of(row, "capture_group_id"),
            place_id: text_of(row, "place_id"),
            width: row.get("width").and_then(Cell::integer),
            height: row.get("height").and_then(Cell::integer),
            source_asset_id: text_of(row, "source_asset_id"),
            archived_at: text_of(row, "archived_at"),
            deleted_at: text_of(row, "deleted_at"),
            purge_at: text_of(row, "purge_at"),
            created_at: text_of(row, "created_at"),
        })
    }
}

/// One label on one photograph. The pair, because **untag removes the edge by
/// id, never by label**.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetTag {
    pub tag_id: String,
    pub label: String,
}

/// One album, as the shelf shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumRow {
    pub album_id: String,
    pub title: Option<String>,
    pub cover_content_id: Option<String>,
}

/// One grid row: the asset, joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GridAsset {
    pub asset: AssetRow,
    /// DERIVED from the flags-scheme tag. `1`/`0` in v0's payload; a bool here,
    /// because there is no third value and a mirror column is what #916 removed.
    pub favorite: bool,
    pub uris: SourceUris,
    pub byte_size: Option<i64>,
    pub media_type: Option<String>,
    /// `captured_at`, else the content item's `created_at`. Derived, never
    /// a duplicate column.
    pub taken_at: Option<String>,
    pub album_ids: Vec<String>,
    pub album_titles: Vec<String>,
    pub place: Option<PlaceRow>,
    pub tags: Vec<AssetTag>,
    pub custody_state: Option<String>,
    /// Trash only: days until the grace window closes. `None` when the row
    /// carries no `purge_at` — never `0`, which would read as "today".
    pub purge_in_days: Option<i64>,
    /// Trash only: the asset owns the grace window (#274); the content item is
    /// the fallback.
    pub purge_at: Option<String>,
}

/// What `library` answers.
// No `Eq`: `memories` holds raw [`Row`]s, whose `Cell` can be a `Real`, and an
// f64 has no total equality. A caller comparing two answers by value would be
// comparing floats.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LibraryData {
    pub assets: Vec<GridAsset>,
    pub albums: Vec<AlbumRow>,
    pub places: Vec<PlaceRow>,
    pub trash: Vec<GridAsset>,
    pub memories: Vec<Row>,
    pub memory_members: Vec<Row>,
    /// Older photographs exist beyond the window. The page's own cursor.
    pub truncated: bool,
    /// The window that was actually asked for, after the clamp.
    pub window: usize,
    /// The oldest `taken_at` this page reached — pass it back as `before`.
    pub tail: Option<String>,
}

/// `library`'s input.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LibraryInput {
    pub limit: Option<usize>,
    /// The keyset cursor: only assets captured strictly earlier.
    pub before: Option<String>,
}

impl LibraryInput {
    /// The clamped window. `Math.min(Math.max(Number(limit) || 500, 20), 2000)`
    /// (`library.ts:63`) — a zero or absent limit is the default, not zero rows.
    #[must_use]
    pub fn window(&self) -> usize {
        self.limit
            .filter(|limit| *limit > 0)
            .unwrap_or(LIBRARY_DEFAULT)
            .clamp(LIBRARY_MIN, LIBRARY_MAX)
    }

    /// The cursor, with the empty string read as absent (`library.ts:65-68`).
    #[must_use]
    pub fn before(&self) -> Option<&str> {
        self.before.as_deref().filter(|text| !text.is_empty())
    }
}

/// Every column both shelves project (`library.ts:19-23`).
pub const ASSET_COLUMNS: &str = "asset_id, content_id, kind, title, captured_at, tz_offset_min, \
                                 capture_group_id, place_id, camera_device_id, width, height, \
                                 duration_s, source_asset_id, archived_at, deleted_at, purge_at, \
                                 created_at, updated_at";

// ---------------------------------------------------------------------------
// The statements.
// ---------------------------------------------------------------------------

/// `photos.library.live` — the newest live, unarchived assets.
///
/// The `before` predicate is `captured_at < ?`, and a NULL `captured_at` FAILS
/// that comparison in SQL. That is not a bug to fix: an undated asset has no
/// place in a timeline cursor, so it rides the first window and no other.
#[must_use]
pub fn live_statement(before: Option<&str>) -> PageQuery {
    let query = PageQuery::new(
        "photos.library.live",
        ASSET_COLUMNS,
        "media_asset",
        PageOrder::desc("captured_at", "asset_id"),
    );
    match before {
        Some(before) => query.filter(
            "deleted_at IS NULL AND archived_at IS NULL AND captured_at < ?",
            vec![PageBindValue::Text(before.to_owned())],
        ),
        None => query.filter("deleted_at IS NULL AND archived_at IS NULL", Vec::new()),
    }
}

/// `photos.library.trash` — a ~30-day shelf the sweep keeps short.
#[must_use]
pub fn trash_statement() -> PageQuery {
    PageQuery::new(
        "photos.library.trash",
        ASSET_COLUMNS,
        "media_asset",
        PageOrder::desc("deleted_at", "asset_id"),
    )
    .filter("deleted_at IS NOT NULL", Vec::new())
}

/// `photos.library.albums` — albums are collections: owner-curated and small.
#[must_use]
pub fn albums_statement(name: &str) -> PageQuery {
    PageQuery::new(
        name,
        "collection_id, name, cover_content_id",
        "core_collection",
        PageOrder::asc("collection_id", "collection_id"),
    )
}

/// `photos.library.memories`.
#[must_use]
pub fn memories_statement() -> PageQuery {
    PageQuery::new(
        "photos.library.memories",
        "memory_id, kind, title_hint, day_key, place_id, started_at, ended_at, computed_at",
        "media_memory",
        PageOrder::desc("computed_at", "memory_id"),
    )
}

/// `photos.library.memoryMembers`.
///
/// **The keyset is the table's own pair.** `media_memory_member` is keyed on
/// `(memory_id, asset_id)` and `ordinal` deliberately TIES — two photographs
/// taken in the same second share one — so a cursor on `ordinal` alone would
/// stop at the tie and call the memory finished (`library.ts:178-181`).
pub fn memory_members_statement(memory_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("memory_id", memory_ids)?;
    Ok(PageQuery::new(
        "photos.library.memoryMembers",
        "memory_id, asset_id, ordinal",
        "media_memory_member",
        PageOrder::asc("memory_id", "asset_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `photos.library.contents` / `photos.search.contents` / the face-queue's.
pub fn content_statement(name: &str, content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        name,
        "content_id, content_uri, byte_size, created_at, deleted_at, purge_at",
        "core_content_item",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `photos.library.albumEntries` / `photos.search.albumEntries`.
pub fn album_entries_statement(name: &str, asset_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", asset_ids)?;
    let mut bind = vec![PageBindValue::Text(TAG_TARGET_TYPE.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        name,
        "entry_id, target_type, target_id, collection_id",
        "core_collection_entry",
        PageOrder::asc("entry_id", "entry_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `photos.shared.schemes`.
#[must_use]
pub fn schemes_statement() -> PageQuery {
    PageQuery::new(
        "photos.shared.schemes",
        "scheme_id, uri",
        "core_concept_scheme",
        PageOrder::asc("scheme_id", "scheme_id"),
    )
}

/// `photos.shared.concepts`.
#[must_use]
pub fn concepts_statement() -> PageQuery {
    PageQuery::new(
        "photos.shared.concepts",
        "concept_id, scheme_id, pref_label, notation",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
}

/// `photos.shared.custody`.
pub fn custody_statement(content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        "photos.shared.custody",
        "content_id, custody_state",
        "blob_custody_state",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `photos.shared.assetTags` — ONE read over the windowed assets' tags, split
/// by scheme afterwards.
pub fn asset_tags_statement(asset_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", asset_ids)?;
    let mut bind = vec![PageBindValue::Text(TAG_TARGET_TYPE.to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "photos.shared.assetTags",
        "tag_id, target_type, target_id, concept_id",
        "core_tag",
        PageOrder::asc("tag_id", "tag_id"),
    )
    .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `photos.search.assets` — only the matched content ids' LIVE assets.
pub fn search_assets_statement(content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        "photos.search.assets",
        "asset_id, content_id, kind, title, captured_at, place_id, width, height, duration_s, \
         deleted_at",
        "media_asset",
        PageOrder::desc("captured_at", "asset_id"),
    )
    .filter(
        &format!("{} AND deleted_at IS NULL", fragment.sql),
        fragment.bind,
    ))
}

// ---------------------------------------------------------------------------
// The joins.
// ---------------------------------------------------------------------------

/// What one read over the windowed assets' tags splits into.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AssetJoins {
    pub tags_by_asset: BTreeMap<String, Vec<AssetTag>>,
    /// THE STAR, derived. No flags scheme or no `starred` concept yet means
    /// nothing is starred — an honest "none", never an error: a vault mints
    /// both the first time something is starred.
    pub favorite_assets: BTreeSet<String>,
    pub custody_by_content: BTreeMap<String, String>,
}

/// `readAssetJoins`, ported (`_shared.ts:118-215`).
#[must_use]
pub fn fold_asset_joins(
    schemes: &[Row],
    concepts: &[Row],
    asset_tags: &[Row],
    custody: &[Row],
) -> AssetJoins {
    let scheme_id_of = |uri: &str| -> Option<String> {
        schemes
            .iter()
            .find(|row| text_of(row, "uri").as_deref() == Some(uri))
            .and_then(|row| text_of(row, "scheme_id"))
    };
    let tags_scheme = scheme_id_of(TAGS_SCHEME_URI);
    let flags_scheme = scheme_id_of(FLAGS_SCHEME_URI);

    let label_of: BTreeMap<String, String> = concepts
        .iter()
        .filter(|row| tags_scheme.is_some() && text_of(row, "scheme_id") == tags_scheme)
        .filter_map(|row| {
            let concept_id = text_of(row, "concept_id")?;
            let label = text_of(row, "pref_label").or_else(|| text_of(row, "notation"))?;
            (!label.is_empty()).then_some((concept_id, label))
        })
        .collect();
    let starred_concept: Option<String> = flags_scheme.as_ref().and_then(|scheme| {
        concepts
            .iter()
            .find(|row| {
                text_of(row, "scheme_id").as_deref() == Some(scheme.as_str())
                    && text_of(row, "notation").as_deref() == Some(STARRED_NOTATION)
            })
            .and_then(|row| text_of(row, "concept_id"))
    });

    let mut joins = AssetJoins::default();
    for row in asset_tags {
        let Some(target) = text_of(row, "target_id") else {
            continue;
        };
        let Some(concept_id) = text_of(row, "concept_id") else {
            continue;
        };
        if starred_concept.as_deref() == Some(concept_id.as_str()) {
            joins.favorite_assets.insert(target);
            continue;
        }
        // From another scheme: not this app's label rail.
        let Some(label) = label_of.get(&concept_id) else {
            continue;
        };
        let Some(tag_id) = text_of(row, "tag_id") else {
            continue;
        };
        joins
            .tags_by_asset
            .entry(target)
            .or_default()
            .push(AssetTag {
                tag_id,
                label: label.clone(),
            });
    }
    for row in custody {
        if let (Some(content), Some(state)) =
            (text_of(row, "content_id"), text_of(row, "custody_state"))
        {
            joins.custody_by_content.insert(content, state);
        }
    }
    joins
}

/// Milliseconds in a day (`_shared/format-kit.ts`'s `DAY_MS`).
pub const DAY_MS: i64 = 86_400_000;

/// Whole days until `purge_at`, rounded UP and floored at zero
/// (`library.ts:271-276`). `None` when there is no date to compare, and
/// **`None` is not `0`**: "no grace window recorded" is not "purges today".
#[must_use]
pub fn purge_in_days(purge_at: Option<&str>, now_ms: i64) -> Option<i64> {
    let parsed = parse_instant_ms(purge_at?)?;
    let ms = parsed - now_ms;
    Some(if ms <= 0 {
        0
    } else {
        // `div_ceil` for integers is unstable on this toolchain; the
        // ceiling division is written out (#1020, toolchain 1.94.1).
        (ms + DAY_MS - 1) / DAY_MS
    })
}

/// `Date.parse` for the ISO-8601 UTC instants the vault writes.
///
/// Deliberately narrow: the vault's own spelling is
/// `strftime('%Y-%m-%dT%H:%M:%fZ')`, so anything else is a value the port
/// refuses to guess at rather than one it reinterprets. v0's `Date.parse`
/// accepts far more and answers `NaN` for the rest, which becomes a `null`
/// `purge_in_days` — the same answer this gives.
#[must_use]
pub fn parse_instant_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> { text.get(from..to)?.parse().ok() };
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let millis = if bytes.get(19) == Some(&b'.') {
        number(20, 23).unwrap_or(0)
    } else {
        0
    };
    // Days from the civil epoch (Howard Hinnant's `days_from_civil`), which is
    // exact for every year the vault can hold and needs no calendar crate.
    let year_shifted = year - i64::from(month <= 2);
    let era = if year_shifted >= 0 {
        year_shifted
    } else {
        year_shifted - 399
    } / 400;
    let year_of_era = year_shifted - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1_000 + millis)
}

// ---------------------------------------------------------------------------
// The `library` fold.
// ---------------------------------------------------------------------------

/// Everything the library's statements returned, so the fold is pure.
#[derive(Debug, Clone, Default)]
pub struct LibraryReads {
    pub live: Vec<AssetRow>,
    /// The live window filled: older photographs exist.
    pub live_filled: bool,
    pub trash: Vec<AssetRow>,
    pub albums: Vec<AlbumRow>,
    pub places: Vec<PlaceRow>,
    pub contents: BTreeMap<String, ContentRow>,
    pub album_ids_by_asset: BTreeMap<String, Vec<String>>,
    pub media_types: BTreeMap<String, String>,
    pub joins: AssetJoins,
    pub memories: Vec<Row>,
    pub memory_members: Vec<Row>,
}

fn join_one(
    asset: &AssetRow,
    reads: &LibraryReads,
    places: &BTreeMap<String, PlaceRow>,
    now_ms: i64,
    trash: bool,
) -> GridAsset {
    let content = reads.contents.get(&asset.content_id);
    let album_ids = reads
        .album_ids_by_asset
        .get(&asset.asset_id)
        .cloned()
        .unwrap_or_default();
    let album_titles = album_ids
        .iter()
        .filter_map(|id| {
            reads
                .albums
                .iter()
                .find(|album| album.album_id == *id)
                .and_then(|album| album.title.clone())
        })
        .collect();
    let purge_at = if trash {
        asset
            .purge_at
            .clone()
            .or_else(|| content.and_then(|content| content.purge_at.clone()))
    } else {
        None
    };
    GridAsset {
        favorite: reads.joins.favorite_assets.contains(&asset.asset_id),
        uris: src_of(content),
        byte_size: content.and_then(|content| content.byte_size),
        media_type: reads.media_types.get(&asset.asset_id).cloned(),
        taken_at: asset
            .captured_at
            .clone()
            .or_else(|| content.and_then(|content| content.created_at.clone())),
        album_ids,
        album_titles,
        place: asset
            .place_id
            .as_deref()
            .and_then(|id| places.get(id))
            .cloned(),
        tags: reads
            .joins
            .tags_by_asset
            .get(&asset.asset_id)
            .cloned()
            .unwrap_or_default(),
        custody_state: reads
            .joins
            .custody_by_content
            .get(&asset.content_id)
            .cloned(),
        purge_in_days: purge_in_days(purge_at.as_deref(), now_ms),
        purge_at,
        asset: asset.clone(),
    }
}

/// THE FOLD. Pure: everything it needs is in [`LibraryReads`].
#[must_use]
pub fn fold_library(reads: &LibraryReads, window: usize, now_ms: i64) -> LibraryData {
    let places: BTreeMap<String, PlaceRow> = reads
        .places
        .iter()
        .map(|place| (place.place_id.clone(), place.clone()))
        .collect();

    let mut assets: Vec<GridAsset> = reads
        .live
        .iter()
        // LIVE MEANS THE BYTES ARE LIVE TOO.
        .filter(|asset| {
            reads
                .contents
                .get(&asset.content_id)
                .is_none_or(|content| content.deleted_at.is_none())
        })
        .map(|asset| join_one(asset, reads, &places, now_ms, false))
        .collect();
    // Newest first by `taken_at`, with an absent one sorting last — the same
    // `String(b.taken_at ?? "").localeCompare(...)` v0 does, which is byte
    // order for the ISO instants this column holds.
    assets.sort_by(|left, right| {
        right
            .taken_at
            .as_deref()
            .unwrap_or("")
            .cmp(left.taken_at.as_deref().unwrap_or(""))
    });

    let mut trash: Vec<GridAsset> = reads
        .trash
        .iter()
        .map(|asset| join_one(asset, reads, &places, now_ms, true))
        .collect();
    trash.sort_by(|left, right| {
        right
            .asset
            .deleted_at
            .as_deref()
            .unwrap_or("")
            .cmp(left.asset.deleted_at.as_deref().unwrap_or(""))
    });

    let tail = assets.last().and_then(|asset| asset.taken_at.clone());
    LibraryData {
        assets,
        albums: reads.albums.clone(),
        places: reads.places.clone(),
        trash,
        memories: reads.memories.clone(),
        memory_members: reads.memory_members.clone(),
        truncated: reads.live_filled,
        window,
        tail,
    }
}

/// Read and fold `library`.
///
/// `now_ms` is INJECTED. v0 calls `Date.now()` inside the handler
/// (`library.ts:273`), which makes `purge_in_days` a function of the host's
/// wall clock and a fixture of it unreproducible (#1020, clock and ids are
/// injected).
pub fn load_library(
    door: &dyn PageDoor,
    input: &LibraryInput,
    now_ms: i64,
) -> KitResult<LibraryData> {
    let window = input.window();
    let before = input.before();

    let live = read_window(door, &live_statement(before), window)?;
    let trash = read_window(door, &trash_statement(), SHELF_ROWS)?;
    let albums = read_pages(
        door,
        &albums_statement("photos.library.albums"),
        ASSET_JOIN_BOUND,
    )?;
    let places = read_pages(door, &places_statement(), ASSET_JOIN_BOUND)?;
    // A cursored page carries no memories: the shelf belongs to the first
    // window (`library.ts:118-120`).
    let memories = if before.is_some() {
        Vec::new()
    } else {
        read_window(door, &memories_statement(), SHELF_ROWS)?.rows
    };

    let live_rows: Vec<AssetRow> = live.rows.iter().filter_map(AssetRow::of).collect();
    let trash_rows: Vec<AssetRow> = trash.rows.iter().filter_map(AssetRow::of).collect();
    let reads = assemble_joins(door, &live_rows, &trash_rows, &albums, &places, memories)?;
    let mut reads = reads;
    reads.live = live_rows;
    reads.live_filled = live.filled;
    reads.trash = trash_rows;
    Ok(fold_library(&reads, window, now_ms))
}

/// The `IN`-bounded joins both `library` and `search` make.
fn assemble_joins(
    door: &dyn PageDoor,
    live: &[AssetRow],
    trash: &[AssetRow],
    albums: &[Row],
    places: &[Row],
    memories: Vec<Row>,
) -> KitResult<LibraryReads> {
    let windowed: Vec<&AssetRow> = live.iter().chain(trash.iter()).collect();
    let asset_ids: Vec<String> = windowed
        .iter()
        .map(|asset| asset.asset_id.clone())
        .collect();
    let mut content_ids: Vec<String> = windowed
        .iter()
        .map(|asset| asset.content_id.clone())
        .filter(|id| !id.is_empty())
        .collect();
    content_ids.sort();
    content_ids.dedup();

    let contents = if content_ids.is_empty() {
        BTreeMap::new()
    } else {
        read_pages(
            door,
            &content_statement("photos.library.contents", &content_ids)?,
            ASSET_JOIN_BOUND,
        )?
        .iter()
        .filter_map(|row| Some((text_of(row, "content_id")?, ContentRow::of(row)?)))
        .collect()
    };

    let mut album_ids_by_asset: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if !asset_ids.is_empty() {
        for row in read_pages(
            door,
            &album_entries_statement("photos.library.albumEntries", &asset_ids)?,
            ASSET_PAIR_BOUND,
        )? {
            if let (Some(target), Some(collection)) =
                (text_of(&row, "target_id"), text_of(&row, "collection_id"))
            {
                album_ids_by_asset
                    .entry(target)
                    .or_default()
                    .push(collection);
            }
        }
    }

    let schemes = read_pages(door, &schemes_statement(), ASSET_JOIN_BOUND)?;
    let concepts = read_pages(door, &concepts_statement(), ASSET_PAIR_BOUND)?;
    let asset_tags = if asset_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(door, &asset_tags_statement(&asset_ids)?, ASSET_PAIR_BOUND)?
    };
    let custody = if content_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(door, &custody_statement(&content_ids)?, ASSET_JOIN_BOUND)?
    };

    let memory_ids: Vec<String> = memories
        .iter()
        .filter_map(|row| text_of(row, "memory_id"))
        .collect();
    let memory_members = if memory_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(
            door,
            &memory_members_statement(&memory_ids)?,
            ASSET_PAIR_BOUND,
        )?
    };

    Ok(LibraryReads {
        live: Vec::new(),
        live_filled: false,
        trash: Vec::new(),
        albums: albums
            .iter()
            .filter_map(|row| {
                Some(AlbumRow {
                    album_id: text_of(row, "collection_id")?,
                    title: text_of(row, "name"),
                    cover_content_id: text_of(row, "cover_content_id"),
                })
            })
            .collect(),
        places: places.iter().filter_map(PlaceRow::of).collect(),
        contents,
        album_ids_by_asset,
        // `core_content_representation` is the R20(b) media-type index, keyed
        // on the OWNER — `media.asset` — never on the bytes, because two
        // assets can share a sha and read it as two different things. The
        // representation read is the automations lane's `representation-reads`
        // port; until it lands the field is absent rather than guessed, and
        // the fixture manifest marks it `deferred`.
        media_types: BTreeMap::new(),
        joins: fold_asset_joins(&schemes, &concepts, &asset_tags, &custody),
        memories,
        memory_members,
    })
}

// ---------------------------------------------------------------------------
// `search`.
// ---------------------------------------------------------------------------

/// What `search` answers. The same grid rows, in **vault rank order**.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub assets: Vec<GridAsset>,
}

/// Read and fold `search`, given the FTS hits the vault's own index answered.
///
/// The FTS read is `ctx.vault.search`, which is not a `PageQuery` and belongs
/// to `crates/search`; the hits arrive here as content ids **in rank order**,
/// and that order is the answer's order — a port that re-sorted by capture time
/// would throw the ranking away.
pub fn load_search(door: &dyn PageDoor, hits: &[String], now_ms: i64) -> KitResult<SearchData> {
    if hits.is_empty() {
        return Ok(SearchData::default());
    }
    let mut content_ids: Vec<String> = hits.to_vec();
    content_ids.sort();
    content_ids.dedup();
    let matched = read_window(door, &search_assets_statement(&content_ids)?, MATCH_ROWS)?;
    let assets: Vec<AssetRow> = matched.rows.iter().filter_map(AssetRow::of).collect();
    if assets.is_empty() {
        return Ok(SearchData::default());
    }
    let albums = read_pages(
        door,
        &albums_statement("photos.search.albums"),
        ASSET_JOIN_BOUND,
    )?;
    let places = read_pages(door, &places_statement(), ASSET_JOIN_BOUND)?;
    let mut reads = assemble_joins(door, &assets, &[], &albums, &places, Vec::new())?;
    reads.live = assets;
    let folded = fold_library(&reads, MATCH_ROWS, now_ms);
    // Vault rank order (best match first), by the hit list's own order.
    let rank: BTreeMap<&str, usize> = hits
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    let mut assets = folded.assets;
    assets.sort_by_key(|asset| {
        rank.get(asset.asset.content_id.as_str())
            .copied()
            .unwrap_or(usize::MAX)
    });
    Ok(SearchData { assets })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_clamps_to_the_manifests_own_bounds() {
        assert_eq!(LibraryInput::default().window(), 500);
        assert_eq!(
            LibraryInput {
                limit: Some(0),
                before: None
            }
            .window(),
            500,
            "a zero limit is v0's `|| 500`, not zero rows"
        );
        assert_eq!(
            LibraryInput {
                limit: Some(5),
                before: None
            }
            .window(),
            20
        );
        assert_eq!(
            LibraryInput {
                limit: Some(9_000),
                before: None
            }
            .window(),
            2_000
        );
    }

    #[test]
    fn an_empty_before_is_no_cursor() {
        let input = LibraryInput {
            limit: None,
            before: Some(String::new()),
        };
        assert_eq!(input.before(), None);
        assert_eq!(live_statement(input.before()).bind.len(), 0);
    }

    /// The keyset predicate is `captured_at < ?`, so a NULL capture time fails
    /// it — which is why an undated asset rides the first window only.
    #[test]
    fn the_cursor_predicate_is_a_strict_comparison_that_null_fails() {
        let query = live_statement(Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(
            query.r#where.as_deref(),
            Some("deleted_at IS NULL AND archived_at IS NULL AND captured_at < ?")
        );
        assert_eq!(query.bind.len(), 1);
    }

    #[test]
    fn archived_assets_are_in_neither_shelf() {
        let live = live_statement(None);
        assert!(
            live.r#where
                .as_deref()
                .is_some_and(|clause| clause.contains("archived_at IS NULL"))
        );
        assert_eq!(
            trash_statement().r#where.as_deref(),
            Some("deleted_at IS NOT NULL")
        );
    }

    #[test]
    fn a_blob_uri_becomes_three_variants_and_a_data_uri_becomes_none() {
        let blob = ContentRow {
            content_id: "c-1".to_owned(),
            content_uri: Some("blob:sha256-abc".to_owned()),
            byte_size: Some(10),
            created_at: None,
            deleted_at: None,
            purge_at: None,
        };
        let uris = src_of(Some(&blob));
        assert_eq!(uris.src.as_deref(), Some("/centraid/_vault/blobs/c-1"));
        assert_eq!(
            uris.thumb.as_deref(),
            Some("/centraid/_vault/blobs/c-1?variant=thumb")
        );
        let inline = ContentRow {
            content_uri: Some("data:image/png;base64,AA".to_owned()),
            ..blob
        };
        let uris = src_of(Some(&inline));
        assert_eq!(uris.src.as_deref(), Some("data:image/png;base64,AA"));
        assert_eq!(uris.thumb, None, "there is no derivative to ask for");
        assert_eq!(src_of(None), SourceUris::default());
    }

    #[test]
    fn a_purge_window_with_no_date_is_unknown_and_not_today() {
        let now = parse_instant_ms("2026-03-01T00:00:00.000Z").expect("parses");
        assert_eq!(purge_in_days(None, now), None);
        assert_eq!(purge_in_days(Some("not-a-date"), now), None);
        assert_eq!(
            purge_in_days(Some("2026-03-31T00:00:00.000Z"), now),
            Some(30)
        );
        assert_eq!(
            purge_in_days(Some("2026-02-01T00:00:00.000Z"), now),
            Some(0),
            "an expired window floors at zero rather than going negative"
        );
    }

    #[test]
    fn the_instant_parser_agrees_with_the_epoch_on_known_dates() {
        assert_eq!(parse_instant_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            parse_instant_ms("2026-03-01T00:00:00.000Z"),
            Some(1_772_323_200_000)
        );
        assert_eq!(
            parse_instant_ms("2099-06-01T09:00:00.000Z"),
            Some(4_083_987_600_000)
        );
        assert_eq!(parse_instant_ms("2026-03-01"), None);
    }

    #[test]
    fn the_star_is_derived_from_the_flags_scheme_and_absence_is_none() {
        use centraid_apps_kit::row::Cell;
        let text = |pairs: &[(&str, &str)]| -> Row {
            pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), Cell::Text((*value).to_owned())))
                .collect()
        };
        let schemes = vec![
            text(&[("scheme_id", "s-flags"), ("uri", FLAGS_SCHEME_URI)]),
            text(&[("scheme_id", "s-tags"), ("uri", TAGS_SCHEME_URI)]),
        ];
        let concepts = vec![
            text(&[
                ("concept_id", "c-star"),
                ("scheme_id", "s-flags"),
                ("notation", STARRED_NOTATION),
                ("pref_label", "Starred"),
            ]),
            text(&[
                ("concept_id", "c-sunset"),
                ("scheme_id", "s-tags"),
                ("notation", "sunset"),
                ("pref_label", "sunset"),
            ]),
        ];
        let tags = vec![
            text(&[
                ("tag_id", "t-1"),
                ("target_type", TAG_TARGET_TYPE),
                ("target_id", "a-1"),
                ("concept_id", "c-star"),
            ]),
            text(&[
                ("tag_id", "t-2"),
                ("target_type", TAG_TARGET_TYPE),
                ("target_id", "a-1"),
                ("concept_id", "c-sunset"),
            ]),
        ];
        let joins = fold_asset_joins(&schemes, &concepts, &tags, &[]);
        assert!(joins.favorite_assets.contains("a-1"));
        assert_eq!(
            joins.tags_by_asset["a-1"].len(),
            1,
            "the star is not a label"
        );
        assert_eq!(joins.tags_by_asset["a-1"][0].tag_id, "t-2");

        // NO flags scheme yet: nothing is starred, and it is not an error.
        let none = fold_asset_joins(&schemes[1..], &concepts, &tags, &[]);
        assert!(none.favorite_assets.is_empty());
    }

    #[test]
    fn a_live_asset_over_released_bytes_is_not_library() {
        let asset = AssetRow {
            asset_id: "a-1".to_owned(),
            content_id: "c-1".to_owned(),
            kind: Some("photo".to_owned()),
            title: None,
            captured_at: Some("2026-01-01T00:00:00.000Z".to_owned()),
            tz_offset_min: None,
            capture_group_id: None,
            place_id: None,
            width: None,
            height: None,
            source_asset_id: None,
            archived_at: None,
            deleted_at: None,
            purge_at: None,
            created_at: None,
        };
        let mut reads = LibraryReads {
            live: vec![asset.clone()],
            ..LibraryReads::default()
        };
        reads.contents.insert(
            "c-1".to_owned(),
            ContentRow {
                content_id: "c-1".to_owned(),
                content_uri: Some("blob:x".to_owned()),
                byte_size: Some(1),
                created_at: None,
                deleted_at: Some("2026-02-01T00:00:00.000Z".to_owned()),
                purge_at: None,
            },
        );
        assert!(fold_library(&reads, 500, 0).assets.is_empty());
    }

    #[test]
    fn the_tail_is_the_oldest_taken_at_the_page_reached() {
        let make = |id: &str, at: &str| AssetRow {
            asset_id: id.to_owned(),
            content_id: format!("c-{id}"),
            kind: None,
            title: None,
            captured_at: Some(at.to_owned()),
            tz_offset_min: None,
            capture_group_id: None,
            place_id: None,
            width: None,
            height: None,
            source_asset_id: None,
            archived_at: None,
            deleted_at: None,
            purge_at: None,
            created_at: None,
        };
        let reads = LibraryReads {
            live: vec![
                make("a-1", "2026-01-01T00:00:00.000Z"),
                make("a-2", "2026-03-01T00:00:00.000Z"),
            ],
            live_filled: true,
            ..LibraryReads::default()
        };
        let data = fold_library(&reads, 500, 0);
        assert_eq!(
            data.assets
                .iter()
                .map(|asset| asset.asset.asset_id.as_str())
                .collect::<Vec<_>>(),
            ["a-2", "a-1"],
            "newest first"
        );
        assert_eq!(data.tail.as_deref(), Some("2026-01-01T00:00:00.000Z"));
        assert!(data.truncated);
    }

    #[test]
    fn every_statement_selects_the_two_columns_its_cursor_reads() {
        let statements = vec![
            live_statement(None),
            trash_statement(),
            albums_statement("photos.library.albums"),
            memories_statement(),
            schemes_statement(),
            concepts_statement(),
        ];
        for query in statements {
            for column in [&query.order.sort_column, &query.order.pk_column] {
                assert!(
                    query.select.contains(column.as_str()),
                    "{} orders by {column} and does not select it",
                    query.name
                );
            }
        }
    }
}
