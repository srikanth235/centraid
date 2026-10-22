//! `note.*`: a note's own verbs — create, edit, move, restore a version.
//!
//! A note is an entity of kind `note` whose words live on its kind row; the
//! notebook it sits in is a column of that row. Everything a member does to a
//! note that is not about its words goes through a shared verb: the trash
//! (`entity.trash`, `entity.restore`), a pin or star (`flag.set`), a tag
//! (`tag.add`), a notebook (`container.create`, `entity.retitle`), a link made
//! by hand or an attachment (`edge.add`). What is here is what only a note has.
//!
//! ## History is the words that were replaced
//!
//! An edit that changes the body writes the body it replaced as a `revision`
//! (`seq` counts up from one); the current words live only on the note. A
//! restore writes the current words as a revision and the chosen ones as
//! current, and an edit or a restore that lands on the words already there
//! writes nothing, because it revised nothing.
//!
//! ## The text is the source; the edges are its compilation (Q-1047-9)
//!
//! A `[[title]]` in a body is compiled into a `links` edge from the note to
//! every live thing that title names, in the same commit that changed the
//! words, so a backlink is a read of an edge and never a scan of bodies. The
//! compile owns the edges it writes and no others: its edges carry the anchor
//! `{"wikilink": "<title>"}`, which is how it tells them from a link the member
//! made by hand (`edge.add` with a text range), and a hand link to the same
//! thing stands in for the compiled one. A title that names nothing compiles to
//! nothing and nothing re-resolves it later; a title that names several things
//! links every one, because the text carries the title and not the id.
//!
//! A memo (a note with an `about` edge) is neither a target of a wikilink nor a
//! shelf note: it belongs to what it is about, and Notes shows it in the Journal.

use std::collections::BTreeSet;

use crate::commands::entity::lookup_live;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::Kind;

/// The most a note's words may weigh. The body is a column of a row that is
/// read whole to index, to preview and to snapshot, so a note this long is
/// refused rather than bloating the file.
pub const BODY_BUDGET_BYTES: usize = 64 * 1024;

/// The most distinct edges one note's text compiles to: the shelf's own card
/// ceiling. One pathological body cannot write thousands of rows.
pub const MAX_LINKS: usize = 100;

/// The kinds a title can resolve to, and so the powerbox's seven columns: what a
/// member can link a note to. One list, because a pick the compile could not
/// resolve would be a `[[title]]` that links nothing.
///
/// A Locker item is one (#1135): its title is plain and searchable, a link holds
/// no secret, and opening it asks Locker's gate like any Locker destination. The
/// compile resolves it for every principal, the assistant's included.
pub const LINKABLE: [Kind; 7] = [
    Kind::Note,
    Kind::Person,
    Kind::Event,
    Kind::Task,
    Kind::Document,
    Kind::Photo,
    Kind::LockerItem,
];

fn body_refusal(ctx: &CommandCtx<'_, '_>) -> Option<String> {
    let body = ctx.optional_str("body")?;
    (body.len() > BODY_BUDGET_BYTES).then(|| {
        format!(
            "That note is {} bytes of text, over the {BODY_BUDGET_BYTES}-byte budget; a note's \
             words are kept in the vault row they are indexed from, so a body this long is \
             refused rather than silently bloating the file.",
            body.len()
        )
    })
}

/// A notebook the note may be filed in: there, live and a notebook.
fn notebook_refusal(ctx: &CommandCtx<'_, '_>, notebook: Option<&str>) -> Result<Option<String>> {
    let Some(id) = notebook else {
        return Ok(None);
    };
    Ok(match lookup_live(ctx.connection(), id)? {
        Err(sentence) => Some(sentence),
        Ok(found) if found.kind != Kind::Notebook => Some(format!(
            "“{}” is a {}, not a notebook",
            found.title,
            found.kind.noun()
        )),
        Ok(_) => None,
    })
}

/// A live note: a trashed one is frozen, restore it first.
fn live_note(ctx: &CommandCtx<'_, '_>) -> Result<std::result::Result<(), String>> {
    Ok(
        match lookup_live(ctx.connection(), ctx.required_str("id")?)? {
            Err(sentence) => Err(sentence),
            Ok(found) if found.kind != Kind::Note => Err(format!(
                "“{}” is a {}, not a note",
                found.title,
                found.kind.noun()
            )),
            Ok(_) => Ok(()),
        },
    )
}

fn pre_create(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if ctx.required_str("title")?.trim().is_empty() {
        return Ok(Some("a note needs a title".to_owned()));
    }
    if let Some(sentence) = body_refusal(ctx) {
        return Ok(Some(sentence));
    }
    notebook_refusal(ctx, ctx.optional_str("notebook_id"))
}

fn pre_edit(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx)? {
        return Ok(Some(sentence));
    }
    Ok(body_refusal(ctx))
}

fn pre_move(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx)? {
        return Ok(Some(sentence));
    }
    notebook_refusal(ctx, ctx.optional_str("notebook_id"))
}

fn pre_restore_version(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    if let Err(sentence) = live_note(ctx)? {
        return Ok(Some(sentence));
    }
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM revision WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![ctx.required_str("id")?, ctx.input["seq"].as_i64()],
        |row| row.get(0),
    )?;
    Ok((held == 0).then(|| "That version is not in this note's history.".to_owned()))
}

/// Found a note: the entity, the kind row, and the edges its words compile to.
///
/// The one place a note is born, so a command of another app that writes a
/// note (a People journal entry, a task's memo) founds it the same way and then
/// adds its own `about` edge.
pub fn found(
    ctx: &CommandCtx<'_, '_>,
    id: Option<&str>,
    title: &str,
    body: &str,
    format: &str,
    notebook: Option<&str>,
) -> Result<String> {
    let title = title.trim();
    let id = match id {
        Some(id) => {
            ctx.insert_entity_as(id, Kind::Note, title)?;
            id.to_owned()
        }
        None => ctx.insert_entity(Kind::Note, title)?,
    };
    ctx.connection().execute(
        "INSERT INTO note (id, body, format, notebook_id) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, body, format, notebook],
    )?;
    compile_wikilinks(ctx, &id, body)?;
    Ok(id)
}

fn create(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = found(
        ctx,
        ctx.optional_str("id"),
        ctx.required_str("title")?,
        ctx.optional_str("body").unwrap_or_default(),
        ctx.optional_str("format").unwrap_or("markdown"),
        ctx.optional_str("notebook_id"),
    )?;
    Ok(serde_json::json!({ "id": id }))
}

/// Write the words a note is about to stop having as its newest revision.
fn keep_replaced(ctx: &CommandCtx<'_, '_>, id: &str, replaced: &str) -> Result<()> {
    ctx.connection().execute(
        "INSERT INTO revision (entity_id, seq, at, body)
         VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM revision WHERE entity_id = ?1), ?2, ?3)",
        rusqlite::params![id, ctx.now, replaced],
    )?;
    Ok(())
}

/// Set a note's words: the one path an edit and a restore both take.
/// Returns whether the words changed.
fn set_body(ctx: &CommandCtx<'_, '_>, id: &str, body: &str) -> Result<bool> {
    let current: String =
        ctx.connection()
            .query_row("SELECT body FROM note WHERE id = ?1", [id], |row| {
                row.get(0)
            })?;
    if current == body {
        return Ok(false);
    }
    keep_replaced(ctx, id, &current)?;
    ctx.connection()
        .execute("UPDATE note SET body = ?2 WHERE id = ?1", [id, body])?;
    compile_wikilinks(ctx, id, body)?;
    Ok(true)
}

fn edit(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    if let Some(body) = ctx.optional_str("body") {
        set_body(ctx, id, body)?;
    }
    if let Some(format) = ctx.optional_str("format") {
        ctx.connection()
            .execute("UPDATE note SET format = ?2 WHERE id = ?1", [id, format])?;
    }
    if let Some(title) = ctx.optional_str("title") {
        ctx.connection().execute(
            "UPDATE entity SET title = ?2 WHERE id = ?1",
            [id, title.trim()],
        )?;
    }
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id }))
}

fn move_note(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    ctx.connection().execute(
        "UPDATE note SET notebook_id = ?2 WHERE id = ?1",
        rusqlite::params![id, ctx.optional_str("notebook_id")],
    )?;
    ctx.touch(id)?;
    Ok(serde_json::json!({ "id": id }))
}

fn restore_version(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let id = ctx.required_str("id")?;
    let chosen: String = ctx.connection().query_row(
        "SELECT body FROM revision WHERE entity_id = ?1 AND seq = ?2",
        rusqlite::params![id, ctx.input["seq"].as_i64()],
        |row| row.get(0),
    )?;
    let restored = set_body(ctx, id, &chosen)?;
    if restored {
        ctx.touch(id)?;
    }
    Ok(serde_json::json!({ "id": id, "restored": restored }))
}

// ---------------------------------------------------------------------------
// Wikilinks
// ---------------------------------------------------------------------------

/// The titles a body names, in the order they first appear, each once.
///
/// A wikilink is `[[` … `]]` on ONE line with something between. Anything else
/// is text: an unclosed `[[` is skipped rather than swallowing what follows it,
/// and when a second `[[` opens before the first closes the second is the link.
/// Titles are trimmed and matched without regard to ASCII case, so `[[Plan]]`
/// and `[[ plan ]]` are one edge.
#[must_use]
pub fn wikilink_titles(body: &str) -> Vec<String> {
    let mut titles: Vec<String> = Vec::new();
    for line in body.lines() {
        let mut rest = line;
        while let Some(open) = rest.find("[[") {
            let after = &rest[open + 2..];
            let Some(close) = after.find("]]") else {
                break;
            };
            let inner = &after[..close];
            if let Some(reopened) = inner.rfind("[[") {
                // The second `[[` opened before the first closed: it is the link.
                rest = &rest[open + 2 + reopened..];
                continue;
            }
            let title = inner.trim();
            if !title.is_empty() && !titles.iter().any(|seen| seen.eq_ignore_ascii_case(title)) {
                titles.push(title.to_owned());
            }
            rest = &after[close + 2..];
        }
    }
    titles
}

/// Recompute the `links` edges a note's words compile to, and no others.
fn compile_wikilinks(ctx: &CommandCtx<'_, '_>, note: &str, body: &str) -> Result<()> {
    let connection = ctx.connection();
    connection.execute(
        "DELETE FROM edge WHERE from_id = ?1 AND rel = 'links'
            AND json_extract(anchor, '$.wikilink') IS NOT NULL",
        [note],
    )?;
    let linkable = LINKABLE
        .iter()
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    let mut resolve = connection.prepare_cached(&format!(
        "SELECT e.id FROM entity e
          WHERE e.kind IN ({linkable}) AND e.deleted_at IS NULL AND e.id <> ?1
            AND lower(e.title) = lower(?2)
            AND NOT (e.kind = 'note'
                     AND EXISTS (SELECT 1 FROM edge m WHERE m.from_id = e.id AND m.rel = 'about'))
          ORDER BY e.n"
    ))?;
    let mut linked: BTreeSet<String> = BTreeSet::new();
    for title in wikilink_titles(body) {
        let targets = resolve
            .query_map(rusqlite::params![note, title], |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for target in targets {
            if linked.len() >= MAX_LINKS {
                break;
            }
            if linked.insert(target.clone()) {
                connection.execute(
                    "INSERT OR IGNORE INTO edge (from_id, rel, to_id, anchor, created_at)
                     VALUES (?1, 'links', ?2, ?3, ?4)",
                    rusqlite::params![
                        note,
                        target,
                        serde_json::json!({ "wikilink": title }).to_string(),
                        ctx.now
                    ],
                )?;
            }
        }
    }
    Ok(())
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const CREATE: &[CommandCondition] = &[CommandCondition {
        predicate: "note_has_a_title_a_body_within_budget_and_a_notebook",
        check: pre_create,
    }];
    const EDIT: &[CommandCondition] = &[CommandCondition {
        predicate: "note_is_live_and_body_within_budget",
        check: pre_edit,
    }];
    const MOVE: &[CommandCondition] = &[CommandCondition {
        predicate: "note_is_live_and_notebook_exists",
        check: pre_move,
    }];
    const RESTORE: &[CommandCondition] = &[CommandCondition {
        predicate: "note_is_live_and_version_is_its_own",
        check: pre_restore_version,
    }];
    vec![
        CommandDefinition::plain(
            "note.create",
            "note",
            r#"{
              "type": "object",
              "required": ["title"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "body": { "type": "string" },
                "format": { "type": "string", "enum": ["markdown", "plain"] },
                "notebook_id": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Once,
            CREATE,
            create,
        ),
        CommandDefinition::plain(
            "note.edit",
            "note",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "title": { "type": "string", "maxLength": 1000 },
                "body": { "type": "string" },
                "format": { "type": "string", "enum": ["markdown", "plain"] }
              }
            }"#,
            Idempotency::Idempotent,
            EDIT,
            edit,
        ),
        CommandDefinition::plain(
            "note.move",
            "note",
            r#"{
              "type": "object",
              "required": ["id"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "notebook_id": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            MOVE,
            move_note,
        ),
        CommandDefinition::plain(
            "note.restore_version",
            "note",
            r#"{
              "type": "object",
              "required": ["id", "seq"],
              "additionalProperties": false,
              "properties": {
                "id": { "type": "string", "minLength": 1 },
                "seq": { "type": "integer", "minimum": 1 }
              }
            }"#,
            Idempotency::Idempotent,
            RESTORE,
            restore_version,
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::wikilink_titles;

    #[test]
    fn a_wikilink_is_two_brackets_on_one_line_with_something_between() {
        assert_eq!(
            wikilink_titles("see [[Plan]] and [[ plan ]] and [[Mum]]"),
            ["Plan", "Mum"]
        );
        assert!(wikilink_titles("[[]] [[   ]] [[unclosed").is_empty());
        assert!(wikilink_titles("[[one\ntwo]]").is_empty());
        assert_eq!(wikilink_titles("[[a [[b]]"), ["b"]);
    }
}
