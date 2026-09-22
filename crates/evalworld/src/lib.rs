//! # The seeded world an assistant evaluation is scored against
//!
//! One vault, deterministic, written **through the real typed commands**, dense
//! enough across all eight apps that a question about it has more than one
//! plausible answer.
//!
//! ## Why it is not a fixture file
//!
//! `crates/apps/*/tests/parity.rs` rebuilds a vault from
//! `contracts/schema/vault-ddl.sql` plus a `rows.json` bundle
//! ([`centraid_apps_kit::contract_vault`]), and for a parity suite that is
//! exactly right: the rows came from v0 and the point is to compare against
//! them unchanged. It is the wrong shape here. A hand-written row is a second
//! opinion about what a write produces — it carries no `core_entity` sibling,
//! no `row_version`, no ledger entry and no FTS trigger firing — so a runtime
//! scored against it is scored against a vault no member has. Every row below
//! is written by [`centraid_vault::Vault::execute`], which is the same handler
//! a tap runs.
//!
//! It is also why this crate holds no SQL. `cargo xtask rules`' `sql-confinement`
//! allows SQL only under `crates/{ontology,vault,search}` and `crates/apps/kit`,
//! and the refusal is load-bearing rather than incidental: a seeder that could
//! write a row directly would eventually write one the command plane refuses,
//! and the suite would then be scoring answers against a state the product
//! cannot reach.
//!
//! ## Determinism, and the one place it stops
//!
//! [`centraid_vault::clock::FixedClock`] plus
//! [`centraid_vault::clock::SeededIds`]: the same seed replays the same ids in
//! the same order, and every timestamp is arithmetic from [`NOW_MS`] rather
//! than from a wall clock. A suite whose expected answers drift with the
//! calendar goes red on a Tuesday for no reason anybody can act on.
//!
//! **Locker ciphertext is the exception, and it is deliberate.**
//! [`centraid_vault::custody::encrypt_under_locker_key`] draws a fresh nonce
//! per call and the key is drawn from the OS, so two builds of this world hold
//! the same locker ROWS — same ids, same titles, same types — sealed under
//! different bytes. That is the property the locker's whole design rests on and
//! it is not one to fixture away. The determinism suite therefore compares the
//! [`Inventory`], which is what a corpus author writes against; it does not
//! compare files.
//!
//! ## What "realistic" is made of here
//!
//! Collisions, on purpose. A world where exactly one row says "dentist" scores
//! every candidate architecture as excellent at disambiguation, because there
//! was nothing to disambiguate. So the world plants, and
//! [`Inventory::matching`] is how a later lane checks the planting is still
//! there:
//!
//! | Planted | Where |
//! |---|---|
//! | Nine rows saying **dentist**, across seven apps | notes ×2 (one trashed), docs, tasks ×2 (same due day), agenda, tally, locker, a People debt |
//! | Rows matching **Neha** — two whole people (both reachable by phone), one bare-first-name Tally friend, one event that names neither | people ×2 + channels ×3, tally ×1, agenda ×1 |
//! | Five matching **Marco**, one of them a trashed misspelling | people ×3, tally ×1, photos ×1 |
//! | An **event and a place with the same name** — "Emerald Bay" — and four more rows besides, plus a SECOND named place so "where was this taken" is not answered by elimination | agenda, photos ×3, notes, docs, locker |
//! | A **task and an event with the same title** — "Book the Tahoe cabin" | tasks, agenda |
//! | **Overlapping date windows**: a trip spanning `+5…+8`, a task due `+7`, three rows landing on `+2`/`+3` | tasks, agenda |
//! | **Soft-deleted rows in seven apps**, several colliding with live labels | notes, docs, tasks, tally, photos, locker, people |
//!
//! ## What is NOT here
//!
//! The corpus and the scoring. This crate answers "what is in the vault"; it
//! has no opinion about what a good answer to a question about it looks like,
//! and it must not grow one — a world that knew the questions would be a world
//! shaped to them.

#![forbid(unsafe_code)]

pub mod inventory;
mod bulk;
mod bulk2;
mod scenario;
mod scenario2;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::{Principal, Vault, VaultError};

pub use inventory::{Entity, Inventory, State};

/// THE WORLD'S "NOW": 2026-06-15T09:00:00.000Z.
///
/// Every read of this vault should be given this instant, and every date below
/// is arithmetic from it. It is a Monday morning, which is the only property of
/// it that is a choice rather than a constant: a week whose "this week" starts
/// tomorrow and whose "last week" is already closed reads like somebody's week.
pub const NOW_MS: i64 = 1_781_514_000_000;

/// The id seed. Changing it is a new world and a new set of expected answers,
/// so it is a constant rather than a parameter.
pub const SEED: &str = "centraid-evalworld/1";

/// The SECOND world's id seed. Distinct from [`SEED`] so that no row of one
/// world can carry an id a row of the other does.
pub const SEED_SECOND: &str = "centraid-evalworld/2";

/// **WHICH SEEDED WORLD.**
///
/// `suite.json` and `blind.json` are two corpora over [`Scenario::First`],
/// which holds out WORDING and not SCENARIO: a third of the blind set's
/// handles are rows the primary suite also names. [`Scenario::Second`] is a
/// world with a DISJOINT cast, places, trip and collision structure, and
/// `holdout.json` is written against it — so a candidate fitted to the first
/// world's nouns cannot transfer across.
///
/// The two share their SHAPE and share no proper noun;
/// `the_two_worlds_share_no_proper_noun` is what asserts the second half.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Scenario {
    /// Sam Whitaker's vault: the Tahoe weekend and the dentist.
    #[default]
    First,
    /// Dara Okonjo's vault: the Mendocino weekend and the optometrist.
    Second,
}

impl Scenario {
    /// The id seed this world is built under.
    #[must_use]
    pub const fn seed(self) -> &'static str {
        match self {
            Self::First => SEED,
            Self::Second => SEED_SECOND,
        }
    }

    /// The member whose vault it is.
    #[must_use]
    pub const fn owner(self) -> &'static str {
        match self {
            Self::First => OWNER,
            Self::Second => OWNER_SECOND,
        }
    }

    /// `1` or `2`, as `--scenario` and `--world` spell it.
    ///
    /// # Errors
    ///
    /// Any other text; the caller names what it was given.
    pub fn parse(text: &str) -> Result<Self, String> {
        match text {
            "1" | "first" => Ok(Self::First),
            "2" | "second" => Ok(Self::Second),
            other => Err(format!(
                "{other:?} is not a world; it is 1 (Sam Whitaker's) or 2 (Dara Okonjo's)"
            )),
        }
    }
}

/// How far before [`NOW_MS`] the world starts being written.
///
/// Three years, because a real vault has a long tail: the bulk of it was
/// written over years and only the last few weeks are the week somebody is
/// living in. Rows are created across that span rather than all in one instant,
/// because `created_at` is a sort key — a world whose every row was created in
/// the same millisecond has ties everywhere, and a keyset page over a tie is
/// exactly the case that distinguishes a correct reader from one that happens
/// to agree with SQLite's row order today.
const BUILD_STARTS_DAYS_BEFORE: i64 = 1095;

/// Where the STORY starts: the six weeks the suite's questions are about.
///
/// The long tail is written first and this is the instant the clock is jumped
/// to before the story is. It is load-bearing: every story row's `created_at`
/// is then exactly what it was when the world held 73 rows, so growing the
/// world moved no timestamp the corpus was written against.
const STORY_STARTS_DAYS_BEFORE: i64 = 42;

/// The member whose vault this is.
pub(crate) const OWNER: &str = "Sam Whitaker";

/// The member whose vault the SECOND world is.
///
/// A second world exists because `blind.json` holds out WORDING and not
/// SCENARIO — see [`Scenario`].
pub(crate) const OWNER_SECOND: &str = "Dara Okonjo";

/// How far the clock moves between one BULK command and the next.
///
/// Four hours across roughly five thousand commands is a little over two
/// years, which lands the last bulk row comfortably before the story starts.
pub(crate) const BULK_STEP_MS: i64 = 4 * 3_600_000;

/// How far the clock moves between one command and the next.
///
/// Six hours: 42 days of runway across roughly 170 commands, so the last row is
/// still written days before [`NOW_MS`] and nothing is created in its own
/// future.
pub(crate) const CLOCK_STEP_MS: i64 = 6 * 3_600_000;

pub const DAY_MS: i64 = 86_400_000;

/// A built world: where it is, and what is in it.
#[derive(Debug, Clone)]
pub struct World {
    /// The vault file. Its byte store is `<path>.bytes` and its Locker key
    /// custody is the `keys/` directory beside it.
    pub vault_path: PathBuf,
    pub inventory: Inventory,
}

/// Why a build could not finish.
#[derive(Debug)]
pub enum BuildError {
    Vault(VaultError),
    Io(std::io::Error),
    /// The file already holds a founded vault.
    ///
    /// The same guard `crates/centraid/src/bin/seed-demo-vault.rs` carries and
    /// for the same reason: this builder REMOVES the file it seeds, and pointed
    /// at a gateway's own directory that destroys a vault somebody is using.
    /// There is no `--force` here, because an evaluation world is always
    /// written somewhere new.
    AlreadyAVault {
        path: PathBuf,
        vault_id: String,
    },
    /// The vault refused commands. Named, never swallowed.
    Refused(Vec<String>),
}

impl std::fmt::Display for BuildError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Vault(error) => write!(formatter, "{error}"),
            Self::Io(error) => write!(formatter, "{error}"),
            Self::AlreadyAVault { path, vault_id } => write!(
                formatter,
                "{} already holds vault {vault_id}; this builder deletes the file it seeds, so seed somewhere else",
                path.display()
            ),
            Self::Refused(refusals) => {
                writeln!(
                    formatter,
                    "the vault refused {} command(s); the world is incomplete:",
                    refusals.len()
                )?;
                for line in refusals {
                    writeln!(formatter, "  {line}")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for BuildError {}

impl From<VaultError> for BuildError {
    fn from(error: VaultError) -> Self {
        Self::Vault(error)
    }
}

impl From<std::io::Error> for BuildError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

/// An ISO-8601 instant `days` from [`NOW_MS`], at `hour:minute` UTC.
///
/// Through [`centraid_vault::clock::format_iso_ms`], which is the schema's own
/// spelling — a second `strftime` in a fixture is a fixture whose timestamps
/// sort differently from the product's.
#[must_use]
pub fn at(days: i64, hour: i64, minute: i64) -> String {
    let midnight = (NOW_MS / DAY_MS) * DAY_MS + days * DAY_MS;
    centraid_vault::clock::format_iso_ms(midnight + hour * 3_600_000 + minute * 60_000)
}

/// The date alone, `YYYY-MM-DD`, `days` from [`NOW_MS`].
#[must_use]
pub fn day(days: i64) -> String {
    at(days, 0, 0)[..10].to_owned()
}

/// The instant every read of this world should be given.
#[must_use]
pub fn now_text() -> String {
    centraid_vault::clock::format_iso_ms(NOW_MS)
}

/// One command, run and recorded.
///
/// A refusal is **collected, and the build fails at the end** rather than
/// stopping at the first one: a world missing two apps and a world missing one
/// command are different findings, and stopping early reports the second when
/// the first is true.
pub(crate) struct Seeder<'a> {
    vault: &'a Vault,
    registry: &'a Registry,
    principal: Principal,
    clock: Arc<FixedClock>,
    pub(crate) refusals: Vec<String>,
    pub(crate) entities: Vec<Entity>,
    /// How far the clock moves per command. Set per PHASE: the long tail is
    /// written with a small step and the story with the six-hour step it has
    /// always had.
    step_ms: i64,
}

impl Seeder<'_> {
    /// Run a command; answer its output, or nothing.
    pub(crate) fn run(&mut self, name: &str, body: serde_json::Value) -> Option<serde_json::Value> {
        // BEFORE the command, so the row it writes is stamped later than the
        // row before it. Stamping after would put the first row of the world at
        // the start instant and every other row one step early.
        self.clock.advance_ms(self.step_ms);
        match self
            .vault
            .execute(self.registry, &self.principal, &Command::new(name, body))
        {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Some(outcome.output),
            Ok(outcome) => {
                self.refusals.push(format!(
                    "{name}: {}",
                    outcome
                        .reason
                        .unwrap_or_else(|| "no reason given".to_owned())
                ));
                None
            }
            Err(error) => {
                self.refusals.push(format!("{name}: {error}"));
                None
            }
        }
    }

    /// Run a command and take one minted id out of its output.
    pub(crate) fn id(
        &mut self,
        name: &str,
        field: &str,
        body: serde_json::Value,
    ) -> Option<String> {
        self.run(name, body)?
            .get(field)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    }

    /// The clock step for the commands that follow.
    pub(crate) fn set_step_ms(&mut self, step_ms: i64) {
        self.step_ms = step_ms;
    }

    /// Move the clock FORWARD to `target_ms`, or leave it alone if it is
    /// already past.
    ///
    /// [`FixedClock`] only goes forward, which is the right shape: a seeder
    /// that could rewind could write a row before the row it depends on. This
    /// is how the long-tail phase hands over to the story phase at exactly the
    /// instant the story has always started at.
    pub(crate) fn jump_to(&mut self, target_ms: i64) {
        use centraid_vault::clock::Clock as _;
        let now = self.clock.now_ms();
        if target_ms > now {
            self.clock.advance_ms(target_ms - now);
        } else {
            self.refusals.push(format!(
                "the long tail overran the story window by {} day(s); lower a bulk count or                  BULK_STEP_MS",
                (now - target_ms) / DAY_MS
            ));
        }
    }

    /// An id the CALLER mints, which Locker requires: a secret is sealed
    /// against the row id, so the party that encrypts has to know the id before
    /// the row exists (D-1020-L9).
    pub(crate) fn mint(&self) -> String {
        self.vault.ids().next()
    }

    /// Record a row in the inventory.
    ///
    /// `plane` is `(app id, logical entity)` as ONE argument rather than two,
    /// because they are one fact: `("tasks", "schedule.task")` is a single
    /// choice, and splitting it is how a call site ends up naming the Tasks app
    /// beside a People entity.
    pub(crate) fn note(
        &mut self,
        id: &str,
        plane: (&str, &str),
        label: &str,
        date: Option<String>,
        state: State,
        planted: Option<&str>,
    ) {
        let (app, entity) = plane;
        self.entities.push(Entity {
            id: id.to_owned(),
            app: app.to_owned(),
            entity: entity.to_owned(),
            label: label.to_owned(),
            date,
            value: None,
            facts: std::collections::BTreeMap::new(),
            state,
            planted: planted.map(str::to_owned),
        });
    }

    /// Record one of the row's own attributes — see [`Entity::facts`].
    pub(crate) fn fact(&mut self, id: &str, key: &str, value: impl Into<String>) {
        if let Some(entity) = self.entities.iter_mut().find(|entity| entity.id == id) {
            entity.facts.insert(key.to_owned(), value.into());
        }
    }

    /// Attach the row's salient scalar — see [`Entity::value`].
    ///
    /// A setter rather than a ninth argument to [`Self::note`]: only a handful
    /// of rows have a scalar that is itself an answer, and widening the call
    /// every other row already makes would put a `None` on thirty call sites
    /// to serve five.
    pub(crate) fn value(&mut self, id: &str, value: impl Into<String>) {
        if let Some(entity) = self.entities.iter_mut().find(|entity| entity.id == id) {
            entity.value = Some(value.into());
        }
    }

    /// Mark an already-recorded row as no longer live.
    ///
    /// Separate from [`Self::note`] because a trashed row is seeded like any
    /// other and then trashed: the vault writes `deleted_at`, and the
    /// inventory has to say the same thing the vault does.
    pub(crate) fn restate(&mut self, id: &str, state: State) {
        if let Some(entity) = self.entities.iter_mut().find(|entity| entity.id == id) {
            entity.state = state;
        }
    }

    pub(crate) fn vault(&self) -> &Vault {
        self.vault
    }
}

/// Build the world at `dir`, fresh.
///
/// The vault is `<dir>/world.db`, its byte store `<dir>/world.bytes`, its
/// Locker key custody `<dir>/keys`, and the inventory is written to
/// `<dir>/inventory.json` as well as returned.
///
/// # Errors
///
/// [`BuildError::AlreadyAVault`] if `dir` already holds a founded vault —
/// this function deletes what it seeds over. [`BuildError::Refused`] if any
/// command was refused, because a partially seeded world scored in silence is
/// the failure this whole crate exists downstream of.
pub fn build(dir: &Path) -> Result<World, BuildError> {
    build_scenario(dir, Scenario::First)
}

/// Build one of the seeded worlds at `dir`, fresh.
///
/// [`build`] is this with [`Scenario::First`]; the second world is the same
/// shape and size class with a disjoint cast, places, trip and collision
/// structure, and it exists so a holdout corpus can hold out the SCENARIO
/// rather than only the wording.
///
/// # Errors
///
/// As [`build`].
pub fn build_scenario(dir: &Path, scenario: Scenario) -> Result<World, BuildError> {
    std::fs::create_dir_all(dir)?;
    let vault_path = dir.join("world.db");
    refuse_an_existing_vault(&vault_path)?;
    // A FRESH FILE EVERY TIME. A world seeded on top of a previous run has
    // counts nobody can predict, and the counts are the ground truth.
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.join(format!("world.db{suffix}")));
    }
    let bytes_dir = vault_path.with_extension("bytes");
    let _ = std::fs::remove_dir_all(&bytes_dir);
    let keys_dir = dir.join("keys");
    let _ = std::fs::remove_dir_all(&keys_dir);

    // THE ONE CONTENT STORE (D-1025-S3-1), on its own runtime. A vault with no
    // store refuses every photograph by name, and a fixture that attached a
    // different kind of store would be seeding an arrangement no device has.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(BuildError::Io)?;
    let store = runtime
        .block_on(centraid_blobs::ByteStore::open(&bytes_dir))
        .map_err(|error| {
            BuildError::Io(std::io::Error::other(format!(
                "the content store at {} does not open: {error}",
                bytes_dir.display()
            )))
        })?;
    // Kept to close it with: iroh-blobs flushes its index on shutdown, and a
    // store left unflushed is a world whose photographs another process reads
    // as absent.
    let to_close = store.clone();

    let clock = Arc::new(FixedClock::at(NOW_MS - BUILD_STARTS_DAYS_BEFORE * DAY_MS));
    let vault = Vault::create_with(
        &vault_path,
        Box::new(Arc::clone(&clock)),
        Box::new(SeededIds::new(scenario.seed())),
    )?
    .with_blobs(Box::new(centraid_blobs::ContentBytes::new(
        store,
        runtime.handle().clone(),
    )));

    // LET SQLITE CHECKPOINT AS IT GOES, which the product deliberately does
    // not. `Vault::open_with` sets `wal_autocheckpoint = 0` because under
    // capture the application owns checkpoints (#1029 §1) — a checkpoint ahead
    // of the spool is how a committed transaction is lost. **This builder has
    // no capture and no spool**, so nothing here holds the frames, and the
    // pragma's only effect is that the `-wal` stops being the world's entire
    // write history. Seeding five thousand rows without it peaked at a 1.4 GB
    // log beside a 4 KB database and filled the disk; with it the peak is a few
    // megabytes. It is a connection setting rather than a write, which is why
    // the read path will carry it.
    vault
        .read(|connection| Ok(connection.pragma_update(None, "wal_autocheckpoint", 1_000_i64)?))?;

    let founded = vault.found("Evaluation vault", scenario.owner())?;
    let registry = Registry::with_system_commands()?;
    registry.install(&vault)?;

    let mut seeder = Seeder {
        vault: &vault,
        registry: &registry,
        principal: Principal::owner("evalworld-device"),
        clock: Arc::clone(&clock),
        refusals: Vec::new(),
        entities: Vec::new(),
        step_ms: BULK_STEP_MS,
    };
    match scenario {
        Scenario::First => scenario::seed(
            &mut seeder,
            &founded.owner_party_id,
            &keys_dir,
            &founded.vault_id,
        ),
        Scenario::Second => scenario2::seed(
            &mut seeder,
            &founded.owner_party_id,
            &keys_dir,
            &founded.vault_id,
        ),
    }

    let Seeder {
        refusals, entities, ..
    } = seeder;
    vault.close()?;
    runtime.block_on(to_close.close());
    checkpoint_the_wal(&vault_path)?;

    if !refusals.is_empty() {
        return Err(BuildError::Refused(refusals));
    }

    let inventory = Inventory {
        now: now_text(),
        seed: scenario.seed().to_owned(),
        vault_id: founded.vault_id,
        owner_party_id: founded.owner_party_id,
        entities,
        refusals,
    };
    std::fs::write(
        dir.join("inventory.json"),
        inventory
            .to_json()
            .map_err(|error| BuildError::Io(std::io::Error::other(error)))?,
    )?;
    Ok(World {
        vault_path,
        inventory,
    })
}

/// FOLD THE WRITE-AHEAD LOG BACK INTO THE DATABASE FILE.
///
/// A defect this crate had all along and that only a big world made visible.
/// The vault sets `wal_autocheckpoint = 0` — under capture the application owns
/// checkpoints (#1029 §1) — and nothing in a build owns one, so the `-wal` is
/// the world's ENTIRE write history rather than its tail. At 73 rows that is a
/// few megabytes nobody notices. At five thousand it was **1.4 GB beside a 4 KB
/// `world.db`**, and `evalsuite` copies this directory once per session: an
/// eighty-five-session run would have moved 120 GB and filled the disk.
///
/// So the log is folded in once, after the vault is closed and by a connection
/// of its own. It has to be a fresh connection: SQLite refuses a TRUNCATE
/// checkpoint inside a transaction and refuses any write through the vault's
/// `query_only` read path, and there is no third door. This is also why it is
/// a pragma rather than a statement — this crate holds no SQL, and
/// `sql-confinement` is right to refuse it one.
fn checkpoint_the_wal(vault_path: &Path) -> Result<(), BuildError> {
    let connection = centraid_vault::rusqlite::Connection::open(vault_path)
        .map_err(|error| BuildError::Io(std::io::Error::other(error)))?;
    connection
        .pragma_update(None, "journal_size_limit", 0_i64)
        .and_then(|()| connection.pragma_update(None, "wal_checkpoint", "TRUNCATE"))
        .map_err(|error| BuildError::Io(std::io::Error::other(error)))?;
    connection
        .close()
        .map_err(|(_, error)| BuildError::Io(std::io::Error::other(error)))
}

/// Refuse a file that is already somebody's vault.
///
/// Answered by [`Vault::vault_id`], which is the vault's own question and needs
/// no SQL here — `sql-confinement` would refuse a query in this crate, and it
/// is right to.
fn refuse_an_existing_vault(vault_path: &Path) -> Result<(), BuildError> {
    if !vault_path.exists() {
        return Ok(());
    }
    let Ok(vault) = Vault::open(vault_path) else {
        // Not a Centraid file at all; the removal below is what it always was.
        return Ok(());
    };
    let found = vault.vault_id().ok().flatten();
    // Closed before anything else touches the path: an open handle over a file
    // about to be removed is how a `-wal` outlives its database.
    let _ = vault.close();
    match found {
        Some(vault_id) => Err(BuildError::AlreadyAVault {
            path: vault_path.to_path_buf(),
            vault_id,
        }),
        None => Ok(()),
    }
}
