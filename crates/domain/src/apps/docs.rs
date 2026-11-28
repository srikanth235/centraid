use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, desc, param, read};

use super::{Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocRow {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub at: String,
    pub starred: bool,
    pub blob: String,
    pub media_type: String,
    pub size: i64,
}

impl DocRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            at: row.get("at")?,
            starred: row.get("starred")?,
            blob: row.get("blob")?,
            media_type: row.get("media_type")?,
            size: row.get("size")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderRow {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

impl FolderRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocDetail {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub starred: bool,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub blob: String,
    pub media_type: String,
    pub size: i64,
    pub body_text: Option<String>,
}

impl DocDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            starred: row.get("starred")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            blob: row.get("blob")?,
            media_type: row.get("media_type")?,
            size: row.get("size")?,
            body_text: row.get("body_text")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FollowedFolder {
    pub id: String,
    pub external_ref: String,
    pub label: String,
    pub fills: Option<String>,
    pub retired_at: Option<String>,
}

impl FollowedFolder {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            external_ref: row.get("ref")?,
            label: row.get("label")?,
            fills: row.get("fills")?,
            retired_at: row.get("retired_at")?,
        })
    }
}

// The top-level library excludes documents homed inside another item.
pub const TOP_LEVEL: Read<DocRow> = read(
    ReadDecl {
        name: "docs.top_level",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, e.updated_at AS at, \
                     e.starred_at IS NOT NULL AS starred, d.blob, d.media_type, b.size \
              FROM entity e JOIN document d ON d.id = e.id JOIN blob b ON b.hash = d.blob \
              WHERE e.kind = 'document' AND e.parent_id IS NULL AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:a, :b) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["entity", "document", "blob"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    DocRow::of,
);

pub const IN_FOLDER: Read<DocRow> = read(
    ReadDecl {
        name: "docs.in_folder",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, e.updated_at AS at, \
                     e.starred_at IS NOT NULL AS starred, d.blob, d.media_type, b.size \
              FROM entity e JOIN document d ON d.id = e.id JOIN blob b ON b.hash = d.blob \
              WHERE e.parent_id = :folder AND e.kind = 'document' AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:a, :b) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[param("folder", ParamTy::Id)],
        reads: &["entity", "document", "blob"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    DocRow::of,
);

pub const STARRED: Read<DocRow> = read(
    ReadDecl {
        name: "docs.starred",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, e.starred_at AS at, \
                     1 AS starred, d.blob, d.media_type, b.size \
              FROM entity e JOIN document d ON d.id = e.id JOIN blob b ON b.hash = d.blob \
              WHERE e.kind = 'document' AND e.starred_at IS NOT NULL AND e.deleted_at IS NULL \
                AND (e.parent_id IS NULL OR e.parent_kind = 'folder') \
                AND (e.starred_at, e.id) < (:a, :b) \
              ORDER BY e.starred_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["entity", "document", "blob"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    DocRow::of,
);

pub const FOLDERS: Read<FolderRow> = read(
    ReadDecl {
        name: "docs.folders",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, e.title, e.parent_id, c.color, c.icon \
              FROM container c INDEXED BY container_by_kind JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'folder' AND e.parent_id IS NULL AND e.deleted_at IS NULL \
              ORDER BY c.id ASC LIMIT 100",
        params: &[],
        reads: &["container", "entity"],
        across: &[],
        bound: 100,
        cursor: &[],
    },
    FolderRow::of,
);

pub const SUBFOLDERS: Read<FolderRow> = read(
    ReadDecl {
        name: "docs.subfolders",
        shape: Shape::BoundedChild,
        sql: "SELECT e.id, e.title, e.parent_id, c.color, c.icon \
              FROM entity e LEFT JOIN container c INDEXED BY container_by_kind \
                ON c.kind = 'folder' AND c.id = e.id \
              WHERE e.parent_id = :folder AND e.kind = 'folder' AND e.deleted_at IS NULL \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT 100",
        params: &[param("folder", ParamTy::Id)],
        reads: &["entity", "container"],
        across: &[],
        bound: 100,
        cursor: &[],
    },
    FolderRow::of,
);

pub const BY_ID: Read<DocDetail> = read(
    ReadDecl {
        name: "docs.by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id, entity.title, entity.parent_id, entity.created_at, entity.updated_at, \
                     entity.starred_at IS NOT NULL AS starred, entity.arrived_via, entity.arrived_label, \
                     document.blob, document.media_type, blob.size, \
                     (SELECT text FROM derivative WHERE blob = document.blob AND variant = 'text') AS body_text \
              FROM entity JOIN document ON document.id = entity.id JOIN blob ON blob.hash = document.blob \
              WHERE entity.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["entity", "document", "blob", "derivative"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    DocDetail::of,
);

pub const FOLLOWED_FOLDERS: Read<FollowedFolder> = read(
    ReadDecl {
        name: "docs.followed_folders",
        shape: Shape::BoundedChild,
        sql: "SELECT id, ref, label, fills, retired_at \
              FROM origin WHERE system = 'files' \
              ORDER BY ref ASC LIMIT 50",
        params: &[],
        reads: &["origin"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    FollowedFolder::of,
);

pub const TRASH: Read<Trashed> = trash!("docs.trash", "'document', 'folder'");

pub const READS: &[ReadDecl] = &[
    TOP_LEVEL.decl,
    IN_FOLDER.decl,
    STARRED.decl,
    FOLDERS.decl,
    SUBFOLDERS.decl,
    BY_ID.decl,
    FOLLOWED_FOLDERS.decl,
    TRASH.decl,
];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "document",
        "docs",
        "document",
        "documents",
        Trash::Listed("docs.trash"),
    )
    .sits_in(&[
        "folder", "txn", "event", "workout", "note", "task", "person",
    ])
    .footers(&[
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.documents.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "folder",
        "docs",
        "folder",
        "folders",
        Trash::Listed("docs.trash"),
    )
    .sits_in(&["folder"])
    .holds(&["document", "folder"], &["entity.held_counts"])
    .exports(Export::Within("document")),
];
