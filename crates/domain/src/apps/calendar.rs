//! Calendar: events, and the calendars that hold them.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, asc, param, read};

use super::{Item, Trashed, trash};

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

pub const READS: &[ReadDecl] = &[TRASH.decl, TODAY_SHORT.decl, TODAY_LONG.decl];

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
