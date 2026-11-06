//! Clearing completed work is atomic, covers the whole selected list and keeps
//! unfinished children by promoting them before their completed parent is trashed.
use crate::commands::{CommandCtx, entity};
use crate::error::Result;
use crate::time::{recurrence::parse_instant_ms, zone::FireZone};
use serde_json::{Value, json};
use std::collections::BTreeSet;

pub(super) const SCHEMA: &str = r#"{"type":"object","required":["view","day","zone"],"additionalProperties":false,"properties":{"view":{"type":"string","enum":["all","today","scheduled","anytime","flagged","reminders","project","tags"]},"day":{"type":"string"},"zone":{"type":"string"},"project_id":{"type":["string","null"]},"tag_id":{"type":["string","null"]}}}"#;

pub(super) fn run(ctx: &CommandCtx<'_, '_>) -> Result<Value> {
    let view = ctx.required_str("view")?;
    let day = ctx.required_str("day")?;
    if view == "project" && ctx.optional_str("project_id").is_none() {
        return Err(crate::error::VaultError::InvalidInput {
            name: "project_id".into(),
            detail: "Choose the list whose completed reminders should be cleared.".into(),
        });
    }
    let zone = FireZone::named(ctx.required_str("zone")?).map_err(|error| {
        crate::error::VaultError::InvalidInput {
            name: "zone".into(),
            detail: error.to_string(),
        }
    })?;
    let mut statement = ctx.connection().prepare(
        "SELECT t.id,t.parent_id,t.project_id,t.due,t.remind_before_min,
                EXISTS (SELECT 1 FROM edge WHERE from_id=t.id AND rel='tagged' AND to_id='flag:starred')
           FROM task t JOIN entity e ON e.id=t.id WHERE t.status='done' AND e.deleted_at IS NULL"
    )?;
    let candidates = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let local_day = |due: &str| {
        if let Some(instant) = parse_instant_ms(due) {
            let wall = zone.wall_clock(instant);
            format!("{:04}-{:02}-{:02}", wall.year, wall.month, wall.day)
        } else {
            due.get(..10).unwrap_or_default().to_owned()
        }
    };
    // Match the tag browser: a tagged parent includes its descendants; a
    // tagged child keeps its ancestors as context, without selecting siblings.
    let tagged: BTreeSet<String> = if view == "tags" {
        ctx.connection().prepare(
            "WITH RECURSIVE tagged(id) AS (
                SELECT edge.from_id FROM edge JOIN concept c ON c.id=edge.to_id
                WHERE edge.rel='tagged' AND c.kind='tag' AND (?1 IS NULL OR c.id=?1)
             ), below(id) AS (
                SELECT id FROM tagged UNION SELECT t.id FROM task t JOIN below b ON t.parent_id=b.id
             ), above(id) AS (
                SELECT id FROM tagged UNION SELECT t.parent_id FROM task t JOIN above a ON t.id=a.id WHERE t.parent_id IS NOT NULL
             ) SELECT id FROM below UNION SELECT id FROM above"
        )?.query_map([ctx.optional_str("tag_id")], |row| row.get(0))?
          .collect::<std::result::Result<_, _>>()?
    } else {
        BTreeSet::new()
    };
    let selected: BTreeSet<String> = candidates
        .iter()
        .filter(|(id, _, project, due, remind, flagged)| match view {
            "today" => due.as_deref().is_some_and(|due| local_day(due) == day),
            "scheduled" => due.is_some(),
            "anytime" => due.is_none(),
            "flagged" => *flagged,
            "reminders" => remind.is_some(),
            "tags" => tagged.contains(id),
            "project" => project.as_deref() == ctx.optional_str("project_id"),
            _ => true,
        })
        .map(|(id, _, _, _, _, _)| id.clone())
        .collect();
    // Keep every child not in this clear operation, including open work.
    let children = ctx
        .connection()
        .prepare("SELECT id,parent_id FROM task WHERE parent_id IS NOT NULL")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (child, parent) in children {
        if selected.contains(&parent) && !selected.contains(&child) {
            ctx.connection()
                .execute("UPDATE task SET parent_id=NULL WHERE id=?1", [&child])?;
            ctx.touch(&child)?;
        }
    }
    let stamp = entity::trash_stamp(ctx)?;
    let mut trashed = Vec::new();
    for (id, parent, _, _, _, _) in &candidates {
        if selected.contains(id)
            && parent
                .as_ref()
                .is_none_or(|parent| !selected.contains(parent))
        {
            entity::trash_one(ctx, id, &stamp, &mut trashed)?;
        }
    }
    Ok(json!({"count": trashed.len(), "trashed": trashed}))
}
