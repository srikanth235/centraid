//! `person.set_birthday_reminder` keeps the compatibility command for restoring a legacy
//! off switch. Birthday reminders always stay on; an off request is refused before any write.

use serde_json::{Value as Json, json};

use crate::commands::person::refusal_unless_live_person;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;

fn pre_set(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.input.get("on").and_then(Json::as_bool) == Some(false) {
        return Ok(Some("Birthday reminders stay on.".to_owned()));
    }
    let id = ctx.required_str("id")?;
    if let Some(sentence) = refusal_unless_live_person(ctx.connection(), id)? {
        return Ok(Some(sentence));
    }
    let has_birthday: bool = ctx.connection().query_row(
        "SELECT birthday IS NOT NULL FROM person WHERE id = ?1",
        [id],
        |row| row.get(0),
    )?;
    Ok((!has_birthday).then(|| "this person has no birthday to remind you of".to_owned()))
}

fn set(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let id = ctx.required_str("id")?;
    let on = ctx.input.get("on").and_then(Json::as_bool).unwrap_or(true);
    let changed = ctx.connection().execute(
        "UPDATE person SET birthday_reminder = ?2 WHERE id = ?1 AND birthday_reminder IS NOT ?2",
        rusqlite::params![id, i64::from(on)],
    )? > 0;
    if changed {
        ctx.touch(id)?;
    }
    Ok(json!({ "id": id, "on": on, "changed": changed }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "person.set_birthday_reminder",
        "person",
        r#"{
          "type": "object",
          "required": ["id", "on"],
          "additionalProperties": false,
          "properties": {
            "id": { "type": "string", "minLength": 1 },
            "on": { "type": "boolean" }
          }
        }"#,
        Idempotency::Idempotent,
        &[CommandCondition {
            predicate: "person_is_live_and_has_a_birthday",
            check: pre_set,
        }],
        set,
    )]
}
