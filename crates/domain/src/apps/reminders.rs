//! Reminders: tasks, and the lists that hold them.

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, asc, param, read};

use super::{Item, Trashed, trash};

pub const TRASH: Read<Trashed> = trash!("reminders.trash", "'task', 'task_list'");

pub const TODAY_DUE: Read<Item> = read(
    ReadDecl {
        name: "reminders.today_due",
        shape: Shape::PagedList,
        sql: "SELECT t.id, n.title, t.due AS at \
              FROM task t INDEXED BY task_by_due CROSS JOIN entity n ON n.id = t.id \
              WHERE n.deleted_at IS NULL AND t.status = 'open' \
                AND t.due >= :low AND t.due <= :high \
                AND (t.due, t.id) > (:a, :b) \
                AND ((t.due_timing = 'zoned' AND t.due >= :from AND t.due < :to) \
                  OR (t.due_timing = 'floating' AND t.due >= :floating_from AND t.due <= :floating_to) \
                  OR (t.due_timing = 'all-day' AND t.due = :day)) \
              ORDER BY t.due ASC, t.id ASC LIMIT :n",
        params: &[
            param("day", ParamTy::Day),
            param("from", ParamTy::Text),
            param("to", ParamTy::Text),
            param("floating_from", ParamTy::Text),
            param("floating_to", ParamTy::Text),
            param("low", ParamTy::Text),
            param("high", ParamTy::Text),
        ],
        reads: &["task"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("at", "a"), asc("id", "b")],
    },
    Item::of,
);

pub const TODAY_SCHEDULED: Read<Item> = read(
    ReadDecl {
        name: "reminders.today_scheduled",
        shape: Shape::PagedList,
        sql: "SELECT t.id, n.title, ifnull(t.due, '') AS at \
              FROM task t INDEXED BY task_by_scheduled CROSS JOIN entity n ON n.id = t.id \
              WHERE n.deleted_at IS NULL AND t.status = 'open' \
                AND t.scheduled_on = :day AND t.id > :a \
              ORDER BY t.id ASC LIMIT :n",
        params: &[param("day", ParamTy::Day)],
        reads: &["task"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("id", "a")],
    },
    Item::of,
);

pub const READS: &[ReadDecl] = &[TRASH.decl, TODAY_DUE.decl, TODAY_SCHEDULED.decl];

pub const KINDS: &[KindDecl] = &[
    KindDecl::new(
        "task",
        "reminders",
        "task",
        "tasks",
        Trash::Listed("reminders.trash"),
    )
    .sits_in(&["task_list", "task"])
    .takes_captures()
    .holds(&["task", "photo", "document"], &["entity.held_counts"])
    .footers(&[
        Footer::Attachments,
        Footer::Linked,
        Footer::MentionedIn,
        Footer::Origin,
        Footer::Says,
    ])
    .exports(Export::File {
        header: "centraid.tasks.v1",
        format: exported,
    })
    .shares(Share::Payload(plain)),
    KindDecl::new(
        "task_list",
        "reminders",
        "task list",
        "task lists",
        Trash::Listed("reminders.trash"),
    )
    .holds(&["task"], &["entity.held_counts"])
    .exports(Export::Within("task")),
];
