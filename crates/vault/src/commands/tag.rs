//! `tag.add`, `tag.remove` and `tag.color`: a member's word on anything.
//!
//! A tag is a `concept` of kind `tag`, minted by its label the first time it is used (its id is a
//! UUIDv7 like every row's; its `key` is the folded label, and `concept(kind, key)` is what finds
//! it again), and a tagging is a `tagged` edge. Which kinds take a tag is the `edge_shape` table
//! (a `*` end is any linkable kind: a container, a concept, a chat or a reading takes none) and
//! the edge's own trigger refuses the rest; [`tag_refusal`] says it in a sentence first. A colour
//! is worn only by a concept kind that takes one (`concept_kind.takes_color`), and a tag does.
//! Putting a word on an entity is not a change to the entity: nothing is touched, but the word
//! is part of the entity's search text, so it is re-indexed.

use rusqlite::{Connection, OptionalExtension};

use crate::commands::entity::{lookup_live, require};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::model::{Kind, Rel, fold_label};

/// The concept of this kind that a label's key names, if there is one.
pub(crate) fn find_concept(
    connection: &Connection,
    kind: Kind,
    label: &str,
) -> Result<Option<String>> {
    Ok(connection
        .query_row(
            "SELECT id FROM concept WHERE kind = ?1 AND key = ?2",
            [kind.as_str(), fold_label(label).as_str()],
            |row| row.get(0),
        )
        .optional()?)
}

/// Whether concepts of this kind wear a colour (`concept_kind.takes_color`).
pub(crate) fn takes_color(connection: &Connection, kind: Kind) -> Result<bool> {
    Ok(connection
        .query_row(
            "SELECT takes_color FROM concept_kind WHERE code = ?1",
            [kind.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(false))
}

/// The concept of this kind that a member's label names, minted when it is new.
///
/// The one place a member's word becomes a row: a tag and a relation both come
/// through here, so "Road  Trip" and "road trip" are one concept. A new one has no colour; a
/// caller that colours it asks [`takes_color`] first.
pub(crate) fn ensure_concept(ctx: &CommandCtx<'_, '_>, kind: Kind, label: &str) -> Result<String> {
    let key = fold_label(label);
    if key.is_empty() {
        return Err(VaultError::InvalidInput {
            name: "label".to_owned(),
            detail: "a label needs at least one character".to_owned(),
        });
    }
    if !kind.is_concept() {
        return Err(VaultError::InvalidInput {
            name: "kind".to_owned(),
            detail: format!("a {} is not a word a member names", kind.noun()),
        });
    }
    if let Some(id) = find_concept(ctx.connection(), kind, label)? {
        return Ok(id);
    }
    let title = label.split_whitespace().collect::<Vec<_>>().join(" ");
    let id = ctx.insert_entity(kind, &title)?;
    ctx.connection().execute(
        "INSERT INTO concept (id, kind, key) VALUES (?1, ?2, ?3)",
        [id.as_str(), kind.as_str(), key.as_str()],
    )?;
    Ok(id)
}

/// The colours a label may wear: the keys of the one list palette (`[list]` in
/// `design/tokens.toml`, `centraid_design::tokens::LIST_IDS`; a test in the
/// screens crate keeps the two lists equal). All eight are keys of the `palette` table.
pub const LABEL_COLORS: [&str; 8] = [
    "blue",
    "mustard",
    "violet",
    "petrol",
    "indigo",
    "graphite",
    "raspberry",
    "orchid",
];

/// The palette colour the fewest labels wear, the first such in palette order:
/// a new label lands on the hue least in use, so a drive's labels spread over
/// the palette before any colour repeats.
pub(crate) fn next_color(ctx: &CommandCtx<'_, '_>) -> Result<&'static str> {
    let mut least = (i64::MAX, LABEL_COLORS[0]);
    for color in LABEL_COLORS {
        let used: i64 = ctx.connection().query_row(
            "SELECT COUNT(*) FROM concept WHERE color = ?1",
            [color],
            |row| row.get(0),
        )?;
        if used < least.0 {
            least = (used, color);
        }
    }
    Ok(least.1)
}

/// A sentence when a row of this kind takes no tag: no `edge_shape` row joins it to a tag, the
/// wildcard end being any linkable kind (`entity_kind.linkable`).
pub(crate) fn tag_refusal(connection: &Connection, kind: Kind) -> Result<Option<String>> {
    let takes: bool = connection.query_row(
        "SELECT EXISTS (
           SELECT 1 FROM edge_shape s JOIN entity_kind k ON k.code = ?1
            WHERE s.rel = ?2 AND s.to_kind = ?3
              AND (s.from_kind = k.code OR (s.from_kind = '*' AND k.linkable = 1)))",
        [kind.as_str(), Rel::Tagged.as_str(), Kind::Tag.as_str()],
        |row| row.get(0),
    )?;
    Ok((!takes).then(|| format!("a {} does not take a tag", kind.noun())))
}

/// A sentence when this entity cannot carry a tag: it is missing, in the trash, or is of a kind
/// that takes none.
pub(crate) fn pre_taggable(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    ctx.check_each(|one| {
        let found = match lookup_live(one.connection(), one.required_str("id")?)? {
            Ok(found) => found,
            Err(sentence) => return Ok(Some(sentence)),
        };
        tag_refusal(one.connection(), found.kind)
    })
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

#[derive(serde::Deserialize)]
struct AddTagInput {
    label: String,
    color: Option<String>,
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AddTagInput = ctx.parse_input()?;
    let known = find_concept(ctx.connection(), Kind::Tag, &input.label)?.is_some();
    let tag = ensure_concept(ctx, Kind::Tag, &input.label)?;
    if !known {
        // A NEW LABEL WEARS THE COLOUR ASKED FOR, else the palette hue least in use.
        let color = match input.color.as_deref() {
            Some(color) => color,
            None => next_color(ctx)?,
        };
        ctx.connection().execute(
            "UPDATE concept SET color = ?2 WHERE id = ?1",
            [tag.as_str(), color],
        )?;
    }
    let mut added = false;
    for id in ctx.target_ids() {
        added |= set_tagged(ctx, &id, &tag, true)?;
    }
    Ok(serde_json::json!({ "tag": tag, "added": added }))
}

#[derive(serde::Deserialize)]
struct RemoveTagInput {
    label: String,
}

fn remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RemoveTagInput = ctx.parse_input()?;
    let Some(tag) = find_concept(ctx.connection(), Kind::Tag, &input.label)? else {
        return Ok(serde_json::json!({ "tag": null, "removed": false }));
    };
    let mut removed = false;
    for id in ctx.target_ids() {
        removed |= set_tagged(ctx, &id, &tag, false)?;
    }
    Ok(serde_json::json!({ "tag": tag, "removed": removed }))
}

#[derive(serde::Deserialize)]
struct RecolorTagInput {
    label: String,
    color: String,
}

/// `tag.color`: change the colour a label wears. The label's words are its identity.
fn recolor(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RecolorTagInput = ctx.parse_input()?;
    let tag = find_concept(ctx.connection(), Kind::Tag, &input.label)?.ok_or_else(|| {
        VaultError::Invariant {
            context: "a precondition said the label exists".to_owned(),
        }
    })?;
    // The colour it wore, so the act can be taken back: the one value this command replaces.
    let replaced: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT color FROM concept WHERE id = ?1",
            [tag.as_str()],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    let changed = ctx.connection().execute(
        "UPDATE concept SET color = ?2 WHERE id = ?1 AND color IS NOT ?2",
        [tag.as_str(), input.color.as_str()],
    )?;
    Ok(serde_json::json!({
        "tag": tag,
        "changed": changed > 0,
        "replaced": { "color": replaced },
    }))
}

fn pre_known_label(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(
        find_concept(ctx.connection(), Kind::Tag, ctx.required_str("label")?)?
            .is_none()
            .then(|| "there is no such label".to_owned()),
    )
}

/// A colour is worn only by a concept kind that takes one.
fn pre_wears_a_color(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok((!takes_color(ctx.connection(), Kind::Tag)?)
        .then(|| format!("a {} wears no colour", Kind::Tag.noun())))
}

fn pre_label(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    Ok(fold_label(ctx.required_str("label")?)
        .is_empty()
        .then(|| "a tag needs a word".to_owned()))
}

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["label"],
  "anyOf": [{ "required": ["id"] }, { "required": ["ids"] }],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "ids": { "type": "array", "minItems": 1, "maxItems": 500,
             "items": { "type": "string", "minLength": 1 } },
    "label": { "type": "string", "maxLength": 200 }
  }
}"#;

/// `tag.add` also takes the colour a NEW label should wear.
const ADD_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["label"],
  "anyOf": [{ "required": ["id"] }, { "required": ["ids"] }],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "ids": { "type": "array", "minItems": 1, "maxItems": 500,
             "items": { "type": "string", "minLength": 1 } },
    "label": { "type": "string", "maxLength": 200 },
    "color": { "enum": ["blue","mustard","violet","petrol","indigo","graphite","raspberry","orchid"] }
  }
}"#;

const COLOR_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["label", "color"],
  "additionalProperties": false,
  "properties": {
    "label": { "type": "string", "maxLength": 200 },
    "color": { "enum": ["blue","mustard","violet","petrol","indigo","graphite","raspberry","orchid"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "tag.add",
            "tag",
            ADD_SCHEMA,
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
        CommandDefinition::plain(
            "tag.color",
            "tag",
            COLOR_SCHEMA,
            Idempotency::Idempotent,
            &[
                CommandCondition {
                    predicate: "label_is_a_word",
                    check: pre_label,
                },
                CommandCondition {
                    predicate: "label_exists",
                    check: pre_known_label,
                },
                CommandCondition {
                    predicate: "kind_wears_a_colour",
                    check: pre_wears_a_color,
                },
            ],
            recolor,
        ),
    ]
}
