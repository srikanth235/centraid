//! Reads over `entity` that no one app owns: a kind's starred rows, what a home holds, and how
//! many of each kind it holds (the number a delete confirm names, N11).

use rusqlite::Row;

use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, desc, param, read};

use super::{Held, Item, Titled};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultInfo {
    pub name: String,
    pub self_id: String,
}

impl VaultInfo {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            name: row.get("name")?,
            self_id: row.get("self_id")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionHead {
    pub seq: i64,
    pub count: i64,
}

impl RevisionHead {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            seq: row.get("seq")?,
            count: row.get("count")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionRow {
    pub seq: i64,
    pub at: String,
    pub actor: String,
    pub cause: String,
}

impl RevisionRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            seq: row.get("seq")?,
            at: row.get("at")?,
            actor: row.get("actor")?,
            cause: row.get("cause")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityMeta {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub starred_at: Option<String>,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub created_at: String,
}

impl EntityMeta {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            starred_at: row.get("starred_at")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityRef {
    pub id: String,
    pub kind: String,
    pub title: String,
}

impl EntityRef {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntitySearchRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub at: String,
}

impl EntitySearchRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
            at: row.get("at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContainerRow {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub color: Option<String>,
    pub icon: Option<String>,
}

impl ContainerRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            title: row.get("title")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
        })
    }
}

pub const STARRED: Read<Item> = read(STARRED_DECL, Item::of);

pub const STARRED_DECL: ReadDecl = ReadDecl {
    name: "entity.starred",
    shape: Shape::PagedList,
    sql: "SELECT id, title, starred_at AS at FROM entity \
          WHERE kind = :kind AND starred_at IS NOT NULL AND deleted_at IS NULL \
            AND (starred_at, id) < (:a, :b) \
          ORDER BY starred_at DESC, id DESC LIMIT :n",
    params: &[param("kind", ParamTy::Text)],
    reads: &["entity"],
    across: &[],
    bound: DEFAULT_PAGE,
    cursor: &[desc("at", "a"), desc("id", "b")],
};

pub const IN_HOME: Read<Item> = read(
    ReadDecl {
        name: "entity.in_home",
        shape: Shape::PagedList,
        sql: "SELECT id, title, updated_at AS at FROM entity \
              WHERE parent_id = :home AND kind = :kind AND deleted_at IS NULL \
                AND (updated_at, id) < (:a, :b) \
              ORDER BY updated_at DESC, id DESC LIMIT :n",
        params: &[param("home", ParamTy::Id), param("kind", ParamTy::Text)],
        reads: &["entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    Item::of,
);

pub const HELD_COUNTS: Read<Held> = read(
    ReadDecl {
        name: "entity.held_counts",
        shape: Shape::Aggregate,
        sql: "SELECT kind, count(*) AS count FROM entity \
              WHERE parent_id = :home AND deleted_at IS NULL GROUP BY kind",
        params: &[param("home", ParamTy::Id)],
        reads: &["entity"],
        across: &[],
        bound: 25,
        cursor: &[],
    },
    Held::of,
);

pub const HELD: Read<String> = read(
    ReadDecl {
        name: "entity.held",
        shape: Shape::ByKey,
        sql: "SELECT id FROM entity WHERE id = :id",
        params: &[param("id", ParamTy::Id)],
        reads: &["entity"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    |row| row.get("id"),
);

pub const VAULT_INFO: Read<VaultInfo> = read(
    ReadDecl {
        name: "entity.vault_info",
        shape: Shape::ByKey,
        sql: "SELECT name, self_id FROM vault WHERE id = 1",
        params: &[],
        reads: &["vault"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    VaultInfo::of,
);

pub const REVISION_HEAD: Read<RevisionHead> = read(
    ReadDecl {
        name: "entity.revision_head",
        shape: Shape::Aggregate,
        sql: "SELECT coalesce(max(seq), 0) AS seq, count(*) AS count \
              FROM revision WHERE entity_id = :id",
        params: &[param("id", ParamTy::Id)],
        reads: &["revision"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    RevisionHead::of,
);

pub const REVISIONS: Read<RevisionRow> = read(
    ReadDecl {
        name: "entity.revisions",
        shape: Shape::BoundedChild,
        sql: "SELECT seq, at, actor, cause FROM revision \
              WHERE entity_id = :id ORDER BY seq DESC LIMIT 50",
        params: &[param("id", ParamTy::Id)],
        reads: &["revision"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    RevisionRow::of,
);

pub const META_BY_ID: Read<EntityMeta> = read(
    ReadDecl {
        name: "entity.meta_by_id",
        shape: Shape::ByKey,
        sql: "SELECT id, kind, title, parent_id, starred_at, arrived_via, arrived_label, created_at \
              FROM entity WHERE id = :id AND deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["entity"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    EntityMeta::of,
);

pub const ATTACHMENTS: Read<EntityRef> = read(
    ReadDecl {
        name: "entity.attachments",
        shape: Shape::BoundedChild,
        sql: "SELECT e.id AS id, e.kind AS kind, e.title AS title \
              FROM edge x JOIN entity e ON e.id = x.from_id \
              WHERE x.to_id = :id AND x.rel = 'attached' AND e.deleted_at IS NULL \
              ORDER BY x.from_id DESC LIMIT 20",
        params: &[param("id", ParamTy::Id)],
        reads: &["edge"],
        across: &["entity"],
        bound: 20,
        cursor: &[],
    },
    EntityRef::of,
);

pub const LINKED: Read<String> = read(
    ReadDecl {
        name: "entity.linked",
        shape: Shape::BoundedChild,
        sql: "SELECT l.b AS id FROM link l \
              WHERE l.a = :id \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = l.b AND e.deleted_at IS NULL) \
              UNION \
              SELECT l.a AS id FROM link l \
              WHERE l.b = :id \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = l.a AND e.deleted_at IS NULL) \
              ORDER BY id LIMIT 50",
        params: &[param("id", ParamTy::Id)],
        reads: &["link"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    |row| row.get("id"),
);

pub const MENTIONED_IN: Read<Titled> = read(
    ReadDecl {
        name: "entity.mentioned_in",
        shape: Shape::BoundedChild,
        sql: "SELECT m.note_id AS id, e.title AS title \
              FROM mention m JOIN entity e ON e.id = m.note_id \
              WHERE m.to_id = :id AND e.deleted_at IS NULL \
              ORDER BY m.note_id DESC LIMIT 20",
        params: &[param("id", ParamTy::Id)],
        reads: &["mention"],
        across: &["entity"],
        bound: 20,
        cursor: &[],
    },
    Titled::of,
);

pub const BY_KIND_RECENT: Read<EntitySearchRow> = read(
    ReadDecl {
        name: "entity.by_kind_recent",
        shape: Shape::PagedList,
        sql: "SELECT id, kind, title, updated_at AS at FROM entity \
              WHERE kind = :kind AND deleted_at IS NULL \
                AND (updated_at, id) < (:a, :b) \
              ORDER BY updated_at DESC, id DESC LIMIT :n",
        params: &[param("kind", ParamTy::Text)],
        reads: &["entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    EntitySearchRow::of,
);

pub const CONTAINERS_BY_KIND: Read<ContainerRow> = read(
    ReadDecl {
        name: "entity.containers_by_kind",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, c.kind, e.title, c.color, c.icon \
              FROM container c INDEXED BY container_by_kind JOIN entity e ON e.id = c.id \
              WHERE c.kind = :kind AND e.deleted_at IS NULL \
              ORDER BY c.id ASC LIMIT 100",
        params: &[param("kind", ParamTy::Text)],
        reads: &["container"],
        across: &["entity"],
        bound: 100,
        cursor: &[],
    },
    ContainerRow::of,
);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FollowedStoreRow {
    pub id: String,
    pub system: String,
    pub r#ref: String,
    pub label: String,
    pub device_id: Option<String>,
    pub fills: Option<String>,
    pub fills_kind: Option<String>,
    pub cursor: Option<String>,
    pub created_at: String,
    pub retired_at: Option<String>,
}

impl FollowedStoreRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            system: row.get("system")?,
            r#ref: row.get("ref")?,
            label: row.get("label")?,
            device_id: row.get("device_id")?,
            fills: row.get("fills")?,
            fills_kind: row.get("fills_kind")?,
            cursor: row.get("cursor")?,
            created_at: row.get("created_at")?,
            retired_at: row.get("retired_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneDifferenceRow {
    pub id: String,
    pub origin_id: String,
    pub system: String,
    pub external_id: String,
    pub stated: String,
    pub stated_title: Option<String>,
    pub seen_at: String,
    pub origin_label: String,
}

impl PhoneDifferenceRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            origin_id: row.get("origin_id")?,
            system: row.get("system")?,
            external_id: row.get("external_id")?,
            stated: row.get("stated")?,
            stated_title: row.get("stated_title")?,
            seen_at: row.get("seen_at")?,
            origin_label: row.get("origin_label")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EarlierVersionRow {
    pub seq: i64,
    pub at: String,
    pub actor: String,
    pub origin_id: Option<String>,
    pub cause: String,
    pub state: String,
    pub body: Option<String>,
    pub autosave: bool,
}

impl EarlierVersionRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            seq: row.get("seq")?,
            at: row.get("at")?,
            actor: row.get("actor")?,
            origin_id: row.get("origin_id")?,
            cause: row.get("cause")?,
            state: row.get("state")?,
            body: row.get("body")?,
            autosave: row.get::<_, i64>("autosave")? != 0,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginCursorRow {
    pub id: String,
    pub system: String,
    pub r#ref: String,
    pub label: String,
    pub device_id: Option<String>,
    pub fills: Option<String>,
    pub cursor: Option<String>,
    pub retired_at: Option<String>,
}

impl OriginCursorRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            system: row.get("system")?,
            r#ref: row.get("ref")?,
            label: row.get("label")?,
            device_id: row.get("device_id")?,
            fills: row.get("fills")?,
            cursor: row.get("cursor")?,
            retired_at: row.get("retired_at")?,
        })
    }
}

pub const FILES_FOLLOWED: Read<FollowedStoreRow> = read(
    ReadDecl {
        name: "entity.files_followed",
        shape: Shape::BoundedChild,
        sql: "SELECT id, system, ref, label, device_id, fills, fills_kind, cursor, created_at, retired_at \
              FROM origin WHERE system = 'files' ORDER BY ref ASC LIMIT 50",
        params: &[],
        reads: &["origin"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    FollowedStoreRow::of,
);

pub const FOLLOWED_STORES: Read<FollowedStoreRow> = read(
    ReadDecl {
        name: "entity.followed_stores",
        shape: Shape::BoundedChild,
        sql: "SELECT id, system, ref, label, device_id, fills, fills_kind, cursor, created_at, retired_at \
              FROM origin WHERE system = :system ORDER BY ref ASC LIMIT 50",
        params: &[param("system", ParamTy::Text)],
        reads: &["origin"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    FollowedStoreRow::of,
);

pub const PHONE_DIFFERENCES: Read<PhoneDifferenceRow> = read(
    ReadDecl {
        name: "entity.phone_differences",
        shape: Shape::BoundedChild,
        sql: "SELECT s.id, s.origin_id, s.system, s.external_id, s.stated, s.stated_title, s.seen_at, o.label AS origin_label \
              FROM source s JOIN origin o ON o.id = s.origin_id \
              WHERE s.entity_id = :id LIMIT 20",
        params: &[param("id", ParamTy::Id)],
        reads: &["source", "origin"],
        across: &[],
        bound: 20,
        cursor: &[],
    },
    PhoneDifferenceRow::of,
);

pub const EARLIER_VERSIONS: Read<EarlierVersionRow> = read(
    ReadDecl {
        name: "entity.earlier_versions",
        shape: Shape::BoundedChild,
        sql: "SELECT seq, at, actor, origin_id, cause, state, body, autosave \
              FROM revision WHERE entity_id = :id ORDER BY seq DESC LIMIT 50",
        params: &[param("id", ParamTy::Id)],
        reads: &["revision"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    EarlierVersionRow::of,
);

pub const ORIGIN_CURSOR: Read<OriginCursorRow> = read(
    ReadDecl {
        name: "entity.origin_cursor",
        shape: Shape::ByKey,
        sql: "SELECT id, system, ref, label, device_id, fills, cursor, retired_at \
              FROM origin WHERE system = :system AND ref = :ref",
        params: &[param("system", ParamTy::Text), param("ref", ParamTy::Text)],
        reads: &["origin"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    OriginCursorRow::of,
);

pub const READS: &[ReadDecl] = &[
    STARRED.decl,
    IN_HOME.decl,
    HELD_COUNTS.decl,
    HELD.decl,
    VAULT_INFO.decl,
    REVISION_HEAD.decl,
    REVISIONS.decl,
    META_BY_ID.decl,
    ATTACHMENTS.decl,
    LINKED.decl,
    MENTIONED_IN.decl,
    BY_KIND_RECENT.decl,
    CONTAINERS_BY_KIND.decl,
    FILES_FOLLOWED.decl,
    FOLLOWED_STORES.decl,
    PHONE_DIFFERENCES.decl,
    EARLIER_VERSIONS.decl,
    ORIGIN_CURSOR.decl,
];
