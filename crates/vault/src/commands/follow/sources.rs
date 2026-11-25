//! Moving a record's sources from one row to another: what a merge of two rows does, so the row
//! that stays is still followed by every store that followed either.

use rusqlite::Connection;

use crate::commands::entity;
use crate::error::{Result, VaultError};

/// Move every source of `from` to `to`, and answer how many moved. **The one call a merge of two
/// rows makes** (People's `person.merge` calls it before it purges the row that goes): `to` then
/// holds a source for each store that stated either row, and each is still compared against its
/// own `stated` by the next pass (A9), so nothing the member merged is lost or stated twice.
///
/// A tombstone of `from` (a source with no row) is not here: it names no row to move. `from` and
/// `to` must be rows of the same kind, because a source names its row's kind and the system's
/// `source_shape` row says which kinds it yields; and `to` is never the vault's owner, who is
/// nobody's record (the database refuses that too, `source_never_names_the_owner`).
///
/// # Errors
///
/// [`VaultError::InvalidInput`] with a sentence when either is not an entity, they are not of one
/// kind, or `to` is the owner; a database error.
pub fn move_sources(connection: &Connection, from: &str, to: &str) -> Result<usize> {
    let invalid = |detail: String| VaultError::InvalidInput {
        name: "into".to_owned(),
        detail,
    };
    let (source, target) = (
        entity::lookup(connection, from)?.map_err(&invalid)?,
        entity::lookup(connection, to)?.map_err(&invalid)?,
    );
    if source.kind != target.kind {
        return Err(invalid(format!(
            "a {} cannot take over the sources of a {}",
            target.kind.noun(),
            source.kind.noun()
        )));
    }
    if entity::is_self(connection, to)? {
        return Err(invalid("a source never names the vault's owner".to_owned()));
    }
    if from == to {
        return Ok(0);
    }
    Ok(connection.execute(
        "UPDATE source SET entity_id = ?2 WHERE entity_id = ?1",
        [from, to],
    )?)
}
