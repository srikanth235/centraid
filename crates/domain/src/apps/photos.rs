use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, asc, desc, param, read};

use super::{Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tile {
    pub id: String,
    pub title: String,
    pub at: String,
    pub starred: bool,
}

impl Tile {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            at: row.get("at")?,
            starred: row.get("starred")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PhotoTile {
    pub id: String,
    pub title: String,
    pub at: String,
    pub starred: bool,
    pub blob: String,
    pub form: String,
    pub taken_at: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_s: Option<f64>,
}

impl PhotoTile {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            at: row.get("at")?,
            starred: row.get("starred")?,
            blob: row.get("blob")?,
            form: row.get("form")?,
            taken_at: row.get("taken_at")?,
            width: row.get("width")?,
            height: row.get("height")?,
            duration_s: row.get("duration_s")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PhotoDetail {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub starred: bool,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub blob: String,
    pub media_type: String,
    pub form: String,
    pub taken_at: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_s: Option<f64>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub place_id: Option<String>,
    pub place_title: Option<String>,
    pub edited_from: Option<String>,
    pub edited_from_title: Option<String>,
    pub size: i64,
}

impl PhotoDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            created_at: row.get("created_at")?,
            starred: row.get("starred")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            blob: row.get("blob")?,
            media_type: row.get("media_type")?,
            form: row.get("form")?,
            taken_at: row.get("taken_at")?,
            width: row.get("width")?,
            height: row.get("height")?,
            duration_s: row.get("duration_s")?,
            lat: row.get("lat")?,
            lon: row.get("lon")?,
            place_id: row.get("place_id")?,
            place_title: row.get("place_title")?,
            edited_from: row.get("edited_from")?,
            edited_from_title: row.get("edited_from_title")?,
            size: row.get("size")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlbumRow {
    pub id: String,
    pub title: String,
    pub cover: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

impl AlbumRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            cover: row.get("cover")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlaceRow {
    pub id: String,
    pub title: String,
    pub address: Option<String>,
    pub locality: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub zone: Option<String>,
}

impl PlaceRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            address: row.get("address")?,
            locality: row.get("locality")?,
            lat: row.get("lat")?,
            lon: row.get("lon")?,
            zone: row.get("zone")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceItem {
    pub id: String,
    pub title: String,
    pub at: String,
}

impl PlaceItem {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            at: row.get("at")?,
        })
    }
}

// Library reads exclude photos homed inside another item.
pub const LIBRARY: Read<Tile> = read(
    ReadDecl {
        name: "photos.library",
        shape: Shape::PagedList,
        sql: "SELECT id, title, created_at AS at, starred_at IS NOT NULL AS starred FROM entity \
              WHERE kind = 'photo' AND parent_id IS NULL AND deleted_at IS NULL \
                AND (created_at, id) < (:a, :b) \
              ORDER BY created_at DESC, id DESC LIMIT :n",
        params: &[],
        reads: &["entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    Tile::of,
);

pub const LIBRARY_GRID: Read<PhotoTile> = read(
    ReadDecl {
        name: "photos.library_grid",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.created_at AS at, e.starred_at IS NOT NULL AS starred, \
                     p.blob, p.form, p.taken_at, p.width, p.height, p.duration_s \
              FROM entity e JOIN photo p ON p.id = e.id \
              WHERE e.kind = 'photo' AND e.parent_id IS NULL AND e.deleted_at IS NULL \
                AND (e.created_at, e.id) < (:a, :b) \
              ORDER BY e.created_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["entity", "photo"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    PhotoTile::of,
);

pub const BY_TAKEN: Read<PhotoTile> = read(
    ReadDecl {
        name: "photos.by_taken",
        shape: Shape::PagedList,
        sql: "SELECT p.id, e.title, p.taken_at AS at, e.starred_at IS NOT NULL AS starred, \
                     p.blob, p.form, p.taken_at, p.width, p.height, p.duration_s \
              FROM photo p INDEXED BY photo_by_taken CROSS JOIN entity e ON e.id = p.id \
              WHERE p.taken_at IS NOT NULL AND e.parent_id IS NULL AND e.deleted_at IS NULL \
                AND (p.taken_at, p.id) < (:a, :b) \
              ORDER BY p.taken_at DESC, p.id DESC LIMIT :n",
        params: &[],
        reads: &["photo", "entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    PhotoTile::of,
);

pub const BY_FORM: Read<PhotoTile> = read(
    ReadDecl {
        name: "photos.by_form",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.created_at AS at, e.starred_at IS NOT NULL AS starred, \
                     p.blob, p.form, p.taken_at, p.width, p.height, p.duration_s \
              FROM entity e JOIN photo p ON p.id = e.id \
              WHERE e.kind = 'photo' AND e.parent_id IS NULL AND e.deleted_at IS NULL \
                AND p.form = :form AND (e.created_at, e.id) < (:a, :b) \
              ORDER BY e.created_at DESC, e.id DESC LIMIT :n",
        params: &[param("form", ParamTy::Text)],
        reads: &["entity", "photo"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    PhotoTile::of,
);

pub const STARRED: Read<PhotoTile> = read(
    ReadDecl {
        name: "photos.starred",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.starred_at AS at, 1 AS starred, \
                     p.blob, p.form, p.taken_at, p.width, p.height, p.duration_s \
              FROM entity e JOIN photo p ON p.id = e.id \
              WHERE e.kind = 'photo' AND e.starred_at IS NOT NULL \
                AND e.parent_id IS NULL AND e.deleted_at IS NULL \
                AND (e.starred_at, e.id) < (:a, :b) \
              ORDER BY e.starred_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["entity", "photo"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    PhotoTile::of,
);

pub const BY_ID: Read<PhotoDetail> = read(
    ReadDecl {
        name: "photos.by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id, entity.title, entity.created_at, entity.starred_at IS NOT NULL AS starred, \
                     entity.arrived_via, entity.arrived_label, photo.blob, photo.media_type, photo.form, \
                     photo.taken_at, photo.width, photo.height, photo.duration_s, photo.lat, photo.lon, \
                     photo.place_id, photo.edited_from, \
                     (SELECT title FROM entity WHERE id = photo.place_id AND deleted_at IS NULL) AS place_title, \
                     (SELECT title FROM entity WHERE id = photo.edited_from AND deleted_at IS NULL) AS edited_from_title, \
                     blob.size \
              FROM entity JOIN photo ON photo.id = entity.id JOIN blob ON blob.hash = photo.blob \
              WHERE entity.id = :id AND entity.parent_id IS NULL AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["entity", "photo", "blob"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    PhotoDetail::of,
);

pub const BURST: Read<PhotoTile> = read(
    ReadDecl {
        name: "photos.burst",
        shape: Shape::BoundedChild,
        sql: "SELECT p.id, e.title, e.created_at AS at, e.starred_at IS NOT NULL AS starred, \
                     p.blob, p.form, p.taken_at, p.width, p.height, p.duration_s \
              FROM photo p JOIN entity e ON e.id = p.id \
              WHERE p.burst = :burst AND e.parent_id IS NULL AND e.deleted_at IS NULL \
              LIMIT 50",
        params: &[param("burst", ParamTy::Text)],
        reads: &["photo", "entity"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    PhotoTile::of,
);

pub const ALBUMS: Read<AlbumRow> = read(
    ReadDecl {
        name: "photos.albums",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, e.title, c.cover, c.color, c.icon \
              FROM container c INDEXED BY container_by_kind JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'album' AND e.deleted_at IS NULL \
              ORDER BY c.id ASC LIMIT 100",
        params: &[],
        reads: &["container", "entity"],
        across: &[],
        bound: 100,
        cursor: &[],
    },
    AlbumRow::of,
);

pub const ALBUM_MEMBERS: Read<PhotoTile> = read(
    ReadDecl {
        name: "photos.album_members",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.created_at AS at, e.starred_at IS NOT NULL AS starred, \
                     p.blob, p.form, p.taken_at, p.width, p.height, p.duration_s \
              FROM edge x JOIN entity e ON e.id = x.to_id JOIN photo p ON p.id = e.id \
              WHERE x.from_id = :album AND x.rel = 'contains' AND e.kind = 'photo' \
                AND e.parent_id IS NULL AND e.deleted_at IS NULL AND x.to_id < :after \
              ORDER BY x.to_id DESC LIMIT :n",
        params: &[param("album", ParamTy::Id)],
        reads: &["edge", "entity", "photo"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("id", "after")],
    },
    PhotoTile::of,
);

pub const PLACES: Read<PlaceRow> = read(
    ReadDecl {
        name: "photos.places",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, pl.address, pl.locality, pl.lat, pl.lon, pl.zone \
              FROM entity e JOIN place pl ON pl.id = e.id \
              WHERE e.kind = 'place' AND e.deleted_at IS NULL \
                AND (e.title, e.id) > (:a, :b) \
              ORDER BY e.title ASC, e.id ASC LIMIT :n",
        params: &[],
        reads: &["entity", "place"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[asc("title", "a"), asc("id", "b")],
    },
    PlaceRow::of,
);

pub const PLACE_BY_ID: Read<PlaceRow> = read(
    ReadDecl {
        name: "photos.place_by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id, entity.title, place.address, place.locality, place.lat, place.lon, place.zone \
              FROM entity JOIN place ON place.id = entity.id \
              WHERE entity.id = :id AND entity.kind = 'place' AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["entity", "place"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    PlaceRow::of,
);

pub const AT_PLACE_PHOTOS: Read<PhotoTile> = read(
    ReadDecl {
        name: "photos.at_place_photos",
        shape: Shape::BoundedChild,
        sql: "SELECT p.id, e.title, e.created_at AS at, e.starred_at IS NOT NULL AS starred, \
                     p.blob, p.form, p.taken_at, p.width, p.height, p.duration_s \
              FROM photo p JOIN entity e ON e.id = p.id \
              WHERE p.place_id = :place AND e.parent_id IS NULL AND e.deleted_at IS NULL \
              LIMIT 50",
        params: &[param("place", ParamTy::Id)],
        reads: &["photo", "entity"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    PhotoTile::of,
);

pub const AT_PLACE_EVENTS: Read<PlaceItem> = read(
    ReadDecl {
        name: "photos.at_place_events",
        shape: Shape::BoundedChild,
        sql: "SELECT ev.id, e.title, ev.starts AS at \
              FROM event ev JOIN entity e ON e.id = ev.id \
              WHERE ev.place_id = :place AND e.deleted_at IS NULL \
              LIMIT 50",
        params: &[param("place", ParamTy::Id)],
        reads: &["event"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    PlaceItem::of,
);

pub const AT_PLACE_WORKOUTS: Read<PlaceItem> = read(
    ReadDecl {
        name: "photos.at_place_workouts",
        shape: Shape::BoundedChild,
        sql: "SELECT w.id, e.title, w.starts AS at \
              FROM workout w JOIN entity e ON e.id = w.id \
              WHERE w.place_id = :place AND e.deleted_at IS NULL \
              LIMIT 50",
        params: &[param("place", ParamTy::Id)],
        reads: &["workout"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    PlaceItem::of,
);

pub const AT_PLACE_TOUCHES: Read<PlaceItem> = read(
    ReadDecl {
        name: "photos.at_place_touches",
        shape: Shape::BoundedChild,
        sql: "SELECT t.id, e.title, t.starts AS at \
              FROM touch t JOIN entity e ON e.id = t.id \
              WHERE t.place_id = :place AND e.deleted_at IS NULL \
              LIMIT 50",
        params: &[param("place", ParamTy::Id)],
        reads: &["touch"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    PlaceItem::of,
);

pub const TRASH: Read<Trashed> = trash!("photos.trash", "'photo', 'album', 'place'");

pub const READS: &[ReadDecl] = &[
    LIBRARY.decl,
    LIBRARY_GRID.decl,
    BY_TAKEN.decl,
    BY_FORM.decl,
    STARRED.decl,
    BY_ID.decl,
    BURST.decl,
    ALBUMS.decl,
    ALBUM_MEMBERS.decl,
    PLACES.decl,
    PLACE_BY_ID.decl,
    AT_PLACE_PHOTOS.decl,
    AT_PLACE_EVENTS.decl,
    AT_PLACE_WORKOUTS.decl,
    AT_PLACE_TOUCHES.decl,
    TRASH.decl,
];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "photo",
        "photos",
        "photo",
        "photos",
        Trash::Listed("photos.trash"),
    )
    .sits_in(&["txn", "event", "workout", "note", "task", "person"])
    .footers(&[
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.photos.v1",
        format: crate::kind::exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "album",
        "photos",
        "album",
        "albums",
        Trash::Listed("photos.trash"),
    )
    .exports(Export::Within("photo")),
    KindDecl::new(
        "place",
        "photos",
        "place",
        "places",
        Trash::Listed("photos.trash"),
    )
    .footers(&[Footer::Linked, Footer::MentionedIn])
    .shares(Share::Payload(plain)),
];
