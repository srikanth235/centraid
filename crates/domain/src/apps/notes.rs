use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, asc, desc, param, read};

use super::{Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteRow {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub at: String,
    pub pinned: bool,
    pub journal_on: Option<String>,
}

impl NoteRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            at: row.get("at")?,
            pinned: row.get("pinned")?,
            journal_on: row.get("journal_on")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteDetail {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub pinned: bool,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub body: String,
    pub format: String,
    pub journal_on: Option<String>,
}

impl NoteDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            pinned: row.get("pinned")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            body: row.get("body")?,
            format: row.get("format")?,
            journal_on: row.get("journal_on")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NoteAsset {
    pub id: String,
    pub note_id: String,
    pub blob: String,
    pub name: String,
    pub media_type: String,
    pub position: f64,
}

impl NoteAsset {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            note_id: row.get("note_id")?,
            blob: row.get("blob")?,
            name: row.get("name")?,
            media_type: row.get("media_type")?,
            position: row.get("position")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MentionRow {
    pub ordinal: i64,
    pub wikilink: String,
    pub to_id: Option<String>,
    pub target_title: Option<String>,
    pub target_kind: Option<String>,
}

impl MentionRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            ordinal: row.get("ordinal")?,
            wikilink: row.get("wikilink")?,
            to_id: row.get("to_id")?,
            target_title: row.get("target_title")?,
            target_kind: row.get("target_kind")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotebookRow {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
}

impl NotebookRow {
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
pub struct TagRow {
    pub id: String,
    pub title: String,
    pub key: String,
    pub color: Option<String>,
}

impl TagRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            key: row.get("key")?,
            color: row.get("color")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuggestCandidate {
    pub id: String,
    pub kind: String,
    pub title: String,
}

impl SuggestCandidate {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
        })
    }
}

pub const LIST: Read<NoteRow> = read(
    ReadDecl {
        name: "notes.list",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, e.updated_at AS at, \
                     e.pinned_at IS NOT NULL AS pinned, n.journal_on \
              FROM entity e JOIN note n ON n.id = e.id \
              WHERE e.kind = 'note' AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:a, :b) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["entity", "note"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    NoteRow::of,
);

pub const PINNED: Read<NoteRow> = read(
    ReadDecl {
        name: "notes.pinned",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, e.pinned_at AS at, \
                     1 AS pinned, n.journal_on \
              FROM entity e JOIN note n ON n.id = e.id \
              WHERE e.kind = 'note' AND e.pinned_at IS NOT NULL AND e.deleted_at IS NULL \
                AND (e.pinned_at, e.id) < (:a, :b) \
              ORDER BY e.pinned_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["entity", "note"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    NoteRow::of,
);

pub const IN_NOTEBOOK: Read<NoteRow> = read(
    ReadDecl {
        name: "notes.in_notebook",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, e.updated_at AS at, \
                     e.pinned_at IS NOT NULL AS pinned, n.journal_on \
              FROM entity e JOIN note n ON n.id = e.id \
              WHERE e.parent_id = :notebook AND e.kind = 'note' AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:a, :b) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[param("notebook", ParamTy::Id)],
        reads: &["entity", "note"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    NoteRow::of,
);

pub const JOURNAL: Read<NoteRow> = read(
    ReadDecl {
        name: "notes.journal",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, n.journal_on AS at, \
                     e.pinned_at IS NOT NULL AS pinned, n.journal_on \
              FROM note n INDEXED BY note_by_journal CROSS JOIN entity e ON e.id = n.id \
              WHERE n.journal_on IS NOT NULL AND e.deleted_at IS NULL \
                AND (n.journal_on, n.id) < (:a, :b) \
              ORDER BY n.journal_on DESC, n.id DESC LIMIT :n",
        params: &[],
        reads: &["note", "entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    NoteRow::of,
);

pub const BY_ID: Read<NoteDetail> = read(
    ReadDecl {
        name: "notes.by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id, entity.title, entity.parent_id, entity.created_at, entity.updated_at, \
                     entity.pinned_at IS NOT NULL AS pinned, entity.arrived_via, entity.arrived_label, \
                     note.body, note.format, note.journal_on \
              FROM entity JOIN note ON note.id = entity.id \
              WHERE entity.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["entity", "note"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    NoteDetail::of,
);

pub const ASSETS: Read<NoteAsset> = read(
    ReadDecl {
        name: "notes.assets",
        shape: Shape::BoundedChild,
        sql: "SELECT id, note_id, blob, name, media_type, position \
              FROM note_asset \
              WHERE note_id = :id \
              ORDER BY position ASC, id ASC LIMIT 50",
        params: &[param("id", ParamTy::Id)],
        reads: &["note_asset"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    NoteAsset::of,
);

pub const MENTIONS: Read<MentionRow> = read(
    ReadDecl {
        name: "notes.mentions",
        shape: Shape::BoundedChild,
        sql: "SELECT m.ordinal, m.wikilink, m.to_id, \
                     e.title AS target_title, e.kind AS target_kind \
              FROM mention m LEFT JOIN entity e ON e.id = m.to_id AND e.deleted_at IS NULL \
              WHERE m.note_id = :id \
              ORDER BY m.ordinal ASC LIMIT 100",
        params: &[param("id", ParamTy::Id)],
        reads: &["mention"],
        across: &["entity"],
        bound: 100,
        cursor: &[],
    },
    MentionRow::of,
);

pub const NOTEBOOKS: Read<NotebookRow> = read(
    ReadDecl {
        name: "notes.notebooks",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, e.title, e.parent_id, c.color, c.icon \
              FROM container c INDEXED BY container_by_kind JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'notebook' AND e.deleted_at IS NULL \
              ORDER BY c.id ASC LIMIT 100",
        params: &[],
        reads: &["container", "entity"],
        across: &[],
        bound: 100,
        cursor: &[],
    },
    NotebookRow::of,
);

pub const TAGS: Read<TagRow> = read(
    ReadDecl {
        name: "notes.tags",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, e.title, c.key, c.color \
              FROM concept c JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'tag' AND e.deleted_at IS NULL \
              ORDER BY c.key ASC LIMIT 200",
        params: &[],
        reads: &["concept", "entity"],
        across: &[],
        bound: 200,
        cursor: &[],
    },
    TagRow::of,
);

/// A keyset-paged tag list for pickers whose lists must reach every tag.
pub const TAGS_PAGE: Read<TagRow> = read(
    ReadDecl {
        name: "notes.tags_page",
        shape: Shape::PagedList,
        sql: "SELECT c.id, e.title, c.key, c.color \
              FROM concept c JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'tag' AND e.deleted_at IS NULL \
                AND (c.key, c.id) > (:after_key, :after_id) \
              ORDER BY c.key ASC, c.id ASC LIMIT :n",
        params: &[],
        reads: &["concept", "entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[asc("key", "after_key"), asc("id", "after_id")],
    },
    TagRow::of,
);

pub const TAG_BY_ID: Read<TagRow> = read(
    ReadDecl {
        name: "notes.tag_by_id",
        shape: Shape::ByKey,
        sql: "SELECT concept.id, entity.title, concept.key, concept.color \
              FROM concept JOIN entity ON entity.id = concept.id \
              WHERE concept.id = :id AND concept.kind = 'tag' AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["concept", "entity"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    TagRow::of,
);

pub const BY_TAG: Read<NoteRow> = read(
    ReadDecl {
        name: "notes.by_tag",
        shape: Shape::PagedList,
        sql: "SELECT e.id, e.title, e.parent_id, e.updated_at AS at, \
                     e.pinned_at IS NOT NULL AS pinned, n.journal_on \
              FROM edge x JOIN entity e ON e.id = x.from_id JOIN note n ON n.id = e.id \
              WHERE x.to_id = :tag AND x.rel = 'tagged' AND e.kind = 'note' \
                AND e.deleted_at IS NULL AND x.from_id < :after \
              ORDER BY x.from_id DESC LIMIT :n",
        params: &[param("tag", ParamTy::Id)],
        reads: &["edge", "entity", "note"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("id", "after")],
    },
    NoteRow::of,
);

pub const NOTE_TAGS: Read<TagRow> = read(
    ReadDecl {
        name: "notes.note_tags",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, e.title, c.key, c.color \
              FROM edge x JOIN concept c ON c.id = x.to_id JOIN entity e ON e.id = c.id \
              WHERE x.from_id = :id AND x.rel = 'tagged' AND c.kind = 'tag' AND e.deleted_at IS NULL \
              ORDER BY x.to_id ASC LIMIT 50",
        params: &[param("id", ParamTy::Id)],
        reads: &["edge", "concept", "entity"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    TagRow::of,
);

pub const MENTION_SUGGEST: Read<SuggestCandidate> = read(
    ReadDecl {
        name: "notes.mention_suggest",
        shape: Shape::BoundedChild,
        sql: "SELECT id, kind, title FROM entity \
              WHERE kind = :kind AND deleted_at IS NULL \
                AND title >= :prefix COLLATE NOCASE AND title < :upper COLLATE NOCASE \
              ORDER BY title COLLATE NOCASE ASC, created_at ASC, id ASC LIMIT 20",
        params: &[
            param("kind", ParamTy::Text),
            param("prefix", ParamTy::Text),
            param("upper", ParamTy::Text),
        ],
        reads: &["entity"],
        across: &[],
        bound: 20,
        cursor: &[],
    },
    SuggestCandidate::of,
);

pub const TRASH: Read<Trashed> = trash!("notes.trash", "'note', 'notebook', 'list'");

pub const READS: &[ReadDecl] = &[
    LIST.decl,
    PINNED.decl,
    IN_NOTEBOOK.decl,
    JOURNAL.decl,
    BY_ID.decl,
    ASSETS.decl,
    MENTIONS.decl,
    NOTEBOOKS.decl,
    TAGS.decl,
    TAGS_PAGE.decl,
    TAG_BY_ID.decl,
    BY_TAG.decl,
    NOTE_TAGS.decl,
    MENTION_SUGGEST.decl,
    TRASH.decl,
];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "note",
        "notes",
        "note",
        "notes",
        Trash::Listed("notes.trash"),
    )
    .sits_in(&["notebook"])
    .takes_captures()
    .holds(&["photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
    ])
    .exports(Export::File {
        header: "centraid.notes.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "notebook",
        "notes",
        "notebook",
        "notebooks",
        Trash::Listed("notes.trash"),
    )
    .sits_in(&["notebook"])
    .holds(&["note", "notebook"], &["entity.held_counts"])
    .exports(Export::Within("note")),
    KindDecl::new(
        "list",
        "notes",
        "list",
        "lists",
        Trash::Listed("notes.trash"),
    ),
];
