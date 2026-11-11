//! Putting an earlier version back.
//!
//! A restore is an ordinary write: it sets the entity's title, kind row and child rows to what
//! the version holds, through the same tables an edit writes (so every CHECK, foreign key and
//! trigger holds, and a refusal is the table's own sentence), stamps the entity (so the search
//! index follows) and runs what an ordinary edit of the kind derives afterwards (a note's links).
//! The commit then keeps the state it replaced as a new version, so a restore is undone by
//! restoring again.
//!
//! Only columns that differ are written, so a restore to what is already held writes nothing,
//! and a `BEFORE UPDATE OF` rule on a column the version does not change is not woken.
//!
//! A column that points at something that is gone (a place that was purged, bytes that were
//! collected) is left as it is and named in [`Restored::kept_current`]: the rest of the version
//! comes back, and nothing is made to point at nothing.

use rusqlite::types::Value as Sql;
use serde_json::Value as Json;

use super::read::{current_state, key_of, version_state};
use super::shape::{CONTENT, Part, shape};
use crate::canonical::canonical_json;
use crate::commands::CommandCtx;
use crate::error::Result;

/// What a restore did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    /// Whether anything was written: a version equal to what is held restores nothing.
    pub restored: bool,
    /// The fields left as they were because what they point at is gone.
    pub kept_current: Vec<String>,
}

/// How much of a version a restore puts back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Everything the version captured.
    All,
    /// Only the entity's content: a note's words, a document's bytes.
    Content,
}

/// Put version `seq` of entity `id` back. `None` when the entity has no such version.
///
/// # Errors
/// A database error, including a table's own refusal of the state.
pub fn restore_version(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    seq: i64,
    scope: Scope,
) -> Result<Option<Restored>> {
    let connection = ctx.connection();
    let Some(wanted) = version_state(connection, id, seq)? else {
        return Ok(None);
    };
    let Some(now) = current_state(connection, id)? else {
        return Ok(None);
    };
    let shape = shape(connection)?;
    let mut writer = Writer {
        ctx,
        id,
        changed: false,
        kept: Vec::new(),
    };
    if scope == Scope::All
        && let (Some(was), Some(is)) = (
            wanted.pointer("/entity/title").and_then(Json::as_str),
            now.pointer("/entity/title").and_then(Json::as_str),
        )
        && was != is
    {
        connection.execute("UPDATE entity SET title = ?2 WHERE id = ?1", [id, was])?;
        writer.changed = true;
    }
    for part in shape.hosts() {
        let (Some(wanted_row), Some(held_row)) = (
            wanted.get(part.name).filter(|row| row.is_object()),
            now.get(part.name).filter(|row| row.is_object()),
        ) else {
            continue;
        };
        let only: Option<Vec<&str>> = (scope == Scope::Content).then(|| {
            CONTENT
                .iter()
                .filter(|(table, _, _)| *table == part.name)
                .map(|(_, column, _)| *column)
                .collect()
        });
        writer.update(part, wanted_row, held_row, &[], only.as_deref())?;
    }
    if scope == Scope::All {
        for host in shape.hosts() {
            if now.get(host.name).is_none_or(Json::is_null) {
                continue;
            }
            for child in shape.children_of(host.name) {
                // A link has no direction a member can see: the two directions are restored as
                // one set, below.
                if LINKS.contains(&child.alias) {
                    continue;
                }
                let (Some(wanted_rows), Some(held_rows)) =
                    (wanted.get(child.alias), now.get(child.alias))
                else {
                    continue;
                };
                writer.child(child, wanted_rows, held_rows)?;
            }
        }
    }
    if scope == Scope::All {
        writer.links(shape, &wanted, &now)?;
    }
    if writer.changed {
        ctx.touch(id)?;
        // What an ordinary edit of the kind derives from what it wrote.
        if wanted.get("note").is_some() {
            crate::commands::note::relink(ctx, id)?;
        }
    }
    Ok(Some(Restored {
        restored: writer.changed,
        kept_current: writer.kept,
    }))
}

/// The aliases of the two directions of a link set by hand.
const LINKS: [&str; 2] = ["link_out", "link_in"];

/// The items a state's links join, by id, with the row and the direction that holds each.
fn linked_ends(state: &Json) -> std::collections::BTreeMap<String, (&Json, &'static str)> {
    let mut found = std::collections::BTreeMap::new();
    for (alias, end) in [("link_out", "to_id"), ("link_in", "from_id")] {
        for row in state
            .get(alias)
            .and_then(Json::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(other) = row.get(end).and_then(Json::as_str) {
                found.entry(other.to_owned()).or_insert((row, alias));
            }
        }
    }
    found
}

struct Writer<'a, 'tx, 'conn> {
    ctx: &'a CommandCtx<'tx, 'conn>,
    id: &'a str,
    changed: bool,
    kept: Vec<String>,
}

fn sql_of(value: &Json) -> Sql {
    match value {
        Json::Null => Sql::Null,
        Json::Bool(flag) => Sql::Integer(i64::from(*flag)),
        Json::Number(number) => number.as_i64().map_or_else(
            || Sql::Real(number.as_f64().unwrap_or_default()),
            Sql::Integer,
        ),
        Json::String(text) => Sql::Text(text.clone()),
        other => Sql::Text(other.to_string()),
    }
}

fn same(left: Option<&Json>, right: Option<&Json>) -> bool {
    match (left, right) {
        (Some(left), Some(right)) => match (canonical_json(left), canonical_json(right)) {
            (Ok(left), Ok(right)) => left == right,
            _ => left == right,
        },
        (None, None) => true,
        _ => false,
    }
}

impl Writer<'_, '_, '_> {
    /// Whether what `column` of `part` points at (in `value`) still exists.
    fn target_exists(&self, part: &Part, column: &str, value: &Json) -> Result<bool> {
        let Some((table, to)) = part.references.get(column) else {
            return Ok(true);
        };
        // A composite key's second half (`kind`) is checked with the first.
        if value.is_null() || to == "kind" || table == part.name {
            return Ok(true);
        }
        let found: bool = self.ctx.connection().query_row(
            &format!(
                "SELECT EXISTS (SELECT 1 FROM {} WHERE {} = ?1)",
                crate::log::quoted(table),
                crate::log::quoted(to)
            ),
            [sql_of(value)],
            |row| row.get(0),
        )?;
        Ok(found)
    }

    /// Set the columns of the entity's row in `part` that differ. `key` names the row among the
    /// entity's rows of a child table; `only` limits the columns.
    fn update(
        &mut self,
        part: &Part,
        wanted: &Json,
        held: &Json,
        key: &[(&str, Sql)],
        only: Option<&[&str]>,
    ) -> Result<()> {
        let mut sets = Vec::new();
        let mut values: Vec<Sql> = Vec::new();
        for column in &part.columns {
            let Some(value) = wanted.get(column) else {
                continue;
            };
            if only.is_some_and(|only| !only.contains(&column.as_str()))
                || same(Some(value), held.get(column))
            {
                continue;
            }
            if !self.target_exists(part, column, value)? {
                self.kept.push(format!("{}.{column}", part.alias));
                continue;
            }
            values.push(sql_of(value));
            sets.push(format!(
                "{} = ?{}",
                crate::log::quoted(column),
                values.len()
            ));
        }
        if sets.is_empty() {
            return Ok(());
        }
        let mut wheres = vec![format!(
            "{} = ?{}",
            crate::log::quoted(part.via()),
            values.len() + 1
        )];
        values.push(Sql::Text(self.id.to_owned()));
        for (column, value) in key {
            values.push(value.clone());
            wheres.push(format!(
                "{} = ?{}",
                crate::log::quoted(column),
                values.len()
            ));
        }
        if let Some(filter) = part.filter() {
            wheres.push(format!("({filter})"));
        }
        self.ctx.connection().execute(
            &format!(
                "UPDATE {} SET {} WHERE {}",
                crate::log::quoted(part.name),
                sets.join(", "),
                wheres.join(" AND ")
            ),
            rusqlite::params_from_iter(values),
        )?;
        self.changed = true;
        Ok(())
    }

    /// Put the links back as a set of items joined, whichever end each was made from: a link the
    /// version did not have is taken off (from whichever end holds it), one it had is made again
    /// the way it was made. A version from before links were kept has no say.
    fn links(&mut self, shape: &super::shape::Shape, wanted: &Json, now: &Json) -> Result<()> {
        if LINKS.iter().all(|alias| wanted.get(alias).is_none()) {
            return Ok(());
        }
        let (wanted_ends, held_ends) = (linked_ends(wanted), linked_ends(now));
        for other in held_ends
            .keys()
            .filter(|other| !wanted_ends.contains_key(*other))
        {
            self.ctx.connection().execute(
                "DELETE FROM edge WHERE rel = 'links' AND anchor IS NULL
                   AND ((from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1))",
                [self.id, other.as_str()],
            )?;
            self.changed = true;
        }
        for (other, (row, alias)) in &wanted_ends {
            if held_ends.contains_key(other) {
                continue;
            }
            if let Some(part) = shape.part(alias) {
                self.insert(part, row)?;
            }
        }
        Ok(())
    }

    fn child(&mut self, part: &Part, wanted: &Json, held: &Json) -> Result<()> {
        if part.is_one() {
            return self.one(part, wanted, held);
        }
        let index = |rows: &Json| -> std::collections::BTreeMap<String, Json> {
            rows.as_array()
                .into_iter()
                .flatten()
                .map(|row| (key_of(part, row), row.clone()))
                .collect()
        };
        let (wanted_rows, held_rows) = (index(wanted), index(held));
        // Rows the version did not have go first, so a row it did have can take their place.
        for (key, row) in &held_rows {
            if !wanted_rows.contains_key(key) {
                self.delete(part, row)?;
            }
        }
        for (key, row) in &wanted_rows {
            match held_rows.get(key) {
                Some(held) => {
                    let keyed = key_values(part, row);
                    let keyed: Vec<(&str, Sql)> = keyed
                        .iter()
                        .map(|(column, value)| (column.as_str(), value.clone()))
                        .collect();
                    self.update(part, row, held, &keyed, None)?;
                }
                None => self.insert(part, row)?,
            }
        }
        Ok(())
    }

    fn one(&mut self, part: &Part, wanted: &Json, held: &Json) -> Result<()> {
        match (wanted.is_object(), held.is_object()) {
            (true, true) => self.update(part, wanted, held, &[], None),
            (true, false) => self.insert(part, wanted),
            (false, true) => self.delete(part, held),
            (false, false) => Ok(()),
        }
    }

    fn delete(&mut self, part: &Part, row: &Json) -> Result<()> {
        let keyed = key_values(part, row);
        let mut values: Vec<Sql> = vec![Sql::Text(self.id.to_owned())];
        let mut wheres = vec![format!("{} = ?1", crate::log::quoted(part.via()))];
        for (column, value) in keyed {
            values.push(value);
            wheres.push(format!(
                "{} = ?{}",
                crate::log::quoted(&column),
                values.len()
            ));
        }
        if let Some(filter) = part.filter() {
            wheres.push(format!("({filter})"));
        }
        self.ctx.connection().execute(
            &format!(
                "DELETE FROM {} WHERE {}",
                crate::log::quoted(part.name),
                wheres.join(" AND ")
            ),
            rusqlite::params_from_iter(values),
        )?;
        self.changed = true;
        Ok(())
    }

    /// Whether a link `row` of this entity would be a second edge between the same two items: the
    /// other direction is held already (`edge.add` never puts both in place, and a restore does
    /// not either).
    fn reverse_link_held(&self, part: &Part, row: &Json) -> Result<bool> {
        if part.name != "edge" || row.get("rel").and_then(Json::as_str) != Some("links") {
            return Ok(false);
        }
        let (other, from_here) = if part.via() == "from_id" {
            (row.get("to_id"), true)
        } else {
            (row.get("from_id"), false)
        };
        let Some(other) = other.and_then(Json::as_str) else {
            return Ok(false);
        };
        // The edge this row would be is `id -> other` (from_here) or `other -> id`; the one to
        // look for is its reverse.
        let (from, to) = if from_here {
            (other, self.id)
        } else {
            (self.id, other)
        };
        Ok(self.ctx.connection().query_row(
            "SELECT EXISTS (SELECT 1 FROM edge WHERE from_id = ?1 AND rel = 'links' AND to_id = ?2)",
            [from, to],
            |held| held.get(0),
        )?)
    }

    fn insert(&mut self, part: &Part, row: &Json) -> Result<()> {
        if self.reverse_link_held(part, row)? {
            return Ok(());
        }
        let mut names = vec![crate::log::quoted(part.via())];
        let mut values: Vec<Sql> = vec![Sql::Text(self.id.to_owned())];
        for column in &part.columns {
            let Some(value) = row.get(column) else {
                continue;
            };
            if !self.target_exists(part, column, value)? {
                // A row that points at something gone cannot come back; the rest can.
                self.kept
                    .push(format!("{}[{}]", part.alias, key_of(part, row)));
                return Ok(());
            }
            names.push(crate::log::quoted(column));
            values.push(sql_of(value));
        }
        let marks: Vec<String> = (1..=values.len()).map(|n| format!("?{n}")).collect();
        self.ctx.connection().execute(
            &format!(
                "INSERT INTO {} ({}) VALUES ({})",
                crate::log::quoted(part.name),
                names.join(", "),
                marks.join(", ")
            ),
            rusqlite::params_from_iter(values),
        )?;
        self.changed = true;
        Ok(())
    }
}

/// A child row's key columns and their values.
fn key_values(part: &Part, row: &Json) -> Vec<(String, Sql)> {
    part.key
        .iter()
        .map(|column| {
            (
                column.clone(),
                sql_of(row.get(column).unwrap_or(&Json::Null)),
            )
        })
        .collect()
}
