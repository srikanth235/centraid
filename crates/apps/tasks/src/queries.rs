//! THE TWO QUERIES: `board` and `search`, read one table at a time over the
//! model's own tables (#1135).
//!
//! A task is an `entity` of kind `task` with a `task` row; what a screen shows
//! about it is another table joined by a column or an edge. The paged door's
//! one shape is a keyset page of one table, so a read here is a window of rows
//! and then, per table, the rows that window's ids name, `IN`-bounded by the
//! window and never a whole-table pull.
//!
//! | A screen's word | Read from |
//! |---|---|
//! | the task, its due, its rule, its status | `task` |
//! | its title, when it was made, the trash | `entity` |
//! | its project, its section | `container` rows, named by `entity` |
//! | its tags | `tagged` edges to `tag` concepts |
//! | what it is about | `about` edges, the far end named by its kind |
//! | what is attached | `attached` edges ([`centraid_apps_kit::attached`]) |
//!
//! ## The two reads that are the SCREEN
//!
//! | Read | What it is |
//! |---|---|
//! | the open window | the newest tasks **by `created_at`** (the entity's, not an id's order: nothing makes an id time-ordered), walked a page at a time until the window holds as many OPEN tasks as the caller sized it for |
//! | the logbook | the [`crate::board::LOGBOOK_ROWS`] most recently closed, newest-completed first (`done_at`; a cancelled task has none and sorts last) |
//! | the index | `search`'s own read, `crates/search`'s: the hits arrive in RANK ORDER |
//!
//! ## Two reads that keep a FAMILY whole across the window edge
//!
//! A parent the two windows missed is fetched, and every subtask of a fetched
//! top-level task, open so a windowed parent's remaining work is not silently
//! gone and closed so `done_children` counts true. **Without the first,
//! [`crate::board::nest_task_families`] would promote a subtask whose parent
//! fell outside the window and the member would see the same work twice.**

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::page::{MAX_PAGE_ROWS, PageRequest};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, Read, read_pages};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_vault::time::recurrence::{
    CollapseInput, RecurrenceAnchor, collapse_missed, is_all_day_anchor,
};
use centraid_vault::time::rrule;
use centraid_vault::time::zone::FireZone;

pub use centraid_apps_kit::attached::Attachment;

use crate::board::{
    BOARD_DEFAULT, BOARD_MAX, BOARD_MIN, FamilyRow, LOGBOOK_ROWS, by_urgency, is_open_status,
    nest_task_families,
};
use crate::{Denial, denial_of};

/// A join per windowed task: the kit's default, 500 x 8 = 4,000 rows.
pub const TASK_JOIN_BOUND: FanOutBound = FanOutBound::new(500, 8);

/// A read named by a window's ids, which may be a thousand tasks and their family.
pub const WIDE: FanOutBound = FanOutBound::new(500, 64);

/// The most pages of entities the open window walks to find its open tasks: a
/// vault of 32,000 tasks, nearly all of them closed.
pub const OPEN_WALK_PAGES: usize = 64;

/// The index answers at most this many matches.
pub const SEARCH_LIMIT: usize = 100;

/// The one open status, and the two that close a task.
pub const OPEN_STATUSES: [&str; 1] = ["open"];
pub const CLOSED_STATUSES: [&str; 2] = ["done", "cancelled"];

const TASK_COLUMNS: &str = "id, parent_id, project_id, section_id, status, description, priority, \
     due, done_at, effort_min, remind_before_min, rule, zone, anchor, series_id, position";
const ENTITY_COLUMNS: &str = "id, title, created_at, updated_at";
const ARCHIVED: &str = "flag:archived";

fn text(word: &str) -> PageBindValue {
    PageBindValue::Text(word.to_owned())
}

// ---------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------

/// One tag on a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskTag {
    /// The tag's concept id: a tag has no id of its own beside it.
    pub concept_id: String,
    pub label: String,
}

/// One thing a task is about: a person, a note, an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    /// The far end's kind (`person`, `note`, ...).
    pub to_type: String,
    pub to_id: String,
}

/// The recurrence facts a repeating task carries. **Never the rule itself**
/// (#834).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RecurrenceFacts {
    pub recurrence_summary: Option<String>,
    /// Unactioned periods, collapsed into a count. A repeating task never
    /// stacks.
    pub missed: Option<usize>,
    pub next_due: Option<String>,
}

/// One task row, decorated. The wire's words are kept (`due_at`, `rrule`,
/// `completed_at`): `due`, `rule` and `done_at` are the model's.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskRow {
    pub task_id: String,
    pub parent_task_id: Option<String>,
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    /// `open`, `done` or `cancelled`.
    pub status: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i64>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub effort_min: Option<i64>,
    /// The reminder's lead time, in minutes before the due moment.
    pub remind_before_min: Option<i64>,
    pub rrule: Option<String>,
    pub tz: Option<String>,
    pub recurrence_anchor: Option<String>,
    pub series_id: Option<String>,
    pub sort_order: Option<i64>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub attachments: Vec<Attachment>,
    pub references: Vec<Reference>,
    pub tags: Vec<TaskTag>,
    pub recurrence: RecurrenceFacts,
    /// Only on a root: the family below it, in the open board's order.
    pub children: Vec<TaskRow>,
    /// How many of `children` are closed.
    pub done_children: Option<usize>,
    /// `search` only: the index's own excerpt.
    pub snippet: Option<String>,
}

impl FamilyRow for TaskRow {
    fn task_id(&self) -> &str {
        &self.task_id
    }
    fn parent_task_id(&self) -> Option<&str> {
        self.parent_task_id.as_deref()
    }
    fn status(&self) -> &str {
        &self.status
    }
}

/// A project, as the board's chrome draws it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectRow {
    pub project_id: String,
    pub name: Option<String>,
    /// The area it sits in, by name.
    pub area: Option<String>,
    pub color: Option<String>,
    pub sort_order: Option<i64>,
}

/// A section.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SectionRow {
    pub section_id: String,
    pub project_id: Option<String>,
    pub name: Option<String>,
    pub sort_order: Option<i64>,
}

/// A tag chip on the board's rail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagChip {
    pub concept_id: String,
    pub label: String,
}

/// What `board` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BoardData {
    pub open: Vec<TaskRow>,
    pub logbook: Vec<TaskRow>,
    pub projects: Vec<ProjectRow>,
    pub sections: Vec<SectionRow>,
    pub tags: Vec<TagChip>,
    /// **What was FETCHED, not what the table holds.**
    pub open_count: usize,
    pub closed_count: usize,
    /// **THE WALK'S OWN CURSOR**: the window filled and more open work exists.
    pub truncated: bool,
    pub window: usize,
}

/// What `search` answers: the board's row shape, in **vault rank order**.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SearchData {
    pub tasks: Vec<TaskRow>,
}

/// The caller's window, clamped to the manifest's declared range.
///
/// **This is the only bound this app has** (census section A7).
#[must_use]
pub fn board_window(limit: Option<i64>) -> usize {
    let asked = limit
        .filter(|value| *value > 0)
        .unwrap_or(i64::try_from(BOARD_DEFAULT).unwrap_or(500));
    let asked = usize::try_from(asked).unwrap_or(BOARD_DEFAULT);
    asked.clamp(BOARD_MIN, BOARD_MAX)
}

// ---------------------------------------------------------------------------
// The reads.
// ---------------------------------------------------------------------------

/// The id-keyed read of one table: `column IN (the ids)`.
fn by_ids(
    name: &'static str,
    table: &'static str,
    select: &'static str,
    column: &'static str,
) -> Read {
    Read {
        name,
        table,
        select,
        order: (column, column),
        column,
    }
}

fn ids_of(rows: &[Row], column: &str) -> Vec<String> {
    rows.iter()
        .filter_map(|row| text_of(row, column))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect()
}

fn by_text<'a>(rows: &'a [Row], column: &str) -> BTreeMap<String, &'a Row> {
    rows.iter()
        .filter_map(|row| text_of(row, column).map(|id| (id, row)))
        .collect()
}

fn int(row: &Row, column: &str) -> Option<i64> {
    row.get(column).and_then(Cell::integer)
}

/// The tasks the `task` rows are, with the entity's words joined on and the
/// trashed left out, in the entities' order.
fn tasks_of(entities: &[Row], tasks: &[Row]) -> Vec<TaskRow> {
    let held = by_text(tasks, "id");
    entities
        .iter()
        .filter_map(|entity| {
            let id = text_of(entity, "id")?;
            Some(task_of(entity, held.get(&id)?))
        })
        .collect()
}

fn task_of(entity: &Row, row: &Row) -> TaskRow {
    TaskRow {
        task_id: text_of(row, "id").unwrap_or_default(),
        parent_task_id: text_of(row, "parent_id"),
        project_id: text_of(row, "project_id"),
        section_id: text_of(row, "section_id"),
        status: text_of(row, "status").unwrap_or_default(),
        title: text_of(entity, "title").unwrap_or_default(),
        description: text_of(row, "description"),
        priority: int(row, "priority"),
        due_at: text_of(row, "due"),
        completed_at: text_of(row, "done_at"),
        effort_min: int(row, "effort_min"),
        remind_before_min: int(row, "remind_before_min"),
        rrule: text_of(row, "rule"),
        tz: text_of(row, "zone"),
        recurrence_anchor: text_of(row, "anchor"),
        series_id: text_of(row, "series_id"),
        // A place in a list is a REAL; the shell counts in whole places.
        sort_order: match row.get("position") {
            Some(Cell::Real(at)) => Some(at.round() as i64),
            other => other.and_then(Cell::integer),
        },
        created_at: text_of(entity, "created_at"),
        updated_at: text_of(entity, "updated_at"),
        ..TaskRow::default()
    }
}

/// The `task` rows whose `column` is among `ids`: the ids are named in the read,
/// so it costs the ids and not the table.
fn task_rows(
    door: &dyn PageDoor,
    name: &'static str,
    column: &'static str,
    ids: &[String],
    extra: Option<(&str, Vec<PageBindValue>)>,
) -> KitResult<Vec<Row>> {
    by_ids(name, "task", TASK_COLUMNS, column).within(WIDE, door, ids, extra)
}

/// The live entities among `ids`, of kind task.
fn live_entities(door: &dyn PageDoor, name: &'static str, ids: &[String]) -> KitResult<Vec<Row>> {
    by_ids(name, "entity", ENTITY_COLUMNS, "id").within(
        WIDE,
        door,
        ids,
        Some(("kind = ? AND deleted_at IS NULL", vec![text("task")])),
    )
}

/// Tasks whose `column` is among `ids`, live only, whole.
fn live_tasks(
    door: &dyn PageDoor,
    name: &'static str,
    column: &'static str,
    ids: &[String],
) -> KitResult<Vec<TaskRow>> {
    let rows = task_rows(door, name, column, ids, None)?;
    let entities = live_entities(door, "tasks.entities", &ids_of(&rows, "id"))?;
    Ok(tasks_of(&entities, &rows))
}

/// THE OPEN WINDOW: the newest tasks by creation, a page of entities at a time,
/// until `window` of them are open. Returns the rows and whether more open work
/// may exist beyond them (the walk's own cursor, never a guess from a count).
fn open_window(door: &dyn PageDoor, window: usize) -> KitResult<(Vec<TaskRow>, bool)> {
    let query = PageQuery::new(
        "tasks.board.entities",
        ENTITY_COLUMNS,
        "entity",
        PageOrder::desc("created_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NULL", vec![text("task")]);
    let mut open: Vec<TaskRow> = Vec::new();
    let mut after = None;
    for _ in 0..OPEN_WALK_PAGES {
        let page = door.page(
            &query,
            &PageRequest {
                limit: MAX_PAGE_ROWS,
                after: after.take(),
            },
        )?;
        let rows = task_rows(
            door,
            "tasks.board.open",
            "id",
            &ids_of(&page.rows, "id"),
            Some(("status = ?", vec![text("open")])),
        )?;
        for task in tasks_of(&page.rows, &rows) {
            if open.len() == window {
                return Ok((open, true));
            }
            open.push(task);
        }
        match page.next {
            None => return Ok((open, false)),
            Some(_) if open.len() == window => return Ok((open, true)),
            Some(next) => after = Some(next),
        }
    }
    Err(KitError::FanOutExceeded {
        query: "tasks.board.open".to_owned(),
        cap: OPEN_WALK_PAGES * MAX_PAGE_ROWS,
    })
}

/// `tasks.board.logbook`: the most recently closed, live.
///
/// **`done_at` IS NULLABLE**: a cancelled task has none, so the read is ONE page
/// and is never continued, and a cancelled task sorts after every done one.
fn logbook(door: &dyn PageDoor) -> KitResult<Vec<TaskRow>> {
    let closed = door.page(
        &PageQuery::new(
            "tasks.board.logbook",
            TASK_COLUMNS,
            "task",
            PageOrder::desc("done_at", "id"),
        )
        .filter("status IN (?, ?)", CLOSED_STATUSES.map(text).to_vec()),
        &PageRequest::first(LOGBOOK_ROWS),
    )?;
    let entities = live_entities(
        door,
        "tasks.board.logbook.entities",
        &ids_of(&closed.rows, "id"),
    )?;
    let by_id = by_text(&entities, "id");
    Ok(closed
        .rows
        .iter()
        .filter_map(|row| Some(task_of(by_id.get(&text_of(row, "id")?)?, row)))
        .collect())
}

/// THE RECURRENCE FACTS, from the ONE engine.
///
/// **The zone is the task's own `tz`** — `crates/vault::time::zone::FireZone`
/// resolves it, and a task with none falls back to the engine's neutral zone
/// exactly as v0's `timeZone ?? "Etc/UTC"` does.
///
/// **A task whose due is a bare date has no zone of its own** (#1090): it is
/// a whole civil day, so its periods are dates and `zone` — the MEMBER'S, the
/// calendar `now` is read on — says which day is today. Expanded in the task's
/// `tz` (or UTC) every period was "missed" at that zone's midnight, and the
/// next one read as the evening before anywhere west of it: a daily task left
/// Today at 20:00 in New York.
///
/// **v0 read `task.recurrence_tz` here and the column is `tz`** (`board.ts:483`
/// and `search.ts:139`): the property was always `undefined`, so the collapse
/// and the next due date were computed in UTC for every member outside it —
/// drift ONT-25's exact shape in a second place. Both readers were fixed at
/// source under R-1020-35 by lane Schedule; the WRITER half — `anchorWrite`
/// sending a key `schedule.organize_task` refuses outright, so an anchor change
/// silently did nothing — went with the close pass.
fn recurrence_of(task: &TaskRow, now: &str, member: &FireZone) -> RecurrenceFacts {
    let (Some(rule), Some(start)) = (task.rrule.as_deref(), task.due_at.as_deref()) else {
        return RecurrenceFacts::default();
    };
    let own;
    let zone = if is_all_day_anchor(start) {
        Some(member)
    } else {
        own = FireZone::named(task.tz.as_deref().unwrap_or("Etc/UTC")).ok();
        own.as_ref()
    };
    let collapsed = collapse_missed(&CollapseInput {
        rrule: rule,
        scheduled_start: start,
        zone,
        anchor: RecurrenceAnchor::from_stored(task.recurrence_anchor.as_deref()),
        now,
        last_completed_at: task.completed_at.as_deref(),
    });
    RecurrenceFacts {
        // THE ONE SUMMARISER (#834): the row carries the sentence, never the
        // rule.
        recurrence_summary: rrule::describe(rule),
        missed: Some(collapsed.missed),
        next_due: collapsed.next_due,
    }
}

/// Everything a row carries that does not depend on its family.
struct Decorations {
    attachments: BTreeMap<String, Vec<Attachment>>,
    references: BTreeMap<String, Vec<Reference>>,
    tags: BTreeMap<String, Vec<TaskTag>>,
    chips: Vec<TagChip>,
}

fn decorate(task: &TaskRow, decorations: &Decorations, now: &str, zone: &FireZone) -> TaskRow {
    TaskRow {
        attachments: decorations
            .attachments
            .get(&task.task_id)
            .cloned()
            .unwrap_or_default(),
        references: decorations
            .references
            .get(&task.task_id)
            .cloned()
            .unwrap_or_default(),
        tags: decorations
            .tags
            .get(&task.task_id)
            .cloned()
            .unwrap_or_default(),
        recurrence: recurrence_of(task, now, zone),
        ..task.clone()
    }
}

fn sort_key(task: &TaskRow) -> (Option<&str>, i64, &str, &str) {
    (
        task.due_at.as_deref(),
        task.priority.unwrap_or(0),
        task.title.as_str(),
        task.task_id.as_str(),
    )
}

/// What hangs off a set of tasks: their attachments, what each is about and the
/// tags each carries (a `search` row carries the attachments alone).
fn read_decorations(
    door: &dyn PageDoor,
    task_ids: &[String],
    whole: bool,
) -> KitResult<Decorations> {
    let attachments = centraid_apps_kit::attached::of(door, task_ids)?;
    let mut decorations = Decorations {
        attachments,
        references: BTreeMap::new(),
        tags: BTreeMap::new(),
        chips: Vec::new(),
    };
    if !whole || task_ids.is_empty() {
        return Ok(decorations);
    }
    let edges = by_ids(
        "tasks.board.edges",
        "edge",
        "from_id, rel, to_id",
        "from_id",
    )
    .within(
        WIDE,
        door,
        task_ids,
        Some(("rel IN (?, ?)", vec![text("about"), text("tagged")])),
    )?;
    let far: BTreeMap<String, Row> = by_ids(
        "tasks.board.far",
        "entity",
        "id, kind, title, deleted_at",
        "id",
    )
    .within(WIDE, door, &ids_of(&edges, "to_id"), None)?
    .into_iter()
    .filter_map(|row| text_of(&row, "id").map(|id| (id, row)))
    .collect();
    let mut chips: BTreeMap<String, String> = BTreeMap::new();
    for edge in &edges {
        let (Some(task), Some(to), Some(rel)) = (
            text_of(edge, "from_id"),
            text_of(edge, "to_id"),
            text_of(edge, "rel"),
        ) else {
            continue;
        };
        let Some(end) = far.get(&to) else { continue };
        let kind = text_of(end, "kind").unwrap_or_default();
        if rel == "tagged" {
            // A flag (starred, pinned, archived) is not a tag a member typed.
            if kind == "tag" {
                let label = text_of(end, "title").unwrap_or_else(|| "?".to_owned());
                chips.insert(to.clone(), label.clone());
                decorations.tags.entry(task).or_default().push(TaskTag {
                    concept_id: to,
                    label,
                });
            }
        } else if end
            .get("deleted_at")
            .is_none_or(|cell| matches!(cell, Cell::Null))
        {
            decorations
                .references
                .entry(task)
                .or_default()
                .push(Reference {
                    to_type: kind,
                    to_id: to,
                });
        }
    }
    let mut chips: Vec<TagChip> = chips
        .into_iter()
        .map(|(concept_id, label)| TagChip { concept_id, label })
        .collect();
    chips.sort_by(|left, right| left.label.cmp(&right.label));
    decorations.chips = chips;
    Ok(decorations)
}

/// The board's chrome: the live, unarchived projects and every section, in their
/// own order. The detail screen and the projects list read it without a board.
///
/// # Errors
///
/// A door refusal or a reached bound, as the caller's read would.
pub fn load_chrome(door: &dyn PageDoor) -> KitResult<(Vec<ProjectRow>, Vec<SectionRow>)> {
    let named = |name: &'static str, kind: &str| -> KitResult<Vec<Row>> {
        read_pages(
            door,
            &PageQuery::new(name, "id, title", "entity", PageOrder::asc("title", "id"))
                .filter("kind = ? AND deleted_at IS NULL", vec![text(kind)]),
            WIDE,
        )
    };
    let projects = named("tasks.board.projects", "project")?;
    let sections = named("tasks.board.sections", "section")?;
    let ids: Vec<String> = ids_of(&projects, "id")
        .into_iter()
        .chain(ids_of(&sections, "id"))
        .collect();
    let placed: BTreeMap<String, Row> = by_ids(
        "tasks.board.containers",
        "container",
        "id, parent_id, color, position",
        "id",
    )
    .within(WIDE, door, &ids, None)?
    .into_iter()
    .filter_map(|row| text_of(&row, "id").map(|id| (id, row)))
    .collect();
    let archived: BTreeSet<String> =
        by_ids("tasks.board.archived", "edge", "from_id, to_id", "from_id")
            .within(
                WIDE,
                door,
                &ids_of(&projects, "id"),
                Some((
                    "rel = ? AND to_id = ?",
                    vec![text("tagged"), text(ARCHIVED)],
                )),
            )?
            .iter()
            .filter_map(|row| text_of(row, "from_id"))
            .collect();
    let areas: BTreeMap<String, String> = by_ids("tasks.board.areas", "entity", "id, title", "id")
        .within(
            WIDE,
            door,
            &ids_of(&placed.values().cloned().collect::<Vec<_>>(), "parent_id"),
            Some(("kind = ?", vec![text("area")])),
        )?
        .iter()
        .filter_map(|row| Some((text_of(row, "id")?, text_of(row, "title")?)))
        .collect();
    let position = |id: &str| match placed.get(id).and_then(|row| row.get("position")) {
        Some(Cell::Real(at)) => *at,
        _ => 0.0,
    };
    let order = |left: &(f64, String), right: &(f64, String)| {
        left.0
            .total_cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
    };
    let mut projects: Vec<(f64, ProjectRow)> = projects
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            if archived.contains(&id) {
                return None;
            }
            let held = placed.get(&id);
            Some((
                position(&id),
                ProjectRow {
                    name: text_of(row, "title"),
                    area: held
                        .and_then(|held| text_of(held, "parent_id"))
                        .and_then(|area| areas.get(&area).cloned()),
                    color: held.and_then(|held| text_of(held, "color")),
                    sort_order: Some(position(&id).round() as i64),
                    project_id: id,
                },
            ))
        })
        .collect();
    projects.sort_by(|left, right| {
        order(
            &(left.0, left.1.project_id.clone()),
            &(right.0, right.1.project_id.clone()),
        )
    });
    let mut sections: Vec<(f64, SectionRow)> = sections
        .iter()
        .filter_map(|row| {
            let id = text_of(row, "id")?;
            Some((
                position(&id),
                SectionRow {
                    name: text_of(row, "title"),
                    project_id: placed.get(&id).and_then(|held| text_of(held, "parent_id")),
                    sort_order: Some(position(&id).round() as i64),
                    section_id: id,
                },
            ))
        })
        .collect();
    sections.sort_by(|left, right| {
        order(
            &(left.0, left.1.section_id.clone()),
            &(right.0, right.1.section_id.clone()),
        )
    });
    Ok((
        projects.into_iter().map(|(_, project)| project).collect(),
        sections.into_iter().map(|(_, section)| section).collect(),
    ))
}

/// A family under a root, in the open board's order, with how many are closed.
fn family(
    task: &TaskRow,
    children: &[&TaskRow],
    decorations: &Decorations,
    now: &str,
    zone: &FireZone,
) -> TaskRow {
    let mut nested: Vec<TaskRow> = children
        .iter()
        .map(|child| decorate(child, decorations, now, zone))
        .collect();
    nested.sort_by(|left, right| by_urgency(sort_key(left), sort_key(right)));
    let done = nested
        .iter()
        .filter(|child| !is_open_status(&child.status))
        .count();
    TaskRow {
        children: nested,
        done_children: Some(done),
        ..decorate(task, decorations, now, zone)
    }
}

/// `board`: the whole app.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`,
/// because a short board that reads as a whole one is the truncation flag again
/// (D-1020-D3-12).
pub fn load_board(
    door: &dyn PageDoor,
    limit: Option<i64>,
    now: &str,
    zone: &FireZone,
) -> KitResult<(BoardData, Option<Denial>)> {
    let window = board_window(limit);
    let (open_rows, truncated) = match open_window(door, window) {
        Ok(found) => found,
        Err(KitError::Door(message)) => {
            return Ok((
                BoardData {
                    window,
                    ..BoardData::default()
                },
                Some(denial_of(message)),
            ));
        }
        Err(other) => return Err(other),
    };
    let closed_rows = logbook(door)?;
    let (projects, sections) = load_chrome(door)?;

    let mut by_id: BTreeMap<String, TaskRow> = BTreeMap::new();
    for task in open_rows.into_iter().chain(closed_rows) {
        by_id.insert(task.task_id.clone(), task);
    }
    // FAMILIES STAY WHOLE ACROSS THE WINDOW EDGE: fetch any referenced parent
    // the windows missed...
    let missing_parents: Vec<String> = by_id
        .values()
        .filter_map(|task| task.parent_task_id.clone())
        .filter(|id| !by_id.contains_key(id))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    for task in live_tasks(door, "tasks.board.parents", "id", &missing_parents)? {
        by_id.insert(task.task_id.clone(), task);
    }
    // ...then the reverse edge: every subtask of a fetched top-level task, open
    // so a windowed parent's to-do work is not silently gone, closed so
    // `done_children` counts true.
    let top_level: Vec<String> = by_id
        .values()
        .filter(|task| task.parent_task_id.is_none())
        .map(|task| task.task_id.clone())
        .collect();
    for task in live_tasks(door, "tasks.board.children", "parent_id", &top_level)? {
        by_id.insert(task.task_id.clone(), task);
    }
    let rows: Vec<TaskRow> = by_id.into_values().collect();
    let task_ids: Vec<String> = rows.iter().map(|task| task.task_id.clone()).collect();
    let decorations = read_decorations(door, &task_ids, true)?;

    let families = nest_task_families(&rows, |task, children| {
        family(
            task,
            &children.iter().collect::<Vec<_>>(),
            &decorations,
            now,
            zone,
        )
    });
    let mut open = families.open;
    open.sort_by(|left, right| by_urgency(sort_key(left), sort_key(right)));
    let mut logbook = families.logbook;
    // Newest-completed first, and a cancelled task's absent stamp sorts last.
    logbook.sort_by(|left, right| {
        right
            .completed_at
            .as_deref()
            .unwrap_or_default()
            .cmp(left.completed_at.as_deref().unwrap_or_default())
            .then_with(|| left.task_id.cmp(&right.task_id))
    });
    logbook.truncate(LOGBOOK_ROWS);

    let open_count = rows
        .iter()
        .filter(|task| is_open_status(&task.status))
        .count();
    Ok((
        BoardData {
            open,
            logbook,
            projects,
            sections,
            tags: decorations.chips,
            open_count,
            closed_count: rows.len() - open_count,
            truncated,
            window,
        },
        None,
    ))
}

/// `search`: the board's row shape, in the order the index ranked them.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_search(
    door: &dyn PageDoor,
    hits: &[(String, String)],
    now: &str,
    zone: &FireZone,
) -> KitResult<(SearchData, Option<Denial>)> {
    let ids: Vec<String> = hits.iter().map(|(id, _)| id.clone()).collect();
    if ids.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let read = || -> KitResult<(BTreeMap<String, TaskRow>, Decorations)> {
        let found: BTreeMap<String, TaskRow> = live_tasks(door, "tasks.search.tasks", "id", &ids)?
            .into_iter()
            .map(|task| (task.task_id.clone(), task))
            .collect();
        let decorations = read_decorations(door, &ids, false)?;
        Ok((found, decorations))
    };
    let (mut found, decorations) = match read() {
        Ok(read) => read,
        Err(KitError::Door(message)) => {
            return Ok((SearchData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let tasks = hits
        .iter()
        .filter_map(|(id, snippet)| {
            let task = found.remove(id)?;
            let mut decorated = decorate(&task, &decorations, now, zone);
            decorated.snippet = Some(snippet.clone());
            Some(decorated)
        })
        .collect();
    Ok((SearchData { tasks }, None))
}

// ---------------------------------------------------------------------------
// One task, and search from a term (#1046, the phone's Tasks arm).
// ---------------------------------------------------------------------------

/// What `task` answers: the task with its whole family below it, and its parent
/// when it has one. `task` is `None` when no LIVE task has the id: never found,
/// purged, or in the trash.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskDetailData {
    pub task: Option<TaskRow>,
    pub parent: Option<TaskRow>,
}

/// What one task's read gathers: the task, its family, its parent and what hangs
/// off each.
struct Whole {
    task: TaskRow,
    children: Vec<TaskRow>,
    parent: Option<TaskRow>,
    decorations: Decorations,
}

/// `task`: one task, decorated as the board decorates it, with EVERY child (open
/// and closed) nested in the open board's order and `done_children` counted over
/// them.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_task(
    door: &dyn PageDoor,
    task_id: &str,
    now: &str,
    zone: &FireZone,
) -> KitResult<(TaskDetailData, Option<Denial>)> {
    let task_id = task_id.trim();
    if task_id.is_empty() {
        return Ok((TaskDetailData::default(), None));
    }
    let ids = [task_id.to_owned()];
    let read = || -> KitResult<Option<Whole>> {
        let Some(task) = live_tasks(door, "tasks.task.by-id", "id", &ids)?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        let children = live_tasks(door, "tasks.board.children", "parent_id", &ids)?;
        let parent = match task.parent_task_id.clone() {
            Some(parent_id) => live_tasks(door, "tasks.task.parent", "id", &[parent_id])?
                .into_iter()
                .next(),
            None => None,
        };
        let mut family_ids: Vec<String> = vec![task.task_id.clone()];
        family_ids.extend(parent.iter().map(|parent| parent.task_id.clone()));
        family_ids.extend(children.iter().map(|child| child.task_id.clone()));
        let decorations = read_decorations(door, &family_ids, true)?;
        Ok(Some(Whole {
            task,
            children,
            parent,
            decorations,
        }))
    };
    let found = match read() {
        Ok(found) => found,
        Err(KitError::Door(message)) => {
            return Ok((TaskDetailData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let Some(Whole {
        task,
        children,
        parent,
        decorations,
    }) = found
    else {
        return Ok((TaskDetailData::default(), None));
    };
    let task = family(
        &task,
        &children.iter().collect::<Vec<_>>(),
        &decorations,
        now,
        zone,
    );
    Ok((
        TaskDetailData {
            task: Some(task),
            parent: parent.map(|parent| decorate(&parent, &decorations, now, zone)),
        },
        None,
    ))
}

/// The index's kind for a task.
pub const TASK_KIND: &str = "task";

/// `search` from a TERM: the index's ranked hits, read back as task rows and
/// folded by [`load_search`].
///
/// A term with no searchable word, or a zero `limit`, answers the empty shape and
/// no denial. `limit` is clamped to [`SEARCH_LIMIT`].
///
/// # Errors
///
/// A reached bound, as [`load_search`].
pub fn load_search_term(
    door: &dyn PageDoor,
    search: &dyn centraid_search::Search,
    principal: &centraid_search::Principal,
    term: &str,
    limit: usize,
    now: &str,
    zone: &FireZone,
) -> KitResult<(SearchData, Option<Denial>)> {
    let term = term.trim();
    if term.is_empty() || limit == 0 {
        return Ok((SearchData::default(), None));
    }
    let request = centraid_search::SearchRequest::new(TASK_KIND, term, limit.min(SEARCH_LIMIT));
    let page = match search.query(principal, &request) {
        Ok(centraid_search::Answer::Data { page, .. }) => page,
        Ok(centraid_search::Answer::Denied(denial)) => {
            return Ok((
                SearchData::default(),
                Some(Denial {
                    code: denial.code,
                    message: denial.message,
                    revoked_at: denial.revoked_at,
                }),
            ));
        }
        Err(centraid_search::SearchError::NoSearchableWords { .. }) => {
            return Ok((SearchData::default(), None));
        }
        Err(other) => return Ok((SearchData::default(), Some(denial_of(other.to_string())))),
    };
    // VAULT ORDER IS RANK ORDER, best match first.
    let hits: Vec<(String, String)> = page
        .rows
        .iter()
        .map(|target| (target.id.clone(), target.snippet.clone()))
        .collect();
    load_search(door, &hits, now, zone)
}

// ---------------------------------------------------------------------------
// The trash shelf.
// ---------------------------------------------------------------------------

/// The trash shelf's own size.
pub const TRASH_ROWS: usize = 500;

/// One trashed task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrashRow {
    pub task_id: String,
    pub title: String,
    pub deleted_at: Option<String>,
    pub purge_at: Option<String>,
}

/// What `trash` answers.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TrashData {
    pub tasks: Vec<TrashRow>,
    /// The shelf is longer than its window.
    pub truncated: bool,
}

/// `trash`: the trashed tasks, most recently trashed first. The trash is the
/// entity's, so the shelf is read from `entity` and needs no other table.
///
/// # Errors
///
/// A reached bound is an `Err`; a door refusal is the payload's denial.
pub fn load_trash(door: &dyn PageDoor) -> KitResult<(TrashData, Option<Denial>)> {
    let query = PageQuery::new(
        "tasks.trash",
        "id, title, deleted_at, purge_at",
        "entity",
        PageOrder::desc("deleted_at", "id"),
    )
    .filter("kind = ? AND deleted_at IS NOT NULL", vec![text("task")]);
    let shelf = match centraid_apps_kit::reads::read_window(door, &query, TRASH_ROWS) {
        Ok(shelf) => shelf,
        Err(KitError::Door(message)) => {
            return Ok((TrashData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    Ok((
        TrashData {
            tasks: shelf
                .rows
                .iter()
                .filter_map(|row| {
                    Some(TrashRow {
                        task_id: text_of(row, "id")?,
                        title: text_of(row, "title").unwrap_or_default(),
                        deleted_at: text_of(row, "deleted_at"),
                        purge_at: text_of(row, "purge_at"),
                    })
                })
                .collect(),
            truncated: shelf.filled,
        },
        None,
    ))
}
