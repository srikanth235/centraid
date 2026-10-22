//! ONE PHOTOGRAPH, AS EVERY GRID DRAWS IT (#1135).
//!
//! A cell is what the library, a shelf, a place, the picker, the film strip, a
//! search hit and a duplicate cluster all show of one photograph: its bytes, its
//! capture, its box, its heart, its albums and what this device holds of it. It is
//! read for a bounded set of ids, one table at a time, because the paged door's one
//! shape is a keyset page of one table.
//!
//! **What this device holds is the vault's to say.** The `photo` read asks the door
//! for the held-bytes columns ([`PageQuery::with_held_thumbnail`]): the path of a
//! picture a cell can draw, and whether the original itself is on this device.
//! Nothing here builds a path or tests a media type, and a cell with no path is a
//! state a surface already draws.
//!
//! **A Live Photo is two photographs and one cell.** Its still and its movie share
//! a `burst`; the still says `live` and names the movie, the movie says whose it is
//! (`live_of`), and the surface decides whether to draw the movie as its own cell.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Read};
use centraid_apps_kit::row::{Cell, Row, integer_or_zero, text_of};
use centraid_apps_kit::rules::{STARRED_FLAG, Standing};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::queries::purge_in_days;

/// The most ids one `IN` list names.
pub const CHUNK: usize = 200;

/// Pairs of rows (a tag, a membership) over a bounded set of photographs.
const PAIRS: FanOutBound = FanOutBound::new(500, 64);

/// The `photo` row's columns a cell needs.
pub const CELL_COLUMNS: &str = "id, blob, media_type, form, taken_at, offset_min, width, height, \
                                duration_s, burst, edited_from, place_id";

/// One photograph, joined.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PhotoCell {
    pub photo_id: String,
    /// The bytes' hash (`photo.blob`); also the original's hash.
    pub content_id: String,
    pub media_type: Option<String>,
    /// `photo`, `video` or `scan`.
    pub form: Option<String>,
    /// The caption; empty when there is none.
    pub title: String,
    /// When it was taken, as the file said. `None` is an undated photograph.
    pub taken_at: Option<String>,
    pub offset_min: Option<i64>,
    pub burst: Option<String>,
    pub edited_from: Option<String>,
    pub place_id: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_s: Option<f64>,
    pub created_at: Option<String>,
    /// The trash stamp; only a trashed photograph has one.
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    /// Whole days left in the trash, rounded up; `None` when there is no date to
    /// count from, and never `0` for that.
    pub purge_in_days: Option<i64>,
    /// A heart is a `tagged` edge to the starred flag, not a column.
    pub favorite: bool,
    pub archived: bool,
    pub byte_size: Option<i64>,
    /// The live albums that hold it.
    pub album_ids: Vec<String>,
    /// A path a cell can draw, from the bytes this device holds.
    pub thumbnail_path: Option<String>,
    /// The original itself is on this device.
    pub original_held: bool,
    /// A still with a paired movie.
    pub live: bool,
    pub live_movie_id: Option<String>,
    pub live_content_id: Option<String>,
    /// A movie paired with a still: that still's id.
    pub live_of: Option<String>,
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

fn text(value: &str) -> Vec<PageBindValue> {
    vec![PageBindValue::Text(value.to_owned())]
}

/// The rows whose `column` is among `ids`, walked in `order`: a column that several
/// rows share (a tag, a membership) is paged with the other end as its tiebreak, so
/// a page boundary inside one id's rows drops none of them.
fn read_of(
    door: &dyn PageDoor,
    name: &'static str,
    table: &'static str,
    select: &'static str,
    column: &'static str,
    ids: &[String],
    extra: Option<(&str, Vec<PageBindValue>)>,
) -> KitResult<Vec<Row>> {
    let order = match (table, column) {
        ("edge", "from_id") => ("from_id", "to_id"),
        ("edge", "to_id") => ("to_id", "from_id"),
        ("photo", "burst") => ("blob", "id"),
        _ => (column, column),
    };
    Read {
        name,
        table,
        select,
        order,
        column,
    }
    .within(PAIRS, door, ids, extra)
}

/// The `photo` rows of `ids` WITH the held-bytes columns, a chunk at a time and one
/// page each (an id names one photograph, so a chunk is one page).
fn held_rows(door: &dyn PageDoor, ids: &[String]) -> KitResult<Vec<Row>> {
    let mut out = Vec::new();
    for chunk in ids.chunks(CHUNK) {
        let fragment = centraid_apps_kit::reads::in_list("id", chunk)?;
        let query = PageQuery::new(
            "photos.cells.photo",
            CELL_COLUMNS,
            "photo",
            PageOrder::asc("blob", "id"),
        )
        .filter(&fragment.sql, fragment.bind)
        .with_held_thumbnail();
        out.extend(
            door.page(
                &query,
                &centraid_apps_kit::PageRequest::first(CHUNK.max(chunk.len())),
            )?
            .rows,
        );
    }
    Ok(out)
}

fn chunked<T>(
    ids: &[String],
    mut read: impl FnMut(&[String]) -> KitResult<Vec<T>>,
) -> KitResult<Vec<T>> {
    let mut out = Vec::new();
    for chunk in ids.chunks(CHUNK) {
        out.extend(read(chunk)?);
    }
    Ok(out)
}

/// The newest photograph of one form in a burst: its id and its bytes' hash.
type Newest = Option<(String, String)>;

/// A still and its movie: two photographs of one burst.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LivePair {
    pub still_id: String,
    pub movie_id: String,
    pub movie_content_id: String,
}

/// The Live Photo pairs of these bursts: per burst, the newest still and the
/// newest movie that are not in the trash, when both exist.
///
/// # Errors
/// The door's refusal, or a walk past its bound.
pub fn live_pairs(
    door: &dyn PageDoor,
    standing: &Standing,
    bursts: &[String],
) -> KitResult<BTreeMap<String, LivePair>> {
    let mut by_burst: BTreeMap<String, (Newest, Newest)> = BTreeMap::new();
    let rows = chunked(bursts, |chunk| {
        read_of(
            door,
            "photos.cells.burst",
            "photo",
            "id, blob, form, burst",
            "burst",
            chunk,
            None,
        )
    })?;
    for row in &rows {
        let (Some(id), Some(burst), Some(blob)) = (
            text_of(row, "id"),
            text_of(row, "burst"),
            text_of(row, "blob"),
        ) else {
            continue;
        };
        if standing.is_trashed(&id) {
            continue;
        }
        let slot = by_burst.entry(burst).or_default();
        let newest = |held: &mut Newest| {
            if held.as_ref().is_none_or(|(held_id, _)| id > *held_id) {
                *held = Some((id.clone(), blob.clone()));
            }
        };
        match text_of(row, "form").as_deref() {
            Some("photo") => newest(&mut slot.0),
            Some("video") => newest(&mut slot.1),
            _ => {}
        }
    }
    Ok(by_burst
        .into_iter()
        .filter_map(|(burst, (still, movie))| {
            let (still_id, _) = still?;
            let (movie_id, movie_content_id) = movie?;
            Some((
                burst,
                LivePair {
                    still_id,
                    movie_id,
                    movie_content_id,
                },
            ))
        })
        .collect())
}

/// The cells of `ids`, by id. An id with no photograph is absent from the answer.
///
/// `now_ms` counts the trash's days; it is injected, never read here.
///
/// # Errors
/// The door's refusal, or a walk past its bound.
pub fn read_cells(
    door: &dyn PageDoor,
    standing: &Standing,
    ids: &[String],
    now_ms: i64,
) -> KitResult<BTreeMap<String, PhotoCell>> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let photos = held_rows(door, ids)?;
    let entities: BTreeMap<String, Row> = chunked(ids, |chunk| {
        read_of(
            door,
            "photos.cells.entity",
            "entity",
            "id, title, created_at, deleted_at, purge_at",
            "id",
            chunk,
            Some(("kind = ?", text("photo"))),
        )
    })?
    .into_iter()
    .filter_map(|row| Some((text_of(&row, "id")?, row)))
    .collect();
    let hashes: Vec<String> = photos
        .iter()
        .filter_map(|row| text_of(row, "blob"))
        .collect();
    let sizes: BTreeMap<String, i64> = chunked(&hashes, |chunk| {
        read_of(
            door,
            "photos.cells.blob",
            "blob",
            "hash, size",
            "hash",
            chunk,
            None,
        )
    })?
    .iter()
    .filter_map(|row| Some((text_of(row, "hash")?, integer_or_zero(row, "size"))))
    .collect();
    let hearted: BTreeSet<String> = chunked(ids, |chunk| {
        read_of(
            door,
            "photos.cells.starred",
            "edge",
            "from_id, to_id",
            "from_id",
            chunk,
            Some((
                "rel = ? AND to_id = ?",
                vec![
                    PageBindValue::Text("tagged".to_owned()),
                    PageBindValue::Text(STARRED_FLAG.to_owned()),
                ],
            )),
        )
    })?
    .iter()
    .filter_map(|row| text_of(row, "from_id"))
    .collect();
    let held_in = chunked(ids, |chunk| {
        read_of(
            door,
            "photos.cells.albums",
            "edge",
            "from_id, to_id, position",
            "to_id",
            chunk,
            Some(("rel = ?", text("contains"))),
        )
    })?;
    let mut album_candidates: Vec<String> = held_in
        .iter()
        .filter_map(|row| text_of(row, "from_id"))
        .collect();
    album_candidates.sort_unstable();
    album_candidates.dedup();
    let live_albums: BTreeSet<String> = chunked(&album_candidates, |chunk| {
        read_of(
            door,
            "photos.cells.album_entities",
            "entity",
            "id",
            "id",
            chunk,
            Some(("kind = ? AND deleted_at IS NULL", text("album"))),
        )
    })?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .collect();
    let mut albums_of: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for edge in &held_in {
        if let (Some(album), Some(photo)) = (text_of(edge, "from_id"), text_of(edge, "to_id"))
            && live_albums.contains(&album)
        {
            albums_of.entry(photo).or_default().push(album);
        }
    }
    let mut bursts: Vec<String> = photos
        .iter()
        .filter_map(|row| text_of(row, "burst"))
        .collect();
    bursts.sort_unstable();
    bursts.dedup();
    let pairs = live_pairs(door, standing, &bursts)?;
    let mut out = BTreeMap::new();
    for row in &photos {
        let (Some(photo_id), Some(content_id)) = (text_of(row, "id"), text_of(row, "blob")) else {
            continue;
        };
        let Some(entity) = entities.get(&photo_id) else {
            continue;
        };
        let burst = text_of(row, "burst");
        let pair = burst.as_deref().and_then(|burst| pairs.get(burst));
        let deleted_at = text_of(entity, "deleted_at");
        let purge_at = text_of(entity, "purge_at");
        let mut cell = PhotoCell {
            byte_size: sizes.get(&content_id).copied(),
            favorite: hearted.contains(&photo_id),
            archived: standing.is_archived(&photo_id),
            album_ids: albums_of.remove(&photo_id).unwrap_or_default(),
            media_type: text_of(row, "media_type"),
            form: text_of(row, "form"),
            title: text_of(entity, "title").unwrap_or_default(),
            taken_at: text_of(row, "taken_at"),
            offset_min: row.get("offset_min").and_then(Cell::integer),
            burst,
            edited_from: text_of(row, "edited_from"),
            place_id: text_of(row, "place_id"),
            width: row.get("width").and_then(Cell::integer),
            height: row.get("height").and_then(Cell::integer),
            duration_s: real_of(row, "duration_s"),
            created_at: text_of(entity, "created_at"),
            purge_in_days: deleted_at
                .as_ref()
                .and_then(|_| purge_in_days(purge_at.as_deref(), now_ms)),
            deleted_at,
            purge_at,
            thumbnail_path: text_of(row, "thumbnail_path").filter(|path| !path.is_empty()),
            original_held: integer_or_zero(row, "original_held") > 0,
            photo_id: photo_id.clone(),
            content_id,
            ..PhotoCell::default()
        };
        if let Some(pair) = pair {
            if pair.still_id == photo_id {
                cell.live = true;
                cell.live_movie_id = Some(pair.movie_id.clone());
                cell.live_content_id = Some(pair.movie_content_id.clone());
            } else if pair.movie_id == photo_id {
                cell.live_of = Some(pair.still_id.clone());
            }
        }
        out.insert(photo_id, cell);
    }
    Ok(out)
}

/// The sort the library draws in: capture time newest first, an undated
/// photograph after every dated one, the id breaking ties newest first.
#[must_use]
pub fn timeline_order(left: &PhotoCell, right: &PhotoCell) -> std::cmp::Ordering {
    match (&left.taken_at, &right.taken_at) {
        (Some(a), Some(b)) => b.cmp(a).then_with(|| right.photo_id.cmp(&left.photo_id)),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => right.photo_id.cmp(&left.photo_id),
    }
}
