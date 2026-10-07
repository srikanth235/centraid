//! THE DOOR: the one way the runtime reaches a live vault (#1088, R-1088-10).
//!
//! The runtime holds no `Vault`, no connection and no file path. It reads the world
//! through [`Door::table`] (every row of one table, in the kit's paged shape), [`Door::tally`]
//! and [`Door::search`]; it writes through [`Door::run`], one typed command at a time; and it
//! asks the door for the three things only a vault can say: the next id ([`Door::mint_id`]),
//! the clock ([`Door::now_ms`], [`Door::advance`]) and a sealed Locker cell ([`Door::seal`],
//! [`Door::unseal`]).
//!
//! # What an implementation must do
//!
//! * **The harness** (`centraid_nativetools::vaultio::Handle`) opens a vault file as the owner
//!   principal `nativetools`, over a settable clock and a seeded id sequence, executes commands
//!   with `Vault::execute` and seals Locker cells under the fixed harness key. It fires no change
//!   feed, because nothing there listens.
//! * **The core** (`crates/core`, the phone) must write through `api::invoke` with an
//!   `invoke_key`, so a write the runtime makes fires the same `ChangeFeed` events as a write a
//!   screen makes; and it must read through `VaultDoor` (`app_query.rs`), the query path a screen
//!   uses, so the runtime sees what the person sees. It must not hand the runtime a connection.
//!   On the phone the Locker policy is off (`Flags::locker`), so `seal` and `unseal` are never
//!   called and an implementation may refuse them.
//!
//! A refusal by the vault is a value ([`Ran::ok`] false), never an `Err`: an `Err` is a door that
//! could not answer at all.

use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_tally::queries::TallyData;
use centraid_search::Target;
use serde_json::Value;

/// What running one command produced, reduced to what the runtime reads.
///
/// A refusal is a value: `reason` is the vault's owner-facing sentence and
/// `predicate` the id of the check that failed (`folder_is_empty`,
/// `group_empty`, `no_busy_conflict`, ...), or `schema` for an input the
/// command's schema rejects and `authority` for a caller it does not allow.
/// The runtime classifies a refusal by that id, never by the sentence
/// (`act.rs`, `Session::refusal`).
#[derive(Debug, Clone)]
pub struct Ran {
    pub ok: bool,
    pub output: Value,
    pub reason: Option<String>,
    pub predicate: Option<String>,
}

/// A live vault, as the runtime sees it. See the module docs for what each implementation
/// owes. `Send` because a chat's session, which owns its door, is held by the core across the
/// calls of a turn and moves between the threads a shell calls on.
pub trait Door: Send {
    /// Every row of one table, through the kit's paged read (`PageQuery` over `table`, ordered by
    /// `sort` then `pk`). `columns` is the comma-separated list to read; a table or a column the
    /// runtime never names is never read.
    fn table(&self, table: &str, columns: &str, sort: &str, pk: &str) -> Result<Vec<Row>, String>;

    /// The Tally ledger, folded by the Tally app's own read.
    fn tally(&self) -> Result<TallyData, String>;

    /// A full-text search over one searchable entity: the targets it found, best first. A text
    /// with no searchable word finds nothing and is not an error.
    fn search(&self, entity: &str, text: &str, limit: usize) -> Result<Vec<Target>, String>;

    /// Run one typed command as the owner at the clock's current instant. A refusal is a value.
    fn run(&self, command: &str, input: Value) -> Result<Ran, String>;

    /// Move the clock on, so the next write gets an instant of its own and a session's writes
    /// land in the order they were made.
    fn advance(&self);

    /// The clock's current instant, in epoch milliseconds.
    fn now_ms(&self) -> i64;

    /// The next id the vault mints, for a row the runtime names before the command that makes it.
    fn mint_id(&self) -> String;

    /// Seal one Locker cell for `item_id`: `(key_id, ciphertext)`. Never called when the Locker
    /// policy is off.
    fn seal(&self, item_id: &str, value: &str) -> Result<(String, String), String>;

    /// Open one sealed Locker cell of `item_id` that was sealed under `key_id`. Never called when
    /// the Locker policy is off.
    fn unseal(&self, key_id: &str, item_id: &str, sealed: &str) -> Result<String, String>;

    /// Run one command a second after the last: [`advance`](Self::advance), then
    /// [`run`](Self::run).
    fn step(&self, command: &str, input: Value) -> Result<Ran, String> {
        self.advance();
        self.run(command, input)
    }

    /// Run a command that must succeed.
    fn must(&self, command: &str, input: Value) -> Result<Value, String> {
        let ran = self.run(command, input.clone())?;
        if ran.ok {
            Ok(ran.output)
        } else {
            Err(format!(
                "{command} refused {input}: {}",
                ran.reason.unwrap_or_default()
            ))
        }
    }
}

/// The text of a cell, or `None` for NULL / absent / non-text.
#[must_use]
pub fn text(row: &Row, column: &str) -> Option<String> {
    match row.get(column) {
        Some(Cell::Text(value)) => Some(value.clone()),
        Some(Cell::Integer(value)) => Some(value.to_string()),
        _ => None,
    }
}

/// The integer of a cell.
#[must_use]
pub fn int(row: &Row, column: &str) -> Option<i64> {
    match row.get(column) {
        Some(Cell::Integer(value)) => Some(*value),
        Some(Cell::Real(value)) => Some(*value as i64),
        Some(Cell::Text(value)) => value.parse().ok(),
        _ => None,
    }
}
