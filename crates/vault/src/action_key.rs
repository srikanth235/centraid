//! The action keys: how a retried act is told from a second one
//! ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
//!
//! An `act` carries a caller's key. The commit that runs it writes the key and a digest of what it
//! asked into `action_key`, in the same transaction, so a delivery the phone repeats after a
//! restart finds the key and is answered `replayed` without running anything. Only an executed
//! act is remembered: a refused one may be asked again, because what refused it may have changed.
//!
//! **Both columns are opaque.** The key is a caller's id and `asked` is a digest of the request;
//! nothing the member typed is stored here, and nothing reads a row to learn a fact about the
//! model. The commit that writes a key forgets every key older than [`KEEP_DAYS`] days on the
//! vault's clock, so the table is as long as a month of acts and no longer.

use rusqlite::Connection;

use crate::clock::{Clock, format_iso_ms};
use crate::error::Result;

/// How long a key is remembered, in days: far past any delivery a phone retries.
pub const KEEP_DAYS: i64 = 30;

/// An `act`'s key and a digest of the request it came with: what the commit records so the same
/// delivery is recognised after a restart.
#[derive(Debug, Clone, Copy)]
pub struct KeyMark<'a> {
    pub key: &'a str,
    pub asked: &'a str,
}

/// What a key remembers: the digest of what it asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recalled {
    pub asked: String,
}

/// The run an `act` key already names, if the table holds one.
pub fn recall(connection: &Connection, key: &str) -> Result<Option<Recalled>> {
    use rusqlite::OptionalExtension as _;
    Ok(connection
        .query_row(
            "SELECT asked FROM action_key WHERE key = ?1",
            [key],
            |row| Ok(Recalled { asked: row.get(0)? }),
        )
        .optional()?)
}

/// Remember `mark` as of `clock`'s now, and forget the keys past [`KEEP_DAYS`]. One commit does
/// both, so the table never outgrows the window by more than the commit in flight.
pub fn remember(connection: &Connection, mark: &KeyMark<'_>, clock: &dyn Clock) -> Result<()> {
    let now = clock.now_ms();
    connection.execute(
        "DELETE FROM action_key WHERE at < ?1",
        [format_iso_ms(now - KEEP_DAYS * 86_400_000)],
    )?;
    connection.execute(
        "INSERT INTO action_key (key, asked, at) VALUES (?1, ?2, ?3)",
        rusqlite::params![mark.key, mark.asked, format_iso_ms(now)],
    )?;
    Ok(())
}
