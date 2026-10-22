//! `edge.add`, `edge.remove` and `edge.move`: how entities are joined.
//!
//! One verb for every relation but `tagged`, which has its own two (`tag.*`,
//! `flag.*`) because what it joins to is a word the verb mints. The baseline's
//! `edge_has_a_shape` trigger is the engine's refusal; the precondition here
//! asks the same `edge_shape` rows first, so a member reads a sentence rather
//! than a constraint.
//!
//! Adding or removing an `about` or `links` edge **touches the entity at its
//! start**: the note whose words the edge is part of. The entity it points at
//! is re-indexed, not touched, because the notes about it are part of what it
//! is found by.

use crate::commands::entity::{lookup, lookup_live, require};
use crate::commands::tag::ensure_concept;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::{Kind, Rel, concept_id, fold_label};

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
    let allowed: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM edge_shape
          WHERE rel = ?1 AND from_kind IN (?2, '*') AND to_kind IN (?3, '*')",
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
    } else if given("state") && rel != Rel::Attendee {
        Some("only an invitee has an answer".to_owned())
    } else if given("anchor") && !rel.belongs_to_note() {
        Some("only a note's own words point at a place in the text".to_owned())
    } else if related && fold_label(ctx.required_str("label")?).is_empty() {
        Some("say how they are related".to_owned())
    } else {
        None
    };
    Ok(refusal)
}

/// What an edge may carry beyond its two ends and its label.
#[derive(Default)]
pub(crate) struct Extras<'a> {
    pub position: Option<f64>,
    pub state: Option<&'a str>,
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
    extras: &Extras<'_>,
) -> Result<()> {
    let next = if rel == Rel::Contains {
        Some(ctx.connection().query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM edge WHERE from_id = ?1 AND rel = 'contains'",
            [from],
            |row| row.get::<_, f64>(0),
        )?)
    } else {
        None
    };
    ctx.connection().execute(
        "INSERT INTO edge (from_id, rel, to_id, label_id, position, state, anchor, created_at)
         VALUES (?1, ?2, ?3, ?4, COALESCE(?5, ?6), ?7, ?8, ?9)
         ON CONFLICT (from_id, rel, to_id, ifnull(label_id, ''))
         DO UPDATE SET position = COALESCE(?5, position),
                       state = COALESCE(?7, state),
                       anchor = COALESCE(?8, anchor)",
        rusqlite::params![
            from,
            rel.as_str(),
            to,
            label_id,
            extras.position,
            next,
            extras.state,
            extras.anchor,
            ctx.now
        ],
    )?;
    if rel.belongs_to_note() {
        ctx.touch(from)?;
        ctx.mark_for_index(to);
    }
    mark_labelled(ctx, from, rel, to);
    Ok(())
}

/// A list or an album is part of the text of what it holds, and a relation's
/// label of both people it joins ([`crate::index::text_of`]): putting such an
/// edge in place or taking it away changes their text without changing them.
fn mark_labelled(ctx: &CommandCtx<'_, '_>, from: &str, rel: Rel, to: &str) {
    match rel {
        Rel::Contains => ctx.mark_for_index(to),
        Rel::Related => {
            ctx.mark_for_index(from);
            ctx.mark_for_index(to);
        }
        _ => {}
    }
}

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let rel = rel_of(ctx)?;
    let label_id = if rel == Rel::Related {
        Some(ensure_concept(
            ctx,
            Kind::Relation,
            ctx.required_str("label")?,
        )?)
    } else {
        None
    };
    put(
        ctx,
        ctx.required_str("from")?,
        rel,
        ctx.required_str("to")?,
        label_id.as_deref(),
        &Extras {
            position: ctx
                .input
                .get("position")
                .and_then(serde_json::Value::as_f64),
            state: ctx.optional_str("state"),
            anchor: ctx
                .input
                .get("anchor")
                .filter(|value| !value.is_null())
                .map(serde_json::Value::to_string),
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

fn remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let from = ctx.required_str("from")?;
    let to = ctx.required_str("to")?;
    let rel = rel_of(ctx)?;
    let label_id = ctx
        .optional_str("label")
        .map(|label| concept_id(Kind::Relation, &fold_label(label)))
        .unwrap_or_default();
    let removed = ctx.connection().execute(
        "DELETE FROM edge WHERE from_id = ?1 AND rel = ?2 AND to_id = ?3 AND ifnull(label_id, '') = ?4",
        rusqlite::params![from, rel.as_str(), to, label_id],
    )?;
    if removed > 0 && rel.belongs_to_note() {
        ctx.touch(from)?;
        ctx.mark_for_index(to);
    }
    if removed > 0 {
        mark_labelled(ctx, from, rel, to);
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

fn move_edge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let (from, to) = (ctx.required_str("from")?, ctx.required_str("to")?);
    require(ctx.connection(), from)?;
    let position = ctx
        .input
        .get("position")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or_default();
    ctx.connection().execute(
        "UPDATE edge SET position = ?3 WHERE from_id = ?1 AND rel = 'contains' AND to_id = ?2",
        rusqlite::params![from, to, position],
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
                         "enum": ["contains", "about", "links", "attached", "attendee", "with", "related"] },
                "to": { "type": "string", "minLength": 1 },
                "label": { "type": ["string", "null"], "maxLength": 200 },
                "position": { "type": ["number", "null"] },
                "state": { "type": ["string", "null"],
                           "enum": ["needs-action", "accepted", "declined", "tentative", null] },
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
                         "enum": ["contains", "about", "links", "attached", "attendee", "with", "related"] },
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
