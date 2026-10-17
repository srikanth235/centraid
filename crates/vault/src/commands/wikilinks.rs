//! WIKILINKS, COMPILED INTO `core.link` (Q-1047-9, owner ruling 2026-10-15).
//!
//! The Notes powerbox writes `[[title]]` into a body and nothing else: the text
//! is the only record of the pick, so "which notes point at this one" was a
//! question only a scan of every body could answer. The three commands that
//! change a body now compile what the text says into the vault's one
//! cross-entity mechanism (`core.link`), so a backlink is a reverse read of an
//! edge and the shelf's references and backlinks come from the vault.
//!
//! ## What a wikilink compiles to
//!
//! | | |
//! |---|---|
//! | **Relation** | `references`, the cross-referencing relation the vault seeds at founding for exactly this (`bootstrap::SEED_RELATIONS`, #272). One relation for every target type: what a link *means* is that this text names that thing. |
//! | **Asserted by** | `app`. The member wrote the words; the app derived the edge and keeps it in step with them. That is what tells a compiled edge from one the member made by hand (`core.link_entities`, always `owner`): the compile ends and re-asserts only its own. |
//! | **Targets** | every live row whose label equals the title, over the powerbox's domains — notes, people, events, tasks, documents and photographs. Locker is not among them, for the reason the powerbox's list gives. A journal entry is not a note target either, and a trashed row is not a target. |
//! | **Consent** | each target is held to `core.link_entities`' own rule: it must be readable under the caller's grant, or no edge is written. |
//!
//! ## The three rules a change here must keep
//!
//! 1. **THE TEXT IS THE SOURCE; THE EDGES ARE ITS COMPILATION.** Every body
//!    change recomputes the whole set rather than diffing the text, so the
//!    result depends on the new body and on what the vault holds now — never on
//!    the order of the edits that led here. A second compile of the same body is
//!    a no-op.
//! 2. **AN ENDED EDGE IS ENDED, NOT ERASED** (#916 R3). A wikilink deleted from
//!    the text sets `valid_to`; the row survives, and the same words typed again
//!    assert a fresh edge, which is what `valid_to` being a date is for.
//! 3. **AN ESTABLISHED EDGE IS NEVER DUPLICATED OR TAKEN.** A link the member
//!    already made by hand to the same target stands in for the compile's, and
//!    removing the wikilink does not end it: it was not the compile's to end.
//!
//! ## What this does not do, on purpose
//!
//! A title that matches nothing compiles to nothing, and **nothing re-resolves
//! it later**: the edge appears the next time the linking note's body changes
//! after a row with that title exists. A rename of the target is the same. A
//! title that matches several rows links every one of them — the text carries
//! the title and not the id, so it cannot say which was meant, and a superset
//! the member can see is a better failure than a silently chosen one. A sweep
//! that re-resolves dangling titles on target writes would be a second writer of
//! `core.link` beside this one and is not built.

use crate::commands::CommandCtx;
use crate::commands::core_links::{endpoint_refusal, relation_concept};
use crate::commands::people::{JOURNAL_ENTRY_NOTATION, JOURNAL_SCHEME_URI};
use crate::error::Result;

/// The relation a wikilink compiles to.
pub(crate) const WIKILINK_RELATION: &str = "references";

/// Who asserted a compiled edge; see the module note. The CHECK's own word.
pub(crate) const WIKILINK_ASSERTED_BY: &str = "app";

/// The most distinct edges one note's text compiles to. The shelf's own card
/// ceiling (`crates/apps/notes`, `MAX_REFS`): an edge past it could not be drawn,
/// and one pathological body must not be able to write thousands of rows.
pub(crate) const MAX_WIKILINKS: usize = 100;

/// A note's logical entity type — the `from` end of every compiled edge.
const NOTE_TYPE: &str = "knowledge.note";

/// Where a title can resolve. One statement per kind; `?1` is the title, bound
/// and never spliced. The labels are the powerbox's own (`centraid_search::DOMAINS`),
/// and the comparison is an exact, ASCII-case-insensitive one — the powerbox
/// writes the target's label verbatim, so an equal title is the pick.
const RESOLVERS: &[(&str, &str)] = &[
    (
        "core.party",
        "SELECT party_id FROM core_party
          WHERE display_name = ?1 COLLATE NOCASE AND deleted_at IS NULL ORDER BY party_id",
    ),
    (
        "core.event",
        "SELECT event_id FROM core_event
          WHERE summary = ?1 COLLATE NOCASE AND deleted_at IS NULL ORDER BY event_id",
    ),
    (
        "schedule.task",
        "SELECT task_id FROM schedule_task
          WHERE title = ?1 COLLATE NOCASE AND deleted_at IS NULL ORDER BY task_id",
    ),
    // A photograph's label is its asset's authored caption, and the powerbox
    // offers the BYTES (`core.content_item`) as the target.
    (
        "core.content_item",
        "SELECT content_id FROM media_asset
          WHERE title = ?1 COLLATE NOCASE AND deleted_at IS NULL ORDER BY content_id",
    ),
    (
        "core.document",
        "SELECT document_id FROM core_document
          WHERE title = ?1 COLLATE NOCASE AND deleted_at IS NULL ORDER BY document_id",
    ),
];

/// The titles a body names, in the order they first appear, each once.
///
/// A wikilink is `[[` … `]]` on ONE line with something between. Anything else
/// is text: an unclosed `[[` is skipped rather than swallowing what follows it,
/// and when a second `[[` opens before the first closes the second is the link.
/// Titles are trimmed and matched without regard to ASCII case, so `[[Plan]]`
/// and `[[ plan ]]` are one edge.
pub(crate) fn titles_in(text: &str) -> Vec<String> {
    let mut titles: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find("[[") {
        let after = &rest[open + 2..];
        let Some(close) = after.find("]]") else {
            break;
        };
        let inner = &after[..close];
        if let Some(nested) = inner.rfind("[[") {
            rest = &after[nested..];
            continue;
        }
        if inner.contains('\n') {
            rest = after;
            continue;
        }
        let title = inner.trim();
        if !title.is_empty() && !titles.iter().any(|seen| seen.eq_ignore_ascii_case(title)) {
            titles.push(title.to_owned());
        }
        rest = &after[close + 2..];
    }
    titles
}

/// Every live row `title` names, as `(entity, id)`, in the powerbox's own
/// domain order. A note never names itself, and a journal entry is no target.
fn resolve(ctx: &CommandCtx<'_, '_>, note_id: &str, title: &str) -> Result<Vec<(String, String)>> {
    let mut found: Vec<(String, String)> = Vec::new();
    let mut ids = ctx.connection().prepare(
        "SELECT note_id FROM knowledge_note
          WHERE title = ?1 COLLATE NOCASE AND deleted_at IS NULL AND note_id <> ?2
            AND note_id NOT IN (
              SELECT t.target_id FROM core_tag t
                JOIN core_concept c ON c.concept_id = t.concept_id
                JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
               WHERE t.target_type = 'knowledge.note' AND s.uri = ?3 AND c.notation = ?4)
          ORDER BY note_id",
    )?;
    let rows = ids.query_map(
        rusqlite::params![title, note_id, JOURNAL_SCHEME_URI, JOURNAL_ENTRY_NOTATION],
        |row| row.get::<_, String>(0),
    )?;
    for id in rows {
        found.push((NOTE_TYPE.to_owned(), id?));
    }
    for (entity, sql) in RESOLVERS {
        let mut statement = ctx.connection().prepare(sql)?;
        let rows = statement.query_map([title], |row| row.get::<_, String>(0))?;
        for id in rows {
            found.push(((*entity).to_owned(), id?));
        }
    }
    Ok(found)
}

/// The live edges this note's last compile left, as `(link_id, to_type, to_id)`.
fn compiled_edges(
    ctx: &CommandCtx<'_, '_>,
    note_id: &str,
    relation_concept_id: &str,
) -> Result<Vec<(String, String, String)>> {
    let mut statement = ctx.connection().prepare(
        "SELECT link_id, to_type, to_id FROM core_link
          WHERE from_type = ?1 AND from_id = ?2 AND relation_concept_id = ?3
            AND asserted_by = ?4 AND valid_to IS NULL
          ORDER BY link_id",
    )?;
    let rows = statement.query_map(
        rusqlite::params![
            NOTE_TYPE,
            note_id,
            relation_concept_id,
            WIKILINK_ASSERTED_BY
        ],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
}

/// Bring a note's compiled edges in step with `body_text`.
///
/// Called by every command that changes a body, after the body is written. Reads
/// first and draws no id when there is nothing to change, so a note with no
/// wikilinks costs one read and moves nothing.
pub(crate) fn compile(ctx: &CommandCtx<'_, '_>, note_id: &str, body_text: &str) -> Result<()> {
    // A vault with no relations vocabulary has nothing to compile to, and a
    // refused save is a worse answer than a note whose links wait.
    let Some(relation) = relation_concept(ctx, WIKILINK_RELATION)? else {
        return Ok(());
    };
    let existing = compiled_edges(ctx, note_id, &relation)?;
    let titles = titles_in(body_text);
    if titles.is_empty() && existing.is_empty() {
        return Ok(());
    }

    let mut wanted: Vec<(String, String)> = Vec::new();
    'titles: for title in &titles {
        for (entity, id) in resolve(ctx, note_id, title)? {
            if wanted.len() >= MAX_WIKILINKS {
                break 'titles;
            }
            // THE SAME CONSENT RULE A HAND-MADE LINK MEETS: a row the caller may
            // not read is not named by an edge, because the edge would be the
            // disclosure.
            if endpoint_refusal(ctx, "to", &entity, &id)?.is_some() {
                continue;
            }
            if !wanted.contains(&(entity.clone(), id.clone())) {
                wanted.push((entity, id));
            }
        }
    }

    for (link_id, to_type, to_id) in &existing {
        if !wanted
            .iter()
            .any(|(entity, id)| entity == to_type && id == to_id)
        {
            ctx.connection().execute(
                "UPDATE core_link SET valid_to = ?1 WHERE link_id = ?2",
                rusqlite::params![ctx.now, link_id],
            )?;
        }
    }

    for (entity, id) in &wanted {
        let held: i64 = ctx.connection().query_row(
            "SELECT COUNT(*) FROM core_link
              WHERE from_type = ?1 AND from_id = ?2 AND to_type = ?3 AND to_id = ?4
                AND relation_concept_id = ?5 AND valid_to IS NULL",
            rusqlite::params![NOTE_TYPE, note_id, entity, id, relation],
            |row| row.get(0),
        )?;
        if held != 0 {
            continue;
        }
        let link_id = ctx.next_id();
        ctx.connection().execute(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, NULL, ?7)",
            rusqlite::params![
                link_id,
                NOTE_TYPE,
                note_id,
                entity,
                id,
                relation,
                ctx.now,
                WIKILINK_ASSERTED_BY
            ],
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wikilink_is_one_line_of_words_between_double_brackets() {
        assert_eq!(
            titles_in("See [[Drive vs fly]] and [[Ana]]."),
            ["Drive vs fly", "Ana"]
        );
        assert!(titles_in("no links, [single] and [[]] and [[   ]]").is_empty());
        assert!(
            titles_in("[[spans\nlines]]").is_empty(),
            "a link does not span a line"
        );
    }

    #[test]
    fn a_title_is_trimmed_and_named_once_whatever_its_case() {
        assert_eq!(
            titles_in("[[Plan]] then [[ plan ]] then [[PLAN]]"),
            ["Plan"],
            "the first spelling is the one kept"
        );
    }

    #[test]
    fn an_unclosed_opener_does_not_swallow_what_follows_it() {
        assert_eq!(titles_in("[[a [[b]] c"), ["b"]);
        assert_eq!(titles_in("[[open\nand then [[Real]]"), ["Real"]);
        assert!(titles_in("[[never closed").is_empty());
    }
}
