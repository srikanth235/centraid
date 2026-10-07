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
//! | `table`, `tally` | [`VaultDoor`], the page door every app query reads through (`Vault::keyset_page`) |
//! | `search` | the FTS door over the vault's read connection, as a screen's search does |
//! | `run` | [`api::invoke_raw`](crate::api), the gate order and change feed a screen's write goes through, with an `invoke_key` |
//! | `mint_id`, `now_ms` | the vault's own id source and clock |
//! | `seal`, `unseal` | nothing: the Locker is off on the phone (R-1088-3), and a door that is asked refuses |
//!
//! # THE DOOR OUTLIVES A CALL, THE LOCK DOES NOT
//!
//! A native session lives as long as its chat, so its door cannot borrow the
//! [`Handle`](crate::Handle) the way [`VaultReader`](super::VaultReader) does.
//! It holds clones of the handle's own `Arc<Mutex<Option<Vault>>>`, registry and
//! event queue instead, and takes the vault lock for exactly one query or one
//! command, as every other path in the core does. A turn that waits on the model
//! for seconds holds nothing a screen needs.
//!
//! # WRITES ARE REFUSED UNTIL PARKING LANDS
//!
//! A write the model makes must park behind a confirm card (R-1088-2). Until the
//! runtime can park, [`CoreDoor::run`] answers every command with a refusal
//! value ([`WRITES_OFF`]) and does not touch the vault. The switch is
//! [`CoreDoor::allow_writes`]; nothing but a test sets it today.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use centraid_api_proto::core_v1 as wire;
use centraid_apps_kit::reads::{FanOutBound, read_pages};
use centraid_apps_kit::row::Row;
use centraid_apps_kit::statement::{PageOrder, PageQuery};
use centraid_apps_tally::queries::{TallyData, load_tally};
use centraid_assist::native::{Door, Ran};
use centraid_search::Target;
use centraid_vault::commands::{CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde_json::Value;

use crate::app_query::VaultDoor;
use crate::events::{ChangeFeed, EventQueue};

/// The vault's reason for a refused write while parking is not built. The
/// predicate rides as `authority`: the caller is not allowed to write yet.
pub const WRITES_OFF: &str = "the chat cannot change the vault yet";

/// The predicate [`WRITES_OFF`] rides under. `authority`, the id the runtime
/// already reads as "this caller may not", so it never mistakes the refusal for
/// a rule of the vault it could ask the member about (`Session::refusal`).
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
    writes: AtomicBool,
    /// Names this door's `invoke_key`s so two doors (two chats, one before a
    /// reopen and one after) never replay each other's.
    nonce: String,
    calls: AtomicU64,
}

impl CoreDoor {
    pub(crate) fn new(
        vault: Arc<Mutex<Option<Vault>>>,
        registry: Arc<Registry>,
        events: Arc<EventQueue>,
        owner: Principal,
    ) -> Self {
        let nonce = {
            let held = vault.lock().unwrap_or_else(PoisonError::into_inner);
            held.as_ref()
                .map_or_else(|| "closed".to_owned(), |vault| vault.ids().next())
        };
        Self {
            vault,
            registry,
            events,
            owner,
            writes: AtomicBool::new(false),
            nonce,
            calls: AtomicU64::new(0),
        }
    }

    /// Let [`Door::run`] reach the vault. Off by default, and off in production
    /// until a write can park behind a confirm card (R-1088-2).
    pub fn allow_writes(&self, on: bool) {
        self.writes.store(on, Ordering::SeqCst);
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

    fn tally(&self) -> Result<TallyData, String> {
        self.with(|vault| {
            let door = VaultDoor::new(vault);
            let data = load_tally(&door);
            if let Some(failure) = door.take_failure() {
                return Err(format!("reading the ledger: {failure}"));
            }
            data.map_err(|error| format!("reading the ledger: {error}"))
        })
    }

    fn search(&self, entity: &str, text: &str, limit: usize) -> Result<Vec<Target>, String> {
        self.with(|vault| {
            let answered = vault
                .read(|connection| {
                    use centraid_search::Search as _;
                    Ok(
                        centraid_search::SqliteDoor::open(connection).and_then(|door| {
                            door.query(
                                &centraid_search::Principal::Owner,
                                &centraid_search::SearchRequest::new(entity, text, limit),
                            )
                        }),
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

    fn run(&self, command: &str, input: Value) -> Result<Ran, String> {
        if !self.writes.load(Ordering::SeqCst) {
            return Ok(Ran {
                ok: false,
                output: Value::Null,
                reason: Some(WRITES_OFF.to_owned()),
                predicate: Some(WRITES_OFF_PREDICATE.to_owned()),
            });
        }
        let request = wire::Command {
            name: command.to_owned(),
            input: serde_json::to_vec(&input)
                .map_err(|error| format!("{command}: the input is not JSON: {error}"))?,
            invoke_key: format!(
                "assist.native:{}:{}",
                self.nonce,
                self.calls.fetch_add(1, Ordering::SeqCst)
            ),
            ..wire::Command::default()
        };
        let changes = ChangeFeed::new(Arc::clone(&self.events));
        let outcome = self.with(|vault| {
            crate::api::invoke_raw(vault, &self.registry, &self.owner, &request, &changes)
                .map_err(|error| format!("{command}: {error}"))
        })?;
        Ok(Ran {
            ok: outcome.status == CommandStatus::Executed,
            output: outcome.output,
            reason: outcome.reason,
            predicate: outcome.predicate,
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

    fn seal(&self, _item_id: &str, _value: &str) -> Result<(String, String), String> {
        Err(LOCKER_OFF.to_owned())
    }

    fn unseal(&self, _key_id: &str, _item_id: &str, _sealed: &str) -> Result<String, String> {
        Err(LOCKER_OFF.to_owned())
    }
}

/// What a door asked for a Locker cell answers: the chat has no Locker (R-1088-3).
const LOCKER_OFF: &str = "the chat holds no Locker key";
