//! `task.*`: a task's own verbs, and the one place a task row is founded.
//!
//! A task is an entity of kind `task` whose state lives on its kind row. The
//! project and section it is filed under are columns (a project is a container,
//! a section its child); who or what it is about is an `about` edge (a follow-up
//! on Mum, a note's checklist line); a tag, an attachment and the trash are the
//! shared verbs. What is here is what only a task has: being added, edited,
//! completed, reopened, cancelled and filed.
//!
//! ## Completion is one operation
//!
//! [`complete`] is the only thing that closes a task as done, whoever asks
//! (Tasks' check box, People's follow-up, an automation, an import). It is a
//! named, idempotent operation and never a toggle, because a toggle's outcome
//! depends on a state the caller did not read, and which screen the member was
//! looking at would decide whether a repeating task got its next occurrence.
//!
//! A repeating task has a **series**: the identity (`series_id`, the first
//! occurrence's own id) every occurrence shares, each keeping its own row. The
//! successor of a completed occurrence is a new open task one step on, and it
//! **inherits what belongs to the series**: where it is filed, its rule, and the
//! `about` and `tagged` edges, so the successor of "call Mum" is still about Mum
//! and still tagged. Cancelling ends the occurrence and spawns nothing.
//!
//! ## Priority is not iCalendar's
//!
//! `0` is unset and a higher number is more urgent (Todoist's scale, and the
//! board's order); the column's CHECK is the only range.

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value as Json, json};

use crate::commands::entity::{find, lookup_live};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::Kind;
use crate::time::recurrence::{NextOccurrenceInput, RecurrenceAnchor, next_occurrence};
use crate::time::zone::FireZone;
use crate::time::{rrule, temporal};

/// The vocabulary of `task.status`, held equal to the CHECK by a test.
pub const STATUSES: [&str; 3] = ["open", "done", "cancelled"];

/// The vocabulary of `task.anchor`, held equal to the CHECK by a test.
pub const ANCHORS: [RecurrenceAnchor; 2] =
    [RecurrenceAnchor::Scheduled, RecurrenceAnchor::Completion];

/// What a new task is told: the rest of its row takes the column defaults (open,
/// unprioritised, no rule, in no project, last in its place).
#[derive(Default)]
pub struct NewTask<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    /// A day, a wall clock, or an instant.
    pub due: Option<&'a str>,
    pub description: Option<&'a str>,
    pub priority: Option<i64>,
    pub effort_min: Option<i64>,
    pub remind_before_min: Option<i64>,
    pub rule: Option<&'a str>,
    pub anchor: Option<&'a str>,
    pub zone: Option<&'a str>,
    pub parent_id: Option<&'a str>,
    pub project_id: Option<&'a str>,
    pub section_id: Option<&'a str>,
    pub position: Option<f64>,
}

/// Found a task: the entity and the kind row. Returns its id.
pub fn found(ctx: &CommandCtx<'_, '_>, task: &NewTask<'_>) -> Result<String> {
    let title = task.title.trim();
    let id = match task.id {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Task, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Task, title)?,
    };
    ctx.connection().execute(
        "INSERT INTO task (id, due, description, priority, effort_min, remind_before_min, rule,
                           anchor, zone, parent_id, project_id, section_id, position)
         VALUES (?1, ?2, ?3, COALESCE(?4, 0), ?5, ?6, ?7, COALESCE(?8, 'scheduled'), ?9, ?10, ?11,
                 ?12, COALESCE(?13, (SELECT COALESCE(MAX(position), 0) + 1 FROM task
                                      WHERE project_id IS ?11)))",
        rusqlite::params![
            id,
            task.due,
            task.description,
            task.priority,
            task.effort_min,
            task.remind_before_min,
            task.rule.map(rrule::canonicalize),
            task.anchor,
            task.zone,
            task.parent_id,
            task.project_id,
            task.section_id,
            task.position,
        ],
    )?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// What a task will be, and whether that is allowed
// ---------------------------------------------------------------------------

/// The columns a write may change, as they will be after it lands.
struct Image {
    id: Option<String>,
    due: Option<String>,
    rule: Option<String>,
    remind: Option<i64>,
    parent: Option<String>,
    project: Option<String>,
    section: Option<String>,
}

/// A stated string: `Some(Some)` sets it, `Some(None)` clears it (`null`), and
/// `None` says nothing.
fn stated(ctx: &CommandCtx<'_, '_>, key: &str) -> Option<Option<String>> {
    ctx.input
        .get(key)
        .map(|value| value.as_str().map(str::to_owned))
}

fn image(ctx: &CommandCtx<'_, '_>) -> Result<Image> {
    let id = ctx.optional_str("id").map(str::to_owned);
    let stored = id
        .as_deref()
        .map(|id| {
            ctx.connection()
                .query_row(
                    "SELECT due, rule, remind_before_min, parent_id, project_id, section_id
                       FROM task WHERE id = ?1",
                    [id],
                    |row| {
                        Ok(Image {
                            id: None,
                            due: row.get(0)?,
                            rule: row.get(1)?,
                            remind: row.get(2)?,
                            parent: row.get(3)?,
                            project: row.get(4)?,
                            section: row.get(5)?,
                        })
                    },
                )
                .optional()
        })
        .transpose()?
        .flatten();
    let held = stored.unwrap_or(Image {
        id: None,
        due: None,
        rule: None,
        remind: None,
        parent: None,
        project: None,
        section: None,
    });
    let project = stated(ctx, "project_id").unwrap_or(held.project.clone());
    // A task moved to another project leaves its section behind unless it names one.
    let section = stated(ctx, "section_id").unwrap_or_else(|| {
        if project == held.project {
            held.section.clone()
        } else {
            None
        }
    });
    Ok(Image {
        id,
        due: stated(ctx, "due").unwrap_or(held.due),
        rule: stated(ctx, "rule").unwrap_or(held.rule),
        remind: ctx
            .input
            .get("remind_before_min")
            .map_or(held.remind, Json::as_i64),
        parent: stated(ctx, "parent_id").unwrap_or(held.parent),
        project,
        section,
    })
}

/// The sentence a member reads when the task, as it would be, is not allowed.
fn refusal(connection: &Connection, task: &Image) -> Result<Option<String>> {
    if let Some(due) = &task.due
        && !matches!(
            temporal::classify(due),
            Some(
                temporal::Kind::Instant
                    | temporal::Kind::FloatingDateTime
                    | temporal::Kind::LocalDate
            )
        )
    {
        return Ok(Some(temporal::refusal(
            "due",
            due,
            &[
                temporal::Kind::Instant,
                temporal::Kind::FloatingDateTime,
                temporal::Kind::LocalDate,
            ],
        )));
    }
    if let Some(rule) = &task.rule
        && let Err(why) = rrule::inspect(rule)
    {
        return Ok(Some(format!("{rule}: {}", why.message())));
    }
    if task.rule.is_some() && task.due.is_none() {
        return Ok(Some(
            "A repeating task needs a due date to repeat from.".to_owned(),
        ));
    }
    if task.remind.is_some() && task.due.is_none() {
        return Ok(Some(
            "A reminder needs a due date to count back from.".to_owned(),
        ));
    }
    if let Some(parent) = &task.parent {
        if task.id.as_deref() == Some(parent.as_str()) {
            return Ok(Some("A task cannot be its own parent.".to_owned()));
        }
        let Some(found) = find(connection, parent)?.filter(|found| found.kind == Kind::Task) else {
            return Ok(Some("That parent is not a task.".to_owned()));
        };
        if found.deleted_at.is_some() {
            return Ok(Some(format!(
                "“{}” is in the trash; restore it first",
                found.title
            )));
        }
        if let Some(id) = &task.id {
            let below: bool = connection.query_row(
                "WITH RECURSIVE up(id) AS (
                   SELECT ?1 UNION SELECT t.parent_id FROM task t JOIN up ON t.id = up.id
                    WHERE t.parent_id IS NOT NULL)
                 SELECT EXISTS (SELECT 1 FROM up WHERE id = ?2)",
                [parent, id],
                |row| row.get(0),
            )?;
            if below {
                return Ok(Some(
                    "That parent is already below this task: a task hierarchy has no loops."
                        .to_owned(),
                ));
            }
        }
    }
    for (id, kind) in [
        (&task.project, Kind::Project),
        (&task.section, Kind::Section),
    ] {
        if let Some(id) = id {
            match lookup_live(connection, id)? {
                Err(sentence) => return Ok(Some(sentence)),
                Ok(found) if found.kind != kind => {
                    return Ok(Some(format!(
                        "“{}” is a {}, not a {}",
                        found.title,
                        found.kind.noun(),
                        kind.noun()
                    )));
                }
                Ok(_) => {}
            }
        }
    }
    if let Some(section) = &task.section {
        let of: Option<String> = connection
            .query_row(
                "SELECT parent_id FROM container WHERE id = ?1",
                [section],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if of != task.project {
            return Ok(Some(
                "That section belongs to a different project.".to_owned(),
            ));
        }
    }
    Ok(None)
}

fn live_task(ctx: &CommandCtx<'_, '_>) -> Result<std::result::Result<(), String>> {
    Ok(
        match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
            Err(sentence) => Err(sentence),
            Ok(found) if found.kind != Kind::Task => Err(format!(
                "“{}” is a {}, not a task",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => Ok(()),
        },
    )
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a task needs a title".to_owned()));
    }
    if let Some(id) = ctx.optional_str("id")
        && find(ctx.connection(), id)?.is_some()
    {
        return Ok(Some("a task with that id already exists".to_owned()));
    }
    if let Some(sentence) = refusal(ctx.connection(), &image(ctx)?)? {
        return Ok(Some(sentence));
    }
    // One level of nesting: a subtask's parent is open and top-level.
    if let Some(parent) = ctx.optional_str("parent_id") {
        let fine: bool = ctx.connection().query_row(
            "SELECT EXISTS (SELECT 1 FROM task WHERE id = ?1 AND parent_id IS NULL AND status = 'open')",
            [parent],
            |row| row.get(0),
        )?;
        if !fine {
            return Ok(Some(
                "That parent is not an open, top-level task.".to_owned(),
            ));
        }
    }
    Ok(None)
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_task(ctx)? {
        return Ok(Some(sentence));
    }
    if ctx.input.get("title").is_some() && ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a task needs a title".to_owned()));
    }
    refusal(ctx.connection(), &image(ctx)?)
}

fn pre_live(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    live_task(ctx).map(std::result::Result::err)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

fn add(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let int = |key: &str| ctx.input.get(key).and_then(Json::as_i64);
    let id = found(
        ctx,
        &NewTask {
            id: ctx.optional_str("id"),
            title: ctx.required_str("title")?,
            due: ctx.optional_str("due"),
            description: ctx.optional_str("description"),
            priority: int("priority"),
            effort_min: int("effort_min"),
            remind_before_min: int("remind_before_min"),
            rule: ctx.optional_str("rule"),
            anchor: ctx.optional_str("anchor"),
            zone: ctx.optional_str("zone"),
            parent_id: ctx.optional_str("parent_id"),
            project_id: ctx.optional_str("project_id"),
            section_id: ctx.optional_str("section_id"),
            position: ctx.input.get("position").and_then(Json::as_f64),
        },
    )?;
    Ok(json!({ "id": id }))
}

/// Set the columns a command states: a key that is present is set (`null`
/// clears it), one that is absent is left alone.
fn set_stated(ctx: &CommandCtx<'_, '_>, id: &str, columns: &[(&str, &str)]) -> Result<()> {
    for (key, column) in columns {
        if let Some(value) = ctx.input.get(*key) {
            let value = if *key == "rule" {
                value.as_str().map(rrule::canonicalize).map(Json::from)
            } else {
                Some(value.clone())
            };
            ctx.connection().execute(
                &format!("UPDATE task SET {column} = ?2 WHERE id = ?1"),
                rusqlite::params![
                    id,
                    crate::commands::follow::to_sql(&value.unwrap_or(Json::Null))
                ],
            )?;
        }
    }
    Ok(())
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    set_stated(
        ctx,
        id,
        &[
            ("description", "description"),
            ("due", "due"),
            ("priority", "priority"),
            ("effort_min", "effort_min"),
            ("remind_before_min", "remind_before_min"),
            ("rule", "rule"),
        ],
    )?;
    if let Some(title) = ctx.optional_str("title") {
        ctx.connection().execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.trim()],
        )?;
    }
    ctx.touch(id)?;
    Ok(json!({ "id": id }))
}

/// File a task: its project, section and place, and how its repeat is measured.
fn organize(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let after = image(ctx)?;
    ctx.connection().execute(
        "UPDATE task SET project_id = ?2, section_id = ?3 WHERE id = ?1",
        rusqlite::params![id, after.project, after.section],
    )?;
    set_stated(
        ctx,
        id,
        &[
            ("position", "position"),
            ("anchor", "anchor"),
            ("zone", "zone"),
        ],
    )?;
    ctx.touch(id)?;
    Ok(json!({ "id": id }))
}

/// What closing a task as done did.
pub struct Completion {
    pub id: String,
    /// The series the task belongs to, when it repeats.
    pub series_id: Option<String>,
    /// The next occurrence, when there is one.
    pub next_id: Option<String>,
    pub next_due: Option<String>,
}

/// The zone a task's repeat rolls over in: its own, else the vault's, else UTC.
fn zone_of(connection: &Connection, task: Option<&str>) -> Option<FireZone> {
    let vault: Option<String> = connection
        .query_row("SELECT zone FROM vault", [], |row| row.get(0))
        .optional()
        .ok()
        .flatten()
        .flatten();
    FireZone::resolve(task, vault.as_deref())
        .or_else(|_| FireZone::named("Etc/UTC"))
        .ok()
}

/// Complete a task, once. Completing a task already done answers the same and
/// never spawns a second successor.
///
/// # Errors
///
/// A task that is not there, or a database error.
pub fn complete(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<Completion> {
    let connection = ctx.connection();
    let (status, rule, due, anchor, zone, series): (
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    ) = connection
        .query_row(
            "SELECT status, rule, due, anchor, zone, series_id FROM task WHERE id = ?1",
            [id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|_| VaultError::Invariant {
            context: format!("`{id}` is not a task, and a precondition said it was"),
        })?;
    // A task that repeats and has no series yet is the head of its own: the
    // identity is minted once and then never moves.
    let series = series.or_else(|| rule.is_some().then(|| id.to_owned()));
    let mut done = Completion {
        id: id.to_owned(),
        series_id: series.clone(),
        next_id: None,
        next_due: None,
    };
    if status == "done" {
        return Ok(done);
    }
    connection.execute(
        "UPDATE task SET status = 'done', done_at = ?2, series_id = ?3 WHERE id = ?1",
        rusqlite::params![id, ctx.now, series],
    )?;
    ctx.touch(id)?;
    let (Some(rule), Some(due)) = (rule, due) else {
        return Ok(done);
    };
    let anchor = RecurrenceAnchor::from_stored(Some(&anchor));
    let zone = zone_of(connection, zone.as_deref());
    let Some(next_due) = next_occurrence(&NextOccurrenceInput {
        rrule: &rule,
        scheduled_start: &due,
        after: if anchor == RecurrenceAnchor::Completion {
            &ctx.now
        } else {
            &due
        },
        zone: zone.as_ref(),
        anchor,
    }) else {
        // A series that has run out stops here.
        return Ok(done);
    };
    let title: String =
        connection.query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    let next = ctx.insert_entity(Kind::Task, &title)?;
    connection.execute(
        "INSERT INTO task (id, status, priority, due, rule, anchor, zone, series_id,
                           remind_before_min, effort_min, parent_id, project_id, section_id,
                           description, position)
         SELECT ?2, 'open', priority, ?3, rule, anchor, zone, series_id, remind_before_min,
                effort_min, parent_id, project_id, section_id, description, position
           FROM task WHERE id = ?1",
        rusqlite::params![id, next, next_due],
    )?;
    connection.execute(
        "INSERT INTO edge (from_id, rel, to_id, label_id, position, state, anchor, created_at)
         SELECT ?2, rel, to_id, label_id, position, state, anchor, ?3 FROM edge
          WHERE from_id = ?1 AND rel IN ('about', 'tagged')",
        rusqlite::params![id, next, ctx.now],
    )?;
    done.next_id = Some(next);
    done.next_due = Some(next_due);
    Ok(done)
}

fn complete_command(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let done = complete(ctx, ctx.required_str("id")?)?;
    Ok(json!({
        "id": done.id,
        "status": "done",
        "series_id": done.series_id,
        "next_id": done.next_id,
        "next_due": done.next_due,
    }))
}

/// Close or reopen a task without a successor: cancelling ends the occurrence,
/// reopening makes a closed one open again. Both are idempotent.
fn settle(ctx: &CommandCtx<'_, '_>, status: &str) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let changed = ctx.connection().execute(
        "UPDATE task SET status = ?2, done_at = NULL WHERE id = ?1 AND status <> ?2",
        [id, status],
    )?;
    if changed > 0 {
        ctx.touch(id)?;
    }
    Ok(json!({ "id": id, "status": status }))
}

fn reopen(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    settle(ctx, "open")
}

fn cancel(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    settle(ctx, "cancelled")
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const ADD_SCHEMA: &str = r#"{
  "type": "object", "required": ["title"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "due": { "type": ["string", "null"], "description": "A day, a wall clock or an instant." },
    "priority": { "type": "integer", "minimum": 0, "maximum": 9 },
    "effort_min": { "type": ["integer", "null"], "minimum": 1 },
    "remind_before_min": { "type": ["integer", "null"], "minimum": 0 },
    "rule": { "type": ["string", "null"], "description": "An RFC 5545 recurrence rule." },
    "anchor": { "type": "string", "enum": ["scheduled", "completion"] },
    "zone": { "type": ["string", "null"] },
    "parent_id": { "type": ["string", "null"] },
    "project_id": { "type": ["string", "null"] },
    "section_id": { "type": ["string", "null"] },
    "position": { "type": "number" }
  }
}"#;

const EDIT_SCHEMA: &str = r#"{
  "type": "object", "required": ["id"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "title": { "type": "string", "maxLength": 1000 },
    "description": { "type": ["string", "null"] },
    "due": { "type": ["string", "null"] },
    "priority": { "type": "integer", "minimum": 0, "maximum": 9 },
    "effort_min": { "type": ["integer", "null"], "minimum": 1 },
    "remind_before_min": { "type": ["integer", "null"], "minimum": 0 },
    "rule": { "type": ["string", "null"] }
  }
}"#;

const ORGANIZE_SCHEMA: &str = r#"{
  "type": "object", "required": ["id"], "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "project_id": { "type": ["string", "null"] },
    "section_id": { "type": ["string", "null"] },
    "position": { "type": "number" },
    "anchor": { "type": "string", "enum": ["scheduled", "completion"] },
    "zone": { "type": ["string", "null"] }
  }
}"#;

const BY_ID: &str = r#"{ "type": "object", "required": ["id"], "additionalProperties": false,
  "properties": { "id": { "type": "string", "minLength": 1 } } }"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const ADD: &[CommandCondition] = &[CommandCondition {
        predicate: "task_has_a_title_and_a_model_that_holds",
        check: pre_add,
    }];
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "task_is_live_and_a_model_that_holds",
        check: pre_edit,
    }];
    const LIVE: &[CommandCondition] = &[CommandCondition {
        predicate: "task_is_live",
        check: pre_live,
    }];
    vec![
        CommandDefinition::plain("task.add", "task", ADD_SCHEMA, Idempotency::Once, ADD, add),
        CommandDefinition::plain(
            "task.edit",
            "task",
            EDIT_SCHEMA,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "task.organize",
            "task",
            ORGANIZE_SCHEMA,
            Idempotency::Idempotent,
            EDIT,
            organize,
        ),
        CommandDefinition::plain(
            "task.complete",
            "task",
            BY_ID,
            Idempotency::Idempotent,
            LIVE,
            complete_command,
        ),
        CommandDefinition::plain(
            "task.reopen",
            "task",
            BY_ID,
            Idempotency::Idempotent,
            LIVE,
            reopen,
        ),
        CommandDefinition::plain(
            "task.cancel",
            "task",
            BY_ID,
            Idempotency::Idempotent,
            LIVE,
            cancel,
        ),
    ]
}
