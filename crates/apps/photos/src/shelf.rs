//! `shelf` — ONE SHELF OF PHOTOGRAPHS, PAGED, with an exact total (#1135).
//!
//! The library, the favorites, the videos, the archive, the trash, an album, a
//! place and "no location yet" are one query under eight names. Each shelf is a
//! predicate over the one verdict ([`centraid_apps_kit::rules::Standing`]), so a
//! count on the collections page and the page it opens cannot disagree:
//!
//! | Shelf | Is |
//! |---|---|
//! | `live` | live: not trashed, not archived, not folded under an edit |
//! | `favorites` | live and hearted |
//! | `videos` | live and a `video` |
//! | `archive` | archived and not trashed |
//! | `trash` | every trashed photograph, archived or not; newest trashed first |
//! | `album` | every member that is not trashed (an archived member is drawn: archiving puts a photograph away from the timeline, not out of a list the member curated) |
//! | `place` | live and in the place (read by the index on `place_id` and ordered here) |
//! | `unplaced` | live and in no place |
//!
//! ## The order, and the walk over a nullable key (D-1020-P11)
//!
//! A timeline shelf is **dated, then undated**: capture time newest first, then the
//! photographs with no capture time, newest id first. The kit's door cannot
//! continue a page over a nullable sort key, so the dated walk excludes its NULLs
//! (`taken_at IS NOT NULL`) and continues by predicate
//! ([`centraid_apps_kit::reads::page_by_predicate`]); the undated tail is a second
//! walk keyed on the id alone. One cursor spans both: a cursor whose `sort_key` is
//! empty is inside the undated tail, because a capture time is never empty.
//!
//! The trash, the archive and the heart are an entity's and an edge's, not columns of
//! the row a page reads, so a walk applies the verdict to every row it examines and
//! stops when the page is full. A shelf whose members are an edge's (favorites,
//! archive, trash, an album) reads the member ids first and sorts them here.
//!
//! `total` is exact and is read with the FIRST page only (a cursor means the caller
//! already holds it): counting a library walks every photograph's id.

use std::collections::BTreeMap;

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::page::{MAX_PAGE_ROWS, PageCursor};
use centraid_apps_kit::reads::{PageDoor, page_by_predicate, read_pages, read_pages_by_predicate};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::rules::{LIBRARY_WALK, STARRED_FLAG, Standing, photo_ids};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::cells::{CHUNK, PhotoCell, read_cells};
use crate::places::{NamedPlace, PlaceCard, describe, read_places};

/// The most cells one page of a shelf carries.
pub const SHELF_MAX: usize = 200;

/// Which shelf.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Shelf {
    Live,
    Favorites,
    Videos,
    Archive,
    Trash,
    Album(String),
    Place(String),
    Unplaced,
}

impl Shelf {
    /// The shelf a name and an optional id make; `None` when the name is unknown
    /// or an album or a place has no id.
    #[must_use]
    pub fn parse(name: &str, id: Option<&str>) -> Option<Self> {
        let id = id.map(str::trim).filter(|id| !id.is_empty());
        Some(match name {
            "live" => Self::Live,
            "favorites" => Self::Favorites,
            "videos" => Self::Videos,
            "archive" => Self::Archive,
            "trash" => Self::Trash,
            "unplaced" => Self::Unplaced,
            "album" => Self::Album(id?.to_owned()),
            "place" => Self::Place(id?.to_owned()),
            _ => return None,
        })
    }
}

/// Where a page stopped: the last cell's sort key (its capture time, or its trash
/// stamp on the trash shelf; empty inside the undated tail) and its id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShelfCursor {
    pub sort_key: String,
    pub id: String,
}

/// `shelf`'s input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShelfInput {
    pub shelf: Shelf,
    /// Required: the cells a page carries, at most [`SHELF_MAX`].
    pub limit: usize,
    pub after: Option<ShelfCursor>,
}

/// An album as a shelf's heading.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumHead {
    pub album_id: String,
    pub title: String,
    /// The album is in the trash: its screen offers the restore.
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
    pub purge_in_days: Option<i64>,
}

/// What `shelf` answers.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ShelfData {
    pub cells: Vec<PhotoCell>,
    /// Where the next page starts; `None` when the shelf ended.
    pub next: Option<ShelfCursor>,
    /// The exact size of the shelf; present on the first page only.
    pub total: Option<usize>,
    /// The album, for an `album` shelf (`None` when no such album exists).
    pub album: Option<AlbumHead>,
    /// For a `place` shelf: the place and how to say where it is (its `count` is
    /// the shelf's total on the first page and `0` after), absent when there is no
    /// such place.
    pub place: Option<PlaceCard>,
}

fn text(value: &str) -> PageBindValue {
    PageBindValue::Text(value.to_owned())
}

/// One examined row of a walk: its id and its sort key.
type Candidate = (String, String);

fn photo_filter(shelf: &Shelf) -> (String, Vec<PageBindValue>) {
    match shelf {
        Shelf::Videos => ("form = ?".to_owned(), vec![text("video")]),
        Shelf::Unplaced => ("place_id IS NULL".to_owned(), Vec::new()),
        _ => (String::new(), Vec::new()),
    }
}

fn and_filter(
    base: &str,
    (extra, binds): (String, Vec<PageBindValue>),
) -> (String, Vec<PageBindValue>) {
    if extra.is_empty() {
        (base.to_owned(), Vec::new())
    } else {
        (format!("{base} AND {extra}"), binds)
    }
}

fn accepts(shelf: &Shelf, standing: &Standing, id: &str) -> bool {
    match shelf {
        Shelf::Archive => standing.on_archive_shelf(id),
        Shelf::Trash => standing.is_trashed(id),
        Shelf::Album(_) => standing.in_album_view(id),
        _ => standing.is_live(id),
    }
}

/// The dated query of a walk shelf.
fn dated_query(shelf: &Shelf) -> PageQuery {
    let (clause, binds) = and_filter("taken_at IS NOT NULL", photo_filter(shelf));
    PageQuery::new(
        "photos.shelf.dated",
        "id, taken_at",
        "photo",
        PageOrder::desc("taken_at", "id"),
    )
    .filter(&clause, binds)
}

/// The undated tail of a walk shelf.
fn undated_query(shelf: &Shelf) -> PageQuery {
    let (clause, binds) = and_filter("taken_at IS NULL", photo_filter(shelf));
    PageQuery::new(
        "photos.shelf.undated",
        "id, taken_at",
        "photo",
        PageOrder::desc("id", "id"),
    )
    .filter(&clause, binds)
}

/// The next `want` accepted photographs of a walk shelf after `after`, and whether
/// more follow.
fn walk(
    door: &dyn PageDoor,
    shelf: &Shelf,
    standing: &Standing,
    after: Option<&ShelfCursor>,
    want: usize,
) -> KitResult<(Vec<Candidate>, bool)> {
    let mut found: Vec<Candidate> = Vec::new();
    // The dated walk, unless the cursor is already inside the undated tail.
    let in_tail = after.is_some_and(|cursor| cursor.sort_key.is_empty());
    if !in_tail {
        let query = dated_query(shelf);
        let mut cursor: Option<PageCursor> = after.map(|cursor| PageCursor {
            sort_key: cursor.sort_key.clone(),
            pk: cursor.id.clone(),
        });
        loop {
            let page = page_by_predicate(door, &query, cursor.as_ref(), MAX_PAGE_ROWS)?;
            for row in &page.rows {
                let (Some(id), Some(taken)) = (text_of(row, "id"), text_of(row, "taken_at")) else {
                    continue;
                };
                if accepts(shelf, standing, &id) {
                    if found.len() == want {
                        return Ok((found, true));
                    }
                    found.push((id, taken));
                }
            }
            match page.next {
                Some(next) => cursor = Some(next),
                None => break,
            }
        }
    }
    let query = undated_query(shelf);
    let mut cursor: Option<PageCursor> = after.filter(|_| in_tail).map(|cursor| PageCursor {
        sort_key: cursor.id.clone(),
        pk: cursor.id.clone(),
    });
    loop {
        let page = page_by_predicate(door, &query, cursor.as_ref(), MAX_PAGE_ROWS)?;
        for row in &page.rows {
            let Some(id) = text_of(row, "id") else {
                continue;
            };
            if accepts(shelf, standing, &id) {
                if found.len() == want {
                    return Ok((found, true));
                }
                found.push((id, String::new()));
            }
        }
        match page.next {
            Some(next) => cursor = Some(next),
            None => return Ok((found, false)),
        }
    }
}

/// How many photographs a walk shelf holds.
fn count_walk(door: &dyn PageDoor, shelf: &Shelf, standing: &Standing) -> KitResult<usize> {
    if matches!(shelf, Shelf::Live) {
        return Ok(photo_ids(door)?
            .iter()
            .filter(|id| standing.is_live(id))
            .count());
    }
    let (clause, binds) = photo_filter(shelf);
    let mut query = PageQuery::new(
        "photos.shelf.count",
        "id, blob",
        "photo",
        PageOrder::asc("blob", "id"),
    );
    if !clause.is_empty() {
        query = query.filter(&clause, binds);
    }
    Ok(read_pages(door, &query, LIBRARY_WALK)?
        .iter()
        .filter_map(|row| text_of(row, "id"))
        .filter(|id| accepts(shelf, standing, id))
        .count())
}

/// The members of an edge-defined shelf, as `(id, taken_at)` in the timeline's
/// order (the trash: `(id, deleted_at)`, newest trashed first), not yet paged.
fn members(door: &dyn PageDoor, shelf: &Shelf, standing: &Standing) -> KitResult<Vec<Candidate>> {
    if matches!(shelf, Shelf::Trash) {
        let mut trashed: Vec<Candidate> = standing
            .trashed
            .iter()
            .map(|(id, at)| (id.clone(), at.clone()))
            .collect();
        trashed.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.0.cmp(&left.0)));
        return Ok(trashed);
    }
    let ids: Vec<String> = match shelf {
        Shelf::Favorites => edge_ids(door, "from_id", "to_id", STARRED_FLAG, "tagged")?,
        Shelf::Archive => standing.archived.iter().cloned().collect(),
        Shelf::Album(id) => edge_ids(door, "to_id", "from_id", id, "contains")?,
        _ => Vec::new(),
    };
    let mut rows: Vec<Row> = Vec::new();
    if let Shelf::Place(place) = shelf {
        // A place's photographs, by the index on `place_id`; the capture order is
        // this function's, because no index serves a place and a capture time.
        rows = read_pages_by_predicate(
            door,
            &PageQuery::new(
                "photos.shelf.in_place",
                "id, taken_at, place_id",
                "photo",
                PageOrder::asc("place_id", "id"),
            )
            .filter("place_id = ?", vec![text(place)]),
            LIBRARY_WALK,
        )?;
    }
    for chunk in ids.chunks(CHUNK) {
        let fragment = centraid_apps_kit::reads::in_list("id", chunk)?;
        rows.extend(
            door.page(
                &PageQuery::new(
                    "photos.shelf.members",
                    "id, taken_at",
                    "photo",
                    PageOrder::asc("blob", "id"),
                )
                .filter(&fragment.sql, fragment.bind),
                &centraid_apps_kit::PageRequest::first(CHUNK),
            )?
            .rows,
        );
    }
    let mut members: Vec<Candidate> = rows
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            accepts(shelf, standing, &id)
                .then(|| (id, text_of(row, "taken_at").unwrap_or_default()))
        })
        .collect();
    // Dated newest first, then the undated, newest id first.
    members.sort_by(
        |left, right| match (left.1.is_empty(), right.1.is_empty()) {
            (false, false) => right.1.cmp(&left.1).then_with(|| right.0.cmp(&left.0)),
            (false, true) => std::cmp::Ordering::Less,
            (true, false) => std::cmp::Ordering::Greater,
            (true, true) => right.0.cmp(&left.0),
        },
    );
    Ok(members)
}

/// The far ends of the edges of one kind at one end: `into` is the column the id
/// is matched in, `far` the column read.
fn edge_ids(
    door: &dyn PageDoor,
    far: &str,
    into: &str,
    id: &str,
    rel: &str,
) -> KitResult<Vec<String>> {
    // `far` is the column whose value is wanted: for a star, the photograph is the
    // `from_id`; for an album's member it is the `to_id`.
    let (sort, pk, select) = if far == "from_id" {
        ("from_id", "to_id", "from_id, to_id")
    } else {
        ("to_id", "from_id", "from_id, to_id")
    };
    let rows = read_pages(
        door,
        &PageQuery::new(
            "photos.shelf.edges",
            select,
            "edge",
            PageOrder::asc(sort, pk),
        )
        .filter(
            &format!("rel = ? AND {into} = ?"),
            vec![text(rel), text(id)],
        ),
        LIBRARY_WALK,
    )?;
    Ok(rows.iter().filter_map(|row| text_of(row, far)).collect())
}

/// Page a sorted member list after a cursor.
fn page_members(
    members: &[Candidate],
    after: Option<&ShelfCursor>,
    want: usize,
    trash: bool,
) -> (Vec<Candidate>, bool) {
    let position = after.map_or(0, |cursor| {
        members
            .iter()
            .position(|(id, key)| {
                if trash {
                    (key.as_str(), id.as_str()) < (cursor.sort_key.as_str(), cursor.id.as_str())
                } else if cursor.sort_key.is_empty() {
                    key.is_empty() && *id < cursor.id
                } else {
                    key.is_empty()
                        || (key.as_str(), id.as_str())
                            < (cursor.sort_key.as_str(), cursor.id.as_str())
                }
            })
            .unwrap_or(members.len())
    });
    let rest = &members[position..];
    (rest.iter().take(want).cloned().collect(), rest.len() > want)
}

/// Read one page of a shelf.
///
/// `now_ms` counts the trash's days; it is injected.
///
/// # Errors
/// The door's refusal, or a walk past the library's bound.
pub fn load_shelf(door: &dyn PageDoor, input: &ShelfInput, now_ms: i64) -> KitResult<ShelfData> {
    let standing = Standing::read(door)?;
    shelf_page(door, &standing, input, now_ms, input.after.is_none())
}

/// [`load_shelf`] under a verdict the caller already holds, and with the total only
/// when asked for (a cover wants the first cell and not the count).
///
/// # Errors
/// The door's refusal, or a walk past the library's bound.
pub fn shelf_page(
    door: &dyn PageDoor,
    standing: &Standing,
    input: &ShelfInput,
    now_ms: i64,
    with_total: bool,
) -> KitResult<ShelfData> {
    let want = input.limit.clamp(1, SHELF_MAX);
    let shelf = &input.shelf;
    let by_edge = matches!(
        shelf,
        Shelf::Favorites | Shelf::Archive | Shelf::Trash | Shelf::Album(_) | Shelf::Place(_)
    );
    let (page, more, total) = if by_edge {
        let all = members(door, shelf, standing)?;
        let (page, more) = page_members(
            &all,
            input.after.as_ref(),
            want,
            matches!(shelf, Shelf::Trash),
        );
        (page, more, with_total.then_some(all.len()))
    } else {
        let (page, more) = walk(door, shelf, standing, input.after.as_ref(), want)?;
        let total = with_total
            .then(|| count_walk(door, shelf, standing))
            .transpose()?;
        (page, more, total)
    };
    let ids: Vec<String> = page.iter().map(|(id, _)| id.clone()).collect();
    let mut cells: BTreeMap<String, PhotoCell> = read_cells(door, standing, &ids, now_ms)?;
    let cells: Vec<PhotoCell> = ids.iter().filter_map(|id| cells.remove(id)).collect();
    let next = if more {
        page.last().map(|(id, key)| ShelfCursor {
            sort_key: key.clone(),
            id: id.clone(),
        })
    } else {
        None
    };
    let (album, place) = match shelf {
        Shelf::Album(id) => (album_head(door, id, now_ms)?, None),
        Shelf::Place(id) => {
            let places = read_places(door)?;
            let anchors = NamedPlace::anchors(&places);
            (
                None,
                places
                    .into_iter()
                    .find(|place| place.place_id == *id)
                    .map(|place| {
                        let (name, phrase) = describe(&place, &anchors);
                        PlaceCard {
                            place,
                            name,
                            phrase,
                            count: total.unwrap_or(0),
                            cover: None,
                        }
                    }),
            )
        }
        _ => (None, None),
    };
    Ok(ShelfData {
        cells,
        next,
        total,
        album,
        place,
    })
}

/// An album's heading: its title and, when it is in the trash, its stamp.
///
/// # Errors
/// The door's refusal.
pub fn album_head(door: &dyn PageDoor, id: &str, now_ms: i64) -> KitResult<Option<AlbumHead>> {
    let Some(row) = centraid_apps_kit::reads::read_by_id(
        door,
        "photos.shelf.album",
        "id, kind, title, deleted_at, purge_at",
        "entity",
        "id",
        id,
    )?
    else {
        return Ok(None);
    };
    if text_of(&row, "kind").as_deref() != Some("album") {
        return Ok(None);
    }
    let deleted_at = text_of(&row, "deleted_at");
    let purge_at = text_of(&row, "purge_at");
    Ok(Some(AlbumHead {
        album_id: id.to_owned(),
        title: text_of(&row, "title").unwrap_or_default(),
        purge_in_days: deleted_at
            .as_ref()
            .and_then(|_| crate::queries::purge_in_days(purge_at.as_deref(), now_ms)),
        deleted_at,
        purge_at,
    }))
}
