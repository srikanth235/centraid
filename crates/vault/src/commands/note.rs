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
//! A journal entry (a note about the owner) is neither a target of a wikilink nor a shelf
//! note: Notes shows it in the Journal. A note about anything else is the member's note,
//! and a link may name it.

use std::collections::BTreeSet;

use rusqlite::OptionalExtension;

use crate::commands::tag::{ensure_concept, next_color, set_tagged};

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
                     AND EXISTS (SELECT 1 FROM edge m WHERE m.from_id = e.id AND m.rel = 'about'
                                    AND m.to_id = (SELECT self_id FROM vault)))
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

// ---------------------------------------------------------------------------
// Import and export (#1173, item 14)
// ---------------------------------------------------------------------------

use crate::commands::note_portable::{self as portable, Entry, Parsed, SourceFile};

/// The most files one import takes.
const IMPORT_MAX_FILES: usize = 5_000;

/// The files, as an array or (how a screen's act carries a list) as JSON text of one.
fn source_files(ctx: &CommandCtx<'_, '_>) -> Vec<SourceFile> {
    let listed = match ctx.input.get("files") {
        Some(serde_json::Value::String(text)) => {
            serde_json::from_str::<Vec<serde_json::Value>>(text).unwrap_or_default()
        }
        Some(serde_json::Value::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    listed
        .iter()
        .take(IMPORT_MAX_FILES)
        .filter_map(|file| {
            Some(SourceFile {
                path: file.get("path")?.as_str()?.to_owned(),
                text: file.get("text")?.as_str()?.to_owned(),
            })
        })
        .collect()
}

fn pre_import(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let too_long = source_files(ctx)
        .iter()
        .any(|file| file.text.len() > BODY_BUDGET_BYTES);
    Ok(too_long.then(|| "A note this long cannot be imported.".to_owned()))
}

/// Whether a live note already has these words under this title.
fn already_there(ctx: &CommandCtx<'_, '_>, parsed: &Parsed) -> Result<bool> {
    let held: i64 = ctx.connection().query_row(
        "SELECT COUNT(*) FROM entity e JOIN note n ON n.id = e.id
          WHERE e.kind = 'note' AND e.deleted_at IS NULL
            AND lower(e.title) = lower(?1) AND n.body = ?2",
        rusqlite::params![parsed.title, parsed.body],
        |row| row.get(0),
    )?;
    Ok(held > 0)
}

/// Whether a title names something a link may be made to: a live thing already in the vault.
fn names_something(ctx: &CommandCtx<'_, '_>, title: &str) -> Result<bool> {
    let linkable = LINKABLE
        .iter()
        .map(|kind| format!("'{}'", kind.as_str()))
        .collect::<Vec<_>>()
        .join(", ");
    let held: i64 = ctx.connection().query_row(
        &format!(
            "SELECT COUNT(*) FROM entity WHERE kind IN ({linkable}) AND deleted_at IS NULL
                AND lower(title) = lower(?1)"
        ),
        [title],
        |row| row.get(0),
    )?;
    Ok(held > 0)
}

/// A name safe as a file name (the export's stem).
pub(crate) fn portable_stem(title: &str) -> String {
    portable::file_stem(title)
}

fn notebook_named(ctx: &CommandCtx<'_, '_>, title: &str) -> Result<String> {
    let found: Option<String> = ctx
        .connection()
        .query_row(
            "SELECT id FROM entity WHERE kind = 'notebook' AND deleted_at IS NULL
                AND lower(title) = lower(?1) ORDER BY n LIMIT 1",
            [title],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = found {
        return Ok(id);
    }
    let id = ctx.insert_entity(Kind::Notebook, title)?;
    ctx.connection().execute(
        "INSERT INTO container (id, kind, parent_id, position)
         VALUES (?1, 'notebook', NULL,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM container
                   WHERE kind = 'notebook' AND parent_id IS NULL))",
        [&id],
    )?;
    Ok(id)
}

/// `note.import`: read Markdown and text files as notes, with their `[[links]]` and
/// `#tags` as real links and tags. With `dry_run` it writes nothing and answers what
/// importing would do, for the preview the member confirms. A note the vault already has
/// (same title, same words) is skipped, so importing twice adds nothing.
fn import(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let dry_run = ctx
        .input
        .get("dry_run")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let files = source_files(ctx);
    let total = files.len();
    let parsed: Vec<Parsed> = files.iter().filter_map(portable::parse).collect();
    let ignored = total - parsed.len();
    let mut fresh: Vec<Parsed> = Vec::new();
    let mut skipped = 0_usize;
    for note in parsed {
        let twin = fresh
            .iter()
            .any(|seen| seen.title.eq_ignore_ascii_case(&note.title) && seen.body == note.body);
        if twin || already_there(ctx, &note)? {
            skipped += 1;
        } else {
            fresh.push(note);
        }
    }
    let tags: BTreeSet<String> = fresh
        .iter()
        .flat_map(|note| note.tags.iter().map(|tag| tag.to_lowercase()))
        .collect();
    let notebooks: BTreeSet<String> = fresh
        .iter()
        .filter_map(|note| note.notebook.as_ref().map(|name| name.to_lowercase()))
        .collect();
    let imported_titles: BTreeSet<String> =
        fresh.iter().map(|note| note.title.to_lowercase()).collect();
    let (mut links, mut unresolved) = (0_usize, 0_usize);
    for note in &fresh {
        for title in wikilink_titles(&note.body) {
            if imported_titles.contains(&title.to_lowercase()) || names_something(ctx, &title)? {
                links += 1;
            } else {
                unresolved += 1;
            }
        }
    }
    let mut report = serde_json::json!({
        "notes": fresh.len(),
        "skipped": skipped,
        "ignored": ignored,
        "tags": tags.len(),
        "notebooks": notebooks.len(),
        "links": links,
        "unresolved": unresolved,
        "dry_run": dry_run,
    });
    if dry_run {
        return Ok(report);
    }
    let mut books: std::collections::BTreeMap<String, String> = std::collections::BTreeMap::new();
    let mut made: Vec<(String, String)> = Vec::new();
    for note in &fresh {
        let notebook = match &note.notebook {
            Some(name) => {
                let key = name.to_lowercase();
                if !books.contains_key(&key) {
                    books.insert(key.clone(), notebook_named(ctx, name)?);
                }
                books.get(&key).cloned()
            }
            None => None,
        };
        let id = found(
            ctx,
            None,
            &note.title,
            &note.body,
            "markdown",
            notebook.as_deref(),
        )?;
        for tag in &note.tags {
            let known: i64 = ctx.connection().query_row(
                "SELECT COUNT(*) FROM concept WHERE kind = 'tag' AND key = ?1",
                [crate::model::fold_label(tag)],
                |row| row.get(0),
            )?;
            let concept = ensure_concept(ctx, Kind::Tag, tag)?;
            if known == 0 {
                ctx.connection().execute(
                    "UPDATE concept SET color = ?2 WHERE id = ?1",
                    [concept.as_str(), next_color(ctx)?],
                )?;
            }
            set_tagged(ctx, &id, &concept, true)?;
        }
        made.push((id, note.body.clone()));
    }
    // A link to a note imported after the one that names it resolves now that all are there.
    for (id, body) in &made {
        compile_wikilinks(ctx, id, body)?;
    }
    report["ids"] = serde_json::json!(made.iter().map(|(id, _)| id).collect::<Vec<_>>());
    Ok(report)
}

/// `note.export`: the member's notes (a notebook's, or all) as Markdown files in an archive,
/// a folder per notebook, `[[links]]` as written, tags in front matter. Writes nothing.
/// Journal entries are People's and are not exported here.
fn export(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let notebook = ctx.optional_str("notebook_id");
    let mut scope: BTreeSet<String> = BTreeSet::new();
    let mut archive_name = "Notes".to_owned();
    if let Some(id) = notebook {
        let title: Option<String> = ctx
            .connection()
            .query_row("SELECT title FROM entity WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        archive_name = title.map_or_else(|| "Notes".to_owned(), |t| portable::file_stem(&t));
        scope.insert(id.to_owned());
        let mut children = ctx.connection().prepare_cached(
            "SELECT c.id FROM container c JOIN entity e ON e.id = c.id
              WHERE c.parent_id = ?1 AND c.kind = 'notebook' AND e.deleted_at IS NULL",
        )?;
        let mut frontier = vec![id.to_owned()];
        while let Some(next) = frontier.pop() {
            let ids = children
                .query_map([&next], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for child in ids {
                if scope.insert(child.clone()) {
                    frontier.push(child);
                }
            }
        }
    }
    let mut statement = ctx.connection().prepare_cached(
        "SELECT e.id, e.title, n.body, nb.title
           FROM entity e JOIN note n ON n.id = e.id
           LEFT JOIN entity nb ON nb.id = n.notebook_id AND nb.deleted_at IS NULL
          WHERE e.kind = 'note' AND e.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM edge m WHERE m.from_id = e.id AND m.rel = 'about'
                              AND m.to_id = (SELECT self_id FROM vault))
            AND (?1 = 0 OR n.notebook_id IN (SELECT value FROM json_each(?2)))
          ORDER BY e.n",
    )?;
    let rows = statement
        .query_map(
            rusqlite::params![
                i64::from(notebook.is_some()),
                serde_json::to_string(&scope).unwrap_or_default()
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tags = ctx.connection().prepare_cached(
        "SELECT c.key FROM edge t JOIN concept c ON c.id = t.to_id AND c.kind = 'tag'
          WHERE t.from_id = ?1 AND t.rel = 'tagged' ORDER BY c.key",
    )?;
    let mut used: BTreeSet<String> = BTreeSet::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (id, title, body, book) in rows {
        let labels = tags
            .query_map([&id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let folder = book.map(|name| portable::file_stem(&name));
        let stem = portable::file_stem(&title);
        let mut path = match &folder {
            Some(folder) => format!("{folder}/{stem}.md"),
            None => format!("{stem}.md"),
        };
        let mut again = 1;
        while !used.insert(path.to_lowercase()) {
            again += 1;
            path = match &folder {
                Some(folder) => format!("{folder}/{stem} {again}.md"),
                None => format!("{stem} {again}.md"),
            };
        }
        entries.push(Entry {
            path,
            bytes: portable::markdown_of(&title, &body, &labels).into_bytes(),
        });
    }
    let count = entries.len();
    let bytes = portable::zip(&entries);
    Ok(serde_json::json!({
        "name": format!("{archive_name}.zip"),
        "media_type": "application/zip",
        "count": count,
        "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
    }))
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
    const IMPORT: &[CommandCondition] = &[CommandCondition {
        predicate: "files_are_notes_within_budget",
        check: pre_import,
    }];
    vec![
        CommandDefinition::plain(
            "note.import",
            "note",
            r#"{
              "type": "object",
              "required": ["files"],
              "additionalProperties": false,
              "properties": {
                "files": { "type": ["array", "string"] },
                "dry_run": { "type": "boolean" }
              }
            }"#,
            Idempotency::Idempotent,
            IMPORT,
            import,
        ),
        CommandDefinition::plain(
            "note.export",
            "note",
            r#"{
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "notebook_id": { "type": ["string", "null"] }
              }
            }"#,
            Idempotency::Idempotent,
            &[],
            export,
        ),
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
