//! `edge.add`, `edge.remove` and `edge.move`, and `link.add` and `link.remove`: how entities are
//! joined.
//!
//! An **edge** is a typed, directed relation (`contains`, `about`, `attached`, `with`, `related`,
//! `depicts`; `tagged` has its own verbs, `tag.*`, because what it joins to is a word the verb mints).
//! What an edge may join, whether it wears a label, a place in a list or an anchor in a note's text is
//! the `edge_shape` row for its relation: this module reads the row's attributes (`label_kind`,
//! `ordered`, `anchored`, and `*` as any `entity_kind.linkable` kind) and names no relation or kind to
//! decide any of it. The baseline's `edge_has_a_shape` trigger is the database's refusal; the
//! precondition here asks the same rows first, so a member reads a sentence rather than a constraint.
//!
//! A **link** is the member's hand-made, undirected "these two belong together" ([`crate::links`]):
//! `link.add` and `link.remove` take the two ends in either order.
//!
//! Adding or removing an edge whose shape is `anchored` (a note's `about`: where in its words the
//! member pointed) **touches the entity at its start**: the edge is part of its words. The entity it
//! points at is re-indexed, not touched, because the notes about it are part of what it is found by.
//! Any other edge (a document or a Locker item `about` a person, a photograph that `depicts` one) is
//! not part of the start's words: it keeps its place in Recents, and an `anchor` is refused on it.

use rusqlite::{Connection, OptionalExtension};

use crate::commands::entity::{lookup, lookup_live, require};
use crate::commands::tag::{ensure_concept, find_concept};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};
use crate::links;
use crate::model::{Kind, Rel, fold_label};

/// The next position at the end of an ordered relation of `?2` out of `?1`: the last entry of the
/// ordered index (`edge_order`), not every member's row (a plain `MAX(position)` cannot use the
/// partial index). `edge.add` and a restore of a member run it, and `index_walks.rs` plans it.
pub const NEXT_POSITION: &str =
    "SELECT COALESCE((SELECT position FROM edge WHERE from_id = ?1 AND rel = ?2
                         AND position IS NOT NULL ORDER BY position DESC LIMIT 1), 0) + 1";

/// What an `edge_shape` row says about an edge between two kinds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Shape {
    /// The kind of label the relation wears, if it wears one.
    pub label_kind: Option<String>,
    /// The relation keeps a `position`.
    pub ordered: bool,
    /// The edge may carry an `anchor`, and is part of its start's words.
    pub anchored: bool,
}

/// The shape that joins `from` to `to` by `rel`, if any does. `*` in a shape is any linkable kind
/// (`entity_kind.linkable`), the same attribute the edge trigger reads.
pub(crate) fn shape_of(
    connection: &Connection,
    rel: Rel,
    from: Kind,
    to: Kind,
) -> Result<Option<Shape>> {
    Ok(connection
        .query_row(
            "SELECT s.label_kind, s.ordered, s.anchored
               FROM edge_shape s, entity_kind fk, entity_kind tk
              WHERE s.rel = ?1 AND fk.code = ?2 AND tk.code = ?3
                AND (s.from_kind = fk.code OR (s.from_kind = '*' AND fk.linkable = 1))
                AND (s.to_kind = tk.code OR (s.to_kind = '*' AND tk.linkable = 1))
              ORDER BY (s.from_kind = '*') + (s.to_kind = '*'), s.from_kind, s.to_kind
              LIMIT 1",
            [rel.as_str(), from.as_str(), to.as_str()],
            |row| {
                Ok(Shape {
                    label_kind: row.get(0)?,
                    ordered: row.get(1)?,
                    anchored: row.get(2)?,
                })
            },
        )
        .optional()?)
}

fn parse_rel(word: &str) -> Result<Rel> {
    Rel::parse(word).ok_or_else(|| VaultError::InvalidInput {
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
    let rel = parse_rel(ctx.required_str("rel")?)?;
    if from.id == to.id {
        return Ok(Some("a thing cannot be joined to itself".to_owned()));
    }
    let Some(shape) = shape_of(ctx.connection(), rel, from.kind, to.kind)? else {
        return Ok(Some(format!(
            "“{}” cannot be `{}` “{}”: nothing joins a {} to a {} that way",
            from.title,
            rel.as_str(),
            to.title,
            from.kind.noun(),
            to.kind.noun()
        )));
    };
    if carries_a_sealed_value(ctx) {
        return Ok(Some(
            "a link carries no sealed value: say it in your own words".to_owned(),
        ));
    }
    let given = |key: &str| ctx.input.get(key).is_some_and(|value| !value.is_null());
    let labelled = shape.label_kind.is_some();
    let refusal = if labelled != given("label") {
        Some(if labelled {
            "say how they are related".to_owned()
        } else {
            format!("only a relation is labelled; `{}` is not one", rel.as_str())
        })
    } else if given("position") && !shape.ordered {
        Some("only what a list or album holds has a place in it".to_owned())
    } else if given("anchor") && !shape.anchored {
        Some("only a note's own words point at a place in the text".to_owned())
    } else if labelled && fold_label(ctx.required_str("label")?).is_empty() {
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

/// Join two entities, or say what is new about a join that is there: its place, its anchor. The one
/// writer of an edge row: `edge.add` and every command that founds a row and joins it (a People
/// interaction `with` someone, a journal entry `about` them) come through here, so the touch rule is
/// kept once. A relation that keeps a place (`ordered`) holds what it is given after what it has,
/// unless told a place.
pub(crate) fn put(
    ctx: &CommandCtx<'_, '_>,
    from: &str,
    rel: Rel,
    to: &str,
    label_id: Option<&str>,
    extras: &Extras,
) -> Result<()> {
    let (start, end) = (
        require(ctx.connection(), from)?,
        require(ctx.connection(), to)?,
    );
    let shape = shape_of(ctx.connection(), rel, start.kind, end.kind)?;
    let ordered = shape.as_ref().is_some_and(|shape| shape.ordered);
    let next = if ordered {
        Some(
            ctx.connection()
                .query_row(NEXT_POSITION, [from, rel.as_str()], |row| {
                    row.get::<_, f64>(0)
                })?,
        )
    } else {
        None
    };
    // An anchor is a JSON object the vault defines, so it carries "v":1 (A3).
    let anchor = match &extras.anchor {
        Some(text) => {
            let mut value: serde_json::Value =
                serde_json::from_str(text).map_err(|_| VaultError::InvalidInput {
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
    if shape.is_some_and(|shape| shape.anchored) {
        ctx.touch(from)?;
    }
    Ok(())
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

fn add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: AddEdgeInput = ctx.parse_input()?;
    let rel = parse_rel(&input.rel)?;
    let (from, to) = (
        require(ctx.connection(), &input.from)?,
        require(ctx.connection(), &input.to)?,
    );
    let shape = shape_of(ctx.connection(), rel, from.kind, to.kind)?;
    // The label is a concept of the kind the shape names, minted when the member's word is new.
    let label_id = match (
        shape.and_then(|shape| shape.label_kind),
        input.label.as_deref(),
    ) {
        (Some(kind), Some(label)) => {
            let kind = Kind::parse(&kind).ok_or_else(|| VaultError::Invariant {
                context: format!("`edge_shape` names the label kind `{kind}`, which is no kind"),
            })?;
            Some(ensure_concept(ctx, kind, label)?)
        }
        _ => None,
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
    let (from, to) = (
        require(ctx.connection(), &input.from)?,
        require(ctx.connection(), &input.to)?,
    );
    let shape = shape_of(ctx.connection(), rel, from.kind, to.kind)?;
    // A label is found by its words (`concept(kind, key)`), never built from them: a member's own
    // label has a minted id. A word no label carries names no edge.
    let label_id = match (
        shape
            .as_ref()
            .and_then(|shape| shape.label_kind.as_deref())
            .and_then(Kind::parse),
        input.label.as_deref(),
    ) {
        (Some(kind), Some(label)) => match find_concept(ctx.connection(), kind, label)? {
            Some(id) => id,
            None => return Ok(serde_json::json!({ "removed": false })),
        },
        _ => String::new(),
    };
    let removed = ctx.connection().execute(
        "DELETE FROM edge WHERE from_id = ?1 AND rel = ?2 AND to_id = ?3 AND ifnull(label_id, '') = ?4",
        rusqlite::params![input.from, rel.as_str(), input.to, label_id],
    )?;
    if removed > 0 && shape.is_some_and(|shape| shape.anchored) {
        ctx.touch(&input.from)?;
    }
    Ok(serde_json::json!({ "removed": removed > 0 }))
}

/// An edge that keeps a place (`position` is set only where the shape says `ordered`) between the
/// two: the one a move changes. Asking for the place, not the relation, names no relation.
fn pre_move(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (from, to) = (ctx.required_str("from")?, ctx.required_str("to")?);
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND to_id = ?2 AND position IS NOT NULL",
        [from, to],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| "that is not in this list".to_owned()))
}

#[derive(serde::Deserialize)]
struct MoveEdgeInput {
    from: String,
    to: String,
    position: f64,
}

/// Reorder: one update of one row's `position`.
fn move_edge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: MoveEdgeInput = ctx.parse_input()?;
    ctx.connection().execute(
        "UPDATE edge SET position = ?3 WHERE from_id = ?1 AND to_id = ?2 AND position IS NOT NULL",
        rusqlite::params![input.from, input.to, input.position],
    )?;
    Ok(serde_json::json!({ "position": input.position }))
}

/// A sentence when this entity is not an end a link joins, from `entity_kind.linkable`.
fn link_end_refusal(ctx: &CommandCtx<'_, '_>, key: &str) -> Result<Option<String>> {
    let found = match lookup_live(ctx.connection(), ctx.required_str(key)?)? {
        Ok(found) => found,
        Err(sentence) => return Ok(Some(sentence)),
    };
    links::end_refusal(ctx.connection(), &found.title, found.kind)
}

fn pre_link(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("a")? == ctx.required_str("b")? {
        return Ok(Some("a thing cannot be linked to itself".to_owned()));
    }
    for key in ["a", "b"] {
        if let Some(sentence) = link_end_refusal(ctx, key)? {
            return Ok(Some(sentence));
        }
    }
    Ok(None)
}

#[derive(serde::Deserialize)]
struct LinkInput {
    a: String,
    b: String,
}

fn link_add(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: LinkInput = ctx.parse_input()?;
    let added = links::add(ctx.connection(), &input.a, &input.b, &ctx.now)?;
    Ok(serde_json::json!({ "added": added }))
}

fn pre_unlink(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    for key in ["a", "b"] {
        if let Err(sentence) = lookup(ctx.connection(), ctx.required_str(key)?)? {
            return Ok(Some(sentence));
        }
    }
    Ok(None)
}

fn link_remove(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: LinkInput = ctx.parse_input()?;
    let removed = links::remove(ctx.connection(), &input.a, &input.b)?;
    Ok(serde_json::json!({ "removed": removed }))
}

const LINK_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["a", "b"],
  "additionalProperties": false,
  "properties": {
    "a": { "type": "string", "minLength": 1 },
    "b": { "type": "string", "minLength": 1 }
  }
}"#;

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
        CommandDefinition::plain(
            "link.add",
            "link",
            LINK_SCHEMA,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "link_joins_linkable_items",
                check: pre_link,
            }],
            link_add,
        ),
        CommandDefinition::plain(
            "link.remove",
            "link",
            LINK_SCHEMA,
            Idempotency::Idempotent,
            &[CommandCondition {
                predicate: "link_ends_exist",
                check: pre_unlink,
            }],
            link_remove,
        ),
    ]
}
