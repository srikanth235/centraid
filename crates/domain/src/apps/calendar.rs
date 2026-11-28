//! Calendar: events, and the calendars that hold them.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, asc, param, read};

use super::{Item, Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventSummary {
    pub id: String,
    pub title: String,
    pub calendar_id: Option<String>,
    pub starts: String,
    pub ends: Option<String>,
    pub timing: String,
    pub zone: Option<String>,
    pub rule: Option<String>,
    pub status: String,
    pub busy: bool,
    pub location: Option<String>,
    pub starred_at: Option<String>,
    pub needs_reply: bool,
}

impl EventSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            calendar_id: row.get("calendar_id")?,
            starts: row.get("starts")?,
            ends: row.get("ends")?,
            timing: row.get("timing")?,
            zone: row.get("zone")?,
            rule: row.get("rule")?,
            status: row.get("status")?,
            busy: row.get::<_, i64>("busy")? != 0,
            location: row.get("location")?,
            starred_at: row.get("starred_at")?,
            needs_reply: row.get::<_, i64>("needs_reply")? != 0,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventDetail {
    pub id: String,
    pub title: String,
    pub calendar_id: Option<String>,
    pub starts: String,
    pub ends: Option<String>,
    pub timing: String,
    pub zone: Option<String>,
    pub rule: Option<String>,
    pub status: String,
    pub busy: bool,
    pub location: Option<String>,
    pub url: Option<String>,
    pub description: Option<String>,
    pub starred_at: Option<String>,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub created_at: String,
}

impl EventDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            calendar_id: row.get("calendar_id")?,
            starts: row.get("starts")?,
            ends: row.get("ends")?,
            timing: row.get("timing")?,
            zone: row.get("zone")?,
            rule: row.get("rule")?,
            status: row.get("status")?,
            busy: row.get::<_, i64>("busy")? != 0,
            location: row.get("location")?,
            url: row.get("url")?,
            description: row.get("description")?,
            starred_at: row.get("starred_at")?,
            arrived_via: row.get("arrived_via")?,
            arrived_label: row.get("arrived_label")?,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestRow {
    pub id: String,
    pub address: Option<String>,
    pub person_id: Option<String>,
    pub name: Option<String>,
    pub role: String,
    pub status: String,
    pub organizer: bool,
}

impl GuestRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            address: row.get("address")?,
            person_id: row.get("person_id")?,
            name: row.get("name")?,
            role: row.get("role")?,
            status: row.get("status")?,
            organizer: row.get::<_, i64>("organizer")? != 0,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertRow {
    pub id: String,
    pub offset_min: i64,
}

impl AlertRow {
    pub(crate) fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            offset_min: row.get("offset_min")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnoozeRow {
    pub until: String,
}

impl SnoozeRow {
    pub(crate) fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            until: row.get("until")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonDateOnDay {
    pub id: String,
    pub person_id: String,
    pub person_name: String,
    pub kind: String,
    pub label: Option<String>,
    pub date: String,
}

impl PersonDateOnDay {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            person_id: row.get("person_id")?,
            person_name: row.get("person_name")?,
            kind: row.get("kind")?,
            label: row.get("label")?,
            date: row.get("date")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarRow {
    pub id: String,
    pub title: String,
    pub color: Option<String>,
    pub icon: Option<String>,
}

impl CalendarRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
        })
    }
}

pub const TRASH: Read<Trashed> = trash!("calendar.trash", "'event', 'calendar'");

pub const TODAY_SHORT: Read<Item> = read(
    ReadDecl {
        name: "calendar.today_short",
        shape: Shape::PagedList,
        sql: "SELECT e.id, n.title, e.starts AS at \
              FROM event e INDEXED BY event_by_start CROSS JOIN entity n ON n.id = e.id \
              WHERE n.deleted_at IS NULL AND e.status <> 'cancelled' AND e.rule IS NULL \
                AND e.starts >= :low AND e.starts <= :high \
                AND (e.starts, e.id) > (:a, :b) \
                AND ((e.timing = 'zoned' AND e.starts >= :from AND e.starts < :to) \
                  OR (e.timing = 'floating' AND e.starts >= :floating_from AND e.starts <= :floating_to) \
                  OR (e.timing = 'all-day' AND e.starts <= :day AND ifnull(e.ends, e.starts) >= :day)) \
              ORDER BY e.starts ASC, e.id ASC LIMIT :n",
        params: &[
            param("day", ParamTy::Day),
            param("from", ParamTy::Text),
            param("to", ParamTy::Text),
            param("floating_from", ParamTy::Text),
            param("floating_to", ParamTy::Text),
            param("low", ParamTy::Text),
            param("high", ParamTy::Text),
        ],
        reads: &["event"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("at", "a"), asc("id", "b")],
    },
    Item::of,
);

pub const TODAY_LONG: Read<Item> = read(
    ReadDecl {
        name: "calendar.today_long",
        shape: Shape::PagedList,
        sql: "SELECT e.id, n.title, e.starts AS at \
              FROM event e INDEXED BY event_long CROSS JOIN entity n ON n.id = e.id \
              WHERE e.long = 1 AND n.deleted_at IS NULL AND e.status <> 'cancelled' AND e.rule IS NULL \
                AND e.starts <= :day AND ifnull(e.ends, e.starts) >= :day \
                AND (e.starts, e.id) > (:a, :b) \
              ORDER BY e.starts ASC, e.id ASC LIMIT :n",
        params: &[param("day", ParamTy::Day)],
        reads: &["event"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("at", "a"), asc("id", "b")],
    },
    Item::of,
);

pub const RANGE_SHORT: Read<EventSummary> = read(
    ReadDecl {
        name: "calendar.range_short",
        shape: Shape::PagedList,
        sql: "SELECT e.id, n.title, n.parent_id AS calendar_id, e.starts, e.ends, e.timing, \
                e.zone, e.rule, e.status, e.busy, e.location, n.starred_at, \
                EXISTS (SELECT 1 FROM event_guest g WHERE g.event_id = e.id AND g.status = 'needs-action') AS needs_reply \
              FROM event e INDEXED BY event_by_start CROSS JOIN entity n ON n.id = e.id \
              WHERE n.deleted_at IS NULL AND e.status <> 'cancelled' AND e.rule IS NULL \
                AND e.starts >= :low AND e.starts <= :high \
                AND (e.starts, e.id) > (:a, :b) \
              ORDER BY e.starts ASC, e.id ASC LIMIT :n",
        params: &[param("low", ParamTy::Text), param("high", ParamTy::Text)],
        reads: &["event", "event_guest"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("starts", "a"), asc("id", "b")],
    },
    EventSummary::of,
);

pub const RANGE_LONG: Read<EventSummary> = read(
    ReadDecl {
        name: "calendar.range_long",
        shape: Shape::PagedList,
        sql: "SELECT e.id, n.title, n.parent_id AS calendar_id, e.starts, e.ends, e.timing, \
                e.zone, e.rule, e.status, e.busy, e.location, n.starred_at, \
                EXISTS (SELECT 1 FROM event_guest g WHERE g.event_id = e.id AND g.status = 'needs-action') AS needs_reply \
              FROM event e INDEXED BY event_long CROSS JOIN entity n ON n.id = e.id \
              WHERE e.long = 1 AND n.deleted_at IS NULL AND e.status <> 'cancelled' AND e.rule IS NULL \
                AND e.starts <= :high AND ifnull(e.ends, e.starts) >= :low \
                AND (e.starts, e.id) > (:a, :b) \
              ORDER BY e.starts ASC, e.id ASC LIMIT :n",
        params: &[param("low", ParamTy::Text), param("high", ParamTy::Text)],
        reads: &["event", "event_guest"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("starts", "a"), asc("id", "b")],
    },
    EventSummary::of,
);

pub const RECURRING: Read<EventSummary> = read(
    ReadDecl {
        name: "calendar.recurring",
        shape: Shape::PagedList,
        sql: "SELECT e.id, n.title, n.parent_id AS calendar_id, e.starts, e.ends, e.timing, \
                e.zone, e.rule, e.status, e.busy, e.location, n.starred_at, \
                EXISTS (SELECT 1 FROM event_guest g WHERE g.event_id = e.id AND g.status = 'needs-action') AS needs_reply \
              FROM event e INDEXED BY event_by_rule CROSS JOIN entity n ON n.id = e.id \
              WHERE e.rule IS NOT NULL AND n.deleted_at IS NULL AND e.status <> 'cancelled' \
                AND e.starts <= :high AND (e.starts, e.id) > (:a, :b) \
              ORDER BY e.starts ASC, e.id ASC LIMIT :n",
        params: &[param("high", ParamTy::Text)],
        reads: &["event", "event_guest"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("starts", "a"), asc("id", "b")],
    },
    EventSummary::of,
);

pub const BY_ID: Read<EventDetail> = read(
    ReadDecl {
        name: "calendar.by_id",
        shape: Shape::ByKey,
        sql: "SELECT event.id AS id, entity.title AS title, entity.parent_id AS calendar_id, \
                event.starts AS starts, event.ends AS ends, event.timing AS timing, \
                event.zone AS zone, event.rule AS rule, event.status AS status, \
                event.busy AS busy, event.location AS location, event.url AS url, \
                event.description AS description, entity.starred_at AS starred_at, \
                entity.arrived_via AS arrived_via, entity.arrived_label AS arrived_label, \
                entity.created_at AS created_at \
              FROM event JOIN entity ON entity.id = event.id \
              WHERE event.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["event"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    EventDetail::of,
);

pub const GUESTS: Read<GuestRow> = read(
    ReadDecl {
        name: "calendar.guests",
        shape: Shape::BoundedChild,
        sql: "SELECT g.id, g.address, g.person_id, g.name, g.role, g.status, g.organizer \
              FROM event_guest g WHERE g.event_id = :event_id \
              ORDER BY g.id ASC LIMIT 100",
        params: &[param("event_id", ParamTy::Id)],
        reads: &["event_guest"],
        across: &[],
        bound: 100,
        cursor: &[],
    },
    GuestRow::of,
);

pub const REMINDERS: Read<AlertRow> = read(
    ReadDecl {
        name: "calendar.reminders",
        shape: Shape::BoundedChild,
        sql: "SELECT id, offset_min FROM reminder \
              WHERE entity_id = :event_id AND ifnull(date_id, '') = '' AND ifnull(field_id, '') = '' \
              ORDER BY offset_min ASC LIMIT 20",
        params: &[param("event_id", ParamTy::Id)],
        reads: &["reminder"],
        across: &[],
        bound: 20,
        cursor: &[],
    },
    AlertRow::of,
);

pub const SNOOZE: Read<SnoozeRow> = read(
    ReadDecl {
        name: "calendar.snooze",
        shape: Shape::ByKey,
        sql: "SELECT until FROM snooze \
              WHERE entity_id = :id AND ifnull(date_id, '') = '' AND ifnull(field_id, '') = ''",
        params: &[param("id", ParamTy::Id)],
        reads: &["snooze"],
        across: &[],
        bound: 1,
        cursor: &[],
    },
    SnoozeRow::of,
);

pub const PERSON_DATES_ON_MD: Read<PersonDateOnDay> = read(
    ReadDecl {
        name: "calendar.person_dates_on_md",
        shape: Shape::BoundedChild,
        sql: "SELECT d.id, d.person_id, e.title AS person_name, d.kind, d.label, d.date \
              FROM person_date d JOIN entity e ON e.id = d.person_id \
              WHERE substr(d.date, -5) = :md AND e.deleted_at IS NULL \
              ORDER BY d.person_id ASC LIMIT 50",
        params: &[param("md", ParamTy::Text)],
        reads: &[],
        across: &["person_date", "entity"],
        bound: 50,
        cursor: &[],
    },
    PersonDateOnDay::of,
);

pub const CALENDARS: Read<CalendarRow> = read(
    ReadDecl {
        name: "calendar.calendars",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, e.title, c.color, c.icon \
              FROM container c INDEXED BY container_by_kind JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'calendar' AND e.deleted_at IS NULL \
              ORDER BY c.id ASC LIMIT 100",
        params: &[],
        reads: &[],
        across: &["container", "entity"],
        bound: 100,
        cursor: &[],
    },
    CalendarRow::of,
);

pub const CALENDAR_BY_ID: Read<CalendarRow> = read(
    ReadDecl {
        name: "calendar.calendar_by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id AS id, entity.title AS title, container.color AS color, \
                container.icon AS icon \
              FROM entity CROSS JOIN container INDEXED BY sqlite_autoindex_container_1 \
                ON container.id = entity.id \
              WHERE entity.id = :id AND entity.kind = 'calendar' AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &[],
        across: &["container", "entity"],
        bound: 1,
        cursor: &[],
    },
    CalendarRow::of,
);

pub const READS: &[ReadDecl] = &[
    TRASH.decl,
    TODAY_SHORT.decl,
    TODAY_LONG.decl,
    RANGE_SHORT.decl,
    RANGE_LONG.decl,
    RECURRING.decl,
    BY_ID.decl,
    GUESTS.decl,
    REMINDERS.decl,
    SNOOZE.decl,
    PERSON_DATES_ON_MD.decl,
    CALENDARS.decl,
    CALENDAR_BY_ID.decl,
];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "event",
        "calendar",
        "event",
        "events",
        Trash::Listed("calendar.trash"),
    )
    .sits_in(&["calendar"])
    .not_top()
    .takes_captures()
    .holds(&["photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.events.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "calendar",
        "calendar",
        "calendar",
        "calendars",
        Trash::Listed("calendar.trash"),
    )
    .holds(&["event"], &["entity.held_counts"])
    .exports(Export::Within("event")),
];
