//! `concept.merge`: two words of one kind that are one (a tag, a category, a kind of workout or
//! touch, a relation). Everything that named the one that goes names the one that stays, and then
//! the one that goes is purged: the edges and links it was on, the parts of lines filed under it,
//! its rules and budgets, the workouts and touches of its kind, the concepts inside it and what is
//! homed in it.

use serde_json::{Value as Json, json};

use crate::commands::entity::{lookup_live, purge_one, repoint_homes};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency, txn};
use crate::error::Result;
use crate::links;
use crate::model::Kind;

fn pre_merge(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (from, into) = (ctx.required_str("from")?, ctx.required_str("into")?);
    if from == into {
        return Ok(Some("a word cannot be merged into itself".to_owned()));
    }
    let mut kinds = Vec::new();
    for id in [from, into] {
        let found = match lookup_live(ctx.connection(), id)? {
            Ok(found) => found,
            Err(sentence) => return Ok(Some(sentence)),
        };
        if !found.kind.is_concept() {
            return Ok(Some(format!(
                "“{}” is a {}, and only a tag, category, kind of workout or touch, or relation is merged",
                found.title,
                found.kind.noun()
            )));
        }
        kinds.push(found.kind);
    }
    if kinds[0] != kinds[1] {
        return Ok(Some(format!(
            "a {} can only be merged into another {}",
            kinds[0].noun(),
            kinds[0].noun()
        )));
    }
    Ok(None)
}

fn merge(ctx: &CommandCtx<'_, '_>) -> Result<Json> {
    let (loser, winner) = (ctx.required_str("from")?, ctx.required_str("into")?);
    let connection = ctx.connection();
    let kind = lookup_live(connection, loser)?
        .map_err(|sentence| crate::error::VaultError::Invariant { context: sentence })?
        .kind;
    let named: Vec<String> = connection
        .prepare_cached("SELECT from_id FROM edge WHERE to_id = ?1 OR label_id = ?1")?
        .query_map([loser], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    match kind {
        Kind::Category => {
            txn::refile_parts_into(ctx, loser, winner)?;
            connection.execute(
                "UPDATE OR IGNORE budget SET category_id = ?2 WHERE category_id = ?1",
                [loser, winner],
            )?;
            connection.execute(
                "UPDATE rule SET category_id = ?2 WHERE category_id = ?1",
                [loser, winner],
            )?;
        }
        Kind::WorkoutKind => {
            connection.execute(
                "UPDATE workout SET type_id = ?2 WHERE type_id = ?1",
                [loser, winner],
            )?;
        }
        Kind::TouchKind => {
            connection.execute(
                "UPDATE touch SET type_id = ?2 WHERE type_id = ?1",
                [loser, winner],
            )?;
        }
        _ => {}
    }
    let repointed = links::repoint(connection, loser, winner)?;
    let homed = repoint_homes(ctx, loser, winner)?;
    connection.execute(
        "UPDATE concept SET color = (SELECT color FROM concept WHERE id = ?1)
          WHERE id = ?2 AND color IS NULL AND EXISTS (
            SELECT 1 FROM concept_kind WHERE code = concept.kind AND takes_color = 1)",
        [loser, winner],
    )?;
    let mut purged = Vec::new();
    purge_one(ctx, loser, &mut purged)?;
    for id in named {
        ctx.mark_for_index(&id);
    }
    ctx.touch(winner)?;
    ctx.mark_for_index(winner);
    Ok(json!({
        "into": winner,
        "edges": repointed.edges,
        "homed": homed,
    }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    let mut merge = CommandDefinition::plain(
        "concept.merge",
        "concept",
        r#"{
          "type": "object",
          "required": ["from", "into"],
          "additionalProperties": false,
          "properties": {
            "from": { "type": "string", "minLength": 1 },
            "into": { "type": "string", "minLength": 1 }
          }
        }"#,
        Idempotency::Once,
        &[CommandCondition {
            predicate: "both_are_words_of_one_kind",
            check: pre_merge,
        }],
        merge,
    );
    merge.risk = crate::commands::Risk::Medium;
    merge.confirm = true;
    vec![merge]
}
