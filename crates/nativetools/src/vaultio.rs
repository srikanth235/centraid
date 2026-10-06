//! Opening a vault for the tool runtime: an injectable clock, deterministic
//! ids, the content store beside the file, and the one door every write goes
//! through (`Vault::execute` with the system registry).
//!
//! Nothing here holds SQL: reads go through the app kit's `PageQuery` over
//! its test door (the owner's view, which is what an eval harness is), and
//! writes go through the vault's typed commands.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use centraid_apps_kit::reads::{FanOutBound, read_pages};
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::statement::{PageOrder, PageQuery};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_vault::access::Principal;
use centraid_vault::backup::store::FsBlobStore;
use centraid_vault::{Clock, Command, CommandStatus, Registry, SeededIds, Vault};

/// The device every command is invoked from.
pub const DEVICE: &str = "nativetools";

/// A clock a caller can set, shared with the vault it was handed to.
#[derive(Clone, Default)]
pub struct SetClock(Arc<AtomicI64>);

impl SetClock {
    #[must_use]
    pub fn at(millis: i64) -> Self {
        Self(Arc::new(AtomicI64::new(millis)))
    }
    pub fn set(&self, millis: i64) {
        self.0.store(millis, Ordering::SeqCst);
    }
    #[must_use]
    pub fn get(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
    pub fn tick(&self) {
        self.0.fetch_add(1000, Ordering::SeqCst);
    }
}

impl Clock for SetClock {
    fn now_ms(&self) -> i64 {
        self.get()
    }
}

/// Epoch milliseconds of a civil (floating, read as UTC) date-time.
#[must_use]
pub fn millis_of(datetime: jiff::civil::DateTime) -> i64 {
    datetime
        .to_zoned(jiff::tz::TimeZone::UTC)
        .map(|zoned| zoned.timestamp().as_millisecond())
        .unwrap_or_default()
}

/// Where the content store of a vault file lives.
#[must_use]
pub fn blobs_dir(vault: &Path) -> PathBuf {
    sibling(vault, "blobs")
}

/// Where the seat-side member key custody of a vault file lives.
#[must_use]
pub fn seat_dir(vault: &Path) -> PathBuf {
    sibling(vault, "seat")
}

/// Copy a CLOSED vault and everything beside it: the file, its WAL pair (the
/// vault never checkpoints on close, `docs/traps/wal-checkpoint.md`), its
/// content store and its seat custody.
pub fn copy_vault(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        return Err(format!("{} already exists", to.display()));
    }
    let io = |error: std::io::Error| error.to_string();
    std::fs::copy(from, to).map_err(io)?;
    for suffix in ["-wal", "-shm"] {
        let mut source = from.as_os_str().to_os_string();
        source.push(suffix);
        let mut target = to.as_os_str().to_os_string();
        target.push(suffix);
        if Path::new(&source).exists() {
            std::fs::copy(&source, &target).map_err(io)?;
        }
    }
    for (source, target) in [
        (blobs_dir(from), blobs_dir(to)),
        (seat_dir(from), seat_dir(to)),
    ] {
        copy_tree(&source, &target).map_err(io)?;
    }
    Ok(())
}

fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    if !from.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    let mut entries: Vec<_> = std::fs::read_dir(from)?.collect::<Result<_, _>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn sibling(vault: &Path, suffix: &str) -> PathBuf {
    let mut name = vault.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{suffix}"));
    vault.with_file_name(name)
}

/// An open vault plus everything a command needs.
pub struct Handle {
    pub vault: Vault,
    pub registry: Registry,
    pub clock: SetClock,
    pub path: PathBuf,
}

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
    pub output: serde_json::Value,
    pub reason: Option<String>,
    pub predicate: Option<String>,
}

impl Handle {
    /// Found a fresh vault at `path`.
    pub fn create(path: &Path, clock: SetClock, seed: &str, me: &str) -> Result<Self, String> {
        Self::create_in(path, clock, seed, me, "USD")
    }

    /// A new vault whose base (default) currency is `currency`.
    pub fn create_in(
        path: &Path,
        clock: SetClock,
        seed: &str,
        me: &str,
        currency: &str,
    ) -> Result<Self, String> {
        let ids = SeededIds::new(seed.to_owned());
        let vault = Vault::create_with(path, Box::new(clock.clone()), Box::new(ids))
            .map_err(|error| error.to_string())?;
        let vault = with_store(vault, path)?;
        vault
            .found_in("Nativetools", me, currency)
            .map_err(|error| error.to_string())?;
        let registry = Registry::with_system_commands().map_err(|error| error.to_string())?;
        registry
            .install(&vault)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            vault,
            registry,
            clock,
            path: path.to_path_buf(),
        })
    }

    /// Open an existing vault. `seed` names the id sequence; callers derive it
    /// from the vault's contents so two sessions never mint the same id.
    pub fn open(path: &Path, clock: SetClock, seed: &str) -> Result<Self, String> {
        let ids = SeededIds::new(seed.to_owned());
        let vault = Vault::open_with(path, Box::new(clock.clone()), Box::new(ids))
            .map_err(|error| error.to_string())?;
        let vault = with_store(vault, path)?;
        let registry = Registry::with_system_commands().map_err(|error| error.to_string())?;
        Ok(Self {
            vault,
            registry,
            clock,
            path: path.to_path_buf(),
        })
    }

    /// Run one command a second after the last: a session's writes each get
    /// their own instant, so their order is the order they were made.
    pub fn step(&self, name: &str, input: serde_json::Value) -> Result<Ran, String> {
        self.clock.tick();
        self.run(name, input)
    }

    /// Run one typed command as the owner at the clock's current instant. A
    /// refusal is a value, not an error.
    pub fn run(&self, name: &str, input: serde_json::Value) -> Result<Ran, String> {
        let outcome = self
            .vault
            .execute(
                &self.registry,
                &Principal::owner(DEVICE),
                &Command::new(name, input),
            )
            .map_err(|error| format!("{name}: {error}"))?;
        Ok(Ran {
            ok: outcome.status == CommandStatus::Executed,
            output: outcome.output,
            reason: outcome.reason,
            predicate: outcome.predicate,
        })
    }

    /// Run a command that must succeed.
    pub fn must(&self, name: &str, input: serde_json::Value) -> Result<serde_json::Value, String> {
        let ran = self.run(name, input.clone())?;
        if ran.ok {
            Ok(ran.output)
        } else {
            Err(format!(
                "{name} refused {input}: {}",
                ran.reason.unwrap_or_default()
            ))
        }
    }

    /// Every row of one table, through the kit's paged read.
    pub fn table(
        &self,
        table: &str,
        columns: &str,
        sort: &str,
        pk: &str,
    ) -> Result<Vec<Row>, String> {
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                let query = PageQuery::new(
                    &format!("nativetools.{table}"),
                    columns,
                    table,
                    PageOrder::asc(sort, pk),
                );
                Ok(read_pages(&door, &query, FanOutBound::new(500, 200)))
            })
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("reading {table}: {error}"))
    }

    /// The Tally ledger, folded by the Tally app's own read.
    pub fn tally(&self) -> Result<centraid_apps_tally::queries::TallyData, String> {
        self.vault
            .read(|connection| {
                let door = TestDoor::new(connection);
                Ok(centraid_apps_tally::queries::load_tally(&door))
            })
            .map_err(|error| error.to_string())?
            .map_err(|error| format!("reading the ledger: {error}"))
    }

    /// Run a search through the vault's FTS door.
    pub fn search(
        &self,
        entity: &str,
        text: &str,
        limit: usize,
    ) -> Result<Vec<centraid_search::Target>, String> {
        self.vault
            .read(|connection| {
                use centraid_search::Search as _;
                let answer =
                    centraid_search::sqlite::SqliteDoor::open(connection).and_then(|door| {
                        door.query(
                            &centraid_search::Principal::Owner,
                            &centraid_search::SearchRequest::new(entity, text, limit),
                        )
                    });
                Ok(answer)
            })
            .map_err(|error| error.to_string())?
            .map(|answer| answer.targets().map(<[_]>::to_vec).unwrap_or_default())
            .or_else(|error| match error {
                centraid_search::SearchError::NoSearchableWords { .. } => Ok(Vec::new()),
                other => Err(other.to_string()),
            })
    }

    /// Found the Locker key plane on the seat beside this vault (idempotent).
    pub fn locker_key(&self) -> Result<(String, Vec<u8>), String> {
        let vault_id = self
            .vault
            .vault_id()
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        let custody =
            centraid_vault::custody::MemberKeyCustody::on_seat(&seat_dir(&self.path), vault_id);
        let now = self.clock.now_text();
        let mut found: Option<Result<(String, Vec<u8>), String>> = None;
        self.vault
            .commit(|tx| {
                tx.set_producer("nativetools.locker-key");
                found = Some(
                    centraid_vault::custody::found_locker_key(
                        tx.connection(),
                        &custody,
                        "locker-key-1",
                        &now,
                    )
                    .map_err(|error| error.to_string()),
                );
                Ok(())
            })
            .map_err(|error| error.to_string())?;
        found.unwrap_or_else(|| Err("the key plane was not founded".to_owned()))
    }
}

impl Handle {
    /// Move the write-ahead log into the vault file and truncate it, through
    /// the vault's own checkpoint (a scratch spool that has never captured,
    /// so nothing is held back). The vault never checkpoints on its own or on
    /// close, so a seeded vault would otherwise keep every write in `-wal`.
    pub fn checkpoint(&self) -> Result<(), String> {
        let spool_dir = self.path.with_extension("checkpoint-spool");
        let _ = std::fs::remove_dir_all(&spool_dir);
        let result = centraid_vault::backup::spool::Spool::open(&spool_dir)
            .map_err(|error| error.to_string())
            .and_then(|spool| {
                centraid_vault::backup::capture::checkpoint(&self.vault, &spool)
                    .map_err(|error| error.to_string())
            });
        let _ = std::fs::remove_dir_all(&spool_dir);
        let outcome = result?;
        if outcome.busy {
            return Err("the checkpoint found a reader in the way".to_owned());
        }
        Ok(())
    }

    /// Seal one locker cell for `item_id` under the Locker key (founding the
    /// key plane on first use): `(key_id, ciphertext)`.
    pub fn seal(&self, item_id: &str, value: &str) -> Result<(String, String), String> {
        let (key_id, key) = self.locker_key()?;
        let sealed = centraid_vault::custody::locker_key::encrypt_under_locker_key(
            &key, &key_id, item_id, value,
        )
        .map_err(|error| error.to_string())?;
        Ok((key_id, sealed))
    }
}

fn with_store(vault: Vault, path: &Path) -> Result<Vault, String> {
    let store = FsBlobStore::open(blobs_dir(path)).map_err(|error| error.to_string())?;
    Ok(vault.with_blobs(Box::new(store)))
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
