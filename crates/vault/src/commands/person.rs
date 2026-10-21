//! `person.merge`: two people who are one.
//!
//! The merged person's every reference is re-pointed at the person who stays,
//! by walking what the file says points at a person (the foreign keys into
//! `person`, read from `PRAGMA foreign_key_list`) and the `edge` table, and
//! then the merged person is purged. Nothing here lists a renting table: a
//! table added tomorrow that points at `person` is merged correctly today.
//!
//! What a merge keeps when both people say something: the surviving person's
//! own value wins, and a blank is filled from the merged person; a contact
//! point both have is kept once; a daily measurement both have is the
//! surviving person's. The merged person's source, if it was followed, becomes
//! a tombstone with the purge (`source.entity_id` nulls itself), so the contact
//! follower never adds the same contact again.

use crate::commands::entity::{lookup_live, purge_one};
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::Result;
use crate::model::Kind;

fn pre_merge(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    let (from, into) = (ctx.required_str("from")?, ctx.required_str("into")?);
    if from == into {
        return Ok(Some("a person cannot be merged into themselves".to_owned()));
    }
    for id in [from, into] {
        let found = match lookup_live(ctx.connection(), id)? {
            Ok(found) => found,
            Err(sentence) => return Ok(Some(sentence)),
        };
        if found.kind != Kind::Person {
            return Ok(Some(format!(
                "“{}” is a {}, and only people are merged",
                found.title,
                found.kind.noun()
            )));
        }
    }
    let is_you: bool =
        ctx.connection()
            .query_row("SELECT self_id = ?1 FROM vault", [from], |row| row.get(0))?;
    Ok(is_you.then(|| "this is you; merge the other person into you instead".to_owned()))
}

fn merge(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let connection = ctx.connection();
    let (loser, winner) = (ctx.required_str("from")?, ctx.required_str("into")?);

    // Edges: an edge cannot change its ends, so each is written again at the
    // surviving person and the old one goes with the purge. One that already
    // exists, or that would join the person to themselves, is dropped.
    let moved = connection.execute(
        "INSERT OR IGNORE INTO edge (from_id, rel, to_id, label_id, position, state, anchor, created_at)
         SELECT CASE from_id WHEN ?1 THEN ?2 ELSE from_id END, rel,
                CASE to_id WHEN ?1 THEN ?2 ELSE to_id END,
                label_id, position, state, anchor, created_at
           FROM edge WHERE from_id = ?1 OR to_id = ?1",
        [loser, winner],
    )?;
    // The notes about the merged person are about the survivor now.
    ctx.mark_for_index(winner);

    // A person may hold one preferred contact point of a kind; the survivor's
    // preference stands.
    connection.execute(
        "UPDATE contact_point SET preferred = 0
          WHERE person_id = ?1 AND kind IN
                (SELECT kind FROM contact_point WHERE person_id = ?2 AND preferred = 1)",
        [loser, winner],
    )?;

    // Every foreign key into `person`, wherever it is. A row that would
    // collide with one the survivor has is left behind and goes with the purge.
    let mut repointed = 0usize;
    for (table, column) in person_references(connection)? {
        repointed += connection.execute(
            &format!(
                "UPDATE OR IGNORE {} SET {} = ?2 WHERE {} = ?1",
                crate::log::quoted(&table),
                crate::log::quoted(&column),
                crate::log::quoted(&column)
            ),
            [loser, winner],
        )?;
    }

    // Blanks are filled from the person who goes.
    connection.execute(
        "UPDATE person SET
           sort_name    = COALESCE(person.sort_name, l.sort_name),
           nickname     = COALESCE(person.nickname, l.nickname),
           role         = COALESCE(person.role, l.role),
           met          = COALESCE(person.met, l.met),
           birthday     = COALESCE(person.birthday, l.birthday),
           avatar       = COALESCE(person.avatar, l.avatar),
           cadence_days = COALESCE(person.cadence_days, l.cadence_days)
         FROM (SELECT * FROM person WHERE id = ?1) AS l
         WHERE person.id = ?2",
        [loser, winner],
    )?;

    let mut purged = Vec::new();
    purge_one(ctx, loser, &mut purged)?;
    ctx.touch(winner)?;
    Ok(serde_json::json!({ "into": winner, "edges": moved, "rows": repointed }))
}

/// Every `(table, column)` with a foreign key into `person(id)`, but the
/// person's own kind-row link to its entity.
fn person_references(connection: &rusqlite::Connection) -> Result<Vec<(String, String)>> {
    let tables: Vec<String> = connection
        .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'person'
               AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
              ORDER BY name",
        )?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut found = Vec::new();
    for table in tables {
        let mut statement = connection.prepare(&format!(
            "PRAGMA foreign_key_list({})",
            crate::log::quoted(&table)
        ))?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(2)?, row.get::<_, String>(3)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        found.extend(
            rows.into_iter()
                .filter(|(target, _)| target == "person")
                .map(|(_, column)| (table.clone(), column)),
        );
    }
    Ok(found)
}

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    vec![CommandDefinition::plain(
        "person.merge",
        "person",
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
            predicate: "both_are_people",
            check: pre_merge,
        }],
        merge,
    )]
}
