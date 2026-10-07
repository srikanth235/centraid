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
//! # What the core owes park and confirm (R-1088-2, R-1088-6)
//!
//! On the phone a session runs `Writes::Park` (`crate::native::park`): the runtime plans a turn's
//! writes against a patched copy of the world and ends the turn with a pending write. During
//! planning it calls [`Door::advance`], [`Door::mint_id`], [`Door::now_ms`] and the reads, and
//! never [`Door::run`]: **nothing a card shows has touched the vault.** The writes happen only in
//! `Session::confirm`, and the core's door must make them like this:
//!
//! * [`Door::run_keyed`] is `api::invoke` with `invoke_key` = the key it is given,
//!   `<PendingWrite::id>:<step index>`. The key is derived from the pending write and the step's
//!   place in it, so a confirm that is delivered twice (a retry after a dropped reply, a replayed
//!   request) finds its steps already recorded by the vault's invocation ledger and writes nothing
//!   more; the session answers the second confirm from memory as well, but the ledger is what holds
//!   across a restart. The door must NOT mint a fresh key per call.
//! * The change feed fires as it does for a screen's write (`ChangeFeed::tables_changed`), once per
//!   step that ran, so every screen that reads those tables refreshes. The harness has no feed and
//!   fires none.
//! * A step the vault refuses comes back as a [`Ran`] with `ok` false (the check id in `predicate`,
//!   the owner-facing sentence in `reason`), never an `Err`: `confirm` types it (`Confirmed::Refused`)
//!   and names how many steps landed before it. A batch is not atomic across commands.
//! * The reads (`table`, `tally`, `events`) see the vault as it is NOW, through the query path a
//!   screen uses: `confirm` reads the rows its steps address again before it runs anything, and a
//!   row that changed since the turn planned is a typed `Confirmed::Stale`, nothing written. A door
//!   that served a cached world would make a stale card look fresh.
//! * [`Door::events`] is `centraid_apps_agenda::occurrences` over the core's own `PageDoor`
//!   (`VaultDoor`), the zone being the request's: the same function the harness's door calls, so the
//!   chat and the Agenda tab cannot disagree about which day an event is on (R-1088-8).
//! * [`Door::advance`] may do nothing on the phone (its clock is the device's), and [`Door::mint_id`]
//!   must be unguessable-enough to be a row id: a parked create shows the id the confirm writes.
//!
//! A refusal by the vault is a value ([`Ran::ok`] false), never an `Err`: an `Err` is a door that
//! could not answer at all.

pub use centraid_apps_agenda::Occurrence;
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
/// owes.
pub trait Door {
    /// Every row of one table, through the kit's paged read (`PageQuery` over `table`, ordered by
    /// `sort` then `pk`). `columns` is the comma-separated list to read; a table or a column the
    /// runtime never names is never read.
    fn table(&self, table: &str, columns: &str, sort: &str, pk: &str) -> Result<Vec<Row>, String>;

    /// The Tally ledger, folded by the Tally app's own read.
    fn tally(&self) -> Result<TallyData, String>;

    /// Every occurrence of an event that occupies a civil day of `from_day..=to_day`
    /// (`YYYY-MM-DD`, days of the IANA zone `tz`): repeating series expanded, the cancelled and
    /// the trashed left out, each placed on the member's calendar in `tz` (its wall clock, its
    /// end, the days it occupies). The rows Agenda's own `upcoming` answers, from the one
    /// implementation of it (`centraid_apps_agenda::occurrences`), so the runtime cannot disagree
    /// with the Agenda tab (R-1088-8). A door that cannot answer says so; the runtime then reads
    /// the stored events as they are.
    fn events(&self, from_day: &str, to_day: &str, tz: &str) -> Result<Vec<Occurrence>, String> {
        let _ = (from_day, to_day, tz);
        Err("this door reads no event window".to_owned())
    }

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

    /// Run one command of a confirmed pending write: [`run`](Self::run) under a key that names
    /// the step (`<pending id>:<step index>`), so a confirm sent twice cannot write twice. The
    /// harness keeps no ledger of keys and just runs it; the core passes the key to
    /// `api::invoke` as the `invoke_key` (see the module docs, "park and confirm").
    fn run_keyed(&self, key: &str, command: &str, input: Value) -> Result<Ran, String> {
        let _ = key;
        self.run(command, input)
    }

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
