//! PHOTOS' READS, over the model's own tables, one table at a time (#1135).
//!
//! A photograph is an `entity` of kind `photo` (its title is the caption and may
//! be empty) over a `photo` row (the blob, what it is, when and where it was
//! taken); an album is a `container` joined to its photographs by ordered
//! `contains` edges; a heart, the archive and a label are `tagged` edges; a place
//! is a `place` entity; a thumbnail, a perceptual hash and a caption are the
//! blob's `derivative`s. The paged door's one shape is a keyset page of one table,
//! so the library is a window of `photo` rows and then, for the ids it returned,
//! one bounded read of each table that decorates them.
//!
//! ## What the library shows
//!
//! The library is the newest `limit` photographs by capture time, **live and not
//! archived, and not folded under an edit**. The trash and the archive are
//! `entity` and `edge` facts, not columns of the `photo` row, so the window is
//! read first and they are applied to it: `truncated` is the page's own cursor and
//! `photos` may hold fewer rows than `window` while it is true.
//!
//! An edit folds the photograph it was made from: a phone's edited photo arrives
//! as two photographs of one capture (the camera's bytes, and the edit's render
//! with `edited_from` naming them and a shared `burst`), and the library draws only
//! the newest live one of a burst, so the grid shows the edit, the original is
//! still there, and trashing or archiving the edit brings the original back. A
//! crop the member saved from Centraid's own editor carries no burst and folds
//! nothing: it is a new photograph they chose to make.
//!
//! ## ONE PAGE, BECAUSE THE SORT COLUMN IS NULLABLE (D-1020-P11)
//!
//! `photo.taken_at` is nullable, and the kit's door refuses a CONTINUED page over a
//! nullable sort key because SQLite's row-value comparison puts every NULL on one
//! side of the keyset and the walk silently drops them. So the window is one page
//! plus "there is more" (`truncated`), and an undated photograph rides the first
//! window only.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{MAX_PAGE_ROWS, PageRequest};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Read, read_pages};
use centraid_apps_kit::reads::{JOIN_FAN_OUT, Window};
use centraid_apps_kit::row::{Cell, Row, integer_or_zero, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::Denial;
use crate::places::PlaceRow;

/// What the index and the door call a photograph.
pub const PHOTO_KIND: &str = "photo";

/// The flags a heart and the archive are: `tagged` edges to these concepts.
pub const STARRED: &str = "flag:starred";
pub const ARCHIVED: &str = "flag:archived";

/// The trash shelf is what the screen shows, so that is the read.
pub const SHELF_ROWS: usize = 200;

/// How many ranked hits `search` folds.
pub const SEARCH_ROWS: usize = MAX_PAGE_ROWS;

/// The library window, as the manifest declares it.
pub const LIBRARY_MIN: usize = 20;
pub const LIBRARY_MAX: usize = 2_000;
pub const LIBRARY_DEFAULT: usize = 500;

/// Where the vault serves a blob's bytes, by hash.
pub use centraid_apps_kit::attached::BLOB_ROUTE;

/// A join per windowed photograph: 500 x 8 = 4,000 rows, the kit's fan-out.
pub const PHOTO_JOIN_BOUND: FanOutBound = JOIN_FAN_OUT;

/// Tags and album entries are pairs over a 2,000-photograph window: 500 x 32 =
/// 16,000 rows, stated.
pub const PHOTO_PAIR_BOUND: FanOutBound = FanOutBound::new(500, 32);

/// The `photo` row's columns, and the entity's.
const PHOTO_COLUMNS: &str = "id, blob, media_type, form, taken_at, offset_min, width, height, \
                             duration_s, burst, edited_from, place_id";
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

/// ONE PAGE, and whether it was the last.
fn read_one_page(door: &dyn PageDoor, query: &PageQuery, rows: usize) -> KitResult<Window> {
    let page = door.page(query, &PageRequest::first(rows.min(MAX_PAGE_ROWS)))?;
    Ok(Window {
        filled: page.next.is_some(),
        rows: page.rows,
    })
}

// ---------------------------------------------------------------------------
// Rows and payloads
// ---------------------------------------------------------------------------

/// One photograph: its `photo` row and its entity.
#[derive(Debug, Clone, PartialEq)]
pub struct PhotoRow {
    pub photo_id: String,
    /// The bytes' hash.
    pub content_id: String,
    pub media_type: Option<String>,
    /// `photo`, `video` or `scan`.
    pub form: Option<String>,
    /// The caption; empty when there is none.
    pub title: String,
    pub taken_at: Option<String>,
    pub offset_min: Option<i64>,
    pub burst: Option<String>,
    pub place_id: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_s: Option<f64>,
    pub edited_from: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

fn real_of(row: &Row, column: &str) -> Option<f64> {
    match row.get(column) {
        Some(Cell::Real(value)) => Some(*value),
        #[expect(
            clippy::cast_precision_loss,
            reason = "a whole number of seconds is exact"
        )]
        Some(Cell::Integer(value)) => Some(*value as f64),
        _ => None,
    }
}

impl PhotoRow {
    /// A `photo` row and its entity's, joined by the caller.
    #[must_use]
    pub fn of(photo: &Row, entity: &Row) -> Option<Self> {
        Some(Self {
            photo_id: text_of(photo, "id")?,
            content_id: text_of(photo, "blob")?,
            media_type: text_of(photo, "media_type"),
            form: text_of(photo, "form"),
            title: text_of(entity, "title").unwrap_or_default(),
            taken_at: text_of(photo, "taken_at"),
            offset_min: photo.get("offset_min").and_then(Cell::integer),
            burst: text_of(photo, "burst"),
            place_id: text_of(photo, "place_id"),
            width: photo.get("width").and_then(Cell::integer),
            height: photo.get("height").and_then(Cell::integer),
            duration_s: real_of(photo, "duration_s"),
            edited_from: text_of(photo, "edited_from"),
            created_at: text_of(entity, "created_at"),
            updated_at: text_of(entity, "updated_at"),
            deleted_at: text_of(entity, "deleted_at"),
            purge_at: text_of(entity, "purge_at"),
        })
    }
}

/// One label on one photograph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoTag {
    pub tag_id: String,
    pub label: String,
}

/// One album, as the shelf shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumRow {
    pub album_id: String,
    pub title: Option<String>,
    /// The chosen cover's bytes, when it is still a member and live; else the
    /// album's first live photograph.
    pub cover_content_id: Option<String>,
    /// Live photographs in it.
    pub photo_count: usize,
}

/// One grid row: the photograph, joined.
#[derive(Debug, Clone, PartialEq)]
pub struct GridPhoto {
    pub photo: PhotoRow,
    /// A heart is a `tagged` edge to the starred flag, not a column.
    pub favorite: bool,
    pub byte_size: Option<i64>,
    /// `taken_at`, else when the photograph was made. Derived, never a duplicate
    /// column.
    pub taken_at: Option<String>,
    pub album_ids: Vec<String>,
    pub album_titles: Vec<String>,
    pub place: Option<PlaceRow>,
    pub tags: Vec<PhotoTag>,
    /// Trash only: days until the grace window closes. `None` when the row
    /// carries no `purge_at` — never `0`, which would read as "today".
    pub purge_in_days: Option<i64>,
    pub purge_at: Option<String>,
}

/// What `library` answers.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LibraryData {
    pub photos: Vec<GridPhoto>,
    pub albums: Vec<AlbumRow>,
    pub places: Vec<PlaceRow>,
    pub trash: Vec<GridPhoto>,
    /// Older photographs exist beyond the window: the page's own cursor.
    pub truncated: bool,
    /// The window that was actually asked for, after the clamp.
    pub window: usize,
    /// The oldest `taken_at` this page reached: pass it back as `before`.
    pub tail: Option<String>,
}

/// `library`'s input.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LibraryInput {
    pub limit: Option<usize>,
    /// The keyset cursor: only photographs taken strictly earlier.
    pub before: Option<String>,
}

impl LibraryInput {
    /// The clamped window: a zero or absent limit is the default, not zero rows.
    #[must_use]
    pub fn window(&self) -> usize {
        self.limit
            .filter(|limit| *limit > 0)
            .unwrap_or(LIBRARY_DEFAULT)
            .clamp(LIBRARY_MIN, LIBRARY_MAX)
    }

    /// The cursor, with the empty string read as absent.
    #[must_use]
    pub fn before(&self) -> Option<&str> {
        self.before.as_deref().filter(|text| !text.is_empty())
    }
}

// ---------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------

/// `photos.library.window` — the newest photographs by capture time.
///
/// The `before` predicate is `taken_at < ?`, and a NULL `taken_at` FAILS that
/// comparison in SQL. That is not a bug to fix: an undated photograph has no place
/// in a timeline cursor, so it rides the first window and no other.
#[must_use]
pub fn window_statement(before: Option<&str>) -> PageQuery {
    let query = PageQuery::new(
        "photos.library.window",
        PHOTO_COLUMNS,
        "photo",
        PageOrder::desc("taken_at", "id"),
    );
    match before {
        Some(before) => query.filter("taken_at < ?", text(before)),
        None => query,
    }
}

/// `photos.library.trash` — what is in the trash, newest first.
#[must_use]
pub fn trash_statement() -> PageQuery {
    PageQuery::new(
        "photos.library.trash",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("deleted_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NOT NULL", text(PHOTO_KIND))
}

/// `photos.library.albums` — albums are containers: owner-curated and small.
#[must_use]
pub fn albums_statement() -> PageQuery {
    PageQuery::new(
        "photos.library.albums",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", text("album"))
}

/// `photos.shared.places` — the places are owner-shaped and small, so a walk with
/// a stated ceiling rather than a window nobody chose.
#[must_use]
pub fn places_statement() -> PageQuery {
    PageQuery::new(
        "photos.shared.places",
        "id, title",
        "entity",
        PageOrder::asc("id", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", text("place"))
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
    .within(PHOTO_PAIR_BOUND, door, ids, extra)
}

fn ids_of(rows: &[Row], column: &str) -> Vec<String> {
    rows.iter().filter_map(|row| text_of(row, column)).collect()
}

// ---------------------------------------------------------------------------
// The joins
// ---------------------------------------------------------------------------

/// Everything the decorations of a set of photographs need, read.
#[derive(Debug, Clone, Default)]
struct Joins {
    sizes: BTreeMap<String, i64>,
    favorites: BTreeSet<String>,
    archived: BTreeSet<String>,
    tags: BTreeMap<String, Vec<PhotoTag>>,
    /// Photograph id to the albums that hold it, in the album's own order.
    albums: BTreeMap<String, Vec<String>>,
}

fn read_joins(door: &dyn PageDoor, photos: &[PhotoRow]) -> KitResult<Joins> {
    let ids: Vec<String> = photos.iter().map(|photo| photo.photo_id.clone()).collect();
    if ids.is_empty() {
        return Ok(Joins::default());
    }
    let hashes: Vec<String> = photos
        .iter()
        .map(|photo| photo.content_id.clone())
        .collect();
    let sizes = read_of(
        door,
        "photos.joins.blobs",
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
        "photos.joins.tagged",
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
        "photos.joins.concepts",
        "entity",
        "id, title",
        "id",
        &concept_ids,
        Some(("kind = ?", text("tag"))),
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect();
    let mut joins = Joins {
        sizes,
        ..Joins::default()
    };
    for edge in &tag_edges {
        let (Some(from), Some(to)) = (text_of(edge, "from_id"), text_of(edge, "to_id")) else {
            continue;
        };
        if to == STARRED {
            joins.favorites.insert(from);
        } else if to == ARCHIVED {
            joins.archived.insert(from);
        } else if let Some(label) = labels.get(&to) {
            joins.tags.entry(from).or_default().push(PhotoTag {
                tag_id: to,
                label: label.clone(),
            });
        }
    }
    let held = read_of(
        door,
        "photos.joins.albums",
        "edge",
        "from_id, to_id, position",
        "to_id",
        &ids,
        Some(("rel = ?", text("contains"))),
    )?;
    for edge in &held {
        if let (Some(album), Some(photo)) = (text_of(edge, "from_id"), text_of(edge, "to_id")) {
            joins.albums.entry(photo).or_default().push(album);
        }
    }
    Ok(joins)
}

/// The entity rows of these photograph ids, by id.
fn read_entities(door: &dyn PageDoor, ids: &[String]) -> KitResult<BTreeMap<String, Row>> {
    Ok(read_of(
        door,
        "photos.rows.entity",
        "entity",
        ENTITY_COLUMNS,
        "id",
        ids,
        Some(("kind = ?", text(PHOTO_KIND))),
    )?
    .into_iter()
    .filter_map(|row| Some((text_of(&row, "id")?, row)))
    .collect())
}

/// The photographs a window of `photo` rows names, joined with their entities
/// and in the window's order.
fn photos_of(door: &dyn PageDoor, photo_rows: &[Row]) -> KitResult<Vec<PhotoRow>> {
    let entities = read_entities(door, &ids_of(photo_rows, "id"))?;
    Ok(photo_rows
        .iter()
        .filter_map(|row| PhotoRow::of(row, entities.get(&text_of(row, "id")?)?))
        .collect())
}

/// The ids an edit folds: a live photograph of a burst folds the photograph it was
/// made from, and any older photograph of the same burst that it did not come from.
///
/// An ungrouped photograph (no burst) folds nothing, so a crop saved from the
/// member's own editor stays drawn beside its original. A Live Photo's movie shares
/// its still's burst and is a `video`, which this never touches.
fn folded(live: &[&PhotoRow]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let stills: Vec<&&PhotoRow> = live
        .iter()
        .filter(|photo| photo.form.as_deref() == Some("photo"))
        .collect();
    for newer in stills.iter().filter(|photo| photo.burst.is_some()) {
        for older in &stills {
            if older.photo_id == newer.photo_id {
                continue;
            }
            let made_from = newer.edited_from.as_deref() == Some(older.photo_id.as_str());
            let same_burst = newer.burst == older.burst
                && older.edited_from.as_deref() != Some(newer.photo_id.as_str())
                && (&newer.created_at, &newer.photo_id) > (&older.created_at, &older.photo_id);
            if made_from || same_burst {
                out.insert(older.photo_id.clone());
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// `library`
// ---------------------------------------------------------------------------

/// Milliseconds in a day.
pub const DAY_MS: i64 = 86_400_000;

/// Whole days until `purge_at`, rounded UP and floored at zero. `None` when there
/// is no date to compare, and **`None` is not `0`**: "no grace window recorded" is
/// not "purges today".
#[must_use]
pub fn purge_in_days(purge_at: Option<&str>, now_ms: i64) -> Option<i64> {
    let parsed = parse_instant_ms(purge_at?)?;
    let ms = parsed - now_ms;
    Some(if ms <= 0 {
        0
    } else {
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

fn album_rows(door: &dyn PageDoor, wanted: &BTreeMap<String, String>) -> KitResult<Vec<AlbumRow>> {
    let ids: Vec<String> = wanted.keys().cloned().collect();
    let containers: BTreeMap<String, Option<String>> = read_of(
        door,
        "photos.albums.containers",
        "container",
        "id, cover",
        "id",
        &ids,
        None,
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "cover"))))
    .collect();
    let mut albums = Vec::new();
    for (album_id, title) in wanted {
        albums.push(AlbumRow {
            album_id: album_id.clone(),
            title: Some(title.clone()),
            cover_content_id: containers.get(album_id).cloned().flatten(),
            photo_count: 0,
        });
    }
    Ok(albums)
}

/// Read and fold `library`.
///
/// `now_ms` is INJECTED: a fixture of the host's wall clock is unreproducible.
pub fn load_library(
    door: &dyn PageDoor,
    input: &LibraryInput,
    now_ms: i64,
) -> KitResult<LibraryData> {
    let window = input.window();
    let newest = read_one_page(door, &window_statement(input.before()), window)?;
    let trashed = read_one_page(door, &trash_statement(), SHELF_ROWS)?;
    let windowed = photos_of(door, &newest.rows)?;
    let trash_ids = ids_of(&trashed.rows, "id");
    let trash_photo_rows = read_of(
        door,
        "photos.trash.rows",
        "photo",
        PHOTO_COLUMNS,
        "id",
        &trash_ids,
        None,
    )?;
    let in_trash = photos_of(door, &trash_photo_rows)?;
    let all: Vec<PhotoRow> = windowed.iter().chain(in_trash.iter()).cloned().collect();
    let joins = read_joins(door, &all)?;
    let places: Vec<PlaceRow> = crate::places::read_places(door)?;
    let by_place: BTreeMap<&str, &PlaceRow> = places
        .iter()
        .map(|place| (place.place_id.as_str(), place))
        .collect();
    let album_entities = read_pages(door, &albums_statement(), PHOTO_JOIN_BOUND)?;
    let wanted: BTreeMap<String, String> = album_entities
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
        .collect();
    let mut albums = album_rows(door, &wanted)?;
    let titles: BTreeMap<&str, &str> = wanted
        .iter()
        .map(|(id, title)| (id.as_str(), title.as_str()))
        .collect();

    let join_one = |photo: &PhotoRow, trash: bool| {
        let album_ids: Vec<String> = joins
            .albums
            .get(&photo.photo_id)
            .into_iter()
            .flatten()
            .filter(|id| titles.contains_key(id.as_str()))
            .cloned()
            .collect();
        let album_titles = album_ids
            .iter()
            .filter_map(|id| titles.get(id.as_str()).map(|title| (*title).to_owned()))
            .collect();
        let purge_at = trash.then(|| photo.purge_at.clone()).flatten();
        GridPhoto {
            favorite: joins.favorites.contains(&photo.photo_id),
            byte_size: joins.sizes.get(&photo.content_id).copied(),
            taken_at: photo.taken_at.clone().or_else(|| photo.created_at.clone()),
            album_ids,
            album_titles,
            place: photo
                .place_id
                .as_deref()
                .and_then(|id| by_place.get(id))
                .map(|place| (*place).clone()),
            tags: joins.tags.get(&photo.photo_id).cloned().unwrap_or_default(),
            purge_in_days: purge_in_days(purge_at.as_deref(), now_ms),
            purge_at,
            photo: photo.clone(),
        }
    };
    let live: Vec<&PhotoRow> = windowed
        .iter()
        .filter(|photo| photo.deleted_at.is_none() && !joins.archived.contains(&photo.photo_id))
        .collect();
    let folds = folded(&live);
    let mut photos: Vec<GridPhoto> = live
        .iter()
        .filter(|photo| !folds.contains(&photo.photo_id))
        .map(|photo| join_one(photo, false))
        .collect();
    // Newest first by `taken_at`, an absent one last.
    photos.sort_by(|left, right| {
        right
            .taken_at
            .as_deref()
            .unwrap_or("")
            .cmp(left.taken_at.as_deref().unwrap_or(""))
            .then_with(|| right.photo.photo_id.cmp(&left.photo.photo_id))
    });
    let mut trash: Vec<GridPhoto> = in_trash.iter().map(|photo| join_one(photo, true)).collect();
    trash.sort_by(|left, right| {
        right
            .photo
            .deleted_at
            .as_deref()
            .unwrap_or("")
            .cmp(left.photo.deleted_at.as_deref().unwrap_or(""))
    });
    // An album counts its live photographs and draws a cover that is still one of
    // them: the chosen cover, else the first it holds.
    for album in &mut albums {
        let held: Vec<&GridPhoto> = photos
            .iter()
            .filter(|grid| grid.album_ids.contains(&album.album_id))
            .collect();
        album.photo_count = held.len();
        let chosen_is_there = album
            .cover_content_id
            .as_deref()
            .is_some_and(|cover| held.iter().any(|grid| grid.photo.content_id == cover));
        if !chosen_is_there {
            album.cover_content_id = held.first().map(|grid| grid.photo.content_id.clone());
        }
    }
    let tail = photos.last().and_then(|grid| grid.taken_at.clone());
    Ok(LibraryData {
        photos,
        albums,
        places,
        trash,
        truncated: newest.filled,
        window,
        tail,
    })
}

// ---------------------------------------------------------------------------
// `search`
// ---------------------------------------------------------------------------

/// What `search` answers: the photographs whose caption, place or recognised text
/// the term names, in the index's **rank order**. A grid reads the photographs
/// themselves by these ids; the order it draws them in is its own.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub photo_ids: Vec<String>,
}

/// Ask the index for `term` over photographs and keep the hits that are LIVE and
/// not archived. The index holds live photographs only; the archive is an edge, so
/// it is read for the ids that came back. `limit` is clamped to [`SEARCH_ROWS`]. A
/// blank term, a term with no searchable word and a zero `limit` answer the empty
/// shape and no denial.
///
/// # Errors
///
/// A reached bound, as [`load_library`].
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
    let request = centraid_search::SearchRequest::new(PHOTO_KIND, term, limit.min(SEARCH_ROWS));
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
    let ids: Vec<String> = page.rows.iter().map(|target| target.id.clone()).collect();
    if ids.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let archived: BTreeSet<String> = ids_of(
        &read_of(
            door,
            "photos.search.archived",
            "edge",
            "from_id, to_id",
            "from_id",
            &ids,
            Some(("rel = ? AND to_id = ?", {
                let mut bind = text("tagged");
                bind.extend(text(ARCHIVED));
                bind
            })),
        )?,
        "from_id",
    )
    .into_iter()
    .collect();
    Ok((
        SearchData {
            photo_ids: ids
                .into_iter()
                .filter(|id| !archived.contains(id))
                .collect(),
        },
        None,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_clamps_to_the_manifests_own_bounds() {
        assert_eq!(LibraryInput::default().window(), 500);
        let at = |limit| LibraryInput {
            limit: Some(limit),
            before: None,
        };
        assert_eq!(
            at(0).window(),
            500,
            "a zero limit is v0's `|| 500`, not zero rows"
        );
        assert_eq!(at(5).window(), 20);
        assert_eq!(at(9_000).window(), 2_000);
    }

    #[test]
    fn an_empty_before_is_no_cursor() {
        let input = LibraryInput {
            limit: None,
            before: Some(String::new()),
        };
        assert_eq!(input.before(), None);
        assert_eq!(window_statement(input.before()).bind.len(), 0);
    }

    /// The keyset predicate is `taken_at < ?`, so a NULL capture time fails it —
    /// which is why an undated photograph rides the first window only.
    #[test]
    fn the_cursor_predicate_is_a_strict_comparison_that_null_fails() {
        let query = window_statement(Some("2026-01-01T00:00:00.000Z"));
        assert_eq!(query.r#where.as_deref(), Some("taken_at < ?"));
        assert_eq!(query.bind.len(), 1);
    }

    #[test]
    fn the_countdown_is_whole_days_rounded_up_and_never_zero_for_no_date() {
        let now = parse_instant_ms("2026-06-01T00:00:00.000Z").expect("an instant");
        assert_eq!(
            purge_in_days(Some("2026-06-02T00:00:00.001Z"), now),
            Some(2)
        );
        assert_eq!(
            purge_in_days(Some("2026-06-01T00:00:00.000Z"), now),
            Some(0)
        );
        assert_eq!(purge_in_days(None, now), None);
    }

    fn photo(
        id: &str,
        form: &str,
        burst: Option<&str>,
        from: Option<&str>,
        made: &str,
    ) -> PhotoRow {
        PhotoRow {
            photo_id: id.to_owned(),
            content_id: format!("h-{id}"),
            media_type: None,
            form: Some(form.to_owned()),
            title: String::new(),
            taken_at: None,
            offset_min: None,
            burst: burst.map(str::to_owned),
            place_id: None,
            width: None,
            height: None,
            duration_s: None,
            edited_from: from.map(str::to_owned),
            created_at: Some(made.to_owned()),
            updated_at: None,
            deleted_at: None,
            purge_at: None,
        }
    }

    /// AN EDIT DRAWS AND THE ORIGINAL STAYS UNDERNEATH: the render folds the camera's
    /// bytes, a second edit folds the first, a crop with no burst folds nothing, and
    /// a movie of a burst is never folded.
    #[test]
    fn an_edit_folds_what_it_was_made_from_and_a_crop_folds_nothing() {
        let original = photo("o", "photo", Some("b"), None, "2026-01-01");
        let edit = photo("e", "photo", Some("b"), Some("o"), "2026-01-02");
        let second = photo("e2", "photo", Some("b"), Some("e"), "2026-01-03");
        let movie = photo("m", "video", Some("b"), None, "2026-01-01");
        let crop = photo("c", "photo", None, Some("o"), "2026-01-04");
        let live = [&original, &edit, &second, &movie, &crop];
        let folds = folded(&live);
        assert_eq!(folds, ["e", "o"].map(str::to_owned).into_iter().collect());
        let without_the_edits = [&original, &movie, &crop];
        assert!(
            folded(&without_the_edits).is_empty(),
            "trashing the edit brings the original back"
        );
    }
}
