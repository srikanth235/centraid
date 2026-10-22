//! THE COLLECTIONS OVERVIEW: every shelf and every album with its exact count and a
//! cover (#1135).
//!
//! Every count here is a count of a SHELF, taken by the same verdict the shelf is
//! drawn by ([`centraid_apps_kit::rules::Standing`]), so a tile and the page it
//! opens cannot disagree. (They used to: the favorites tile counted every hearted
//! photograph that was not trashed, the shelf drew the live ones.) The library's
//! count is the number Home's tile shows: an edit and the photograph it was made
//! from are one.
//!
//! ## The cover of an album
//!
//! The album's chosen cover (`container.cover`, a photograph's bytes) when that
//! photograph is still a member and not in the trash; else the member that comes
//! first in the album's own order (its `position`, then its id). A cover is a whole
//! [`PhotoCell`], so it carries the path this device can draw.

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, Read, read_pages, read_pages_by_predicate};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::rules::{LIBRARY_WALK, Standing};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};

use crate::cells::{PhotoCell, read_cells};
use crate::queries::purge_in_days;
use crate::shelf::{Shelf, ShelfInput, shelf_page};

/// One standing shelf on the collections page.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ShelfTile {
    /// Exact.
    pub count: usize,
    /// The shelf's first cell, newest.
    pub cover: Option<PhotoCell>,
}

/// One album.
#[derive(Debug, Clone, PartialEq)]
pub struct AlbumCard {
    pub album_id: String,
    pub title: String,
    /// Members that are not in the trash.
    pub count: usize,
    pub cover: Option<PhotoCell>,
}

/// An album in the trash, waiting for its restore or its purge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashedAlbum {
    pub album_id: String,
    pub title: String,
    pub deleted_at: String,
    pub purge_at: Option<String>,
    pub purge_in_days: Option<i64>,
}

/// What `albums` answers.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AlbumsData {
    /// Live albums by title.
    pub albums: Vec<AlbumCard>,
    /// Albums in the trash, newest trashed first.
    pub trashed_albums: Vec<TrashedAlbum>,
    pub live: ShelfTile,
    pub favorites: ShelfTile,
    pub videos: ShelfTile,
    pub archive: ShelfTile,
    pub trash: ShelfTile,
    /// Places that hold at least one live photograph.
    pub places: usize,
    /// Live photographs in no place.
    pub unplaced: usize,
}

/// A count of the live library, taken over every photograph once.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Census {
    pub live: usize,
    pub videos: usize,
    pub unplaced: usize,
    /// Live photographs per place.
    pub per_place: BTreeMap<String, usize>,
    /// The newest live photograph of each place, by capture time then id: its
    /// cover. A dated photograph outranks an undated one.
    pub newest_in_place: BTreeMap<String, (Option<String>, String)>,
}

impl Census {
    /// Walk every photograph and count what is live.
    ///
    /// # Errors
    /// The door's refusal, or a walk past the library's bound.
    pub fn read(door: &dyn PageDoor, standing: &Standing) -> KitResult<Self> {
        let rows = read_pages(
            door,
            &PageQuery::new(
                "photos.census",
                "id, blob, form, place_id, taken_at",
                "photo",
                PageOrder::asc("blob", "id"),
            ),
            LIBRARY_WALK,
        )?;
        let mut census = Self::default();
        for row in &rows {
            let Some(id) = text_of(row, "id") else {
                continue;
            };
            if !standing.is_live(&id) {
                continue;
            }
            census.live += 1;
            if text_of(row, "form").as_deref() == Some("video") {
                census.videos += 1;
            }
            match text_of(row, "place_id") {
                Some(place) => {
                    *census.per_place.entry(place.clone()).or_default() += 1;
                    let key = (text_of(row, "taken_at"), id);
                    let newer = census
                        .newest_in_place
                        .get(&place)
                        .is_none_or(|held| key > *held);
                    if newer {
                        census.newest_in_place.insert(place, key);
                    }
                }
                None => census.unplaced += 1,
            }
        }
        Ok(census)
    }
}

/// How many photographs are live: not trashed, not archived, and not folded under an
/// edit. The number Home's tile shows and the library shelf's total.
///
/// # Errors
/// The door's refusal, or a walk past the library bound.
pub fn live_photo_count(door: &dyn PageDoor) -> KitResult<usize> {
    let standing = Standing::read(door)?;
    Ok(Census::read(door, &standing)?.live)
}

fn tile(
    door: &dyn PageDoor,
    standing: &Standing,
    shelf: Shelf,
    now_ms: i64,
    count: Option<usize>,
) -> KitResult<ShelfTile> {
    let first = shelf_page(
        door,
        standing,
        &ShelfInput {
            shelf,
            limit: 1,
            after: None,
        },
        now_ms,
        count.is_none(),
    )?;
    Ok(ShelfTile {
        count: count.or(first.total).unwrap_or_default(),
        cover: first.cells.into_iter().next(),
    })
}

fn real_of(row: &Row, column: &str) -> f64 {
    match row.get(column) {
        Some(Cell::Real(value)) => *value,
        #[expect(clippy::cast_precision_loss, reason = "a position is a small number")]
        Some(Cell::Integer(value)) => *value as f64,
        _ => 0.0,
    }
}

/// The live albums, by title.
fn live_albums(door: &dyn PageDoor) -> KitResult<Vec<(String, String)>> {
    Ok(read_pages(
        door,
        &PageQuery::new(
            "photos.albums.live",
            "id, title",
            "entity",
            PageOrder::asc("title", "id"),
        )
        .filter(
            "kind = ? AND deleted_at IS NULL",
            vec![PageBindValue::Text("album".to_owned())],
        ),
        LIBRARY_WALK,
    )?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect())
}

/// The albums in the trash, newest trashed first.
fn trashed_albums(door: &dyn PageDoor, now_ms: i64) -> KitResult<Vec<TrashedAlbum>> {
    Ok(read_pages_by_predicate(
        door,
        &PageQuery::new(
            "photos.albums.trashed",
            "id, title, deleted_at, purge_at",
            "entity",
            PageOrder::desc("deleted_at", "id"),
        )
        .filter(
            "kind = ? AND deleted_at IS NOT NULL",
            vec![PageBindValue::Text("album".to_owned())],
        ),
        LIBRARY_WALK,
    )?
    .iter()
    .filter_map(|row| {
        let purge_at = text_of(row, "purge_at");
        Some(TrashedAlbum {
            album_id: text_of(row, "id")?,
            title: text_of(row, "title")?,
            deleted_at: text_of(row, "deleted_at")?,
            purge_in_days: purge_in_days(purge_at.as_deref(), now_ms),
            purge_at,
        })
    })
    .collect())
}

/// Read the collections overview.
///
/// `now_ms` counts the trash's days; it is injected.
///
/// # Errors
/// The door's refusal, or a walk past the library's bound.
pub fn load_albums(door: &dyn PageDoor, now_ms: i64) -> KitResult<AlbumsData> {
    let standing = Standing::read(door)?;
    let census = Census::read(door, &standing)?;
    let live_places: BTreeSet<String> = crate::places::read_places(door)?
        .into_iter()
        .map(|place| place.place_id)
        .collect();
    let albums = live_albums(door)?;
    let ids: Vec<String> = albums.iter().map(|(id, _)| id.clone()).collect();
    // Each album's members, in the album's own order, with the trash taken out.
    let edges = Read {
        name: "photos.albums.members",
        table: "edge",
        select: "from_id, to_id, position",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .among(
        LIBRARY_WALK,
        door,
        &ids,
        Some(("rel = ?", vec![PageBindValue::Text("contains".to_owned())])),
    )?;
    let mut members: BTreeMap<String, Vec<(f64, String)>> = BTreeMap::new();
    for edge in &edges {
        if let (Some(album), Some(photo)) = (text_of(edge, "from_id"), text_of(edge, "to_id"))
            && standing.in_album_view(&photo)
        {
            members
                .entry(album)
                .or_default()
                .push((real_of(edge, "position"), photo));
        }
    }
    for list in members.values_mut() {
        list.sort_by(|left, right| {
            left.0
                .total_cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
        });
    }
    // The chosen covers are bytes; the photograph that holds them is one lookup.
    let chosen: BTreeMap<String, String> = Read {
        name: "photos.albums.covers",
        table: "container",
        select: "id, cover",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &ids, None)?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "cover")?)))
    .collect();
    let blobs: Vec<String> = chosen
        .values()
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let by_blob: BTreeMap<String, String> = Read {
        name: "photos.albums.cover_photos",
        table: "photo",
        select: "id, blob",
        order: ("blob", "id"),
        column: "blob",
    }
    .of(door, &blobs, None)?
    .iter()
    .filter_map(|row| Some((text_of(row, "blob")?, text_of(row, "id")?)))
    .collect();
    let mut cover_of: BTreeMap<String, String> = BTreeMap::new();
    for (album, list) in &members {
        let picked = chosen
            .get(album)
            .and_then(|blob| by_blob.get(blob))
            .filter(|photo| list.iter().any(|(_, member)| member == *photo))
            .cloned()
            .or_else(|| list.first().map(|(_, member)| member.clone()));
        if let Some(photo) = picked {
            cover_of.insert(album.clone(), photo);
        }
    }
    let cover_ids: Vec<String> = cover_of.values().cloned().collect();
    let covers = read_cells(door, &standing, &cover_ids, now_ms)?;
    let cards = albums
        .into_iter()
        .map(|(album_id, title)| AlbumCard {
            count: members.get(&album_id).map_or(0, Vec::len),
            cover: cover_of
                .get(&album_id)
                .and_then(|photo| covers.get(photo).cloned()),
            album_id,
            title,
        })
        .collect();
    Ok(AlbumsData {
        albums: cards,
        trashed_albums: trashed_albums(door, now_ms)?,
        live: tile(door, &standing, Shelf::Live, now_ms, Some(census.live))?,
        favorites: tile(door, &standing, Shelf::Favorites, now_ms, None)?,
        videos: tile(door, &standing, Shelf::Videos, now_ms, Some(census.videos))?,
        archive: tile(door, &standing, Shelf::Archive, now_ms, None)?,
        trash: tile(door, &standing, Shelf::Trash, now_ms, None)?,
        places: census
            .per_place
            .keys()
            .filter(|place| live_places.contains(*place))
            .count(),
        unplaced: census.unplaced,
    })
}
