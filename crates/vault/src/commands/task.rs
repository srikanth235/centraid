//! A task's row: how one is founded.
//!
//! Agenda owns the `task.*` commands; People founds tasks too (a follow-up and
//! a gift idea are tasks with an `about` edge to the person), so the row is
//! written in one place that both come to.

use crate::commands::CommandCtx;
use crate::error::Result;
use crate::model::Kind;

/// What a new task is told: the rest of its row takes the column defaults (open,
/// unprioritised, no rule, no project).
pub struct NewTask<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    /// A day, or a day and a time.
    pub due: Option<&'a str>,
    pub description: Option<&'a str>,
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
        "INSERT INTO task (id, due, description) VALUES (?1, ?2, ?3)",
        rusqlite::params![id, task.due, task.description],
    )?;
    Ok(id)
}
