//! `tag.add` and `tag.remove`: a member's word on anything.
//!
//! A tag is a `concept` of kind `tag`, minted by its label the first time it is
//! used (`tag:<folded label>`), and a tagging is a `tagged` edge. Putting a word
//! on an entity is not a change to the entity: nothing is touched.

use crate::commands::entity::{lookup_live, require};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::{Kind, concept_id, fold_label};

/// The concept of this kind that a member's label names, minted when it is new.
///
/// The one place a member's word becomes a row: a tag and a relation both come
/// through here, so "Road  Trip" and "road trip" are one concept.
pub(crate) fn ensure_concept(ctx: &CommandCtx<'_, '_>, kind: Kind, label: &str) -> Result<String> {
    let key = fold_label(label);
    if key.is_empty() {
        return Err(VaultError::InvalidInput {
            name: "label".to_owned(),
            detail: "a label needs at least one character".to_owned(),
        });
    }
    let id = concept_id(kind, &key);
    let known: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM concept WHERE kind = ?1 AND key = ?2",
        [kind.as_str(), key.as_str()],
        |row| row.get(0),
    )?;
    if known == 0 {
        let title = label.split_whitespace().collect::<Vec<_>>().join(" ");
        ctx.insert_entity_as(&id, kind, &title)?;
        ctx.connection().execute(
            "INSERT INTO concept (id, kind, key) VALUES (?1, ?2, ?3)",
            [id.as_str(), kind.as_str(), key.as_str()],
        )?;
    }
    Ok(id)
}

/// A sentence when this entity cannot carry a tag or a flag: it is missing, in
/// the trash, or is itself a word.
pub(crate) fn pre_taggable(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    Ok(found.kind.is_concept().then(|| {
        format!(
            "a {} is a word, not something that takes a word",
            found.kind.noun()
        )
    }))
}

/// Put an edge of `tagged` from `id` to a concept, or take it away.
pub(crate) fn set_tagged(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    concept: &str,
    on: bool,
) -> Result<bool> {
    require(ctx.connection(), id)?;
    let changed = if on {
        ctx.connection().execute(
            "INSERT INTO edge (from_id, rel, to_id, created_at) VALUES (?1, 'tagged', ?2, ?3)
             ON CONFLICT DO NOTHING",
            rusqlite::params![id, concept, ctx.now],
        )?
    } else {
        ctx.connection().execute(
            "DELETE FROM edge WHERE from_id = ?1 AND rel = 'tagged' AND to_id = ?2",
            [id, concept],
        )?
    };
    Ok(changed > 0)
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let tag = ensure_concept(ctx, Kind::Tag, ctx.required_str("label")?)?;
    let added = set_tagged(ctx, id, &tag, true)?;
    Ok(serde_json::json!({ "tag": tag, "added": added }))
}

fn remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let tag = concept_id(Kind::Tag, &fold_label(ctx.required_str("label")?));
    let removed = set_tagged(ctx, id, &tag, false)?;
    Ok(serde_json::json!({ "tag": tag, "removed": removed }))
}

fn pre_label(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(fold_label(ctx.required_str("label")?)
        .is_empty()
        .then(|| "a tag needs a word".to_owned()))
}

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["id", "label"],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "label": { "type": "string", "maxLength": 200 }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "tag.add",
            "tag",
            SCHEMA,
            Idempotency::Idempotent,
            &[
                CommandCondition {
                    predicate: "entity_takes_a_tag",
                    check: pre_taggable,
                },
                CommandCondition {
                    predicate: "label_is_a_word",
                    check: pre_label,
                },
            ],
            add,
        ),
        CommandDefinition::plain(
            "tag.remove",
            "tag",
            SCHEMA,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "entity_takes_a_tag",
                check: pre_taggable,
            }],
            remove,
        ),
    ]
}
