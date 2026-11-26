//! People: the people a member knows, the catch-ups with them, and the page that gathers
//! everything about one: "With <name>" (app-plane §3).
//!
//! A person's page holds one section per source. Each is a `PagedList` on an index that already
//! exists, and the preview shows the first page's first few rows with the section's own "Show
//! all". No section shows a count: a count is an unbounded aggregate. `:person` is the person's
//! id; the keyset parameters are the first-page sentinel or the last row's key. Ids are UUIDv7, so
//! ordering by id is ordering by when the item was made.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, desc, param, read};

use super::{Held, Titled, Trashed, trash};

/// A row of the Events section: when it starts is what it is ordered by.
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

/// A row that is only an id: the Notes section, whose titles come from a read of the page's ids.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Id(pub String);

impl Id {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self(row.get("id")?))
    }
}

const PERSON: &[crate::read::Param] = &[param("person", ParamTy::Id)];

/// Events the person is a guest of, by when the event starts (`event_guest.starts` copies
/// `event.starts`, so a date, a floating and a zoned start sort by their text): `event_guest_by_person_start`.
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

/// Payments with the person (`with` edges from a transaction): `edge_to`.
pub const PAYMENTS: Read<Titled> = by_edge!("people.with_payments", "with", " AND e.kind = 'txn'");
/// Workouts with the person.
pub const WORKOUTS: Read<Titled> =
    by_edge!("people.with_workouts", "with", " AND e.kind = 'workout'");
/// Catch-ups with the person.
pub const CATCH_UPS: Read<Titled> =
    by_edge!("people.with_catch_ups", "with", " AND e.kind = 'touch'");
/// People in photos: library photos only, never a capture homed in an item.
pub const PHOTOS: Read<Titled> =
    by_edge!("people.with_photos", "depicts", " AND e.parent_id IS NULL");
/// Documents about the person, top level only.
pub const DOCS: Read<Titled> = by_edge!(
    "people.with_docs",
    "about",
    " AND e.kind = 'document' AND e.parent_id IS NULL"
);

/// Notes about the person, or whose `[[…]]` resolves to them: ids only, because a title column puts
/// a temp B-tree in each leg of the merge. `mention_by_target` and `edge_to`.
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

/// How many live catch-ups a person's trash takes with them: those with this person and no one
/// else.
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

/// People and catch-ups in the trash.
pub const TRASH: Read<Trashed> = trash!("people.trash", "'person', 'touch'");

pub const READS: &[ReadDecl] = &[
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
