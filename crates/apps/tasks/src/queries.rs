//! THE TWO QUERIES: `board` and `search`.
//!
//! `queries/board.ts` is the whole app (559 lines). Its doctrine, in its own
//! words: *"Task board as a bounded window, never a whole-table pull (#262):
//! newest open tasks by `created_at` (caller-sized window, default 500) plus
//! the 50 most recently closed — exactly what the logbook shows."*
//!
//! ## The two reads that are the SCREEN, and the joins over what they returned
//!
//! | Read | What it is |
//! |---|---|
//! | `tasks.board.open` | one page of open tasks, **newest by `created_at`** — not by `task_id`, because nothing in the vault enforces that an id is time-ordered and an imported one sorts wherever its text sorts (#996 wave 4) |
//! | `tasks.board.logbook` | one page of [`crate::board::LOGBOOK_ROWS`] closed tasks, newest-completed first |
//! | `ctx.vault.search` | `search`'s own FTS read, `crates/search`'s, and the hits arrive in RANK ORDER |
//!
//! Everything else — the missing parents, the children, the attachments, the
//! bytes, the links, the anchors and the tags — is `IN`-bounded by ids one of
//! those already returned, and walked to the end with a stated bound.
//!
//! ## Two reads that exist to keep a FAMILY whole across the window edge
//!
//! `tasks.board.parents` fetches any parent the two windows missed, and
//! `tasks.board.children` fetches every subtask of a fetched top-level task —
//! open, so a windowed parent's remaining work is not silently gone, and
//! closed, so `done_children` counts true. **Without the first,
//! [`crate::board::nest_task_families`] would promote a subtask whose parent
//! fell outside the window and the member would see the same work twice.**

use std::collections::{BTreeMap, BTreeSet};

use centraid_apps_kit::error::{KitError, KitResult};
use centraid_apps_kit::reads::{FanOutBound, PageDoor, in_list, read_pages, read_window};
use centraid_apps_kit::representations::{RepresentationIndex, read_representations};
use centraid_apps_kit::row::{Cell, Row, text_of};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_vault::time::recurrence::{CollapseInput, RecurrenceAnchor, collapse_missed};
use centraid_vault::time::rrule;
use centraid_vault::time::zone::FireZone;
use serde_json::Value;

use crate::board::{
    BOARD_DEFAULT, BOARD_MAX, BOARD_MIN, FamilyRow, LOGBOOK_ROWS, by_urgency, is_open_status,
    nest_task_families,
};
use crate::{Denial, denial_of};

/// A join per windowed task: the kit's default, 500 × 8 = 4,000 rows.
pub const TASK_JOIN_BOUND: FanOutBound = FanOutBound::new(500, 8);

/// The blob route a `blob:` content URI becomes (#296).
pub const BLOB_ROUTE: &str = "/centraid/_vault/blobs";

/// FTS answers at most this many matches (`search.ts:56`).
pub const SEARCH_LIMIT: usize = 100;

pub const OPEN_STATUSES: [&str; 2] = ["needs-action", "in-process"];
pub const CLOSED_STATUSES: [&str; 2] = ["completed", "cancelled"];

/// One task row, as both task reads project it (`board.ts:37`-`:40`).
pub const TASK_COLUMNS: &str = "task_id, parent_task_id, project_id, section_id, status, title, \
     description, priority, due_at, completed_at, effort_min, rrule, tz, recurrence_anchor, \
     series_id, sort_order, created_at, updated_at";

// ---------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------

/// One attachment on a task, joined to its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Attachment {
    pub attachment_id: String,
    pub content_id: String,
    pub role: Option<String>,
    pub is_primary: Option<i64>,
    pub media_type: String,
    pub content_uri: String,
    pub byte_size: i64,
}

/// One tag on a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskTag {
    pub tag_id: String,
    pub concept_id: String,
    /// The concept's own label, or `?` when the concept row is not there.
    pub label: String,
}

/// One cross-reference (#272, #282): an `@`-mention resolved through a live
/// link and its anchor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub link_id: String,
    pub to_type: String,
    pub to_id: String,
    /// The anchor's selector, when the link carries one and it reads.
    pub selector: Option<Value>,
    /// The resolved card, when the caller's resolver had one.
    ///
    /// **`None` is v0's unresolvable case, not a missing feature**: v0 fills a
    /// ref the resolver did not answer with `{type, id, status: "unknown",
    /// title: null, subtitle: null, thumbnail_content_id: null}`
    /// (`board.ts:446`-`:452`), which is what a surface draws. The entity-card
    /// resolver itself is `crates/vault`'s and is not in this build; the
    /// fallback is therefore the whole of what this port answers, and the
    /// receipt names the hand-off rather than leaving the column silently
    /// empty.
    pub card: Option<Value>,
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

/// One task row, decorated.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaskRow {
    pub task_id: String,
    pub parent_task_id: Option<String>,
    pub project_id: Option<String>,
    pub section_id: Option<String>,
    pub status: String,
    pub title: String,
    pub description: Option<String>,
    pub priority: Option<i64>,
    pub due_at: Option<String>,
    pub completed_at: Option<String>,
    pub effort_min: Option<i64>,
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
    /// **THE PAGE'S OWN CURSOR** — it exists or it does not (#996 R8).
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
/// **This is the only bound this app has** (census §A7): there is no
/// module-level ceiling, and adding one would be a refusal v0 does not have.
#[must_use]
pub fn board_window(limit: Option<i64>) -> usize {
    let asked = limit
        .filter(|value| *value > 0)
        .unwrap_or(i64::try_from(BOARD_DEFAULT).unwrap_or(500));
    let asked = usize::try_from(asked).unwrap_or(BOARD_DEFAULT);
    asked.clamp(BOARD_MIN, BOARD_MAX)
}

// ---------------------------------------------------------------------------
// Statements.
// ---------------------------------------------------------------------------

/// `tasks.board.open` — the open window, as a page.
///
/// **NEWEST BY CREATION, AND THE COLUMN THAT SAYS SO** (#996 wave 4). This
/// window was `task_id DESC`, on the assumption that a task id is a UUIDv7 and
/// therefore already in creation order. Nothing in the vault enforces that, and
/// when it is false the newest task is not on the newest page — silently.
/// `created_at` is `NOT NULL`, so the page is continuable and `truncated` is
/// its cursor.
pub fn open_statement() -> KitResult<PageQuery> {
    let fragment = in_list("status", &OPEN_STATUSES.map(str::to_owned))?;
    Ok(PageQuery::new(
        "tasks.board.open",
        TASK_COLUMNS,
        "schedule_task",
        PageOrder::desc("created_at", "task_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `tasks.board.logbook` — the 50 most recently closed.
///
/// **`completed_at` IS NULLABLE**: cancelling a task clears it
/// (`operations/task_lifecycle`), so a cancelled task carries none. The read is
/// therefore ONE page and is never continued — lane V's nullable-sort refusal
/// (`KitError::NullableSortKey`) is what would stop a continuation, and the
/// logbook does not need one because its size is the screen's.
pub fn logbook_statement() -> KitResult<PageQuery> {
    let fragment = in_list("status", &CLOSED_STATUSES.map(str::to_owned))?;
    Ok(PageQuery::new(
        "tasks.board.logbook",
        TASK_COLUMNS,
        "schedule_task",
        PageOrder::desc("completed_at", "task_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `tasks.board.projects` — the live projects, in their own order.
#[must_use]
pub fn projects_statement() -> PageQuery {
    PageQuery::new(
        "tasks.board.projects",
        "project_id, name, area, color, sort_order",
        "schedule_project",
        PageOrder::asc("sort_order", "project_id"),
    )
    .filter("archived_at IS NULL", Vec::new())
}

/// `tasks.board.sections`.
#[must_use]
pub fn sections_statement() -> PageQuery {
    PageQuery::new(
        "tasks.board.sections",
        "section_id, project_id, name, sort_order",
        "schedule_section",
        PageOrder::asc("sort_order", "section_id"),
    )
}

/// `tasks.board.parents` — the parents the two windows missed.
pub fn parents_statement(task_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("task_id", task_ids)?;
    Ok(PageQuery::new(
        "tasks.board.parents",
        TASK_COLUMNS,
        "schedule_task",
        PageOrder::asc("task_id", "task_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `tasks.board.children` — every subtask of a fetched top-level task.
pub fn children_statement(parent_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("parent_task_id", parent_ids)?;
    Ok(PageQuery::new(
        "tasks.board.children",
        TASK_COLUMNS,
        "schedule_task",
        PageOrder::asc("task_id", "task_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

fn by_target(
    name: &'static str,
    select: &'static str,
    from: &'static str,
    pk: &'static str,
    task_ids: &[String],
) -> KitResult<PageQuery> {
    let fragment = in_list("target_id", task_ids)?;
    let mut bind = vec![PageBindValue::Text("schedule.task".to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(name, select, from, PageOrder::asc(pk, pk))
        .filter(&format!("target_type = ? AND {}", fragment.sql), bind))
}

/// `tasks.<query>.attachments`.
pub fn attachments_statement(name: &'static str, task_ids: &[String]) -> KitResult<PageQuery> {
    by_target(
        name,
        "attachment_id, target_type, target_id, content_id, role, is_primary",
        "core_attachment",
        "attachment_id",
        task_ids,
    )
}

/// `tasks.<query>.contents`.
pub fn contents_statement(name: &'static str, content_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("content_id", content_ids)?;
    Ok(PageQuery::new(
        name,
        "content_id, content_uri, byte_size",
        "core_content_item",
        PageOrder::asc("content_id", "content_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `tasks.board.links` — the live cross-references.
pub fn links_statement(task_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("from_id", task_ids)?;
    let mut bind = vec![PageBindValue::Text("schedule.task".to_owned())];
    bind.extend(fragment.bind);
    Ok(PageQuery::new(
        "tasks.board.links",
        "link_id, from_id, to_type, to_id",
        "core_link",
        PageOrder::asc("link_id", "link_id"),
    )
    .filter(
        &format!("from_type = ? AND valid_to IS NULL AND {}", fragment.sql),
        bind,
    ))
}

/// `tasks.board.link-anchors`.
pub fn link_anchors_statement(link_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("link_id", link_ids)?;
    Ok(PageQuery::new(
        "tasks.board.link-anchors",
        "anchor_id, link_id, selector_json",
        "core_link_anchor",
        PageOrder::asc("anchor_id", "anchor_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

/// `tasks.board.tags`.
pub fn tags_statement(task_ids: &[String]) -> KitResult<PageQuery> {
    by_target(
        "tasks.board.tags",
        "tag_id, target_id, concept_id",
        "core_tag",
        "tag_id",
        task_ids,
    )
}

/// `tasks.board.tag-concepts`.
pub fn tag_concepts_statement(concept_ids: &[String]) -> KitResult<PageQuery> {
    let fragment = in_list("concept_id", concept_ids)?;
    Ok(PageQuery::new(
        "tasks.board.tag-concepts",
        "concept_id, pref_label",
        "core_concept",
        PageOrder::asc("concept_id", "concept_id"),
    )
    .filter(&fragment.sql, fragment.bind))
}

// ---------------------------------------------------------------------------
// The folds.
// ---------------------------------------------------------------------------

fn cell_text(row: &Row, column: &str) -> Option<String> {
    text_of(row, column)
}

fn cell_int(row: &Row, column: &str) -> Option<i64> {
    row.get(column).and_then(Cell::integer)
}

/// Blob-backed bytes serve as same-origin URLs (#296).
fn source_of(content_uri: Option<&str>, content_id: &str) -> String {
    match content_uri {
        Some(uri) if uri.starts_with("blob:") => format!("{BLOB_ROUTE}/{content_id}"),
        Some(uri) => uri.to_owned(),
        None => String::new(),
    }
}

fn attachments_by_task(
    attachment_rows: &[Row],
    content_rows: &[Row],
    representations: &RepresentationIndex,
) -> BTreeMap<String, Vec<Attachment>> {
    let contents: BTreeMap<String, &Row> = content_rows
        .iter()
        .filter_map(|row| cell_text(row, "content_id").map(|id| (id, row)))
        .collect();
    let mut by_task: BTreeMap<String, Vec<Attachment>> = BTreeMap::new();
    for row in attachment_rows {
        let Some(attachment_id) = cell_text(row, "attachment_id") else {
            continue;
        };
        let Some(target_id) = cell_text(row, "target_id") else {
            continue;
        };
        let content_id = cell_text(row, "content_id").unwrap_or_default();
        let content = contents.get(&content_id);
        by_task.entry(target_id).or_default().push(Attachment {
            // The ATTACHMENT's own reading of the bytes (#996 R20(b)).
            media_type: representations
                .owner("core.attachment", &attachment_id)
                .or_else(|| representations.content(&content_id))
                .unwrap_or("application/octet-stream")
                .to_owned(),
            content_uri: source_of(
                content
                    .and_then(|row| cell_text(row, "content_uri"))
                    .as_deref(),
                &content_id,
            ),
            byte_size: content
                .and_then(|row| cell_int(row, "byte_size"))
                .unwrap_or(0),
            attachment_id,
            content_id,
            role: cell_text(row, "role"),
            is_primary: cell_int(row, "is_primary"),
        });
    }
    for list in by_task.values_mut() {
        list.sort_by(|left, right| {
            right
                .is_primary
                .unwrap_or(0)
                .cmp(&left.is_primary.unwrap_or(0))
        });
    }
    by_task
}

fn task_of(row: &Row) -> Option<TaskRow> {
    Some(TaskRow {
        task_id: cell_text(row, "task_id")?,
        parent_task_id: cell_text(row, "parent_task_id"),
        project_id: cell_text(row, "project_id"),
        section_id: cell_text(row, "section_id"),
        status: cell_text(row, "status").unwrap_or_default(),
        title: cell_text(row, "title").unwrap_or_default(),
        description: cell_text(row, "description"),
        priority: cell_int(row, "priority"),
        due_at: cell_text(row, "due_at"),
        completed_at: cell_text(row, "completed_at"),
        effort_min: cell_int(row, "effort_min"),
        rrule: cell_text(row, "rrule"),
        tz: cell_text(row, "tz"),
        recurrence_anchor: cell_text(row, "recurrence_anchor"),
        series_id: cell_text(row, "series_id"),
        sort_order: cell_int(row, "sort_order"),
        created_at: cell_text(row, "created_at"),
        updated_at: cell_text(row, "updated_at"),
        ..TaskRow::default()
    })
}

/// THE RECURRENCE FACTS, from the ONE engine.
///
/// **The zone is the task's own `tz`** — `crates/vault::time::zone::FireZone`
/// resolves it, and a task with none falls back to the engine's neutral zone
/// exactly as v0's `timeZone ?? "Etc/UTC"` does.
///
/// **v0 reads `task.recurrence_tz` here and the column is `tz`** (`board.ts:483`
/// and `search.ts:139`): the property is always `undefined`, so the collapse and
/// the next due date are computed in UTC for every member outside it — drift
/// ONT-25's exact shape in a second place. Fixed at source under R-1020-35 and
/// named in the receipt.
fn recurrence_of(task: &TaskRow, now: &str) -> RecurrenceFacts {
    let (Some(rule), Some(start)) = (task.rrule.as_deref(), task.due_at.as_deref()) else {
        return RecurrenceFacts::default();
    };
    let zone = FireZone::named(task.tz.as_deref().unwrap_or("Etc/UTC")).ok();
    let collapsed = collapse_missed(&CollapseInput {
        rrule: rule,
        scheduled_start: start,
        zone: zone.as_ref(),
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

fn decorate(task: &TaskRow, decorations: &Decorations, now: &str) -> TaskRow {
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
        recurrence: recurrence_of(task, now),
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

fn read_decorations(
    door: &dyn PageDoor,
    prefix: &'static str,
    task_ids: &[String],
) -> KitResult<Decorations> {
    let attachments_name = if prefix == "board" {
        "tasks.board.attachments"
    } else {
        "tasks.search.attachments"
    };
    let contents_name = if prefix == "board" {
        "tasks.board.contents"
    } else {
        "tasks.search.contents"
    };
    let attachment_rows = read_pages(
        door,
        &attachments_statement(attachments_name, task_ids)?,
        TASK_JOIN_BOUND,
    )?;
    let content_ids: Vec<String> = attachment_rows
        .iter()
        .filter_map(|row| cell_text(row, "content_id"))
        .filter(|id| !id.is_empty())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let content_rows = if content_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(
            door,
            &contents_statement(contents_name, &content_ids)?,
            TASK_JOIN_BOUND,
        )?
    };
    let representations = read_representations(door, &content_ids, TASK_JOIN_BOUND)?;
    let attachments = attachments_by_task(&attachment_rows, &content_rows, &representations);
    if prefix != "board" {
        return Ok(Decorations {
            attachments,
            references: BTreeMap::new(),
            tags: BTreeMap::new(),
            chips: Vec::new(),
        });
    }
    // Cross-references (#272, #282): @-mentioned entities resolve via live
    // links plus anchors.
    let link_rows = read_pages(door, &links_statement(task_ids)?, TASK_JOIN_BOUND)?;
    let link_ids: Vec<String> = link_rows
        .iter()
        .filter_map(|row| cell_text(row, "link_id"))
        .collect();
    let anchor_rows = if link_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(door, &link_anchors_statement(&link_ids)?, TASK_JOIN_BOUND)?
    };
    let selectors: BTreeMap<String, Value> = anchor_rows
        .iter()
        .filter_map(|row| {
            let link_id = cell_text(row, "link_id")?;
            // AN UNREADABLE SELECTOR IS JUST AN UNANCHORED REFERENCE, never a
            // dropped one.
            let selector = serde_json::from_str(&cell_text(row, "selector_json")?).ok()?;
            Some((link_id, selector))
        })
        .collect();
    let mut references: BTreeMap<String, Vec<Reference>> = BTreeMap::new();
    for row in &link_rows {
        let (Some(link_id), Some(from_id)) = (cell_text(row, "link_id"), cell_text(row, "from_id"))
        else {
            continue;
        };
        references.entry(from_id).or_default().push(Reference {
            selector: selectors.get(&link_id).cloned(),
            link_id,
            to_type: cell_text(row, "to_type").unwrap_or_default(),
            to_id: cell_text(row, "to_id").unwrap_or_default(),
            card: None,
        });
    }
    let tag_rows = read_pages(door, &tags_statement(task_ids)?, TASK_JOIN_BOUND)?;
    let concept_ids: Vec<String> = tag_rows
        .iter()
        .filter_map(|row| cell_text(row, "concept_id"))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    let concept_rows = if concept_ids.is_empty() {
        Vec::new()
    } else {
        read_pages(
            door,
            &tag_concepts_statement(&concept_ids)?,
            TASK_JOIN_BOUND,
        )?
    };
    let labels: BTreeMap<String, String> = concept_rows
        .iter()
        .filter_map(|row| Some((cell_text(row, "concept_id")?, cell_text(row, "pref_label")?)))
        .collect();
    let mut tags: BTreeMap<String, Vec<TaskTag>> = BTreeMap::new();
    for row in &tag_rows {
        let (Some(tag_id), Some(target_id), Some(concept_id)) = (
            cell_text(row, "tag_id"),
            cell_text(row, "target_id"),
            cell_text(row, "concept_id"),
        ) else {
            continue;
        };
        tags.entry(target_id).or_default().push(TaskTag {
            label: labels
                .get(&concept_id)
                .cloned()
                .unwrap_or_else(|| "?".to_owned()),
            tag_id,
            concept_id,
        });
    }
    let mut chips: Vec<TagChip> = labels
        .into_iter()
        .map(|(concept_id, label)| TagChip { concept_id, label })
        .collect();
    chips.sort_by(|left, right| left.label.cmp(&right.label));
    Ok(Decorations {
        attachments,
        references,
        tags,
        chips,
    })
}

/// `board` — the whole app.
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
) -> KitResult<(BoardData, Option<Denial>)> {
    let window = board_window(limit);
    let open_page = match read_window(door, &open_statement()?, window) {
        Ok(page) => page,
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
    let closed_page = read_window(door, &logbook_statement()?, LOGBOOK_ROWS)?;
    let projects: Vec<ProjectRow> = read_pages(door, &projects_statement(), TASK_JOIN_BOUND)?
        .iter()
        .filter_map(|row| {
            Some(ProjectRow {
                project_id: cell_text(row, "project_id")?,
                name: cell_text(row, "name"),
                area: cell_text(row, "area"),
                color: cell_text(row, "color"),
                sort_order: cell_int(row, "sort_order"),
            })
        })
        .collect();
    let sections: Vec<SectionRow> = read_pages(door, &sections_statement(), TASK_JOIN_BOUND)?
        .iter()
        .filter_map(|row| {
            Some(SectionRow {
                section_id: cell_text(row, "section_id")?,
                project_id: cell_text(row, "project_id"),
                name: cell_text(row, "name"),
                sort_order: cell_int(row, "sort_order"),
            })
        })
        .collect();

    let mut by_id: BTreeMap<String, TaskRow> = BTreeMap::new();
    for row in open_page.rows.iter().chain(closed_page.rows.iter()) {
        if let Some(task) = task_of(row) {
            by_id.insert(task.task_id.clone(), task);
        }
    }
    // FAMILIES STAY WHOLE ACROSS THE WINDOW EDGE: fetch any referenced parent
    // the windows missed.
    let missing_parents: Vec<String> = by_id
        .values()
        .filter_map(|task| task.parent_task_id.clone())
        .filter(|id| !by_id.contains_key(id))
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect();
    if !missing_parents.is_empty() {
        for row in read_pages(door, &parents_statement(&missing_parents)?, TASK_JOIN_BOUND)? {
            if let Some(task) = task_of(&row) {
                by_id.insert(task.task_id.clone(), task);
            }
        }
    }
    // …then the reverse edge: every subtask of a fetched top-level task — open
    // so a windowed parent's to-do work is not silently gone, closed so
    // `done_children` counts true.
    let top_level: Vec<String> = by_id
        .values()
        .filter(|task| task.parent_task_id.is_none())
        .map(|task| task.task_id.clone())
        .collect();
    if !top_level.is_empty() {
        for row in read_pages(door, &children_statement(&top_level)?, TASK_JOIN_BOUND)? {
            if let Some(task) = task_of(&row) {
                by_id.insert(task.task_id.clone(), task);
            }
        }
    }
    let rows: Vec<TaskRow> = by_id.into_values().collect();
    let task_ids: Vec<String> = rows.iter().map(|task| task.task_id.clone()).collect();
    let decorations = if task_ids.is_empty() {
        Decorations {
            attachments: BTreeMap::new(),
            references: BTreeMap::new(),
            tags: BTreeMap::new(),
            chips: Vec::new(),
        }
    } else {
        read_decorations(door, "board", &task_ids)?
    };

    let families = nest_task_families(&rows, |task, children| {
        let mut nested: Vec<TaskRow> = children
            .iter()
            .map(|child| decorate(child, &decorations, now))
            .collect();
        nested.sort_by(|left, right| by_urgency(sort_key(left), sort_key(right)));
        let done = nested
            .iter()
            .filter(|child| !is_open_status(&child.status))
            .count();
        TaskRow {
            children: nested,
            done_children: Some(done),
            ..decorate(task, &decorations, now)
        }
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
            // THE PAGE'S OWN CURSOR, not a guess from the row count.
            truncated: open_page.filled,
            window,
        },
        None,
    ))
}

/// `search` — the board's row shape, in the order the index ranked them.
///
/// # Errors
///
/// A door refusal becomes the payload's denial; a reached bound is an `Err`.
pub fn load_search(
    door: &dyn PageDoor,
    hits: &[Row],
    now: &str,
) -> KitResult<(SearchData, Option<Denial>)> {
    if hits.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let task_ids: Vec<String> = hits
        .iter()
        .filter_map(|row| cell_text(row, "task_id"))
        .collect();
    if task_ids.is_empty() {
        return Ok((SearchData::default(), None));
    }
    let decorations = match read_decorations(door, "search", &task_ids) {
        Ok(decorations) => decorations,
        Err(KitError::Door(message)) => {
            return Ok((SearchData::default(), Some(denial_of(message))));
        }
        Err(other) => return Err(other),
    };
    let tasks = hits
        .iter()
        .filter_map(|row| {
            let task = task_of(row)?;
            let mut decorated = decorate(&task, &decorations, now);
            decorated.snippet = Some(cell_text(row, "_snippet").unwrap_or_default());
            Some(decorated)
        })
        .collect();
    Ok((SearchData { tasks }, None))
}
