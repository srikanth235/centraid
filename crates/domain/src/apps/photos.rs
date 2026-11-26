//! Photos: the library, the albums, the places.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, plain};
use crate::read::{DEFAULT_PAGE, Read, ReadDecl, Shape, desc, read};

use super::{Trashed, trash};

/// One tile of the library grid.
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

/// The library: photos with no home but the library itself, newest first. A capture homed in an
/// item is never a library row. `entity_by_created`.
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

/// Photos, albums and places in the trash.
pub const TRASH: Read<Trashed> = trash!("photos.trash", "'photo', 'album', 'place'");

pub const READS: &[ReadDecl] = &[LIBRARY.decl, TRASH.decl];

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
