//! COMPLETION IS ONE OPERATION (#996 R21; drift ONT-27).
//!
//! People and Tasks completed the same `schedule_task` row with different SQL.
//! `people.toggle_task` flipped the status in a `CASE` expression — so **which
//! app the member happened to be looking at decided whether a repeating task
//! got its next occurrence**, and a double tap silently reopened a task the
//! other screen had just closed. Tasks' own recurrence copied the columns of
//! the completed row into a fresh one with no series identity and without the
//! `about` link, so the successor of a recurring "call Mum" was no longer
//! about Mum: the reminder survived and the person it was for did not.
//!
//! Three things this module makes true for every caller:
//!
//! 1. [`complete`] and [`reopen`] are separate, named, **idempotent**
//!    operations. Never a toggle: a toggle's outcome depends on a state the
//!    caller did not read, which is the whole of ONT-27's "which app completed
//!    it decides what happens".
//! 2. A recurring task has a **stable series identity** (`series_id`), and
//!    each occurrence keeps its own `task_id`. The series is what the
//!    successor belongs to; the occurrence is what was completed.
//! 3. The relationships that belong to the SERIES are inherited. A live
//!    `core_link` from the completed occurrence is re-asserted from the
//!    successor.
//!
//! ## Why it is here and not in `crates/apps/tasks`
//!
//! Because it is not Tasks'. `schedule.set_task_status` calls it, People's
//! task commands call it, automations calls it, and an import calls it — and
//! the point of the boundary is that they cannot each have their own.

use rusqlite::Connection;

use super::task_write::{Stated, TaskWriteDraft, assert_task_write};
use crate::error::{Result, VaultError};
use crate::time::recurrence::{NextOccurrenceInput, RecurrenceAnchor, next_occurrence};
use crate::time::zone::FireZone;

/// A successor carries at least as many live links as the occurrence it came
/// from (#996, ONT-27) — the postcondition People and Tasks both assert after
/// a completion, **in one spelling** so the two apps cannot check different
/// things.
pub const SUCCESSOR_INHERITS_SERIES_LINKS_SQL: &str =
    "SELECT (CASE WHEN :next_task_id IS NULL THEN 1
             ELSE ((SELECT count(*) FROM core_link
                     WHERE from_type = 'schedule.task' AND from_id = :next_task_id
                       AND valid_to IS NULL)
                   >= (SELECT count(*) FROM core_link
                        WHERE from_type = 'schedule.task' AND from_id = :task_id
                          AND valid_to IS NULL)) END) AS n";

/// What a lifecycle operation needs from its caller. The clock and the id
/// source are INJECTED, never read inline (`crates/vault::clock`).
pub struct TaskLifecycle<'a> {
    pub connection: &'a Connection,
    pub now: &'a str,
    pub next_id: &'a dyn Fn() -> String,
    /// The vault's zone, when it has one. A task with its own `tz` uses that;
    /// a task with none falls back to this, and a vault with neither falls
    /// back to `Etc/UTC` — which is what v0's `row.tz ?? "Etc/UTC"` does, and
    /// is the ONE place this tree still has a default zone.
    pub vault_zone: Option<&'a str>,
}

/// What a lifecycle operation answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskLifecycleResult {
    pub task_id: String,
    pub status: String,
    /// The series this occurrence belongs to; `None` when the task does not
    /// repeat.
    pub series_id: Option<String>,
    pub next_task_id: Option<String>,
    pub next_due_at: Option<String>,
}

impl TaskLifecycleResult {
    /// The command output shape, with the optional halves present only when
    /// they were produced — v0 spreads a partial object for the same reason.
    #[must_use]
    pub fn to_json(&self) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        out.insert("task_id".to_owned(), self.task_id.clone().into());
        out.insert("status".to_owned(), self.status.clone().into());
        out.insert(
            "series_id".to_owned(),
            self.series_id
                .clone()
                .map_or(serde_json::Value::Null, Into::into),
        );
        if let Some(next) = &self.next_task_id {
            out.insert("next_task_id".to_owned(), next.clone().into());
        }
        if let Some(due) = &self.next_due_at {
            out.insert("next_due_at".to_owned(), due.clone().into());
        }
        serde_json::Value::Object(out)
    }
}

struct TaskRow {
    task_id: String,
    status: String,
    owner_party_id: String,
    title: String,
    description: Option<String>,
    priority: i64,
    due_at: Option<String>,
    effort_min: Option<i64>,
    parent_task_id: Option<String>,
    rrule: Option<String>,
    remind_before_min: Option<i64>,
    project_id: Option<String>,
    section_id: Option<String>,
    sort_order: i64,
    recurrence_anchor: String,
    tz: Option<String>,
    series_id: Option<String>,
}

const TASK_COLUMNS: &str = "task_id, status, owner_party_id, title, description, priority,
       due_at, effort_min, parent_task_id, rrule, remind_before_min, project_id,
       section_id, sort_order, recurrence_anchor, tz, series_id";

fn task_row(connection: &Connection, task_id: &str) -> Option<TaskRow> {
    connection
        .query_row(
            &format!(
                "SELECT {TASK_COLUMNS} FROM schedule_task \
                 WHERE task_id = ?1 AND deleted_at IS NULL"
            ),
            [task_id],
            |row| {
                Ok(TaskRow {
                    task_id: row.get(0)?,
                    status: row.get(1)?,
                    owner_party_id: row.get(2)?,
                    title: row.get(3)?,
                    description: row.get(4)?,
                    priority: row.get(5)?,
                    due_at: row.get(6)?,
                    effort_min: row.get(7)?,
                    parent_task_id: row.get(8)?,
                    rrule: row.get(9)?,
                    remind_before_min: row.get(10)?,
                    project_id: row.get(11)?,
                    section_id: row.get(12)?,
                    sort_order: row.get(13)?,
                    recurrence_anchor: row.get(14)?,
                    tz: row.get(15)?,
                    series_id: row.get(16)?,
                })
            },
        )
        .ok()
}

/// An operation refusal, carrying the CONDITION's name and the member-facing
/// sentence. v0 throws `OperationRefusalError` with the same two fields;
/// `InvalidInput` is where those two land here, because the vault has one
/// refusal shape and a second would be a second thing for a surface to render.
fn refuse(condition: &'static str, message: &str) -> VaultError {
    VaultError::InvalidInput {
        name: condition.to_owned(),
        detail: message.to_owned(),
    }
}

/// The series a task belongs to.
///
/// A task that repeats and has never been given one becomes the head of its
/// own series — the identity is minted once and then never moves, so every
/// occurrence of "call Mum" answers the same question with the same id.
fn series_id_of(connection: &Connection, row: &TaskRow) -> Result<Option<String>> {
    if row.series_id.is_some() {
        return Ok(row.series_id.clone());
    }
    if row.rrule.is_none() {
        return Ok(None);
    }
    connection.execute(
        "UPDATE schedule_task SET series_id = ?1 WHERE task_id = ?1",
        [&row.task_id],
    )?;
    Ok(Some(row.task_id.clone()))
}

/// Re-assert the completed occurrence's live links from the successor.
///
/// **Copied, not moved**: the completed occurrence keeps its own history, and
/// the `about` edge is a fact about both rows.
fn inherit_series_links(
    ctx: &TaskLifecycle<'_>,
    from_task_id: &str,
    to_task_id: &str,
) -> Result<()> {
    let mut statement = ctx.connection.prepare(
        "SELECT to_type, to_id, relation_concept_id, asserted_by
           FROM core_link
          WHERE from_type = 'schedule.task' AND from_id = ?1 AND valid_to IS NULL",
    )?;
    let links: Vec<(String, String, String, String)> = statement
        .query_map([from_task_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    drop(statement);
    for (to_type, to_id, relation_concept_id, asserted_by) in links {
        let link_id = (ctx.next_id)();
        ctx.connection.execute(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id)
             VALUES (?1, 'schedule.task', ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL)
             ON CONFLICT DO NOTHING",
            rusqlite::params![
                link_id,
                to_task_id,
                to_type,
                to_id,
                relation_concept_id,
                ctx.now,
                asserted_by,
            ],
        )?;
    }
    Ok(())
}

/// The zone a task's recurrence rolls over in: the task's own, else the
/// vault's, else UTC.
fn task_zone(ctx: &TaskLifecycle<'_>, row: &TaskRow) -> Option<FireZone> {
    FireZone::resolve(row.tz.as_deref(), ctx.vault_zone)
        .or_else(|_| FireZone::named("Etc/UTC"))
        .ok()
}

/// COMPLETE a task. Idempotent: completing an already-completed task is the
/// same answer, and **never spawns a second successor**.
///
/// # Errors
///
/// A task that is not here to complete, or a successor the model would refuse.
pub fn complete(ctx: &TaskLifecycle<'_>, task_id: &str) -> Result<TaskLifecycleResult> {
    let Some(row) = task_row(ctx.connection, task_id) else {
        return Err(refuse("task_exists", "That task is not here to complete."));
    };
    if row.status == "completed" {
        return Ok(TaskLifecycleResult {
            task_id: task_id.to_owned(),
            status: "completed".to_owned(),
            series_id: row.series_id,
            next_task_id: None,
            next_due_at: None,
        });
    }
    let series_id = series_id_of(ctx.connection, &row)?;
    ctx.connection.execute(
        "UPDATE schedule_task SET status = 'completed', completed_at = ?1 WHERE task_id = ?2",
        rusqlite::params![ctx.now, task_id],
    )?;
    let mut result = TaskLifecycleResult {
        task_id: task_id.to_owned(),
        status: "completed".to_owned(),
        series_id: series_id.clone(),
        next_task_id: None,
        next_due_at: None,
    };
    let (Some(rule), Some(due_at)) = (row.rrule.as_deref(), row.due_at.as_deref()) else {
        return Ok(result);
    };
    let anchor = RecurrenceAnchor::from_stored(Some(row.recurrence_anchor.as_str()));
    let zone = task_zone(ctx, &row);
    let after = if anchor == RecurrenceAnchor::Completion {
        ctx.now
    } else {
        due_at
    };
    let Some(next_due) = next_occurrence(&NextOccurrenceInput {
        rrule: rule,
        scheduled_start: due_at,
        after,
        zone: zone.as_ref(),
        anchor,
    }) else {
        return Ok(result);
    };
    // The successor is a canonical write like any other; a series whose next
    // occurrence would be invalid STOPS rather than writing a row no reader
    // can make sense of.
    if let Some(refusal) = assert_task_write(
        ctx.connection,
        TaskWriteDraft {
            task_id: None,
            parent_task_id: Stated::read(row.parent_task_id.clone(), false),
            project_id: Stated::read(row.project_id.clone(), false),
            section_id: Stated::read(row.section_id.clone(), false),
            due_at: Stated::Set(next_due.clone()),
            rrule: Stated::Set(rule.to_owned()),
            status: Stated::Set("needs-action".to_owned()),
        },
    ) {
        return Err(refuse(refusal.condition, &refusal.message));
    }
    let next_task_id = (ctx.next_id)();
    ctx.connection.execute(
        "INSERT INTO schedule_task
           (task_id, owner_party_id, title, description, status, priority,
            due_at, completed_at, effort_min, parent_task_id, rrule,
            remind_before_min, project_id, section_id, sort_order,
            recurrence_anchor, tz, series_id)
         VALUES (?1, ?2, ?3, ?4, 'needs-action', ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16)",
        rusqlite::params![
            next_task_id,
            row.owner_party_id,
            row.title,
            row.description,
            row.priority,
            next_due,
            row.effort_min,
            row.parent_task_id,
            row.rrule,
            row.remind_before_min,
            row.project_id,
            row.section_id,
            row.sort_order,
            row.recurrence_anchor,
            row.tz,
            series_id,
        ],
    )?;
    // ONT-27: the successor of a recurring "call Mum" is still about Mum.
    inherit_series_links(ctx, task_id, &next_task_id)?;
    result.next_task_id = Some(next_task_id);
    result.next_due_at = Some(next_due);
    Ok(result)
}

/// REOPEN a task. Idempotent, and never spawns anything.
///
/// # Errors
///
/// A task that is not here to reopen.
pub fn reopen(ctx: &TaskLifecycle<'_>, task_id: &str, status: &str) -> Result<TaskLifecycleResult> {
    let Some(row) = task_row(ctx.connection, task_id) else {
        return Err(refuse("task_exists", "That task is not here to reopen."));
    };
    if row.status == status {
        return Ok(TaskLifecycleResult {
            task_id: task_id.to_owned(),
            status: status.to_owned(),
            series_id: row.series_id,
            next_task_id: None,
            next_due_at: None,
        });
    }
    ctx.connection.execute(
        "UPDATE schedule_task SET status = ?1, completed_at = NULL WHERE task_id = ?2",
        rusqlite::params![status, task_id],
    )?;
    Ok(TaskLifecycleResult {
        task_id: task_id.to_owned(),
        status: status.to_owned(),
        series_id: row.series_id,
        next_task_id: None,
        next_due_at: None,
    })
}

/// CANCEL is neither: it ends the occurrence **without a successor**.
///
/// # Errors
///
/// A task that is not here to cancel.
pub fn cancel(ctx: &TaskLifecycle<'_>, task_id: &str) -> Result<TaskLifecycleResult> {
    let Some(row) = task_row(ctx.connection, task_id) else {
        return Err(refuse("task_exists", "That task is not here to cancel."));
    };
    ctx.connection.execute(
        "UPDATE schedule_task SET status = 'cancelled', completed_at = NULL WHERE task_id = ?1",
        [task_id],
    )?;
    Ok(TaskLifecycleResult {
        task_id: task_id.to_owned(),
        status: "cancelled".to_owned(),
        series_id: row.series_id,
        next_task_id: None,
        next_due_at: None,
    })
}
