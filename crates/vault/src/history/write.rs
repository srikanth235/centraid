//! Keeping a state the member held but never saved (#1185).
//!
//! The commit door writes a version only when a commit replaces a state. A save the vault
//! refused as stale replaces nothing, yet the words behind it are the member's: this keeps them
//! as an earlier version, beside the state the record holds now, so the screen can show the
//! record as the vault has it and the member can still bring their words back with Restore.

use rusqlite::Connection;
use serde_json::{Map, Value as Json};

use super::shape::{CONTENT, is_sealed};
use super::{current_state, head, keep};
use crate::canonical::canonical_json;
use crate::error::Result;

/// What [`keep_overlay`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    /// The version was written, at this `seq`.
    Version(i64),
    /// The words were the ones the record holds: there is nothing earlier to keep.
    Same,
}

/// Why a field cannot be kept, or `None` when it can: it must be a `table.column` the entity's
/// state holds (its title, its kind row), not a sealed cell and not the bytes of a document.
fn refusal(state: &Json, name: &str) -> Option<String> {
    let Some((table, column)) = name.split_once('.') else {
        return Some(format!("`{name}` is not a field of a record"));
    };
    if is_sealed(table, column)
        || CONTENT
            .iter()
            .any(|(t, c, _)| (*t, *c) == (table, column) && *c != "body")
    {
        return Some(format!("`{name}` is not kept this way"));
    }
    let held = state
        .get(table)
        .and_then(Json::as_object)
        .is_some_and(|row| row.contains_key(column));
    (!held).then(|| format!("`{name}` is not a field this record keeps"))
}

/// The first reason an overlay cannot be kept on `id`, or `None`.
///
/// # Errors
/// A database error.
pub fn overlay_refusal(
    connection: &Connection,
    id: &str,
    overlay: &Map<String, Json>,
) -> Result<Option<String>> {
    let Some(state) = current_state(connection, id)? else {
        return Ok(Some(format!("there is nothing with the id `{id}`")));
    };
    Ok(overlay.keys().find_map(|name| refusal(&state, name)))
}

/// Keep the record as the member had it: the state it holds now with `overlay`'s fields
/// (`table.column` to value) put over it, written as the newest earlier version. The record
/// itself is not changed. The overlay must have passed [`overlay_refusal`].
///
/// # Errors
/// A database error.
pub fn keep_overlay(
    connection: &Connection,
    id: &str,
    overlay: &Map<String, Json>,
    now: &str,
    cause: &str,
) -> Result<Kept> {
    let Some(now_state) = current_state(connection, id)? else {
        return Ok(Kept::Same);
    };
    let mut held = now_state.clone();
    for (name, value) in overlay {
        if let Some((table, column)) = name.split_once('.')
            && let Some(row) = held.get_mut(table).and_then(Json::as_object_mut)
        {
            row.insert(column.to_owned(), value.clone());
        }
    }
    if held == now_state {
        return Ok(Kept::Same);
    }
    keep(
        connection,
        id,
        &canonical_json(&held)?,
        &canonical_json(&now_state)?,
        now,
        cause,
    )?;
    Ok(Kept::Version(head(connection, id)?))
}
