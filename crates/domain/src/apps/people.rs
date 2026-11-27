//! People, catch-ups, and each person's "With" page.
//!
//! Each "With" section is paged on an existing index. `:person` names the person, and cursor
//! values follow the section's declared order.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, asc, desc, param, read};

use super::{Held, Titled, Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonSummary {
    pub id: String,
    pub title: String,
    pub role: Option<String>,
    pub org: Option<String>,
    pub starred_at: Option<String>,
    pub cadence_days: Option<i64>,
    pub form: String,
}

impl PersonSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            role: row.get("role")?,
            org: row.get("org")?,
            starred_at: row.get("starred_at")?,
            cadence_days: row.get("cadence_days")?,
            form: row.get("form")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonDetail {
    pub id: String,
    pub title: String,
    pub form: String,
    pub given: Option<String>,
    pub family: Option<String>,
    pub nickname: Option<String>,
    pub role: Option<String>,
    pub org: Option<String>,
    pub met: Option<String>,
    pub cadence_days: Option<i64>,
    pub starred_at: Option<String>,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub updated_at: String,
}

impl PersonDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            form: row.get("form")?,
            given: row.get("given")?,
            family: row.get("family")?,
            nickname: row.get("nickname")?,
            role: row.get("role")?,
            org: row.get("org")?,
            met: row.get("met")?,
            cadence_days: row.get("cadence_days")?,
            starred_at: row.get("starred_at")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            updated_at: row.get("updated_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ContactPoint {
    pub id: String,
    pub kind: String,
    pub value: String,
    pub label: Option<String>,
    pub preferred: bool,
    pub position: f64,
}

impl ContactPoint {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            value: row.get("value")?,
            label: row.get("label")?,
            preferred: row.get::<_, i64>("preferred")? != 0,
            position: row.get("position")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonDate {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    pub date: String,
    pub reminder_id: Option<String>,
    pub offset_min: Option<i64>,
}

impl PersonDate {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            kind: row.get("kind")?,
            label: row.get("label")?,
            date: row.get("date")?,
            reminder_id: row.get("reminder_id")?,
            offset_min: row.get("offset_min")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Relation {
    pub id: String,
    pub name: String,
    pub relation: String,
}

impl Relation {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            name: row.get("name")?,
            relation: row.get("relation")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeopleList {
    pub id: String,
    pub title: String,
    pub color: Option<String>,
    pub icon: Option<String>,
}

impl PeopleList {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Count(pub i64);

impl Count {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self(row.get("count")?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub id: String,
    pub title: String,
    pub starts: String,
}

impl Event {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            starts: row.get("starts")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Id(pub String);

impl Id {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self(row.get("id")?))
    }
}

const PERSON: &[crate::read::Param] = &[param("person", ParamTy::Id)];
const BY_ID_PARAM: &[crate::read::Param] = &[param("id", ParamTy::Id)];
const LIST_PARAM: &[crate::read::Param] = &[param("list", ParamTy::Id)];

pub const LIST: Read<PersonSummary> = read(
    ReadDecl {
        name: "people.list",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, p.role AS role, p.org AS org, \
                     e.starred_at AS starred_at, p.cadence_days AS cadence_days, p.form AS form \
              FROM entity e JOIN person p ON p.id = e.id \
              WHERE e.kind = 'person' AND e.deleted_at IS NULL \
                AND (e.title, e.id) > (:after_title, :after_id) \
              ORDER BY e.title ASC, e.id ASC LIMIT :n",
        params: &[],
        reads: &["person"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("title", "after_title"), asc("id", "after_id")],
    },
    PersonSummary::of,
);

pub const LIST_RECENT: Read<PersonSummary> = read(
    ReadDecl {
        name: "people.list_recent",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, p.role AS role, p.org AS org, \
                     e.starred_at AS starred_at, p.cadence_days AS cadence_days, p.form AS form, \
                     e.updated_at AS updated_at \
              FROM entity e JOIN person p ON p.id = e.id \
              WHERE e.kind = 'person' AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:after_at, :after_id) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["person"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("updated_at", "after_at"), desc("id", "after_id")],
    },
    PersonSummary::of,
);

pub const LIST_STARRED: Read<PersonSummary> = read(
    ReadDecl {
        name: "people.list_starred",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, p.role AS role, p.org AS org, \
                     e.starred_at AS starred_at, p.cadence_days AS cadence_days, p.form AS form \
              FROM entity e JOIN person p ON p.id = e.id \
              WHERE e.kind = 'person' AND e.starred_at IS NOT NULL AND e.deleted_at IS NULL \
                AND (e.starred_at, e.id) < (:after_at, :after_id) \
              ORDER BY e.starred_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["person"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("starred_at", "after_at"), desc("id", "after_id")],
    },
    PersonSummary::of,
);

pub const BY_ID: Read<PersonDetail> = read(
    ReadDecl {
        name: "people.by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id AS id, entity.title AS title, person.form AS form, \
                     person.given AS given, person.family AS family, person.nickname AS nickname, \
                     person.role AS role, person.org AS org, person.met AS met, \
                     person.cadence_days AS cadence_days, entity.starred_at AS starred_at, \
                     entity.arrived_via AS arrived_via, entity.arrived_label AS arrived_label, \
                     entity.updated_at AS updated_at \
              FROM entity JOIN person ON person.id = entity.id \
              WHERE entity.id = :id AND entity.deleted_at IS NULL",
        params: BY_ID_PARAM,
        reads: &["person"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    PersonDetail::of,
);

pub const CONTACT_POINTS: Read<ContactPoint> = read(
    ReadDecl {
        name: "people.contact_points",
        shape: Shape::BoundedChild,
        sql: "SELECT id, kind, value, label, preferred, position \
              FROM contact_point \
              WHERE person_id = :person \
              ORDER BY kind, normalized LIMIT 50",
        params: PERSON,
        reads: &["contact_point"],
        across: &[],
        bound: 50,
        cursor: &[],
    },
    ContactPoint::of,
);

pub const DATES: Read<PersonDate> = read(
    ReadDecl {
        name: "people.dates",
        shape: Shape::BoundedChild,
        sql: "SELECT d.id AS id, d.kind AS kind, d.label AS label, d.date AS date, \
                     r.id AS reminder_id, r.offset_min AS offset_min \
              FROM person_date d LEFT JOIN reminder r ON r.date_id = d.id \
              WHERE d.person_id = :person \
              ORDER BY d.position, d.id LIMIT 50",
        params: PERSON,
        reads: &["person_date"],
        across: &["reminder"],
        bound: 50,
        cursor: &[],
    },
    PersonDate::of,
);

pub const RELATIONS: Read<Relation> = read(
    ReadDecl {
        name: "people.relations",
        shape: Shape::BoundedChild,
        sql: "SELECT x.to_id AS id, t.title AS name, COALESCE(l.title, '') AS relation \
              FROM edge x \
              JOIN entity t ON t.id = x.to_id \
              LEFT JOIN entity l ON l.id = x.label_id \
              WHERE x.from_id = :person AND x.rel = 'related' AND t.deleted_at IS NULL \
              ORDER BY x.to_id LIMIT 50",
        params: PERSON,
        reads: &["edge"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    Relation::of,
);

pub const LISTS: Read<PeopleList> = read(
    ReadDecl {
        name: "people.lists",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, c.color AS color, c.icon AS icon \
              FROM entity e INDEXED BY entity_by_title \
              CROSS JOIN container c INDEXED BY container_by_kind ON c.kind = 'list' AND c.id = e.id \
              WHERE e.kind = 'list' AND e.deleted_at IS NULL \
                AND (e.title, e.id) > (:after_title, :after_id) \
              ORDER BY e.title ASC, e.id ASC LIMIT :n",
        params: &[],
        reads: &["container"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("title", "after_title"), asc("id", "after_id")],
    },
    PeopleList::of,
);

pub const LIST_BY_ID: Read<PeopleList> = read(
    ReadDecl {
        name: "people.list_by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id AS id, entity.title AS title, container.color AS color, \
                     container.icon AS icon \
              FROM entity CROSS JOIN container INDEXED BY sqlite_autoindex_container_1 \
                ON container.id = entity.id \
              WHERE entity.id = :id AND entity.kind = 'list' AND entity.deleted_at IS NULL",
        params: BY_ID_PARAM,
        reads: &["container"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    PeopleList::of,
);

pub const LIST_MEMBERS: Read<PersonSummary> = read(
    ReadDecl {
        name: "people.list_members",
        shape: Shape::PagedList,
        sql: "SELECT e.id AS id, e.title AS title, p.role AS role, p.org AS org, \
                     e.starred_at AS starred_at, p.cadence_days AS cadence_days, p.form AS form \
              FROM edge x \
              JOIN entity e ON e.id = x.to_id \
              JOIN person p ON p.id = e.id \
              WHERE x.from_id = :list AND x.rel = 'contains' AND e.deleted_at IS NULL \
                AND x.to_id > :after_id \
              ORDER BY x.to_id ASC LIMIT :n",
        params: LIST_PARAM,
        reads: &["edge", "person"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("id", "after_id")],
    },
    PersonSummary::of,
);

pub const LIST_MEMBER_COUNT: Read<Count> = read(
    ReadDecl {
        name: "people.list_member_count",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM edge x JOIN entity e ON e.id = x.to_id \
              WHERE x.from_id = :list AND x.rel = 'contains' AND e.deleted_at IS NULL",
        params: LIST_PARAM,
        reads: &["edge"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    Count::of,
);

pub const LINKED: Read<Id> = read(
    ReadDecl {
        name: "people.linked",
        shape: Shape::BoundedChild,
        sql: "SELECT l.b AS id FROM link l \
              WHERE l.a = :person \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = l.b AND e.deleted_at IS NULL) \
              UNION \
              SELECT l.a AS id FROM link l \
              WHERE l.b = :person \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = l.a AND e.deleted_at IS NULL) \
              ORDER BY id LIMIT 50",
        params: PERSON,
        reads: &["link"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    Id::of,
);

pub const MENTIONED_IN: Read<Titled> = read(
    ReadDecl {
        name: "people.mentioned_in",
        shape: Shape::BoundedChild,
        sql: "SELECT m.note_id AS id, e.title AS title \
              FROM mention m JOIN entity e ON e.id = m.note_id \
              WHERE m.to_id = :person AND e.deleted_at IS NULL \
              ORDER BY m.note_id DESC LIMIT 20",
        params: PERSON,
        reads: &["mention"],
        across: &["entity"],
        bound: 20,
        cursor: &[],
    },
    Titled::of,
);

pub const ATTACHMENTS: Read<EntityRef> = read(
    ReadDecl {
        name: "people.attachments",
        shape: Shape::BoundedChild,
        sql: "SELECT e.id AS id, e.kind AS kind, e.title AS title \
              FROM edge x JOIN entity e ON e.id = x.from_id \
              WHERE x.to_id = :person AND x.rel = 'attached' AND e.deleted_at IS NULL \
              ORDER BY x.from_id DESC LIMIT 20",
        params: PERSON,
        reads: &["edge"],
        across: &["entity"],
        bound: 20,
        cursor: &[],
    },
    EntityRef::of,
);

pub const REVISIONS_COUNT: Read<Count> = read(
    ReadDecl {
        name: "people.revisions_count",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM revision WHERE entity_id = :person",
        params: PERSON,
        reads: &["revision"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    Count::of,
);

pub const ENTITY_TITLE: Read<EntityRef> = read(
    ReadDecl {
        name: "people.entity_title",
        shape: Shape::ByKey,
        sql: "SELECT id, kind, title FROM entity WHERE id = :id AND deleted_at IS NULL",
        params: BY_ID_PARAM,
        reads: &["entity"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    EntityRef::of,
);

pub const SELF_ID: Read<Id> = read(
    ReadDecl {
        name: "people.self_id",
        shape: Shape::ByKey,
        sql: "SELECT self_id AS id FROM vault WHERE id = 1",
        params: &[],
        reads: &["vault"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    Id::of,
);

pub const EVENTS: Read<Event> = read(
    ReadDecl {
        name: "people.with_events",
        shape: Shape::PagedList,
        sql: "SELECT ev.id AS id, e.title AS title, ev.starts AS starts \
              FROM event_guest g JOIN event ev ON ev.id = g.event_id JOIN entity e ON e.id = ev.id \
              WHERE g.person_id = :person AND e.deleted_at IS NULL \
                AND (g.starts, g.event_id) < (:after_start, :after_id) \
              ORDER BY g.starts DESC, g.event_id DESC LIMIT :n",
        params: PERSON,
        reads: &["event_guest"],
        across: &["event", "entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("starts", "after_start"), desc("id", "after_id")],
    },
    Event::of,
);

macro_rules! by_edge {
    ($name:literal, $rel:literal, $extra:literal) => {
        read(
            ReadDecl {
                name: $name,
                shape: Shape::PagedList,
                sql: concat!(
                    "SELECT e.id AS id, e.title AS title FROM edge x JOIN entity e ON e.id = x.from_id \
                     WHERE x.to_id = :person AND x.rel = '",
                    $rel,
                    "' AND e.deleted_at IS NULL",
                    $extra,
                    " AND x.from_id < :after ORDER BY x.from_id DESC LIMIT :n"
                ),
                params: PERSON,
                reads: &["edge"],
                across: &["entity"],
                bound: DEFAULT_PAGE,
                cursor: &[desc("id", "after")],
            },
            Titled::of,
        )
    };
}

pub const PAYMENTS: Read<Titled> = by_edge!("people.with_payments", "with", " AND e.kind = 'txn'");
pub const WORKOUTS: Read<Titled> =
    by_edge!("people.with_workouts", "with", " AND e.kind = 'workout'");
pub const CATCH_UPS: Read<Titled> =
    by_edge!("people.with_catch_ups", "with", " AND e.kind = 'touch'");
pub const PHOTOS: Read<Titled> =
    by_edge!("people.with_photos", "depicts", " AND e.parent_id IS NULL");
pub const DOCS: Read<Titled> = by_edge!(
    "people.with_docs",
    "about",
    " AND e.kind = 'document' AND e.parent_id IS NULL"
);

pub const NOTES: Read<Id> = read(
    ReadDecl {
        name: "people.with_notes",
        shape: Shape::PagedList,
        sql: "SELECT m.note_id AS id FROM mention m \
              WHERE m.to_id = :person AND m.note_id < :after \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = m.note_id AND e.deleted_at IS NULL) \
              UNION \
              SELECT x.from_id FROM edge x \
              WHERE x.to_id = :person AND x.rel = 'about' AND x.from_id < :after \
                AND EXISTS (SELECT 1 FROM entity e WHERE e.id = x.from_id AND e.kind = 'note' \
                              AND e.deleted_at IS NULL) \
              ORDER BY id DESC LIMIT :n",
        params: PERSON,
        reads: &["mention", "edge"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("id", "after")],
    },
    Id::of,
);

fn touches(row: &Row<'_>) -> rusqlite::Result<Held> {
    Ok(Held {
        kind: "touch".to_owned(),
        count: row.get("count")?,
    })
}

pub const TOUCHES_HELD: Read<Held> = read(
    ReadDecl {
        name: "people.touches_held",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM edge e JOIN entity f ON f.id = e.from_id \
              WHERE e.to_id = :person AND e.rel IN ('about', 'with') \
                AND f.kind = 'touch' AND f.deleted_at IS NULL \
                AND NOT EXISTS (SELECT 1 FROM edge o WHERE o.from_id = e.from_id \
                                  AND o.rel IN ('about', 'with') AND o.to_id <> :person)",
        params: PERSON,
        reads: &["edge"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    touches,
);

pub const TRASH: Read<Trashed> = trash!("people.trash", "'person', 'touch'");

pub const READS: &[ReadDecl] = &[
    LIST.decl,
    LIST_RECENT.decl,
    LIST_STARRED.decl,
    BY_ID.decl,
    CONTACT_POINTS.decl,
    DATES.decl,
    RELATIONS.decl,
    LISTS.decl,
    LIST_BY_ID.decl,
    LIST_MEMBERS.decl,
    LIST_MEMBER_COUNT.decl,
    LINKED.decl,
    MENTIONED_IN.decl,
    ATTACHMENTS.decl,
    REVISIONS_COUNT.decl,
    ENTITY_TITLE.decl,
    SELF_ID.decl,
    EVENTS.decl,
    PAYMENTS.decl,
    WORKOUTS.decl,
    CATCH_UPS.decl,
    PHOTOS.decl,
    DOCS.decl,
    NOTES.decl,
    TOUCHES_HELD.decl,
    TRASH.decl,
];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "person",
        "people",
        "person",
        "people",
        Trash::Listed("people.trash"),
    )
    .takes_captures()
    .holds(
        &["touch", "photo", "document"],
        &["entity.held_counts", "people.touches_held"],
    )
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.people.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "touch",
        "people",
        "catch-up",
        "catch-ups",
        Trash::Listed("people.trash"),
    )
    .footers(&[Footer::Linked, Footer::MentionedIn])
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "touch_kind",
        "people",
        "catch-up type",
        "catch-up types",
        Trash::Purged("a type is purged outright; a catch-up cannot sit on one that is gone"),
    )
    .sits_in(&["touch_kind"]),
    KindDecl::new(
        "relation",
        "people",
        "relationship",
        "relationships",
        Trash::Purged("a relationship is purged outright; the people it joined stay"),
    ),
];
