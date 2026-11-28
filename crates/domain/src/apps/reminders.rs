//! Reminders: tasks, and the lists that hold them.

use rusqlite::Row;

use crate::kind::{Export, Footer, KindDecl, Share, Trash, exported, plain};
use crate::read::{DEFAULT_PAGE, ParamTy, Read, ReadDecl, Shape, asc, desc, param, read};

use super::calendar::{AlertRow, SnoozeRow};
use super::{Item, Trashed, trash};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskSummary {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub priority: i64,
    pub due: Option<String>,
    pub due_timing: Option<String>,
    pub zone: Option<String>,
    pub scheduled_on: Option<String>,
    pub done_at: Option<String>,
    pub rule: Option<String>,
    pub series_id: Option<String>,
    pub starred_at: Option<String>,
    pub at: String,
}

impl TaskSummary {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            status: row.get("status")?,
            priority: row.get("priority")?,
            due: row.get("due")?,
            due_timing: row.get("due_timing")?,
            zone: row.get("zone")?,
            scheduled_on: row.get("scheduled_on")?,
            done_at: row.get("done_at")?,
            rule: row.get("rule")?,
            series_id: row.get("series_id")?,
            starred_at: row.get("starred_at")?,
            at: row.get("at")?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskDetail {
    pub id: String,
    pub title: String,
    pub parent_id: Option<String>,
    pub status: String,
    pub priority: i64,
    pub due: Option<String>,
    pub due_timing: Option<String>,
    pub zone: Option<String>,
    pub scheduled_on: Option<String>,
    pub done_at: Option<String>,
    pub rule: Option<String>,
    pub anchor: String,
    pub series_id: Option<String>,
    pub url: Option<String>,
    pub description: Option<String>,
    pub starred_at: Option<String>,
    pub arrived_via: Option<String>,
    pub arrived_label: Option<String>,
    pub created_at: String,
}

impl TaskDetail {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            parent_id: row.get("parent_id")?,
            status: row.get("status")?,
            priority: row.get("priority")?,
            due: row.get("due")?,
            due_timing: row.get("due_timing")?,
            zone: row.get("zone")?,
            scheduled_on: row.get("scheduled_on")?,
            done_at: row.get("done_at")?,
            rule: row.get("rule")?,
            anchor: row.get("anchor")?,
            series_id: row.get("series_id")?,
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
pub struct TaskListRow {
    pub id: String,
    pub title: String,
    pub color: Option<String>,
    pub icon: Option<String>,
}

pub const INBOX: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.inbox",
        shape: Shape::PagedList,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, \
                coalesce(t.due, t.scheduled_on, '') AS at \
              FROM entity e INDEXED BY entity_by_title \
                CROSS JOIN task t ON t.id = e.id \
              WHERE e.kind = 'task' AND t.status = 'open' \
                AND e.deleted_at IS NULL AND e.parent_id IS NULL \
                AND (e.title, e.id) > (:a, :b) \
              ORDER BY e.title ASC, e.id ASC LIMIT :n",
        params: &[],
        reads: &["task", "entity"],
        across: &[],
        bound: DEFAULT_PAGE,
        cursor: &[asc("title", "a"), asc("id", "b")],
    },
    TaskSummary::of,
);

pub const INBOX_COUNT: Read<i64> = read(
    ReadDecl {
        name: "reminders.inbox_count",
        shape: Shape::Aggregate,
        sql: "SELECT count(*) AS count FROM task t INDEXED BY task_by_due CROSS JOIN entity e ON e.id = t.id \
              WHERE t.status = 'open' AND e.deleted_at IS NULL AND e.parent_id IS NULL",
        params: &[],
        reads: &["task"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    |row| row.get("count"),
);

impl TaskListRow {
    fn of(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get("id")?,
            title: row.get("title")?,
            color: row.get("color")?,
            icon: row.get("icon")?,
        })
    }
}

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

pub const OPEN_BY_DUE: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.open_by_due",
        shape: Shape::PagedList,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, t.due AS at \
              FROM task t INDEXED BY task_by_due CROSS JOIN entity e ON e.id = t.id \
              WHERE t.status = 'open' AND t.due IS NOT NULL AND e.deleted_at IS NULL \
                AND (t.due, t.id) > (:a, :b) \
              ORDER BY t.due ASC, t.id ASC LIMIT :n",
        params: &[],
        reads: &["task"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("at", "a"), asc("id", "b")],
    },
    TaskSummary::of,
);

pub const OPEN_UNDATED: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.open_undated",
        shape: Shape::PagedList,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, '' AS at \
              FROM task t INDEXED BY task_by_due CROSS JOIN entity e ON e.id = t.id \
              WHERE t.status = 'open' AND t.due IS NULL AND e.deleted_at IS NULL \
                AND t.id > :a \
              ORDER BY t.id ASC LIMIT :n",
        params: &[],
        reads: &["task"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[asc("id", "a")],
    },
    TaskSummary::of,
);

pub const COMPLETED: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.completed",
        shape: Shape::PagedList,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, t.done_at AS at \
              FROM task t INDEXED BY task_by_done CROSS JOIN entity e ON e.id = t.id \
              WHERE t.status = 'done' AND t.done_at IS NOT NULL AND e.deleted_at IS NULL \
                AND (t.done_at, t.id) < (:a, :b) \
              ORDER BY t.done_at DESC, t.id DESC LIMIT :n",
        params: &[],
        reads: &["task"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    TaskSummary::of,
);

pub const STARRED: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.starred",
        shape: Shape::PagedList,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, e.starred_at AS at \
              FROM entity e INDEXED BY entity_starred JOIN task t ON t.id = e.id \
              WHERE e.kind = 'task' AND e.starred_at IS NOT NULL AND e.deleted_at IS NULL \
                AND (e.starred_at, e.id) < (:a, :b) \
              ORDER BY e.starred_at DESC, e.id DESC LIMIT :n",
        params: &[],
        reads: &["task"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    TaskSummary::of,
);

pub const IN_LIST: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.in_list",
        shape: Shape::PagedList,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, e.updated_at AS at \
              FROM entity e INDEXED BY entity_by_home JOIN task t ON t.id = e.id \
              WHERE e.parent_id = :list_id AND e.kind = 'task' AND e.deleted_at IS NULL \
                AND (e.updated_at, e.id) < (:a, :b) \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT :n",
        params: &[param("list_id", ParamTy::Id)],
        reads: &["task"],
        across: &["entity"],
        bound: DEFAULT_PAGE,
        cursor: &[desc("at", "a"), desc("id", "b")],
    },
    TaskSummary::of,
);

pub const SUBTASKS: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.subtasks",
        shape: Shape::BoundedChild,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, e.updated_at AS at \
              FROM entity e INDEXED BY entity_by_home JOIN task t ON t.id = e.id \
              WHERE e.parent_id = :task_id AND e.kind = 'task' AND e.deleted_at IS NULL \
              ORDER BY e.updated_at DESC, e.id DESC LIMIT 100",
        params: &[param("task_id", ParamTy::Id)],
        reads: &["task"],
        across: &["entity"],
        bound: 100,
        cursor: &[],
    },
    TaskSummary::of,
);

pub const SERIES: Read<TaskSummary> = read(
    ReadDecl {
        name: "reminders.series",
        shape: Shape::BoundedChild,
        sql: "SELECT t.id, e.title, e.parent_id, t.status, t.priority, t.due, t.due_timing, \
                t.zone, t.scheduled_on, t.done_at, t.rule, t.series_id, e.starred_at, ifnull(t.due, '') AS at \
              FROM task t INDEXED BY task_by_series JOIN entity e ON e.id = t.id \
              WHERE t.series_id = :series_id AND e.deleted_at IS NULL \
              ORDER BY t.due ASC, t.id ASC LIMIT 50",
        params: &[param("series_id", ParamTy::Id)],
        reads: &["task"],
        across: &["entity"],
        bound: 50,
        cursor: &[],
    },
    TaskSummary::of,
);

pub const BY_ID: Read<TaskDetail> = read(
    ReadDecl {
        name: "reminders.by_id",
        shape: Shape::ByKey,
        sql: "SELECT task.id AS id, entity.title AS title, entity.parent_id AS parent_id, \
                task.status AS status, task.priority AS priority, task.due AS due, \
                task.due_timing AS due_timing, task.zone AS zone, \
                task.scheduled_on AS scheduled_on, task.done_at AS done_at, \
                task.rule AS rule, task.anchor AS anchor, task.series_id AS series_id, \
                task.url AS url, task.description AS description, \
                entity.starred_at AS starred_at, entity.arrived_via AS arrived_via, \
                entity.arrived_label AS arrived_label, entity.created_at AS created_at \
              FROM task JOIN entity ON entity.id = task.id \
              WHERE task.id = :id AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &["task"],
        across: &["entity"],
        bound: 1,
        cursor: &[],
    },
    TaskDetail::of,
);

pub const LISTS: Read<TaskListRow> = read(
    ReadDecl {
        name: "reminders.lists",
        shape: Shape::BoundedChild,
        sql: "SELECT c.id, e.title, c.color, c.icon \
              FROM container c INDEXED BY container_by_kind JOIN entity e ON e.id = c.id \
              WHERE c.kind = 'task_list' AND e.deleted_at IS NULL \
              ORDER BY c.id ASC LIMIT 100",
        params: &[],
        reads: &[],
        across: &["container", "entity"],
        bound: 100,
        cursor: &[],
    },
    TaskListRow::of,
);

pub const LIST_BY_ID: Read<TaskListRow> = read(
    ReadDecl {
        name: "reminders.list_by_id",
        shape: Shape::ByKey,
        sql: "SELECT entity.id AS id, entity.title AS title, container.color AS color, \
                container.icon AS icon \
              FROM entity CROSS JOIN container INDEXED BY sqlite_autoindex_container_1 \
                ON container.id = entity.id \
              WHERE entity.id = :id AND entity.kind = 'task_list' AND entity.deleted_at IS NULL",
        params: &[param("id", ParamTy::Id)],
        reads: &[],
        across: &["container", "entity"],
        bound: 1,
        cursor: &[],
    },
    TaskListRow::of,
);

pub const REMINDERS: Read<AlertRow> = read(
    ReadDecl {
        name: "reminders.reminders",
        shape: Shape::BoundedChild,
        sql: "SELECT id, offset_min FROM reminder \
              WHERE entity_id = :task_id AND ifnull(date_id, '') = '' AND ifnull(field_id, '') = '' \
              ORDER BY offset_min ASC LIMIT 20",
        params: &[param("task_id", ParamTy::Id)],
        reads: &["reminder"],
        across: &[],
        bound: 20,
        cursor: &[],
    },
    AlertRow::of,
);

pub const SNOOZE: Read<SnoozeRow> = read(
    ReadDecl {
        name: "reminders.snooze",
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

pub const READS: &[ReadDecl] = &[
    TRASH.decl,
    TODAY_DUE.decl,
    TODAY_SCHEDULED.decl,
    OPEN_BY_DUE.decl,
    OPEN_UNDATED.decl,
    INBOX.decl,
    INBOX_COUNT.decl,
    COMPLETED.decl,
    STARRED.decl,
    IN_LIST.decl,
    SUBTASKS.decl,
    SERIES.decl,
    BY_ID.decl,
    LISTS.decl,
    LIST_BY_ID.decl,
    REMINDERS.decl,
    SNOOZE.decl,
];

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
