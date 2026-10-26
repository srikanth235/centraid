//! `photo` — EVERYTHING ONE PHOTOGRAPH'S SCREENS NEED (#1135): the lightbox, the
//! editor, the place and label sheets and the info panel.
//!
//! It is the photograph's cell (its bytes, its capture, its box, its heart, its
//! albums by id, what this device holds, its Live Photo pairing) plus what only one
//! photograph shows: the albums by name, its labels, its place and how to say where
//! it is, and its lineage. The film strip's neighbours come from `shelf`, and the
//! places to choose from from `places`.

use centraid_apps_kit::error::KitResult;
use centraid_apps_kit::reads::{PageDoor, Read};
use centraid_apps_kit::row::{Row, text_of};
use centraid_apps_kit::rules::{STARRED_FLAG, Standing};
use centraid_apps_kit::statement::PageBindValue;

use crate::cells::{PhotoCell, read_cells};
use crate::places::{NamedPlace, PlaceRow, describe, exact_location, read_places};
use crate::queries::{ARCHIVED, PhotoTag};

/// A place as one photograph's panel shows it.
#[derive(Debug, Clone, PartialEq)]
pub struct PhotoPlace {
    pub place: PlaceRow,
    pub name: Option<String>,
    pub phrase: crate::places::PlacePhrase,
    /// Coordinates as digits, for the member's explicit "show exact location".
    pub exact_location: Option<String>,
}

/// An album a photograph is in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumRef {
    pub album_id: String,
    pub title: String,
}

/// What `photo` answers.
#[derive(Debug, Clone, PartialEq)]
pub struct PhotoDetail {
    pub cell: PhotoCell,
    pub trashed: bool,
    /// The live albums that hold it, by title.
    pub albums: Vec<AlbumRef>,
    /// Its labels, by name; a heart and the archive are not labels.
    pub tags: Vec<PhotoTag>,
    pub place: Option<PhotoPlace>,
    /// The photographs made from this one (edits and crops) that are not in the
    /// trash.
    pub edits: Vec<String>,
}

fn text(value: &str) -> Vec<PageBindValue> {
    vec![PageBindValue::Text(value.to_owned())]
}

/// Read one photograph. `None` when there is no such photograph.
///
/// `now_ms` counts the trash's days; it is injected.
///
/// # Errors
/// The door's refusal, or a walk past its bound.
pub fn load_photo(door: &dyn PageDoor, id: &str, now_ms: i64) -> KitResult<Option<PhotoDetail>> {
    let standing = Standing::read(door)?;
    let ids = [id.to_owned()];
    let Some(cell) = read_cells(door, &standing, &ids, now_ms)?.remove(id) else {
        return Ok(None);
    };
    let tag_edges: Vec<Row> = Read {
        name: "photos.detail.tagged",
        table: "edge",
        select: "from_id, to_id",
        order: ("from_id", "to_id"),
        column: "from_id",
    }
    .of(door, &ids, Some(("rel = ?", text("tagged"))))?;
    let concepts: Vec<String> = tag_edges
        .iter()
        .filter_map(|edge| text_of(edge, "to_id"))
        .filter(|to| to != STARRED_FLAG && to != ARCHIVED)
        .collect();
    let labels: std::collections::BTreeMap<String, String> = Read {
        name: "photos.detail.concepts",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &concepts, Some(("kind = ?", text("tag"))))?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect();
    let tags = concepts
        .into_iter()
        .filter_map(|tag_id| {
            let label = labels.get(&tag_id)?.clone();
            Some(PhotoTag { tag_id, label })
        })
        .collect();
    let titles: std::collections::BTreeMap<String, String> = Read {
        name: "photos.detail.albums",
        table: "entity",
        select: "id, title",
        order: ("id", "id"),
        column: "id",
    }
    .of(door, &cell.album_ids, Some(("kind = ?", text("album"))))?
    .iter()
    .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
    .collect();
    let albums = cell
        .album_ids
        .iter()
        .filter_map(|album_id| {
            Some(AlbumRef {
                album_id: album_id.clone(),
                title: titles.get(album_id)?.clone(),
            })
        })
        .collect();
    let place = match cell.place_id.as_deref() {
        None => None,
        Some(place_id) => {
            let places = read_places(door)?;
            let anchors = NamedPlace::anchors(&places);
            places
                .into_iter()
                .find(|place| place.place_id == place_id)
                .map(|place| {
                    let (name, phrase) = describe(&place, &anchors);
                    PhotoPlace {
                        exact_location: exact_location(place.lat, place.lng),
                        place,
                        name,
                        phrase,
                    }
                })
        }
    };
    let edits = Read {
        name: "photos.detail.edits",
        table: "photo",
        select: "id, edited_from",
        order: ("edited_from", "id"),
        column: "edited_from",
    }
    .of(door, &ids, None)?
    .iter()
    .filter_map(|row| text_of(row, "id"))
    .filter(|edit| !standing.is_trashed(edit))
    .collect();
    Ok(Some(PhotoDetail {
        trashed: cell.deleted_at.is_some(),
        cell,
        albums,
        tags,
        place,
        edits,
    }))
}
