//! THE CORE'S DOOR FOR THE NATIVE TOOL RUNTIME (#1088, R-1088-10).
//!
//! `centraid_assist::native` reaches a vault only through a
//! [`Door`](centraid_assist::native::Door). The harness's door opens a vault
//! FILE of its own. This one is the phone's: it reaches the vault the core
//! already holds open, through the very paths a screen uses, and never opens it
//! a second time.
//!
//! | The runtime asks | The door answers through |
//! |---|---|
//! | `table` | [`VaultDoor`], the page door every app query reads through (`Vault::keyset_page`) |
//! | `search` | the FTS door over the vault's read connection, as a screen's search does |
//! | `run` | refused: a write is a confirmed card's, keyed (below) |
//! | `mint_id`, `now_ms` | the vault's own id source and clock |
//! | `run_keyed` | `api::command`, the write path the shell's own `Command` request takes: a typed Locker secret is sealed under the open Locker session, then `invoke_raw` runs it (#1135) |
//!
//! # A SEALED VALUE IS A CHANNEL THIS DOOR KEEPS CLOSED (#1135)
//!
//! The chat is the member's principal: the door runs every command as the owner device and the
//! vault withholds nothing from it. What it never does is let a sealed plaintext reach the
//! runtime. A sealed column is read as a presence bit (the runtime's world asks for `IS NOT NULL`),
//! no door method returns a sealed cell, and a secret the member typed in chat arrives in the input
//! of `locker.add_item` / `locker.edit_item` and is sealed in [`crate::api::command`], the one write
//! path the shell's own `Command` request takes too, before the vault sees it. A shut Locker answers [`Door::locked_for`] first, so a confirm stops before it
//! runs a step and the card waits for the unlock.
//!
//! # THE DOOR OUTLIVES A CALL, THE LOCK DOES NOT
//!
//! A native session lives as long as its chat, so its door cannot borrow the
//! [`Handle`](crate::Handle) for the length of a call.
//! It holds clones of the handle's own `Arc<Mutex<Option<Vault>>>`, registry and
//! event queue instead, and takes the vault lock for exactly one query or one
//! command, as every other path in the core does. A turn that waits on the model
//! for seconds holds nothing a screen needs.
//!
//! # WRITES ARE A CONFIRMED CARD'S, KEYED
//!
//! A write the model makes parks behind a confirm card (R-1088-2), so the runtime reaches
//! [`Door::run_keyed`] only when the member taps, once per step, under `<pending id>:<step>`. That
//! is the one way this door writes. A bare [`Door::run`] is refused: nothing legitimate on the
//! phone issues one, so a path around the card finds a closed door and the vault untouched.
//!
//! The vault keeps no ledger of `invoke_key`s ([`crate::api::invoke`] requires one and runs the
//! command), so the door keeps its own: a key it has already run successfully answers the same
//! [`Ran`] and runs nothing. That is what makes a confirm delivered twice write once; it lives as
//! long as the session that holds the door, which is as long as a pending write can be confirmed.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::reads::{FanOutBound, read_pages};
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_assist::native::door::Occurrence;
use centraid_assist::native::{Door, Ran};
use centraid_search::Target;
use centraid_vault::commands::{CommandStatus, Registry};
use centraid_vault::time::zone::FireZone;
use centraid_vault::{Principal, Vault};
use serde_json::Value;

use crate::app_query::VaultDoor;
use crate::events::{ChangeFeed, EventQueue};

/// Why a bare `run` is refused: a write is made by confirming a card, and only that.
pub const WRITES_OFF: &str = "the chat writes only through a confirmed card";

/// The predicate [`WRITES_OFF`] rides under. `authority`, the id the runtime already reads as "this
/// caller may not", so it never mistakes the refusal for a rule of the vault it could ask the
/// member about (`Session::refusal`).
pub const WRITES_OFF_PREDICATE: &str = "authority";

/// The page ceiling of one table read, as the harness's door and the app
/// queries state it: 500 rows a page, 200 pages.
const PAGE_ROWS: usize = 500;
const FAN_OUT_PAGES: usize = 200;

/// A native session's way into the open vault. See the module docs.
pub struct CoreDoor {
    vault: Arc<Mutex<Option<Vault>>>,
    registry: Arc<Registry>,
    events: Arc<EventQueue>,
    owner: Principal,
    /// The Locker session the handle holds: a typed secret is sealed under its key.
    locker: Arc<crate::locker::phone::Cell>,
    /// What each key has already run, so a step confirmed twice runs once.
    done: Mutex<BTreeMap<String, Ran>>,
    calls: AtomicU64,
}

impl CoreDoor {
    pub(crate) fn new(
        vault: Arc<Mutex<Option<Vault>>>,
        registry: Arc<Registry>,
        events: Arc<EventQueue>,
        owner: Principal,
        locker: Arc<crate::locker::phone::Cell>,
    ) -> Self {
        Self {
            vault,
            registry,
            events,
            owner,
            locker,
            done: Mutex::new(BTreeMap::new()),
            calls: AtomicU64::new(0),
        }
    }

    /// Run a body with the vault the handle holds, for one query or one command.
    fn with<T>(&self, body: impl FnOnce(&Vault) -> Result<T, String>) -> Result<T, String> {
        let held = self.vault.lock().unwrap_or_else(PoisonError::into_inner);
        let vault = held
            .as_ref()
            .ok_or_else(|| "this core holds no vault".to_owned())?;
        body(vault)
    }
}

impl Door for CoreDoor {
    fn table(&self, table: &str, columns: &str, sort: &str, pk: &str) -> Result<Vec<Row>, String> {
        self.with(|vault| {
            let door = VaultDoor::new(vault);
            let query = PageQuery::new(
                &format!("assist.native.{table}"),
                columns,
                table,
                PageOrder::asc(sort, pk),
            );
            let rows = read_pages(&door, &query, FanOutBound::new(PAGE_ROWS, FAN_OUT_PAGES));
            // THE VAULT'S OWN WORDS before the kit's: the door keeps the first failure it saw.
            if let Some(failure) = door.take_failure() {
                return Err(format!("reading {table}: {failure}"));
            }
            rows.map_err(|error| format!("reading {table}: {error}"))
        })
    }

    fn table_where(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
        predicate: &str,
        binds: &[String],
    ) -> Result<Vec<Row>, String> {
        self.with(|vault| {
            let door = VaultDoor::new(vault);
            let query = PageQuery::new(
                &format!("assist.native.{table}"),
                columns,
                table,
                PageOrder::asc(sort, pk),
            )
            .filter(
                predicate,
                binds.iter().cloned().map(PageBindValue::Text).collect(),
            );
            let rows = read_pages(&door, &query, FanOutBound::new(PAGE_ROWS, FAN_OUT_PAGES));
            if let Some(failure) = door.take_failure() {
                return Err(format!("reading {table}: {failure}"));
            }
            rows.map_err(|error| format!("reading {table}: {error}"))
        })
    }

    fn search(&self, entity: &str, text: &str, limit: usize) -> Result<Vec<Target>, String> {
        self.with(|vault| {
            let answered = vault
                .read(|connection| {
                    use centraid_search::Search as _;
                    Ok(
                        centraid_search::SqliteDoor::open(connection, vault.words()).and_then(
                            |door| {
                                door.query(
                                    &centraid_search::Principal::Owner,
                                    &centraid_search::SearchRequest::new(entity, text, limit),
                                )
                            },
                        ),
                    )
                })
                .map_err(|error| error.to_string())?;
            match answered {
                Ok(answer) => Ok(answer.targets().map(<[_]>::to_vec).unwrap_or_default()),
                // A TEXT WITH NO SEARCHABLE WORD is an answer, as it is on a screen.
                Err(centraid_search::SearchError::NoSearchableWords { .. }) => Ok(Vec::new()),
                Err(other) => Err(other.to_string()),
            }
        })
    }

    fn run(&self, _command: &str, _input: Value) -> Result<Ran, String> {
        Ok(Ran {
            ok: false,
            output: Value::Null,
            reason: Some(WRITES_OFF.to_owned()),
            predicate: Some(WRITES_OFF_PREDICATE.to_owned()),
        })
    }

    fn run_keyed(&self, key: &str, command: &str, input: Value) -> Result<Ran, String> {
        let mut done = self.done.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(earlier) = done.get(key) {
            return Ok(earlier.clone());
        }
        let request = wire::Command {
            name: command.to_owned(),
            input: serde_json::to_vec(&input)
                .map_err(|error| format!("{command}: the input is not JSON: {error}"))?,
            invoke_key: key.to_owned(),
            ..wire::Command::default()
        };
        let changes = ChangeFeed::new(Arc::clone(&self.events));
        let outcome = self.with(|vault| {
            crate::api::command(
                vault,
                &self.locker,
                &self.registry,
                &self.owner,
                &request,
                &changes,
            )
            .map_err(|error| format!("{command}: {error}"))
        })?;
        let ran = Ran {
            ok: outcome.status == CommandStatus::Executed,
            output: outcome.output,
            reason: outcome.reason,
            predicate: outcome.predicate,
        };
        // only a step that landed is remembered: a refused one may be asked again
        if ran.ok {
            done.insert(key.to_owned(), ran.clone());
        }
        Ok(ran)
    }

    fn events(&self, from_day: &str, to_day: &str, tz: &str) -> Result<Vec<Occurrence>, String> {
        let zone = FireZone::named(tz).map_err(|_| format!("{tz} is not a time zone"))?;
        self.with(|vault| {
            let door = VaultDoor::new(vault);
            let now = vault.clock().now_text();
            let read = centraid_apps_agenda::occurrences(&door, from_day, to_day, &now, &zone);
            if let Some(failure) = door.take_failure() {
                return Err(format!("reading the events: {failure}"));
            }
            match read {
                Ok((rows, None)) => Ok(rows),
                Ok((_, Some(denial))) => Err(denial
                    .message
                    .unwrap_or_else(|| "the events are refused".to_owned())),
                Err(error) => Err(format!("reading the events: {error}")),
            }
        })
    }

    /// The vault's clock is the real one: each write has an instant of its own.
    fn advance(&self) {}

    fn now_ms(&self) -> i64 {
        self.with(|vault| Ok(vault.clock().now_ms()))
            .unwrap_or_default()
    }

    fn mint_id(&self) -> String {
        self.with(|vault| Ok(vault.ids().next()))
            .unwrap_or_else(|_| format!("closed-{}", self.calls.fetch_add(1, Ordering::SeqCst)))
    }

    fn locked_for(&self, command: &str, input: &Value) -> bool {
        self.with(|vault| {
            Ok(crate::locker::phone::locked_for(
                vault,
                &self.locker,
                command,
                input,
            ))
        })
        .unwrap_or(false)
    }
}
