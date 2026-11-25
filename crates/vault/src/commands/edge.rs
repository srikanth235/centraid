//! `edge.add`, `edge.remove` and `edge.move`: how entities are joined.
//!
//! One verb for every relation but `tagged`, which has its own two (`tag.*`,
//! `flag.*`) because what it joins to is a word the verb mints. The baseline's
//! `edge_has_a_shape` trigger is the engine's refusal; the precondition here
//! asks the same `edge_shape` rows first, so a member reads a sentence rather
//! than a constraint.
//!
//! Adding or removing an `about` or `links` edge **touches the entity at its
//! start when that is a note**: the note whose words the edge is part of. The
//! entity it points at is re-indexed, not touched, because the notes about it
//! are part of what it is found by. A document, a line or a Locker item that is
//! `about` a person, or a photograph that `depicts` one, is not a note: the edge
//! is not part of its words, so it keeps its place in Recents, and an `anchor`
//! (a place in a note's text) is refused on it.

use crate::commands::entity::{lookup, lookup_live, require};
use crate::commands::tag::ensure_concept;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::{Kind, Rel, concept_id, fold_label};

/// The next position at the end of a list: the last entry of the ordered index (`edge_order`),
/// not every member's row (a plain `MAX(position)` cannot use the partial index). `edge.add` and a
/// restore of a member run it, and `index_walks.rs` plans it.
pub const NEXT_POSITION: &str =
    "SELECT COALESCE((SELECT position FROM edge WHERE from_id = ?1 AND rel = 'contains'
                         AND position IS NOT NULL ORDER BY position DESC LIMIT 1), 0) + 1";

fn rel_of(ctx: &CommandCtx<'_, '_>) -> Result<Rel> {
    let word = ctx.required_str("rel")?;
    Rel::parse(word).ok_or_else(|| crate::error::VaultError::InvalidInput {
        name: "rel".to_owned(),
        detail: format!("`{word}` is not a way things are joined"),
    })
}

fn pre_add(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let from = match lookup_live(ctx.connection(), ctx.required_str("from")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let to = match lookup_live(ctx.connection(), ctx.required_str("to")?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    let rel = rel_of(ctx)?;
    if from.id == to.id {
        return Ok(Some("a thing cannot be joined to itself".to_owned()));
    }
    // A `*` in a shape is any LINKABLE kind (`entity_kind.linkable`), as the shape trigger reads it.
    let allowed: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM edge_shape s, entity_kind fk, entity_kind tk
          WHERE s.rel = ?1 AND fk.code = ?2 AND tk.code = ?3
            AND (s.from_kind = fk.code OR (s.from_kind = '*' AND fk.linkable = 1))
            AND (s.to_kind = tk.code OR (s.to_kind = '*' AND tk.linkable = 1))",
        [rel.as_str(), from.kind.as_str(), to.kind.as_str()],
        |row| row.get(0),
    )?;
    if allowed == 0 {
        return Ok(Some(format!(
            "“{}” cannot be `{}` “{}”: nothing joins a {} to a {} that way",
            from.title,
            rel.as_str(),
            to.title,
            from.kind.noun(),
            to.kind.noun()
        )));
    }
    if carries_a_sealed_value(ctx) {
        return Ok(Some(
            "a link carries no sealed value: say it in your own words".to_owned(),
        ));
    }
    let given = |key: &str| ctx.input.get(key).is_some_and(|value| !value.is_null());
    let related = rel == Rel::Related;
    let refusal = if related != given("label") {
        Some(if related {
            "say how they are related".to_owned()
        } else {
            format!("only a relation is labelled; `{}` is not one", rel.as_str())
        })
    } else if given("position") && rel != Rel::Contains {
        Some("only what a list or album holds has a place in it".to_owned())
    } else if given("anchor") && !(rel.belongs_to_note() && from.kind == Kind::Note) {
        Some("only a note's own words point at a place in the text".to_owned())
    } else if related && fold_label(ctx.required_str("label")?).is_empty() {
        Some("say how they are related".to_owned())
    } else {
        None
    };
    Ok(refusal)
}

/// Whether a word of the edge's label, or of any string in its anchor, is a Locker
/// ciphertext (#1173, O4). An edge is read by every app that may read edges, so a sealed
/// value in a label or an anchor would leave the wall by being a word of a link. Nothing
/// legitimate says one: a label names a relation, an anchor names a place in a note's text.
fn carries_a_sealed_value(ctx: &CommandCtx<'_, '_>) -> bool {
    fn sealed_in(value: &serde_json::Value) -> bool {
        match value {
            serde_json::Value::String(text) => text
                .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | ';'))
                .any(crate::custody::locker_key::is_locker_ciphertext),
            serde_json::Value::Array(items) => items.iter().any(sealed_in),
            serde_json::Value::Object(map) => map.values().any(sealed_in),
            _ => false,
        }
    }
    ["label", "anchor"]
        .iter()
        .filter_map(|key| ctx.input.get(key))
        .any(sealed_in)
}

/// What an edge may carry beyond its two ends and its label.
#[derive(Default)]
pub(crate) struct Extras {
    pub position: Option<f64>,
    pub anchor: Option<String>,
}

/// Join two entities, or say what is new about a join that is there: its place,
/// its answer, its anchor. The one writer of an edge row: `edge.add` and every
/// command that founds a row and joins it (a People interaction `with` someone,
/// a journal entry `about` them) come through here, so the touch rule is kept
/// once. A list holds what it is given after what it has, unless told a place.
pub(crate) fn put(
    ctx: &CommandCtx<'_, '_>,
    from: &str,
    rel: Rel,
    to: &str,
    label_id: Option<&str>,
    extras: &Extras,
) -> Result<()> {
    let next = if rel == Rel::Contains {
        Some(
            ctx.connection()
                .query_row(NEXT_POSITION, [from], |row| row.get::<_, f64>(0))?,
        )
    } else {
        None
    };
    // An anchor is a JSON object the vault defines, so it carries "v":1 (A3).
    let anchor = match &extras.anchor {
        Some(text) => {
            let mut value: serde_json::Value =
                serde_json::from_str(text).map_err(|_| crate::error::VaultError::InvalidInput {
                    name: "anchor".to_owned(),
                    detail: "an anchor is an object".to_owned(),
                })?;
            if let Some(object) = value.as_object_mut() {
                object.insert("v".to_owned(), serde_json::json!(1));
            }
            Some(value.to_string())
        }
        None => None,
    };
    ctx.connection().execute(
        "INSERT INTO edge (from_id, rel, to_id, label_id, position, anchor, created_at)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5, ?6), ?7, ?8)
         ON CONFLICT (from_id, rel, to_id, ifnull(label_id, ''))
         DO UPDATE SET position = COALESCE(?5, position),
                       anchor = COALESCE(?7, anchor)",
        rusqlite::params![
            from,
            rel.as_str(),
            to,
            label_id,
            extras.position,
            next,
            anchor,
            ctx.now
        ],
    )?;
    if rel.belongs_to_note() && is_note(ctx, from)? {
        ctx.touch(from)?;
    }
    Ok(())
}

fn is_kind(ctx: &CommandCtx<'_, '_>, id: &str, kind: Kind) -> Result<bool> {
    let found: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM entity WHERE id = ?1 AND kind = ?2",
        [id, kind.as_str()],
        |row| row.get(0),
    )?;
    Ok(found == 1)
}

fn is_note(ctx: &CommandCtx<'_, '_>, id: &str) -> Result<bool> {
    is_kind(ctx, id, Kind::Note)
}

#[derive(serde::Deserialize)]
struct AddEdgeInput {
    from: String,
    rel: String,
    to: String,
    label: Option<String>,
    position: Option<f64>,
    anchor: Option<serde_json::Value>,
}

fn parse_rel(word: &str) -> Result<Rel> {
    Rel::parse(word).ok_or_else(|| crate::error::VaultError::InvalidInput {
        name: "rel".to_owned(),
        detail: format!("`{word}` is not a way things are joined"),
    })
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AddEdgeInput = ctx.parse_input()?;
    let rel = parse_rel(&input.rel)?;
    let label_id = if rel == Rel::Related {
        let label =
            input
                .label
                .as_deref()
                .ok_or_else(|| crate::error::VaultError::InvalidInput {
                    name: "label".to_owned(),
                    detail: "a required string is missing".to_owned(),
                })?;
        Some(ensure_concept(ctx, Kind::Relation, label)?)
    } else {
        None
    };
    put(
        ctx,
        &input.from,
        rel,
        &input.to,
        label_id.as_deref(),
        &Extras {
            position: input.position,
            anchor: input
                .anchor
                .filter(|value| !value.is_null())
                .map(|value| value.to_string()),
        },
    )?;
    Ok(serde_json::json!({ "label": label_id }))
}

fn pre_remove(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    for key in ["from", "to"] {
        if let Err(sentence) = lookup(ctx.connection(), ctx.required_str(key)?)? {
            return Ok(Some(sentence));
        }
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct RemoveEdgeInput {
    from: String,
    rel: String,
    to: String,
    label: Option<String>,
}

fn remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: RemoveEdgeInput = ctx.parse_input()?;
    let rel = parse_rel(&input.rel)?;
    let label_id = input
        .label
        .as_deref()
        .map(|label| concept_id(Kind::Relation, &fold_label(label)))
        .unwrap_or_default();
    let removed = ctx.connection().execute(
        "DELETE FROM edge WHERE from_id = ?1 AND rel = ?2 AND to_id = ?3 AND ifnull(label_id, '') = ?4",
        rusqlite::params![input.from, rel.as_str(), input.to, label_id],
    )?;
    if removed > 0 && rel.belongs_to_note() && is_note(ctx, &input.from)? {
        ctx.touch(&input.from)?;
    }
    Ok(serde_json::json!({ "removed": removed > 0 }))
}

fn pre_move(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (from, to) = (ctx.required_str("from")?, ctx.required_str("to")?);
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'contains' AND to_id = ?2",
        [from, to],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| "that is not in this list".to_owned()))
}

#[derive(serde::Deserialize)]
struct MoveEdgeInput {
    from: String,
    to: String,
    position: Option<f64>,
}

fn move_edge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: MoveEdgeInput = ctx.parse_input()?;
    require(ctx.connection(), &input.from)?;
    let position = input.position.unwrap_or_default();
    ctx.connection().execute(
        "UPDATE edge SET position = ?3 WHERE from_id = ?1 AND rel = 'contains' AND to_id = ?2",
        rusqlite::params![input.from, input.to, position],
    )?;
    Ok(serde_json::json!({ "position": position }))
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![
        CommandDefinition::plain(
            "edge.add",
            "edge",
            r#"{
              "type": "object",
              "required": ["from", "rel", "to"],
              "additionalProperties": false,
              "properties": {
                "from": { "type": "string", "minLength": 1 },
                "rel": { "type": "string",
                         "enum": ["contains", "tagged", "about", "attached", "with", "related", "depicts"] },
                "to": { "type": "string", "minLength": 1 },
                "label": { "type": ["string", "null"], "maxLength": 200 },
                "position": { "type": ["number", "null"] },
                "anchor": { "type": ["object", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "edge_joins_what_it_may",
                check: pre_add,
            }],
            add,
        ),
        CommandDefinition::plain(
            "edge.remove",
            "edge",
            r#"{
              "type": "object",
              "required": ["from", "rel", "to"],
              "additionalProperties": false,
              "properties": {
                "from": { "type": "string", "minLength": 1 },
                "rel": { "type": "string",
                         "enum": ["contains", "tagged", "about", "attached", "with", "related", "depicts"] },
                "to": { "type": "string", "minLength": 1 },
                "label": { "type": ["string", "null"], "maxLength": 200 }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "edge_ends_exist",
                check: pre_remove,
            }],
            remove,
        ),
        CommandDefinition::plain(
            "edge.move",
            "edge",
            r#"{
              "type": "object",
              "required": ["from", "to", "position"],
              "additionalProperties": false,
              "properties": {
                "from": { "type": "string", "minLength": 1 },
                "to": { "type": "string", "minLength": 1 },
                "position": { "type": "number" }
              }
            }"#,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "item_is_in_the_list",
                check: pre_move,
            }],
            move_edge,
        ),
    ]
}
