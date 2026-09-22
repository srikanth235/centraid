//! # The assistant evaluation: outcomes, not calls
//!
//! This crate is the SCORER and the HARNESS. It answers one question —
//! *given this vault and this conversation, did the candidate reach the right
//! outcome?* — and it is deliberately incapable of answering any other. In
//! particular it has no opinion about how a candidate reaches it: no
//! FTS-first assumption, no classifier, no plan grammar. A candidate is a
//! `&mut dyn` implementation of [`Candidate`] that is handed a request and a
//! [`Context`] and answers a [`Plan`]. Everything it does in between is its
//! own business and is never inspected.
//!
//! ## Why the interface is shaped this way
//!
//! A harness that scored a *call sequence* would be a harness that had already
//! chosen an architecture: it would reward a runtime that searches before it
//! reads, and punish one that reads a board directly even when the board holds
//! the answer. So the only thing scored is:
//!
//! * for a `ids` case — the row ids the candidate answered with;
//! * for a `write` case — the state of the vault AFTER the turn, through a
//!   named predicate;
//! * for a `no_action` case — that the candidate declined AND wrote nothing.
//!
//! [`Context`] is the action space, not a script. It offers the two real doors
//! (`centraid_search` and the app crates' own `load_*`) and the typed command
//! plane, because those are the doors a shipped runtime would have. A
//! candidate may call them in any order, any number of times, or not at all.
//!
//! ## The soft-delete ruling
//!
//! **A row's own `deleted_at` is ground truth. An app board that shows a
//! soft-deleted row is wrong, and the harness does not adopt its answer.**
//!
//! Tasks and Agenda are the two app crates in the workspace that never filter
//! `deleted_at` (characterised in `crates/evalworld/tests/world.rs`), so the
//! FTS door and the Tasks board disagree about a trashed task. Scoring by the
//! board would freeze that defect into the evaluation and then mark DOWN a
//! candidate that correctly hides a row the member deleted — the evaluation
//! would be enforcing the bug. Scoring by `deleted_at` costs nothing if the
//! defect is fixed and is right either way.
//!
//! The harness does not hide the disagreement from a candidate, though:
//! [`Context::open`] returns every row the app door returned and stamps each
//! with [`VaultRow::live`], read from the row's own `deleted_at`. What a
//! candidate does with that is a property of the candidate. What the SUITE may
//! expect is fixed: a trashed row is never a correct answer.

#![forbid(unsafe_code)]

/// The instrument with a DIAL — right with probability `p`, degenerate
/// otherwise. What shows that the score ranks rather than only floors.
pub mod degraded;
pub mod handles;
/// The SECOND held-out corpus's reference — `holdout.json`, over
/// `centraid_evalworld::Scenario::Second`. `blind.json` holds out WORDING
/// over one world; this one holds out the SCENARIO.
pub mod holdoutref;
/// The degenerate and crippled measuring instruments. **In the library, not
/// beside the binary**: `cargo test` could not reach them while they were a
/// `#[path]` module of `run-nulls`, so the only thing asserting that a flawed
/// candidate scores badly was a report nobody's CI read (review item 15).
pub mod nulls;
pub mod reference;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{PageDoor, read_by_id};
use centraid_apps_kit::row::{Cell, Row};
use centraid_apps_kit::statement::{PageBindValue, PageOrder, PageQuery};
use centraid_apps_kit::testdoor::TestDoor;
use centraid_search::{Search as _, SearchRequest, SqliteDoor};
use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// The suite, as the contract spells it.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Suite {
    pub version: u32,
    /// The world's day, `YYYY-MM-DD`. A suite whose expected answers drift
    /// with the calendar is not ground truth.
    pub today: String,
    /// **STABLE ROW HANDLES — see [`handles`].** A case names `people/neha-rao`
    /// and this says which row that is, by its app, entity and label. Nothing
    /// in this file is a uuid, because a uuid is a function of the seeding
    /// order and adding one command to the world would rewrite the corpus.
    /// Turned into ids by [`Suite::resolve`], once, before anything is scored.
    #[serde(default)]
    pub handles: BTreeMap<String, handles::HandleSpec>,
    pub sessions: Vec<Session>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub category: String,
    /// SESSIONS THAT ARE THE SAME QUESTION IN TWO SHAPES.
    ///
    /// `s71`/`s02` are the overdue task as a count and as a row; `s65`/`s09`
    /// are the trip's four expenses as a list and as a sum. Both pairs are
    /// deliberate — the shapes are what is being told apart — but a per-
    /// category average counts the same retrieval twice, and a candidate that
    /// happens to nail that one retrieval is paid for it twice. A session that
    /// names a group is averaged with its fellows into ONE unit before the
    /// de-duplicated column is taken; the raw column is printed beside it and
    /// neither is hidden.
    ///
    /// Declared by the suite, never inferred: `s71` and `s02` share no id at
    /// all (one expects a number), so no overlap detector could find that pair
    /// — only the author knows they are the same question.
    #[serde(default)]
    pub correlation_group: Option<String>,
    pub turns: Vec<Turn>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub request: String,
    pub expected: Expected,
}

/// What a correct turn LOOKS LIKE — never how it is reached.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Expected {
    /// The candidate answered with these rows.
    Ids {
        /// The logical entity, or `"*"` where the answer legitimately spans
        /// several — a day window crossing Agenda and Tasks, a broad "what do
        /// I have about Emerald Bay". **Advisory either way**: the ids are the
        /// ground truth, and this harness has never scored on the entity. It
        /// is carried so a suite author can say what they meant and a
        /// validator can check they meant it.
        entity: String,
        ids: Vec<String>,
        #[serde(default)]
        ordered: bool,
        /// THE SORT THE CASE ASSERTS, in the case's own words —
        /// `"due_at ascending"`, `"captured_at descending"`.
        ///
        /// `ordered: true` on its own says the ids must come back in this
        /// sequence but never says WHY that sequence is the right one, so a
        /// candidate that sorted by a different reasonable key fails a rule
        /// the suite never stated. The harness still scores the sequence
        /// strictly — relaxing it would weaken the verdict — but every
        /// `ordered` turn with no `order_by` is named in the report's
        /// UNDECLARED ORDERING register, because an ordering nobody wrote
        /// down is not a result anyone should quote.
        ///
        /// **Never scored against the vault.** The harness does not re-sort
        /// the world to check the claim; it records whether the case made one.
        #[serde(default)]
        order_by: Option<String>,
    },
    /// The candidate answered with a NUMBER.
    ///
    /// "How much did I spend last month" has an answer that is a sum, and
    /// expressing it as *which four expense rows* scores a candidate that
    /// retrieves perfectly and adds wrong as correct. Compared exactly;
    /// `unit` is advisory and never scored, because a currency the case and
    /// the candidate spell differently is a disagreement about words.
    Value {
        value: f64,
        #[serde(default)]
        unit: Option<String>,
    },
    /// The vault ended the turn in a state this predicate accepts.
    Write {
        predicate: String,
        #[serde(default)]
        args: Map<String, Value>,
    },
    /// SEVERAL writes, ALL of which must hold.
    ///
    /// "Move both dentist tasks to Friday" is one instruction with two
    /// outcomes, and a single-target expectation would have made every write
    /// case easier than the ones a member actually gives. All-or-nothing on
    /// purpose: half a bulk edit is a worse outcome than none of it, because
    /// the member believes it finished.
    WriteSet {
        writes: Vec<WriteExpectation>,
        /// **THE HARNESS REFUSES TO SCORE THIS, and says so loudly.**
        ///
        /// A `write_set` is judged by asking each predicate about the vault
        /// AFTER the turn, and an end state cannot witness the order the
        /// writes arrived in: "reschedule the task, then cancel the event"
        /// and the reverse leave byte-identical vaults. Scoring it would mean
        /// scoring the call sequence, which is the one thing this harness is
        /// built not to do — it would reward whichever architecture happens
        /// to emit commands in the author's order.
        ///
        /// So a case that sets this is a SUITE ERROR rather than a quietly
        /// ignored field: the turn fails with a complaint naming the refusal,
        /// so nobody writes a case believing the order is being checked. If
        /// write order ever has to be scored, it needs an ordered write LOG
        /// in the outcome vocabulary, not a flag here.
        #[serde(default)]
        ordered: bool,
    },
    /// The candidate declined, and wrote nothing.
    ///
    /// `reason` is `clarify`, `refuse` or `none` — the last for true
    /// abandonment, where the member moved on and the correct outcome is that
    /// nothing happened.
    NoAction {
        reason: String,
        /// What is ambiguous or refused, for a human reading the suite.
        /// **Never scored** — an explanation the harness graded would be a
        /// harness scoring words again.
        #[serde(default)]
        why: Option<String>,
    },
}

/// One expected write inside a [`Expected::WriteSet`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteExpectation {
    pub predicate: String,
    #[serde(default)]
    pub args: Map<String, Value>,
}

impl Suite {
    /// Read a suite from a JSON file.
    ///
    /// # Errors
    ///
    /// The file is unreadable, or it is not a suite.
    pub fn read(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        serde_json::from_str(&text).map_err(|error| format!("{}: {error}", path.display()))
    }
}

// ---------------------------------------------------------------------------
// The world, made cheap to re-deal.
// ---------------------------------------------------------------------------

/// The eight app boards a candidate may open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum App {
    Agenda,
    Docs,
    Locker,
    Notes,
    People,
    Photos,
    Tally,
    Tasks,
}

impl App {
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Agenda => "agenda",
            Self::Docs => "docs",
            Self::Locker => "locker",
            Self::Notes => "notes",
            Self::People => "people",
            Self::Photos => "photos",
            Self::Tally => "tally",
            Self::Tasks => "tasks",
        }
    }

    #[must_use]
    pub const fn all() -> [Self; 8] {
        [
            Self::Agenda,
            Self::Docs,
            Self::Locker,
            Self::Notes,
            Self::People,
            Self::Photos,
            Self::Tally,
            Self::Tasks,
        ]
    }
}

/// Where a logical entity's row lives, so liveness can be read from the row
/// itself rather than inferred from whichever door answered.
#[must_use]
pub fn row_of(entity: &str) -> Option<(&'static str, &'static str)> {
    Some(match entity {
        "knowledge.note" => ("knowledge_note", "note_id"),
        "core.party" => ("core_party", "party_id"),
        "core.event" => ("core_event", "event_id"),
        "schedule.task" => ("schedule_task", "task_id"),
        "tally.expense" => ("tally_expense", "expense_id"),
        "core.document" => ("core_document", "document_id"),
        // THE PHOTOS ID IS THE ASSET, not the content item. `evalworld`'s
        // inventory records a photograph by the id `media.add_asset` minted,
        // while `centraid_search`'s `core.content_item` domain indexes
        // `core_content_item.content_id`. The two are different keys for the
        // same picture; this harness scores on the asset, because that is what
        // a suite author reads out of `inventory.json`.
        //
        // The two key spaces are JOINED AT THE SEARCH DOOR, not left to the
        // candidate: [`Context::search`] translates a `core.content_item` hit
        // to the `asset_id` that owns it (`media_asset.content_id` is UNIQUE),
        // so a picture found through the search plane answers in the same key
        // a case is written against. Before that translation, 11 photograph
        // ids were unreachable by search alone and a retrieval-first candidate
        // was marked down for a seam of ours. Bytes no asset owns — a
        // document's content item — keep their `content_id` and are stamped
        // `unowned_bytes` rather than being passed off as a photograph.
        "core.content_item" => ("media_asset", "asset_id"),
        "locker.item" => ("locker_item", "item_id"),
        "core.place" => ("core_place", "place_id"),
        "media.album" => ("media_album", "album_id"),
        "tally.group" => ("tally_group", "group_id"),
        "people.important_date" => ("people_important_date", "date_id"),
        "social.contact_channel" => ("social_contact_channel", "channel_id"),
        "core.activity" => ("core_activity", "activity_id"),
        "tally.obligation" => ("tally_obligation", "obligation_id"),
        "tally.settlement" => ("tally_settlement", "settlement_id"),
        // The Kinds the manifests declare `surface: "kind"` beyond the
        // original nineteen. `knowledge.notebook` is the Notes door's own word
        // for `core.collection`, the way `media.album` is Photos' (both are
        // rows of `core_collection`; Photos reads its own view).
        "knowledge.notebook" => ("core_collection", "collection_id"),
        "social.circle" => ("social_circle", "circle_id"),
        "schedule.project" => ("schedule_project", "project_id"),
        "core.account" => ("core_account", "account_id"),
        "core.transaction" => ("core_transaction", "txn_id"),
        _ => return None,
    })
}

/// A world built once and dealt many times.
///
/// Building the seeded vault runs ~170 typed commands and a blob store; doing
/// that per session would make a 40-session suite a coffee break. A built
/// world is a handful of files, so a session gets a FRESH world by copying
/// them — writes in one session cannot reach another, and the deal costs
/// milliseconds.
pub struct WorldTemplate {
    dir: tempfile::TempDir,
    pub inventory: centraid_evalworld::Inventory,
}

impl WorldTemplate {
    /// Seed the template world once.
    ///
    /// # Errors
    ///
    /// The world does not build — a refused command, or a directory that
    /// already holds a vault.
    pub fn build() -> Result<Self, String> {
        Self::build_scenario(centraid_evalworld::Scenario::First)
    }

    /// Seed one of the two worlds once.
    ///
    /// [`Self::build`] is this with `Scenario::First`. `holdout.json` is
    /// written against `Scenario::Second` — a disjoint cast, places, weekend
    /// and collision structure — so that a corpus can hold out the SCENARIO
    /// and not only the wording.
    ///
    /// # Errors
    ///
    /// As [`Self::build`].
    pub fn build_scenario(scenario: centraid_evalworld::Scenario) -> Result<Self, String> {
        let dir = tempfile::tempdir().map_err(|error| format!("a temp dir: {error}"))?;
        let world = centraid_evalworld::build_scenario(dir.path(), scenario)
            .map_err(|error| error.to_string())?;
        Ok(Self {
            dir,
            inventory: world.inventory,
        })
    }

    /// A private copy of the world, on its own temp directory.
    ///
    /// # Errors
    ///
    /// The copy fails.
    pub fn deal(&self) -> Result<Dealt, String> {
        let into = tempfile::tempdir().map_err(|error| format!("a temp dir: {error}"))?;
        copy_tree(self.dir.path(), into.path())?;
        let vault_path = into.path().join("world.db");
        let now_ms = centraid_evalworld::NOW_MS;
        // THE CLOCK AND THE IDS ARE INJECTED, and they must be: `Vault::open`
        // takes the wall clock, so a candidate's write would be stamped
        // whenever the suite happened to run and a predicate about "today"
        // would drift. The id seed is distinct from the world's so a row a
        // candidate mints cannot collide with one the world planted.
        let vault = Vault::open_with(
            &vault_path,
            Box::new(FixedClock::at(now_ms)),
            Box::new(SeededIds::new("centraid-evalsuite/1")),
        )
        .map_err(|error| format!("the world does not open: {error}"))?;
        let registry =
            Registry::with_system_commands().map_err(|error| format!("the registry: {error}"))?;
        Ok(Dealt {
            digest_cache: std::cell::RefCell::new(None),
            shapes: std::cell::RefCell::new(centraid_ontology::snapshot::SnapshotCache::new()),
            scans: std::cell::Cell::new(0),
            scan_micros: std::cell::Cell::new(0),
            keys_dir: into.path().join("keys"),
            _dir: into,
            vault: Some(vault),
            registry,
            now: centraid_evalworld::now_text(),
            now_ms,
            me: self.inventory.owner_party_id.clone(),
        })
    }
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|error| format!("{}: {error}", to.display()))?;
    let entries =
        std::fs::read_dir(from).map_err(|error| format!("{}: {error}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let target = to.join(entry.file_name());
        let kind = entry
            .file_type()
            .map_err(|error| format!("{}: {error}", entry.path().display()))?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)
                .map_err(|error| format!("{}: {error}", entry.path().display()))?;
        }
    }
    Ok(())
}

/// One session's private world.
pub struct Dealt {
    keys_dir: PathBuf,
    _dir: tempfile::TempDir,
    vault: Option<Vault>,
    registry: Registry,
    now: String,
    now_ms: i64,
    me: String,
    /// **THE LAST DIGEST, AND THE CHANGE COUNTER IT WAS TAKEN AT.**
    ///
    /// See [`Dealt::digest`]: SQLite counts every row its connection has
    /// inserted, updated or deleted, so a turn that only read cannot have
    /// moved the counter, and re-scanning 140 tables to learn that is the
    /// single most expensive thing the harness does.
    digest_cache: std::cell::RefCell<Option<(u64, VaultDigest)>>,
    /// The schema shapes, remembered across this world's scans.
    shapes: std::cell::RefCell<centraid_ontology::snapshot::SnapshotCache>,
    /// Scans actually taken, and what they cost — the harness's own bill,
    /// never a candidate's.
    scans: std::cell::Cell<usize>,
    scan_micros: std::cell::Cell<u128>,
}

impl Dealt {
    fn vault(&self) -> &Vault {
        self.vault.as_ref().expect("the vault outlives the session")
    }

    /// EVERY MUTABLE ROW IN THE VAULT, AS A DIGEST.
    ///
    /// `centraid_ontology::snapshot` walks every table `sqlite_master` names
    /// (minus the FTS shadows, which are a function of the rows they index)
    /// and hashes each row's columns — `deleted_at` and `updated_at`
    /// included, so a soft delete and a touch are both changes. This crate
    /// holds no SQL of its own and could not have written that scan; it is
    /// borrowed from the layer that is allowed to.
    ///
    /// A table with no single-column primary key cannot be diffed row by row,
    /// so its ROW COUNT is carried instead, under the key `table/#rows`. That
    /// is weaker — a row rewritten in place is invisible — and it is named in
    /// the report rather than hidden.
    /// **AND WHY IT IS NOT TAKEN TWICE FOR NOTHING.**
    ///
    /// The scan is ~140 tables and every row in them, and the harness asks for
    /// one after EVERY turn — which doubled the cost of a full run for an
    /// answer that, on the ~80% of turns that never write, is identical to
    /// the one before it. The gate is SQLite's own
    /// `sqlite3_total_changes`: the count of rows this connection has
    /// inserted, updated or deleted since it was opened. The vault holds ONE
    /// connection (`crates/vault/src/file.rs`), commands go through it, and
    /// nothing else in the process can touch the file — so an unchanged
    /// counter is proof that no row moved, not a heuristic about it.
    ///
    /// **It weakens nothing.** A turn that wrote re-scans in full, including
    /// a write the vault rolled back (a rollback still moves the counter, so
    /// the answer is re-derived rather than assumed). What the digest catches
    /// — a soft delete, a touched `updated_at`, a bystander row moved by a
    /// correct command — is caught exactly as before.
    pub fn digest(&self) -> VaultDigest {
        let changes = self
            .vault()
            .read(|connection| Ok(connection.total_changes()))
            .unwrap_or(u64::MAX);
        if let Some((taken_at, digest)) = self.digest_cache.borrow().as_ref() {
            if *taken_at == changes {
                return digest.clone();
            }
        }
        let started = std::time::Instant::now();
        let mut shapes = self.shapes.borrow_mut();
        let snapshot = self
            .vault()
            .read(|connection| {
                centraid_ontology::snapshot::snapshot_vault_cached(connection, &mut shapes)
                    .map_err(|error| sql_error(error.to_string()))
            })
            .unwrap_or_default();
        drop(shapes);
        let mut digest = VaultDigest::new();
        for (table, table_snapshot) in snapshot {
            if BOOKKEEPING.iter().any(|(name, _)| *name == table) {
                continue;
            }
            if table_snapshot.primary_key.is_none() {
                digest.insert(format!("{table}/#rows"), table_snapshot.rows.to_string());
                continue;
            }
            for (id, row_digest) in table_snapshot.digests {
                digest.insert(format!("{table}/{id}"), row_digest);
            }
        }
        self.scans.set(self.scans.get() + 1);
        self.scan_micros
            .set(self.scan_micros.get() + started.elapsed().as_micros());
        *self.digest_cache.borrow_mut() = Some((changes, digest.clone()));
        digest
    }

    /// **THE DIGEST OF A WORLD NOTHING HAS TOUCHED YET, HANDED IN.**
    ///
    /// A freshly dealt world is a byte copy of the template, so its digest is
    /// the same digest every session starts from and scanning for it 90 times
    /// buys one answer 90 times. The caller that already holds that answer
    /// primes it here, against this world's current change counter; the first
    /// row any turn moves moves the counter and the next digest is a real
    /// scan again.
    ///
    /// Only sound for a world NOTHING has run against yet, which is the only
    /// place [`run`] calls it, and `two_fresh_deals_digest_alike` is what
    /// stops it being an assumption.
    pub fn prime(&self, digest: VaultDigest) {
        let changes = self
            .vault()
            .read(|connection| Ok(connection.total_changes()))
            .unwrap_or(u64::MAX);
        *self.digest_cache.borrow_mut() = Some((changes, digest));
    }

    /// How many full scans this world has actually paid for, and their total
    /// microseconds. The harness's own cost, reported apart from every
    /// candidate's.
    #[must_use]
    pub fn scan_cost(&self) -> (usize, u128) {
        (self.scans.get(), self.scan_micros.get())
    }
}

impl Drop for Dealt {
    fn drop(&mut self) {
        // Closed rather than dropped: an open handle leaves a `-wal` beside a
        // file about to be removed, and the temp dir then fails to clear.
        if let Some(vault) = self.vault.take() {
            let _ = vault.close();
        }
    }
}

// ---------------------------------------------------------------------------
// What a candidate sees, and what it answers.
// ---------------------------------------------------------------------------

/// One row, as any door describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultRow {
    pub id: String,
    pub entity: String,
    pub app: String,
    pub label: String,
    /// The row's own salient date, when it has one.
    pub date: Option<String>,
    /// **From the row's own `deleted_at`**, never from whichever door answered
    /// — see the module note on the soft-delete ruling.
    pub live: bool,
    /// THE FACTS THE APP'S OWN READER COMPUTED, that the row does not carry:
    /// a photograph's favourite flag and album titles, a document's star, a
    /// task's status and effort, an expense's group and payer.
    ///
    /// It is a bag rather than a struct on purpose. A struct would be this
    /// harness deciding which facts a candidate is allowed to reason over, and
    /// that is an architecture. These are simply what `load_*` answered.
    pub extra: BTreeMap<String, String>,
}

/// What a candidate answers for one turn.
///
/// Four shapes, matching the four the suite may expect. There is no "plan" in
/// the sense of a call list: the calls already happened, through [`Context`],
/// and nobody looked.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// These rows, in this order where order was asked for.
    Ids(Vec<String>),
    /// A write was made. The predicate, not the candidate, says whether it was
    /// the right one.
    Wrote,
    /// A single number — a sum, a count, a balance.
    Value(f64),
    /// The candidate declined — `"clarify"` or `"refuse"`.
    Declined { reason: String },
}

/// One turn, as it happened.
#[derive(Debug, Clone)]
pub struct TurnRecord {
    pub request: String,
    pub plan: Plan,
}

/// The doors, the clock and the conversation so far.
///
/// This is the whole action space. It is not a script and it imposes no order:
/// a candidate may search first, open a board first, write without reading, or
/// answer from the conversation alone.
pub struct Context<'world> {
    dealt: &'world Dealt,
    history: Vec<TurnRecord>,
    /// Writes EXECUTED this turn. What makes `no_action` an outcome rather
    /// than a promise.
    writes_this_turn: usize,
    /// **WHAT THE TURN COST**, charged at every door. See [`TurnCost`].
    ///
    /// A `RefCell` because the read doors take `&self` — a candidate must be
    /// able to search without holding the context mutably, and the meter must
    /// not change that.
    cost: std::cell::RefCell<TurnCost>,
}

/// ONE DOOR'S BILL FOR ONE TURN.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DoorCost {
    /// How many times the candidate opened this door.
    pub calls: usize,
    /// How many rows came back through it. A write door returns none.
    pub rows: usize,
    /// Wall-clock inside the door, microseconds.
    pub micros: u128,
}

/// **FAST IS A COLUMN, NEVER A TERM IN THE SCORE.**
///
/// The brief asks for a runtime that answers on a phone CPU at interactive
/// latency, and a harness that only says *right* cannot tell a candidate that
/// reads one board from one that scans all eight — the two score identically
/// and cost two orders of magnitude apart. So every door is metered: how many
/// times it was opened, how many rows it handed back, and how long it took.
///
/// It is reported BESIDE the verdict and never folded into it. A cost term in
/// the score would be this harness choosing an architecture — exactly the
/// thing the rest of the crate refuses to do — and the tradeoff between a
/// slow right answer and a fast wrong one is the reader's to make, with both
/// numbers in front of them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnCost {
    /// Door name -> its bill. `search`, `open`, `field`, `seal`, `write`…
    pub doors: BTreeMap<String, DoorCost>,
    /// The whole turn's wall clock, microseconds — the candidate's own time,
    /// with the harness's digest scans NOT included (they are charged to
    /// [`TurnResult::digest_micros`] instead, so a candidate is never billed
    /// for being measured).
    pub micros: u128,
}

impl TurnCost {
    /// Every door call this turn made.
    #[must_use]
    pub fn calls(&self) -> usize {
        self.doors.values().map(|door| door.calls).sum()
    }

    /// Every row that came back through any door.
    #[must_use]
    pub fn rows(&self) -> usize {
        self.doors.values().map(|door| door.rows).sum()
    }

    /// Calls at one named door.
    #[must_use]
    pub fn calls_at(&self, door: &str) -> usize {
        self.doors.get(door).map_or(0, |bill| bill.calls)
    }

    /// Rows through one named door.
    #[must_use]
    pub fn rows_at(&self, door: &str) -> usize {
        self.doors.get(door).map_or(0, |bill| bill.rows)
    }

    /// Commands EXECUTED through the write door. A refused command is a call
    /// and not a write, and the two are counted apart.
    #[must_use]
    pub fn writes(&self) -> usize {
        self.rows_at("write")
    }

    /// Fold another turn's bill into this one.
    pub fn absorb(&mut self, other: &Self) {
        for (name, bill) in &other.doors {
            let entry = self.doors.entry(name.clone()).or_default();
            entry.calls += bill.calls;
            entry.rows += bill.rows;
            entry.micros += bill.micros;
        }
        self.micros += other.micros;
    }
}

impl<'world> Context<'world> {
    fn new(dealt: &'world Dealt) -> Self {
        Self {
            dealt,
            history: Vec::new(),
            writes_this_turn: 0,
            cost: std::cell::RefCell::new(TurnCost::default()),
        }
    }

    /// Charge one door call: a call, the rows it answered, the time it took.
    fn charge(&self, door: &str, started: std::time::Instant, rows: usize) {
        let mut cost = self.cost.borrow_mut();
        let bill = cost.doors.entry(door.to_owned()).or_default();
        bill.calls += 1;
        bill.rows += rows;
        bill.micros += started.elapsed().as_micros();
    }

    /// What this turn has cost so far, as a candidate may read it of itself.
    #[must_use]
    pub fn cost(&self) -> TurnCost {
        self.cost.borrow().clone()
    }

    /// The world's instant, ISO-8601. Never the wall clock.
    #[must_use]
    pub fn now(&self) -> &str {
        &self.dealt.now
    }

    /// The world's day, `YYYY-MM-DD`.
    #[must_use]
    pub fn today(&self) -> &str {
        &self.dealt.now[..10]
    }

    /// The member's own party id — who "I" and "me" are.
    #[must_use]
    pub fn me(&self) -> &str {
        &self.dealt.me
    }

    /// Everything said in this session before this turn.
    #[must_use]
    pub fn history(&self) -> &[TurnRecord] {
        &self.history
    }

    /// The FTS door, over one of the seven domains.
    ///
    /// **A PHOTOGRAPH HIT COMES BACK KEYED BY ITS ASSET.** The search plane
    /// indexes `core_content_item.content_id`; a suite case names a picture by
    /// the `asset_id` in `inventory.json`. A candidate that found the right
    /// picture through this door would otherwise hand back an id the scorer
    /// does not recognise and be marked down for the harness's own key-space
    /// seam. A shipped runtime has to own this mapping wherever it puts it, so
    /// the harness owns it here — see [`row_of`].
    ///
    /// # Errors
    ///
    /// The door refused — an unknown domain (`locker.item` lands here, on
    /// purpose), a query with no searchable word, a denial.
    pub fn search(&self, entity: &str, query: &str, limit: usize) -> Result<Vec<VaultRow>, String> {
        let started = std::time::Instant::now();
        let outcome = self.search_inner(entity, query, limit);
        self.charge("search", started, outcome.as_ref().map_or(0, Vec::len));
        outcome
    }

    fn search_inner(
        &self,
        entity: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<VaultRow>, String> {
        let request = SearchRequest::new(entity, query, limit);
        let hits = self
            .dealt
            .vault()
            .read(|connection| {
                let door = SqliteDoor::open(connection).map_err(sql_error)?;
                let answer = door
                    .query(&centraid_search::Principal::Owner, &request)
                    .map_err(|error| sql_error(error.to_string()))?;
                let targets = answer
                    .targets()
                    .ok_or_else(|| sql_error("the search door denied the owner"))?;
                Ok(targets.to_vec())
            })
            .map_err(|error| error.to_string())?;
        let mut rows = Vec::with_capacity(hits.len());
        for hit in hits {
            let mut extra: BTreeMap<String, String> =
                [("snippet".to_owned(), hit.snippet)].into_iter().collect();
            let mut id = hit.id;
            let mut live = None;
            if hit.entity == "core.content_item" {
                match self.asset_owning(&id)? {
                    // The picture's own id, which is what a case is written
                    // against. `media_asset.content_id` is UNIQUE, so this is
                    // exactly one row.
                    Some(asset_id) => {
                        extra.insert("content_id".to_owned(), id);
                        id = asset_id;
                    }
                    // BYTES NO ASSET OWNS — a document's content item, since
                    // Docs' bytes are content items too. The hit is kept (a
                    // candidate that reached it should see it) but it is NOT
                    // dressed up as a photograph: the id stays the
                    // `content_id` it really is, the row is stamped
                    // `unowned_bytes`, and its liveness is read from
                    // `core_content_item` instead of the photo table, where
                    // the lookup would miss and read as trashed.
                    None => {
                        extra.insert("unowned_bytes".to_owned(), "true".to_owned());
                        live = Some(self.row_is_live("core_content_item", "content_id", &id)?);
                    }
                }
            }
            let live = match live {
                Some(live) => live,
                None => self.is_live(&hit.entity, &id)?,
            };
            rows.push(VaultRow {
                id,
                entity: hit.entity,
                app: hit.app_id,
                label: hit.title,
                date: None,
                live,
                extra,
            });
        }
        Ok(rows)
    }

    /// The asset that owns these bytes, if one does.
    fn asset_owning(&self, content_id: &str) -> Result<Option<String>, String> {
        self.dealt
            .vault()
            .read(|connection| {
                let door = TestDoor::new(connection);
                Ok(read_by_id(
                    &door,
                    "evalsuite.asset_of_content",
                    "asset_id, content_id",
                    "media_asset",
                    "content_id",
                    content_id,
                )
                .ok()
                .flatten()
                .and_then(|row| row.get("asset_id").and_then(Cell::text).map(str::to_owned)))
            })
            .map_err(|error| error.to_string())
    }

    /// One app's own board, through the app crate's own `load_*`.
    ///
    /// # Errors
    ///
    /// The door refused, or the app's fold reached a bound.
    pub fn open(&self, app: App) -> Result<Vec<VaultRow>, String> {
        let started = std::time::Instant::now();
        let outcome = self.open_inner(app);
        self.charge("open", started, outcome.as_ref().map_or(0, Vec::len));
        outcome
    }

    fn open_inner(&self, app: App) -> Result<Vec<VaultRow>, String> {
        let now = self.dealt.now.clone();
        let now_ms = self.dealt.now_ms;
        let rows = self
            .dealt
            .vault()
            .read(|connection| {
                let door = TestDoor::new(connection);
                board_of(app, &door, &now, now_ms).map_err(sql_error)
            })
            .map_err(|error| error.to_string())?;
        // THE LIVENESS STAMP, from each row's own `deleted_at`. The Tasks
        // board and the Agenda grid do not filter it; the harness does not
        // adopt their answer, and it does not hide it either.
        rows.into_iter()
            .map(|mut row| {
                row.live = self.is_live(&row.entity, &row.id)?;
                Ok(row)
            })
            .collect()
    }

    /// One column of one row a candidate already holds the id of.
    ///
    /// The neutral primitive for "look closer at this row" — a group id, a
    /// status, a coordinate. A shipped runtime would have this from whichever
    /// app door it opened; offering it here keeps a candidate from having to
    /// re-derive the whole board to read one field, WITHOUT teaching it an
    /// order to read in.
    ///
    /// # Errors
    ///
    /// The entity is not one this harness knows a table for.
    pub fn field(&self, entity: &str, id: &str, column: &str) -> Result<Option<String>, String> {
        let started = std::time::Instant::now();
        let outcome = self.field_inner(entity, id, column);
        self.charge(
            "field",
            started,
            outcome
                .as_ref()
                .map_or(0, |found| usize::from(found.is_some())),
        );
        outcome
    }

    fn field_inner(&self, entity: &str, id: &str, column: &str) -> Result<Option<String>, String> {
        let (table, pk) =
            row_of(entity).ok_or_else(|| format!("no table is known for `{entity}`"))?;
        let select = format!("{pk}, {column}");
        self.dealt
            .vault()
            .read(|connection| {
                let door = TestDoor::new(connection);
                Ok(read_by_id(&door, "evalsuite.field", &select, table, pk, id)
                    .ok()
                    .flatten()
                    .and_then(|row| row.get(column).map(cell_text)))
            })
            .map_err(|error| error.to_string())
    }

    /// Seal a secret for a Locker row, under the member key.
    ///
    /// **This is the seat's job, and it is why it is here.** `locker.add_item`
    /// refuses plaintext by name — "this gateway holds no key and cannot seal
    /// one" — so a candidate that could not seal could not put a password in
    /// the Locker at all, and a whole app would be write-only-by-accident in
    /// the evaluation. The id is passed in because a Locker secret is sealed
    /// against its own row id (`AAD = rowId ‖ keyId`), so the caller mints the
    /// id before the row exists.
    ///
    /// # Errors
    ///
    /// The vault holds no live locker key, or this seat holds no key file for
    /// it.
    pub fn seal(&self, item_id: &str, plaintext: &str) -> Result<String, String> {
        let started = std::time::Instant::now();
        let outcome = self.seal_inner(item_id, plaintext);
        self.charge("seal", started, 0);
        outcome
    }

    fn seal_inner(&self, item_id: &str, plaintext: &str) -> Result<String, String> {
        let vault_id = self
            .dealt
            .vault()
            .vault_id()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "this vault is not founded".to_owned())?;
        let key_id = self
            .dealt
            .vault()
            .read(|connection| Ok(centraid_vault::custody::live_locker_key_id(connection)))
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "this vault has no live locker key".to_owned())?;
        let custody = centraid_vault::custody::MemberKeyCustody::with_store(
            centraid_vault::custody::KeyStore::new(&self.dealt.keys_dir),
            &vault_id,
        );
        let key = custody.load(&key_id).map_err(|error| error.to_string())?;
        centraid_vault::custody::encrypt_under_locker_key(&key, &key_id, item_id, plaintext)
            .map_err(|error| error.to_string())
    }

    /// The live Locker key's id, which `locker.add_item` requires be declared.
    ///
    /// # Errors
    ///
    /// The vault has no live locker key.
    pub fn locker_key_id(&self) -> Result<String, String> {
        self.dealt
            .vault()
            .read(|connection| Ok(centraid_vault::custody::live_locker_key_id(connection)))
            .map_err(|error| error.to_string())?
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "this vault has no live locker key".to_owned())
    }

    /// An id the CALLER mints, which Locker requires.
    #[must_use]
    pub fn mint(&self) -> String {
        self.dealt.vault().ids().next()
    }

    /// A typed command. The ONLY way to change the vault.
    ///
    /// # Errors
    ///
    /// The vault refused — a failed precondition, an unknown command, a schema
    /// violation. A refusal is not a panic: a candidate may legitimately try a
    /// write the vault declines, and the predicate will then say so.
    pub fn write(&mut self, command: &str, body: Value) -> Result<Value, String> {
        let started = std::time::Instant::now();
        let answer = self.write_inner(command, body);
        // **THE WRITE DOOR IS METERED LIKE ANY OTHER, and its `rows` column
        // counts COMMANDS THAT LANDED.** A refused command is a call the
        // candidate paid for and a write that never happened, and folding the
        // two together would read as a candidate that wrote twice as often as
        // it did.
        self.charge("write", started, usize::from(answer.is_ok()));
        answer
    }

    fn write_inner(&mut self, command: &str, body: Value) -> Result<Value, String> {
        let outcome = self
            .dealt
            .vault()
            .execute(
                &self.dealt.registry,
                &Principal::owner("evalsuite-device"),
                &Command::new(command, body),
            )
            .map_err(|error| error.to_string())?;
        if outcome.status == CommandStatus::Executed {
            self.writes_this_turn += 1;
            Ok(outcome.output)
        } else {
            Err(outcome
                .reason
                .unwrap_or_else(|| format!("{command}: refused with no reason given")))
        }
    }

    /// The row's own `deleted_at`, as a liveness answer.
    fn is_live(&self, entity: &str, id: &str) -> Result<bool, String> {
        let Some((table, pk)) = row_of(entity) else {
            return Ok(true);
        };
        self.row_is_live(table, pk, id)
    }

    /// One named row's own `deleted_at`, as a liveness answer.
    fn row_is_live(&self, table: &str, pk: &str, id: &str) -> Result<bool, String> {
        self.dealt
            .vault()
            .read(|connection| {
                let door = TestDoor::new(connection);
                let found = read_by_id(
                    &door,
                    "evalsuite.liveness",
                    &format!("{pk}, deleted_at"),
                    table,
                    pk,
                    id,
                );
                Ok(match found {
                    // A table with no `deleted_at` cannot hold a trashed row.
                    Err(_) => true,
                    Ok(None) => false,
                    Ok(Some(row)) => row.get("deleted_at").and_then(Cell::text).is_none(),
                })
            })
            .map_err(|error| error.to_string())
    }
}

fn sql_error(message: impl std::fmt::Display) -> centraid_vault::VaultError {
    centraid_vault::VaultError::Sqlite(rusqlite::Error::InvalidParameterName(message.to_string()))
}

// ---------------------------------------------------------------------------
// The candidate interface.
// ---------------------------------------------------------------------------

/// One conversation's worth of a candidate runtime.
///
/// **Architecture-neutral by construction.** The trait says nothing about how
/// a turn is resolved: it is handed the member's words and the doors, and it
/// answers what it believes the outcome should be. A retrieval-first design, a
/// classifier, a grammar, a small language model and a hand-written table all
/// implement exactly this.
pub trait Candidate {
    /// Resolve one turn.
    fn turn(&mut self, request: &str, ctx: &mut Context<'_>) -> Plan;
}

/// A candidate runtime, as something that can start a fresh conversation.
///
/// Sessions are independent — a fresh world AND a fresh candidate — because a
/// candidate that carried state between sessions would be scored on an
/// arrangement no member has.
pub trait CandidateRuntime {
    /// A name for the report.
    fn name(&self) -> &str;
    /// A candidate for one session.
    fn session(&self, session: &Session) -> Box<dyn Candidate>;
}

// ---------------------------------------------------------------------------
// Predicates: what a correct WRITE left behind.
// ---------------------------------------------------------------------------

/// Read-only access to the vault, for a predicate.
pub struct Probe<'world> {
    dealt: &'world Dealt,
}

impl Probe<'_> {
    /// One row by id, projecting `select`.
    fn row(&self, table: &str, pk: &str, id: &str, select: &str) -> Option<Row> {
        self.dealt
            .vault()
            .read(|connection| {
                let door = TestDoor::new(connection);
                Ok(read_by_id(&door, "evalsuite.probe", select, table, pk, id)
                    .ok()
                    .flatten())
            })
            .ok()
            .flatten()
    }

    /// The member's own party id — what `"paid_by": "me"` resolves to.
    fn me(&self) -> &str {
        &self.dealt.me
    }

    /// One app's board, as [`Context::open`] hands it to a candidate — the
    /// same rows, the same liveness stamp, the same extras. A predicate about
    /// a star or an album asks the app's own reader rather than guessing which
    /// tag table the flag landed in.
    fn board(&self, app: App) -> Vec<VaultRow> {
        let now = self.dealt.now.clone();
        let now_ms = self.dealt.now_ms;
        let rows = self
            .dealt
            .vault()
            .read(|connection| {
                let door = TestDoor::new(connection);
                Ok(board_of(app, &door, &now, now_ms).unwrap_or_default())
            })
            .unwrap_or_default();
        rows.into_iter()
            .map(|mut row| {
                row.live = self.live(&row.entity, &row.id);
                row
            })
            .collect()
    }

    fn live(&self, entity: &str, id: &str) -> bool {
        let Some((table, pk)) = row_of(entity) else {
            return true;
        };
        self.row(table, pk, id, &format!("{pk}, deleted_at"))
            .is_none_or(|row| text(&row, "deleted_at").is_none())
    }

    /// Every row of `table` whose `column` equals `value`.
    fn by(&self, table: &str, pk: &str, select: &str, column: &str, value: &str) -> Vec<Row> {
        let query = PageQuery::new("evalsuite.probe.by", select, table, PageOrder::asc(pk, pk))
            .filter(
                &format!("{column} = ?"),
                vec![PageBindValue::Text(value.to_owned())],
            );
        self.dealt
            .vault()
            .read(|connection| {
                let door = TestDoor::new(connection);
                Ok(door
                    .page(&query, &PageRequest::first(50))
                    .map(|page| page.rows)
                    .unwrap_or_default())
            })
            .unwrap_or_default()
    }
}

/// A cell as text, whatever its storage class. An integer column read as
/// `None` because it was not TEXT is the kind of silence a predicate must not
/// have.
fn cell_text(cell: &Cell) -> String {
    match cell {
        Cell::Null => String::new(),
        other => other.to_cursor_text(),
    }
}

fn text(row: &Row, column: &str) -> Option<String> {
    row.get(column).and_then(Cell::text).map(str::to_owned)
}

fn integer(row: &Row, column: &str) -> Option<i64> {
    row.get(column).and_then(Cell::integer)
}

fn arg<'a>(args: &'a Map<String, Value>, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("the predicate needs a string `{key}`"))
}

/// **A CHANGE THIS CONVERSATION MADE, not one the world was seeded with.**
///
/// Tally and People write a `core_entity_revision` before they change a row —
/// it is what makes their undo a rollback rather than a second edit — so a
/// revision of this entity recorded on or after `since` is evidence that the
/// turn before this one actually wrote something. Without it "the row is
/// live" is true of an untouched world, which is DEFECT #4 in undo clothing.
fn recorded_since(
    probe: &Probe<'_>,
    entity_type: &str,
    entity_id: &str,
    args: &Map<String, Value>,
) -> Result<(), String> {
    let Some(since) = args.get("since").and_then(Value::as_str) else {
        return Ok(());
    };
    let revisions = probe.by(
        "core_entity_revision",
        "revision_id",
        "revision_id, entity_type, entity_id, recorded_at",
        "entity_id",
        entity_id,
    );
    revisions
        .iter()
        .filter(|row| text(row, "entity_type").as_deref() == Some(entity_type))
        .any(|row| text(row, "recorded_at").is_some_and(|stamp| stamp.as_str() >= since))
        .then_some(())
        .ok_or_else(|| {
            format!(
                "nothing was recorded against {entity_type} {entity_id} on or after {since}, \
                 so there is no change here to have taken back"
            )
        })
}

/// Does `stamp` fall on `wanted`? `wanted` may be a day or a whole instant.
fn falls_on(stamp: &str, wanted: &str) -> bool {
    stamp.starts_with(wanted)
}

type Predicate = fn(&Probe<'_>, &Map<String, Value>) -> Result<(), String>;

/// EVERY PREDICATE, by name.
///
/// Small and readable on purpose: a predicate that needed a paragraph to
/// explain would be a case whose correctness nobody could check.
#[must_use]
pub fn predicates() -> BTreeMap<&'static str, Predicate> {
    let mut table: BTreeMap<&'static str, Predicate> = BTreeMap::new();

    // --- Agenda -----------------------------------------------------------

    // The event MOVED, on the same identity. `to` is a day or a whole instant,
    // so a case can pin the hour when the hour is the point ("an hour later")
    // and leave it open when it is not.
    table.insert("event_rescheduled", |probe, args| {
        let id = arg(args, "id")?;
        let to = arg(args, "to")?;
        let row = probe
            .row(
                "core_event",
                "event_id",
                id,
                "event_id, dtstart, deleted_at",
            )
            .ok_or_else(|| format!("no event {id}"))?;
        // A MOVED EVENT IS A LIVE EVENT. Trashing it also changes what the
        // grid shows, and a predicate that read only `dtstart` would take
        // "I deleted it" for "I moved it".
        if text(&row, "deleted_at").is_some() {
            return Err(format!("event {id} was TRASHED, not moved"));
        }
        let dtstart = text(&row, "dtstart").unwrap_or_default();
        if falls_on(&dtstart, to) {
            Ok(())
        } else {
            Err(format!("event {id} starts {dtstart}, not {to}"))
        }
    });

    // A NEW event, by the words the member used and the slot they named.
    table.insert("event_created", |probe, args| {
        let summary = arg(args, "summary")?;
        let rows = probe.by(
            "core_event",
            "event_id",
            "event_id, summary, dtstart, deleted_at",
            "summary",
            summary,
        );
        let live: Vec<&Row> = rows
            .iter()
            .filter(|row| text(row, "deleted_at").is_none())
            .collect();
        if live.is_empty() {
            return Err(format!("no live event called {summary:?}"));
        }
        match args.get("dtstart").and_then(Value::as_str) {
            None => Ok(()),
            Some(start) => live
                .iter()
                .any(|row| falls_on(&text(row, "dtstart").unwrap_or_default(), start))
                .then_some(())
                .ok_or_else(|| format!("no event {summary:?} starts {start}")),
        }
    });

    // Cancelling is a status revision attendees see, never a removal.
    table.insert("event_cancelled", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row("core_event", "event_id", id, "event_id, status, deleted_at")
            .ok_or_else(|| format!("no event {id}"))?;
        // CANCELLING IS A REVISION ATTENDEES SEE. Deleting the row is how an
        // attendee never hears, which is the opposite outcome.
        if text(&row, "deleted_at").is_some() {
            return Err(format!("event {id} was TRASHED, not cancelled"));
        }
        match text(&row, "status").as_deref() {
            Some("cancelled" | "CANCELLED") => Ok(()),
            other => Err(format!("event {id} is {other:?}, not cancelled")),
        }
    });

    // --- Tasks ------------------------------------------------------------

    table.insert("task_completed", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row(
                "schedule_task",
                "task_id",
                id,
                "task_id, status, deleted_at",
            )
            .ok_or_else(|| format!("no task {id}"))?;
        // TICKED OFF, NOT THROWN AWAY. A trashed task leaves the board too,
        // and a member who asked to finish one did not ask to lose it.
        if text(&row, "deleted_at").is_some() {
            return Err(format!("task {id} was TRASHED, not completed"));
        }
        match text(&row, "status").as_deref() {
            Some("completed") => Ok(()),
            other => Err(format!("task {id} is {other:?}, not completed")),
        }
    });

    table.insert("task_rescheduled", |probe, args| {
        let id = arg(args, "id")?;
        let to = arg(args, "to")?;
        let row = probe
            .row(
                "schedule_task",
                "task_id",
                id,
                "task_id, due_at, deleted_at",
            )
            .ok_or_else(|| format!("no task {id}"))?;
        if text(&row, "deleted_at").is_some() {
            return Err(format!("task {id} was TRASHED, not moved"));
        }
        let due = text(&row, "due_at").unwrap_or_default();
        if falls_on(&due, to) {
            Ok(())
        } else {
            Err(format!("task {id} is due {due}, not {to}"))
        }
    });

    // A NEW task. `due` is optional AND may be explicitly `null`: "add a task
    // to call the Truckee place" carries no date, and a candidate that invents
    // one has not done what was asked.
    table.insert("task_created", |probe, args| {
        let title = arg(args, "title")?;
        let rows = probe.by(
            "schedule_task",
            "task_id",
            "task_id, title, due_at, deleted_at",
            "title",
            title,
        );
        let live: Vec<&Row> = rows
            .iter()
            .filter(|row| text(row, "deleted_at").is_none())
            .collect();
        if live.is_empty() {
            return Err(format!("no live task titled {title:?}"));
        }
        match args.get("due") {
            None => Ok(()),
            Some(Value::Null) => live
                .iter()
                .any(|row| text(row, "due_at").is_none())
                .then_some(())
                .ok_or_else(|| format!("every task titled {title:?} carries a due date")),
            Some(Value::String(due)) => live
                .iter()
                .any(|row| falls_on(&text(row, "due_at").unwrap_or_default(), due))
                .then_some(())
                .ok_or_else(|| format!("no task titled {title:?} is due {due}")),
            Some(other) => Err(format!("`due` is a day, a null or absent, not {other}")),
        }
    });

    table.insert("task_trashed", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row("schedule_task", "task_id", id, "task_id, deleted_at")
            .ok_or_else(|| format!("no task {id}"))?;
        if text(&row, "deleted_at").is_some() {
            Ok(())
        } else {
            Err(format!("task {id} is not trashed"))
        }
    });

    // --- Notes and Docs ---------------------------------------------------

    table.insert("note_created", |probe, args| {
        let title = arg(args, "title")?;
        let rows = probe.by(
            "knowledge_note",
            "note_id",
            "note_id, title, deleted_at",
            "title",
            title,
        );
        rows.iter()
            .any(|row| text(row, "deleted_at").is_none())
            .then_some(())
            .ok_or_else(|| format!("no live note titled {title:?}"))
    });

    // TRASHED, NOT PURGED. The row stays, restorable, for the grace window —
    // a predicate that checked for absence would pass on a purge, which is a
    // different and much worse outcome.
    table.insert("document_trashed", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row(
                "core_document",
                "document_id",
                id,
                "document_id, deleted_at",
            )
            .ok_or_else(|| format!("no document {id} — it was removed, not trashed"))?;
        if text(&row, "deleted_at").is_some() {
            Ok(())
        } else {
            Err(format!("document {id} is not trashed"))
        }
    });

    // THROUGH THE APP'S OWN DOOR. The star is a flags-scheme tag on a wrapper
    // concept, not a column; asking Docs' reader is asking what a member sees.
    table.insert("document_starred", |probe, args| {
        let id = arg(args, "id")?;
        let board = probe.board(App::Docs);
        let document = board
            .iter()
            .find(|row| row.id == id)
            .ok_or_else(|| format!("no document {id} on the drive"))?;
        // A STARRED DOCUMENT IS A DOCUMENT. The Docs drive hands back the
        // trash as well, so a candidate that starred a file on its way to
        // deleting it would otherwise pass.
        if !document.live || document.extra.get("trashed").map(String::as_str) == Some("true") {
            return Err(format!("document {id} was trashed"));
        }
        document
            .extra
            .get("starred")
            .filter(|value| *value == "true")
            .map(|_| ())
            .ok_or_else(|| format!("document {id} is not starred"))
    });

    // --- People and Tally -------------------------------------------------

    // A TOUCH WAS LOGGED AGAINST EXACTLY THIS PARTY — the outcome the three
    // Nehas exist to make expensive to get right. Read as the member sees it:
    // their profile now says when they were last contacted. The command writes
    // the activity, the link and this stamp in one stroke, so the stamp is the
    // whole outcome and not a proxy for it.
    //
    // **`since` is how a correction is scored.** The world already logged a
    // touch against Neha Kulkarni and Marco Ferreira six weeks ago, so a bare
    // "is there a stamp" would pass without the candidate writing anything. A
    // case about a call made TODAY passes `{"since": "2026-06-15"}`.
    table.insert("interaction_logged", |probe, args| {
        let party = arg(args, "party_id")?;
        let row = probe
            .row(
                "people_profile",
                "party_id",
                party,
                "party_id, last_contacted_at",
            )
            .ok_or_else(|| format!("no profile for party {party}"))?;
        let stamp = text(&row, "last_contacted_at")
            .ok_or_else(|| format!("nothing is logged against party {party}"))?;
        match args.get("since").and_then(Value::as_str) {
            None => Ok(()),
            Some(since) if stamp.as_str() >= since => Ok(()),
            Some(since) => Err(format!(
                "party {party} was last contacted {stamp}, which is before {since}"
            )),
        }
    });

    // ...AND NOTHING WAS LOGGED AGAINST THIS ONE. Paired with the above, this
    // is what makes "she picked the right Neha" a score rather than a hope.
    table.insert("no_interaction_logged", |probe, args| {
        let party = arg(args, "party_id")?;
        let row = probe
            .row(
                "people_profile",
                "party_id",
                party,
                "party_id, last_contacted_at",
            )
            .ok_or_else(|| format!("no profile for party {party}"))?;
        match (
            text(&row, "last_contacted_at"),
            args.get("since").and_then(Value::as_str),
        ) {
            (None, _) => Ok(()),
            (Some(stamp), Some(since)) if stamp.as_str() < since => Ok(()),
            (Some(stamp), _) => Err(format!("party {party} was contacted {stamp}")),
        }
    });

    // CLOSED, NOT DELETED: a settled debt stays as history.
    //
    // **AND DELETION IS NOT SETTLEMENT.** This predicate used to accept
    // `deleted_at` as an alternative to `settled_at`, in the same breath as a
    // comment saying a settled debt stays as history — so a candidate that
    // made the IOU disappear scored exactly as a candidate that paid it,
    // which is the worst outcome in the app scored as the best (DEFECT #17).
    // A trashed obligation is now simply not a live debt: it is dropped from
    // the set, and if it was the only one the case fails for the absence.
    //
    // **`amount_minor` IS SCORED.** It is named in `validate-suite`'s
    // `DISCRIMINATING_ARGUMENT` as the thing that stops the seeded world
    // satisfying this predicate on its own, and for two releases nothing read
    // it — a guard the validator advertised and the scorer ignored.
    table.insert("debt_settled", |probe, args| {
        let party = arg(args, "party_id")?;
        let rows = probe.by(
            "tally_obligation",
            "obligation_id",
            "obligation_id, to_party, amount_minor, settled_at, deleted_at",
            "to_party",
            party,
        );
        let live: Vec<&Row> = rows
            .iter()
            .filter(|row| text(row, "deleted_at").is_none())
            .collect();
        if live.is_empty() {
            return Err(format!(
                "no live debt is owed to party {party} — {} of them were trashed rather \
                 than settled",
                rows.len()
            ));
        }
        if let Some(open) = live.iter().find(|row| text(row, "settled_at").is_none()) {
            return Err(format!(
                "a debt to party {party} is still open ({})",
                text(open, "obligation_id").unwrap_or_default()
            ));
        }
        match args.get("amount_minor").and_then(Value::as_i64) {
            None => Ok(()),
            Some(amount) => live
                .iter()
                .any(|row| integer(row, "amount_minor") == Some(amount))
                .then_some(())
                .ok_or_else(|| format!("no debt to party {party} is for {amount} in minor units")),
        }
    });

    // SETTLED UP with one member of one group. A settlement is a row, not a
    // flag: "we are square" is a payment somebody recorded, and the group it
    // was recorded in is part of the claim.
    // **`amount_minor` IS SCORED, and it is the whole of "settled up".**
    //
    // The world already holds a settlement from Ana to the member for 5,000
    // in the trip group, so "is there a live settlement naming Ana in this
    // group" was TRUE BEFORE THE CONVERSATION STARTED: `s74`'s third write
    // passed by skipping her. `validate-suite` demanded the amount for
    // exactly that reason and the scorer never read it (DEFECT #17). Paying
    // somebody back the wrong number is not settling up with them, so the
    // amount is not a refinement of this predicate — it is the claim.
    const SETTLEMENT_COLUMNS: &str =
        "settlement_id, group_id, from_party, to_party, amount_minor, deleted_at";
    table.insert("settled_up", |probe, args| {
        let party = arg(args, "party_id")?;
        let mut candidates = probe.by(
            "tally_settlement",
            "settlement_id",
            SETTLEMENT_COLUMNS,
            "from_party",
            party,
        );
        candidates.extend(probe.by(
            "tally_settlement",
            "settlement_id",
            SETTLEMENT_COLUMNS,
            "to_party",
            party,
        ));
        let live: Vec<&Row> = candidates
            .iter()
            .filter(|row| text(row, "deleted_at").is_none())
            .filter(|row| match args.get("group_id").and_then(Value::as_str) {
                None => true,
                Some(group) => text(row, "group_id").as_deref() == Some(group),
            })
            .collect();
        if live.is_empty() {
            return Err(format!("no live settlement names party {party}"));
        }
        match args.get("amount_minor").and_then(Value::as_i64) {
            None => Ok(()),
            Some(amount) => live
                .iter()
                .any(|row| integer(row, "amount_minor") == Some(amount))
                .then_some(())
                .ok_or_else(|| {
                    format!(
                        "a settlement names party {party}, but none of the {} of them is \
                         for {amount} in minor units",
                        live.len()
                    )
                }),
        }
    });

    table.insert("expense_added", |probe, args| {
        let description = arg(args, "description")?;
        let rows = probe.by(
            "tally_expense",
            "expense_id",
            "expense_id, description, amount_minor, group_id, paid_by, deleted_at",
            "description",
            description,
        );
        let live: Vec<&Row> = rows
            .iter()
            .filter(|row| text(row, "deleted_at").is_none())
            .collect();
        if live.is_empty() {
            return Err(format!("no live expense described {description:?}"));
        }
        let matching: Vec<&&Row> = live
            .iter()
            .filter(
                |row| match args.get("amount_minor").and_then(Value::as_i64) {
                    None => true,
                    Some(amount) => integer(row, "amount_minor") == Some(amount),
                },
            )
            .filter(|row| match args.get("group_id").and_then(Value::as_str) {
                None => true,
                Some(group) => text(row, "group_id").as_deref() == Some(group),
            })
            // `"paid_by": "me"` is the member — a suite must not have to paste
            // the owner's party id into a case to say "I paid".
            .filter(|row| match args.get("paid_by").and_then(Value::as_str) {
                None => true,
                Some("me") => text(row, "paid_by").as_deref() == Some(probe.me()),
                Some(party) => text(row, "paid_by").as_deref() == Some(party),
            })
            .collect();
        if matching.is_empty() {
            Err(format!(
                "an expense {description:?} exists but none matches {args:?}"
            ))
        } else {
            Ok(())
        }
    });

    // --- Photos -----------------------------------------------------------

    // THROUGH THE APP'S OWN DOOR again: album membership is a collection, and
    // what a member means by "it is in the album" is that Photos shows it
    // there.
    table.insert("photo_added_to_album", |probe, args| {
        let id = arg(args, "id")?;
        let album = arg(args, "album_id")?;
        let board = probe.board(App::Photos);
        let title = board
            .iter()
            .find(|row| row.entity == "media.album" && row.id == album)
            .map(|row| row.label.clone())
            .ok_or_else(|| format!("no album {album}"))?;
        let photo = board
            .iter()
            .find(|row| row.id == id)
            .ok_or_else(|| format!("no photograph {id}"))?;
        // The Photos grid carries its trash; a picture filed into an album on
        // the way to being deleted is not in the album a member can open.
        if !photo.live {
            return Err(format!("photograph {id} was trashed"));
        }
        photo
            .extra
            .get("album_titles")
            .is_some_and(|titles| titles.split('\u{1f}').any(|held| held == title))
            .then_some(())
            .ok_or_else(|| format!("photograph {id} is not in {title:?}"))
    });

    // --- Locker -----------------------------------------------------------

    table.insert("locker_item_created", |probe, args| {
        let title = arg(args, "title")?;
        let found = probe
            .board(App::Locker)
            .into_iter()
            .find(|row| row.label == title)
            .ok_or_else(|| format!("no locker item titled {title:?}"))?;
        match args.get("type").and_then(Value::as_str) {
            None => Ok(()),
            Some(wanted) if found.extra.get("type").map(String::as_str) == Some(wanted) => Ok(()),
            Some(wanted) => Err(format!(
                "locker item {title:?} is a {:?}, not a {wanted:?}",
                found.extra.get("type")
            )),
        }
    });

    // **THE RECEIPT IS THE OUTCOME.** A reveal produces no vault change a
    // member can see except the record of who looked, and `access_receipt` is
    // append-only and hash-chained precisely so that record cannot be quietly
    // removed. A candidate that showed the password without filing one has not
    // done a smaller version of the right thing — it has done the wrong thing.
    // --- Undo -------------------------------------------------------------
    //
    // **AN UNDO IS THE ONLY OUTCOME WHOSE EVIDENCE CAN BE ERASED BY REACHING
    // IT.** A task trashed and then restored leaves `schedule_task` byte for
    // byte as it was, so "the row is live" is true of a vault where nothing
    // ever happened. Each predicate below therefore carries a second half
    // that the untouched world cannot satisfy, and which half it is depends
    // on what the command actually writes:
    //
    // * `task_restored` and `asset_restored` name rows the WORLD SEEDS IN THE
    //   TRASH. The row is not live before the turn, so restoring it is the
    //   candidate's doing and nothing else's. Neither command stamps a row on
    //   the way past, so there is no `since` to read and pretending otherwise
    //   would be a guard that never fires.
    // * `document_restored` reads `updated_at` against an `on` — a DAY, not an
    //   "at or after". Both halves of the gesture stamp it from the injected
    //   clock, so the day is exact; a `since` would be satisfied by the stamp a
    //   TRIGGER writes from `strftime('now')` — the WALL clock — on any update
    //   that does not set the column, which is a date in the real present and
    //   therefore after anything a case could name (DEFECT #26).
    // * `expense_undone` and `person_undone` read the REVISION PLANE. Tally
    //   and People record what a row looked like before they change it, so an
    //   undo is a rollback rather than a second edit aimed at the old value —
    //   and a revision recorded on or after `since` is a change this
    //   conversation made.
    //
    // `no_write_expectation_holds_against_the_untouched_world` is what keeps
    // that claim honest for all five.

    table.insert("task_restored", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row(
                "schedule_task",
                "task_id",
                id,
                "task_id, deleted_at, purge_at",
            )
            .ok_or_else(|| format!("no task {id} — it was purged, not restored"))?;
        if let Some(stamp) = text(&row, "deleted_at") {
            return Err(format!("task {id} is still in the trash (deleted {stamp})"));
        }
        // THE PURGE DATE GOES WITH IT. A row left carrying one is a row the
        // lifecycle sweep still destroys, which is not what "put it back"
        // asked for.
        match text(&row, "purge_at") {
            None => Ok(()),
            Some(stamp) => Err(format!(
                "task {id} is out of the trash but still due to be purged {stamp}"
            )),
        }
    });

    table.insert("document_restored", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row(
                "core_document",
                "document_id",
                id,
                "document_id, deleted_at, purge_at, updated_at",
            )
            .ok_or_else(|| format!("no document {id} — it was purged, not restored"))?;
        if let Some(stamp) = text(&row, "deleted_at") {
            return Err(format!(
                "document {id} is still in the trash (deleted {stamp})"
            ));
        }
        if let Some(stamp) = text(&row, "purge_at") {
            return Err(format!(
                "document {id} is out of the trash but still due to be purged {stamp}"
            ));
        }
        // **`on`, A DAY — NOT `since`, AN "AT OR AFTER".** Both halves of the
        // gesture stamp `updated_at` from the injected clock, so the day the
        // case names is exact. An "at or after" would be satisfied by the
        // stamp a TRIGGER writes from the wall clock on any update that does
        // not set the column itself, which is a date in the real present and
        // therefore after anything the corpus could name (DEFECT #26).
        match args.get("on").and_then(Value::as_str) {
            None => Ok(()),
            Some(on) => match text(&row, "updated_at") {
                Some(stamp) if falls_on(&stamp, on) => Ok(()),
                other => Err(format!(
                    "document {id} was last touched {other:?}, not on {on} — it is live \
                     because it was never trashed, not because it came back"
                )),
            },
        }
    });

    table.insert("asset_restored", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row(
                "media_asset",
                "asset_id",
                id,
                "asset_id, content_id, deleted_at, purge_at",
            )
            .ok_or_else(|| format!("no photograph {id} — it was purged, not restored"))?;
        if let Some(stamp) = text(&row, "deleted_at") {
            return Err(format!(
                "photograph {id} is still in the trash (deleted {stamp})"
            ));
        }
        if let Some(stamp) = text(&row, "purge_at") {
            return Err(format!(
                "photograph {id} is out of the trash but still due to be purged {stamp}"
            ));
        }
        // **AND THE BYTES CAME BACK.** Trashing an asset releases its content
        // item when nothing else references it; a restore that left the
        // content dead would hand the member a row with no picture in it.
        let content = text(&row, "content_id")
            .ok_or_else(|| format!("photograph {id} names no content item"))?;
        let bytes = probe
            .row(
                "core_content_item",
                "content_id",
                &content,
                "content_id, deleted_at",
            )
            .ok_or_else(|| format!("photograph {id}'s bytes are gone"))?;
        match text(&bytes, "deleted_at") {
            None => Ok(()),
            Some(_) => Err(format!("photograph {id} is live but its bytes are not")),
        }
    });

    table.insert("expense_trashed", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row("tally_expense", "expense_id", id, "expense_id, deleted_at")
            .ok_or_else(|| format!("no expense {id} — it was removed, not trashed"))?;
        if text(&row, "deleted_at").is_some() {
            Ok(())
        } else {
            Err(format!("expense {id} is not trashed"))
        }
    });

    table.insert("expense_undone", |probe, args| {
        let id = arg(args, "id")?;
        let row = probe
            .row("tally_expense", "expense_id", id, "expense_id, deleted_at")
            .ok_or_else(|| format!("no expense {id}"))?;
        if let Some(stamp) = text(&row, "deleted_at") {
            return Err(format!("expense {id} is still trashed (deleted {stamp})"));
        }
        recorded_since(probe, "tally.expense", id, args)
    });

    table.insert("person_trashed", |probe, args| {
        let party = arg(args, "party_id")?;
        let profiles = probe.by(
            "people_profile",
            "profile_id",
            "profile_id, party_id, deleted_at",
            "party_id",
            party,
        );
        if profiles.is_empty() {
            return Err(format!("no profile for party {party}"));
        }
        if profiles.iter().all(|row| text(row, "deleted_at").is_some()) {
            Ok(())
        } else {
            Err(format!("party {party} is not in the trash"))
        }
    });

    table.insert("person_undone", |probe, args| {
        let party = arg(args, "party_id")?;
        let profiles = probe.by(
            "people_profile",
            "profile_id",
            "profile_id, party_id, deleted_at",
            "party_id",
            party,
        );
        if profiles.is_empty() {
            return Err(format!("no profile for party {party}"));
        }
        if let Some(gone) = profiles
            .iter()
            .find(|row| text(row, "deleted_at").is_some())
        {
            return Err(format!(
                "party {party} is still in the trash ({})",
                text(gone, "profile_id").unwrap_or_default()
            ));
        }
        recorded_since(probe, "people.person", party, args)
    });

    table.insert("locker_field_revealed", |probe, args| {
        let id = arg(args, "id")?;
        let field = arg(args, "field")?;
        let receipts = probe.by(
            "access_receipt",
            "receipt_id",
            "receipt_id, object_id, object_type, action, detail_json",
            "object_id",
            id,
        );
        if receipts.is_empty() {
            return Err(format!("no access receipt names locker item {id}"));
        }
        receipts
            .iter()
            .any(|row| {
                text(row, "detail_json")
                    .unwrap_or_default()
                    .contains(&format!("\"{field}\""))
            })
            .then_some(())
            .ok_or_else(|| format!("no receipt for {id} names the column {field:?}"))
    });

    table
}

// ---------------------------------------------------------------------------
// The changed-row set: what the turn ACTUALLY touched.
// ---------------------------------------------------------------------------

/// Every mutable row in the vault, `table/primary key` -> digest.
///
/// A table with no single-column primary key carries its row COUNT instead,
/// under `table/#rows`.
pub type VaultDigest = BTreeMap<String, String>;

/// **THE ONLY GLOBAL EXEMPTIONS, and each is here because the WRITE PLANE
/// rewrites it as a consequence of executing anything at all.**
///
/// A candidate cannot avoid touching these and no expectation could license
/// them per-predicate without licensing them for every predicate, which is
/// the same list with more places to get it wrong. Nothing that holds member
/// content is in here, and a name added to this list is a hole in the
/// side-effect score — `the_bookkeeping_exemptions_hold_no_member_content`
/// is what stops one being added quietly.
const BOOKKEEPING: &[(&str, &str)] = &[
    (
        "agent_command",
        "the command REGISTRY: executing a command the vault has not seen \
         before registers its definition. A fact about the registry, not \
         about the member's rows.",
    ),
    (
        "agent_command_invocation",
        "the write plane's own ledger — one row per command attempted, the \
         refused ones included. It is the record THAT a command ran, so \
         scoring a candidate for appending to it would score it for writing \
         at all.",
    ),
    (
        "agent_invocation_check",
        "one row per precondition and postcondition that invocation \
         evaluated: part of the same ledger entry.",
    ),
    (
        "agent_explanation",
        "the explanation attached to an invocation, written by the plane and \
         never by the candidate.",
    ),
    (
        "access_receipt",
        "ONE ROW PER COMMAND EXECUTED. It is the call sequence written down, \
         and the call sequence is the one thing this harness refuses to \
         score: licensing it per predicate would mean licensing a COMMAND \
         COUNT, so a candidate reaching the right outcome in two commands \
         would fail a turn a candidate reaching it in one passes. \
         **The cost is named in DEFECTS.md #18**: a reveal against an item \
         nobody asked about files a receipt and nothing else, so extra \
         reveals are invisible to the changed-row set. \
         `locker_field_revealed` reads this table directly and is unaffected.",
    ),
    (
        "core_entity",
        "the ontology's id registry: one row per entity that exists, minted \
         beside the row it registers and carrying none of its content. The \
         registered row is licensed on its own merits, so counting this one \
         too would double-count every licensed creation.",
    ),
    (
        "replica_meta",
        "the replica protocol's singleton — rewritten by OPENING the vault, \
         so it moves on a turn that only reads. `centraid_ontology` excludes \
         it from its own golden corpus for exactly this reason.",
    ),
];

/// One row that moved between two digests.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct RowChange {
    pub table: String,
    /// The primary key, or `#rows` for a table that has none.
    pub id: String,
    pub kind: RowChangeKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RowChangeKind {
    Added,
    /// A column changed — `deleted_at` and `updated_at` included, so a soft
    /// delete and a touch both land here.
    Modified,
    /// **THE ROW IS GONE.** Centraid trashes; it does not purge. A removal is
    /// never licensed by any expectation in this harness.
    Removed,
}

impl std::fmt::Display for RowChange {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let verb = match self.kind {
            RowChangeKind::Added => "added",
            RowChangeKind::Modified => "modified",
            RowChangeKind::Removed => "REMOVED",
        };
        write!(out, "{verb} {}/{}", self.table, self.id)
    }
}

/// Which rows moved between two digests.
#[must_use]
pub fn diff(before: &VaultDigest, after: &VaultDigest) -> Vec<RowChange> {
    let split = |key: &str| {
        let (table, id) = key.split_once('/').unwrap_or((key, ""));
        (table.to_owned(), id.to_owned())
    };
    let mut changes = Vec::new();
    for (key, digest) in after {
        let (table, id) = split(key);
        match before.get(key) {
            None => changes.push(RowChange {
                table,
                id,
                kind: RowChangeKind::Added,
            }),
            Some(was) if was != digest => changes.push(RowChange {
                table,
                id,
                kind: RowChangeKind::Modified,
            }),
            Some(_) => {}
        }
    }
    for key in before.keys() {
        if !after.contains_key(key) {
            let (table, id) = split(key);
            changes.push(RowChange {
                table,
                id,
                kind: RowChangeKind::Removed,
            });
        }
    }
    changes.sort();
    changes
}

/// ONE TABLE'S WORTH OF PERMISSION, as an expectation grants it.
#[derive(Debug, Clone)]
pub struct Allowance {
    pub table: &'static str,
    /// Primary keys this expectation licenses a change to, by name.
    pub ids: Vec<String>,
    /// How many rows with ids nobody could name in advance may be ADDED.
    /// Never licenses a modification and never a removal.
    pub new_rows: usize,
    /// **WHY**, in the expectation's own terms. It is printed in the
    /// complaint, so an allowance nobody can justify reads as one.
    pub reason: &'static str,
}

impl Allowance {
    fn row(table: &'static str, id: impl Into<String>, reason: &'static str) -> Self {
        Self {
            table,
            ids: vec![id.into()],
            new_rows: 0,
            reason,
        }
    }

    fn rows(table: &'static str, ids: Vec<String>, reason: &'static str) -> Self {
        Self {
            table,
            ids,
            new_rows: 0,
            reason,
        }
    }

    fn new(table: &'static str, new_rows: usize, reason: &'static str) -> Self {
        Self {
            table,
            ids: Vec::new(),
            new_rows,
            reason,
        }
    }

    /// **A TABLE WITH NO SINGLE-COLUMN PRIMARY KEY**, which the digest can
    /// only COUNT. Licensing it licenses any change to that count, which is
    /// weaker than every other allowance here and is named as such in
    /// DEFECTS.md #19 rather than dressed up as equivalent.
    fn counted(table: &'static str, reason: &'static str) -> Self {
        Self {
            table,
            ids: vec!["#rows".to_owned()],
            new_rows: 0,
            reason,
        }
    }
}

/// **WHAT AN EXPECTATION LICENSES THE TURN TO HAVE CHANGED.**
///
/// The predicate says the right thing HAPPENED. This says nothing else did.
/// Without it, a candidate that reschedules the task the case names and also
/// trashes four unrelated rows scores exactly the same as one that reschedules
/// the task — which is the difference between a product a member can be handed
/// and one that cannot (DEFECT #16).
///
/// **Per-predicate, never global.** Every derived row a command cannot avoid
/// writing — the splits under a new expense, the transaction under a
/// settlement — is licensed by NAME, by the predicate that knows why it is
/// there. The only list that spans predicates is [`BOOKKEEPING`], which is the
/// write plane's own ledger.
#[derive(Debug, Clone, Default)]
pub struct License {
    pub allowances: Vec<Allowance>,
    /// True when this predicate has no licence written for it yet, so a
    /// change cannot be judged against it. Reported, never silently allowed.
    pub unwritten: bool,
}

impl License {
    fn of(allowances: Vec<Allowance>) -> Self {
        Self {
            allowances,
            unwritten: false,
        }
    }

    /// The changes this licence does NOT cover, as complaints.
    #[must_use]
    pub fn unlicensed(&self, changes: &[RowChange]) -> Vec<String> {
        let mut budget: BTreeMap<&str, usize> = BTreeMap::new();
        for allowance in &self.allowances {
            *budget.entry(allowance.table).or_default() += allowance.new_rows;
        }
        let mut complaints = Vec::new();
        for change in changes {
            // **A PURGE IS NEVER LICENSED.** Centraid trashes; it does not
            // remove. A row that is simply gone is a worse outcome than the
            // one the member asked for, whichever row it is — so no
            // allowance, named or budgeted, covers a removal.
            if change.kind == RowChangeKind::Removed {
                complaints.push(change.to_string());
                continue;
            }
            let named = self.allowances.iter().any(|allowance| {
                allowance.table == change.table && allowance.ids.contains(&change.id)
            });
            if named {
                continue;
            }
            if change.kind == RowChangeKind::Added
                && let Some(left) = budget.get_mut(change.table.as_str())
                && *left > 0
            {
                *left -= 1;
                continue;
            }
            complaints.push(change.to_string());
        }
        complaints
    }
}

type Licensor = fn(&Probe<'_>, &Map<String, Value>) -> License;

/// **EVERY WRITE PREDICATE'S LICENCE, by name.**
///
/// One entry per predicate in [`predicates`]. A predicate with no entry here
/// cannot be judged on its side effects, and that is a failure rather than a
/// pass — `every_write_predicate_has_a_licence` holds the two lists together.
#[must_use]
pub fn licenses() -> BTreeMap<&'static str, Licensor> {
    let mut table: BTreeMap<&'static str, Licensor> = BTreeMap::new();

    // --- Agenda -----------------------------------------------------------

    table.insert("event_rescheduled", |_probe, args| {
        License::of(vec![Allowance::row(
            "core_event",
            arg(args, "id").unwrap_or_default(),
            "the event the member named moves; nothing else does",
        )])
    });

    table.insert("event_cancelled", |_probe, args| {
        License::of(vec![Allowance::row(
            "core_event",
            arg(args, "id").unwrap_or_default(),
            "cancelling is a status revision on that one event",
        )])
    });

    table.insert("event_created", |_probe, _args| {
        License::of(vec![
            Allowance::new("core_event", 1, "the event the member asked for"),
            Allowance::new(
                "schedule_event_ext",
                1,
                "`schedule.add_event` writes the Agenda-side extension row \
                 beside every event it creates; an event without one is not \
                 on the grid",
            ),
        ])
    });

    // --- Tasks ------------------------------------------------------------

    for name in ["task_completed", "task_rescheduled", "task_trashed"] {
        table.insert(name, |_probe, args| {
            License::of(vec![Allowance::row(
                "schedule_task",
                arg(args, "id").unwrap_or_default(),
                "the task the member named, and only it",
            )])
        });
    }

    table.insert("task_created", |_probe, _args| {
        License::of(vec![Allowance::new(
            "schedule_task",
            1,
            "the task the member asked for",
        )])
    });

    // --- Notes and Docs ---------------------------------------------------

    table.insert("note_created", |_probe, _args| {
        License::of(vec![
            Allowance::new("knowledge_note", 1, "the note the member asked for"),
            Allowance::new(
                "core_content_item",
                1,
                "a note's body is a content item — `knowledge.add_note` writes \
                 the two together and a note without one has no text",
            ),
            Allowance::new(
                "core_content_text",
                1,
                "the body's text, under that content item",
            ),
            Allowance::new(
                "core_content_representation",
                1,
                "the body's representation row, under that content item",
            ),
            Allowance::new(
                "core_entity_revision",
                1,
                "`knowledge.create_note` records an undo snapshot: the note is \
                 restorable for its window, and a create that left no way back \
                 would be a different outcome. Licensed HERE rather than \
                 globally — only the commands that record one get one",
            ),
        ])
    });

    table.insert("document_trashed", |_probe, args| {
        License::of(vec![Allowance::row(
            "core_document",
            arg(args, "id").unwrap_or_default(),
            "the document the member named is trashed, not purged",
        )])
    });

    table.insert("document_starred", |_probe, args| {
        License::of(vec![
            Allowance::row(
                "core_document",
                arg(args, "id").unwrap_or_default(),
                "the document the star hangs off",
            ),
            Allowance::new(
                "core_tag",
                1,
                "the star is a flags-scheme TAG, not a column: starring writes \
                 one tag row against that document",
            ),
        ])
    });

    // --- People and Tally -------------------------------------------------

    table.insert("interaction_logged", |probe, args| {
        // **THE PROFILE'S OWN KEY, not the party's.** `people_profile` is keyed
        // by `profile_id` and carries `party_id` as a unique column, so a
        // licence naming the party would name a row that does not exist and
        // the stamp the command MUST write would read as collateral damage.
        let profiles: Vec<String> = probe
            .by(
                "people_profile",
                "profile_id",
                "profile_id, party_id",
                "party_id",
                arg(args, "party_id").unwrap_or_default(),
            )
            .iter()
            .filter_map(|row| text(row, "profile_id"))
            .collect();
        License::of(vec![
            Allowance::rows(
                "people_profile",
                profiles,
                "the profile whose `last_contacted_at` the touch stamps",
            ),
            Allowance::new("core_activity", 1, "the touch itself"),
            Allowance::new(
                "core_link",
                1,
                "the link that binds the touch to that party — without it the \
                 activity belongs to nobody",
            ),
        ])
    });

    // THE NEGATIVE HALF LICENSES NOTHING. It is an assertion that a party was
    // left alone, so any change it were to license would be the opposite of
    // what it says. In a `write_set` the licences union, so its emptiness
    // costs its partner nothing.
    table.insert("no_interaction_logged", |_probe, _args| {
        License::of(Vec::new())
    });

    // THE OBLIGATIONS THIS SETTLEMENT CLOSES, by name — read off the vault
    // before the turn, so a candidate that closes a debt to somebody else is
    // not covered by the row it was supposed to close.
    table.insert("debt_settled", |probe, args| {
        let party = arg(args, "party_id").unwrap_or_default();
        let ids: Vec<String> = probe
            .by(
                "tally_obligation",
                "obligation_id",
                "obligation_id, to_party",
                "to_party",
                party,
            )
            .iter()
            .filter_map(|row| text(row, "obligation_id"))
            .collect();
        License::of(vec![Allowance::rows(
            "tally_obligation",
            ids,
            "`people.settle_debt` stamps `settled_at` on the debts owed to \
             that party. It closes them; it deletes nothing and touches no \
             other party's row",
        )])
    });

    // WHAT `tally.settle_up` ACTUALLY WRITES, read from the command: the
    // settlement row; the canonical `core_transaction` when the owner is one
    // of the two parties, because the owner's money really moved; and, on the
    // first owner settlement in a vault, the `Tally settlements` pool that
    // transaction posts against. It touches no expense, no split and no
    // obligation.
    table.insert("settled_up", |_probe, _args| {
        License::of(vec![
            Allowance::new("tally_settlement", 1, "the payment somebody recorded"),
            Allowance::new(
                "core_transaction",
                1,
                "a settlement the owner is part of moves the owner's money, so \
                 `tally.settle_up` emits the canonical transaction and binds it",
            ),
        ])
    });

    table.insert("expense_added", |_probe, _args| {
        License::of(vec![
            Allowance::new("tally_expense", 1, "the expense the member added"),
            Allowance::counted(
                "tally_expense_split",
                "an expense is nothing without its shares — `tally.add_expense` \
                 writes one split row per member named in the split, and the \
                 table has no single-column primary key to name them by",
            ),
            Allowance::counted(
                "tally_expense_payer",
                "...and one payer row, likewise keyless",
            ),
        ])
    });

    // --- Photos -----------------------------------------------------------

    table.insert("photo_added_to_album", |_probe, _args| {
        License::of(vec![Allowance::new(
            "core_collection_entry",
            1,
            "an album is a collection and membership is one entry row",
        )])
    });

    // --- Locker -----------------------------------------------------------

    table.insert("locker_item_created", |_probe, _args| {
        License::of(vec![Allowance::new(
            "locker_item",
            1,
            "the item the member asked to keep",
        )])
    });

    // **THE RECEIPT IS THE WHOLE OUTCOME**, so it is the whole licence: a
    // reveal changes no row a member can see, and an item that MOVED during a
    // reveal was edited, which is not what was asked for.
    // --- Undo -------------------------------------------------------------
    //
    // A restore moves the row it names back out of the trash, and a rollback
    // additionally moves the RECORDING of the change it takes back. Both are
    // named here rather than budgeted: the revision rows exist before the turn
    // that undoes them, so an `Allowance::new` — which only ever licenses an
    // ADDED row — would read them as collateral damage.

    table.insert("task_restored", |_probe, args| {
        License::of(vec![Allowance::row(
            "schedule_task",
            arg(args, "id").unwrap_or_default(),
            "the task comes out of the trash; nothing else moves",
        )])
    });

    table.insert("document_restored", |_probe, args| {
        License::of(vec![Allowance::row(
            "core_document",
            arg(args, "id").unwrap_or_default(),
            "the document comes out of the trash; its folder and its star were \
             never dropped, so nothing has to be put back beside it",
        )])
    });

    table.insert("asset_restored", |probe, args| {
        let id = arg(args, "id").unwrap_or_default();
        let content = probe
            .row("media_asset", "asset_id", id, "asset_id, content_id")
            .and_then(|row| text(&row, "content_id"))
            .into_iter()
            .collect();
        License::of(vec![
            Allowance::row("media_asset", id, "the photograph comes out of the trash"),
            Allowance::rows(
                "core_content_item",
                content,
                "...and its bytes with it — `media.delete_asset` releases the \
                 content item when nothing else holds it, and a picture \
                 restored without one is a row with no photograph in it. \
                 ALBUM MEMBERSHIP IS NOT LICENSED and is not restored: the \
                 entries were deleted, and re-inventing them would file the \
                 frame into an album the member may since have curated",
            ),
        ])
    });

    table.insert("expense_trashed", |_probe, args| {
        License::of(vec![
            Allowance::row(
                "tally_expense",
                arg(args, "id").unwrap_or_default(),
                "the expense is dated shut; its splits stay put, because the \
                 balance fold already ignores a trashed row",
            ),
            Allowance::new(
                "core_entity_revision",
                1,
                "`tally.delete_expense` records what the expense was before it \
                 trashed it — the snapshot is what makes the undo a rollback",
            ),
        ])
    });

    table.insert("expense_undone", |probe, args| {
        License::of(vec![
            Allowance::row(
                "tally_expense",
                arg(args, "id").unwrap_or_default(),
                "the expense the snapshot is put back into",
            ),
            Allowance::rows(
                "core_entity_revision",
                revisions_of(probe, arg(args, "id").unwrap_or_default()),
                "the recording being spent: an undo stamps `undone_at` so the \
                 same snapshot cannot be applied twice",
            ),
            Allowance::counted(
                "tally_expense_split",
                "a snapshot restores the shares it recorded, and the table has \
                 no single-column primary key to name them by (DEFECT #19)",
            ),
            Allowance::counted(
                "tally_expense_payer",
                "...and the payer set, likewise keyless",
            ),
        ])
    });

    table.insert("person_trashed", |probe, args| {
        License::of(vec![
            Allowance::rows(
                "people_profile",
                profiles_of(probe, arg(args, "party_id").unwrap_or_default()),
                "ONLY THE PROFILE IS DATED SHUT. The canonical party survives, \
                 so every link, tag and obligation naming this person still \
                 resolves",
            ),
            Allowance::new(
                "core_entity_revision",
                1,
                "`people.trash_person` records the profile as it was, which is \
                 what the undo puts back",
            ),
        ])
    });

    table.insert("person_undone", |probe, args| {
        let party = arg(args, "party_id").unwrap_or_default();
        License::of(vec![
            Allowance::row(
                "core_party",
                party,
                "`people.undo_person` restates the display name the snapshot \
                 held, so the party row is stamped even when the name did not \
                 change",
            ),
            Allowance::rows(
                "people_profile",
                profiles_of(probe, party),
                "the profile the snapshot is put back into",
            ),
            Allowance::rows(
                "core_entity_revision",
                revisions_of(probe, party),
                "the recording being spent — `undone_at`, so one snapshot \
                 cannot be applied twice",
            ),
        ])
    });

    table.insert("locker_field_revealed", |_probe, _args| {
        // **AND IT LICENSES NOTHING**, which is the honest answer rather than
        // an empty one: a reveal moves no row a member can see, so the only
        // trace is the `access_receipt` the write plane files for every
        // command and which [`BOOKKEEPING`] therefore exempts. An item that
        // MOVED during a reveal was edited, and this catches that; a reveal
        // against an item nobody asked about it cannot catch (DEFECTS #18).
        License::of(Vec::new())
    });

    table
}

/// Every revision row recorded against one entity, by name — read BEFORE the
/// turn is judged, so an undo's licence covers the recording it spends.
fn revisions_of(probe: &Probe<'_>, entity_id: &str) -> Vec<String> {
    probe
        .by(
            "core_entity_revision",
            "revision_id",
            "revision_id, entity_id",
            "entity_id",
            entity_id,
        )
        .iter()
        .filter_map(|row| text(row, "revision_id"))
        .collect()
}

/// The profile rows of one party. `people_profile` is keyed by `profile_id`
/// and carries `party_id` as a column, so a licence naming the party would
/// name a row that does not exist.
fn profiles_of(probe: &Probe<'_>, party_id: &str) -> Vec<String> {
    probe
        .by(
            "people_profile",
            "profile_id",
            "profile_id, party_id",
            "party_id",
            party_id,
        )
        .iter()
        .filter_map(|row| text(row, "profile_id"))
        .collect()
}

/// The licence one expected write grants, or an unwritten one.
fn license_for(
    predicate: &str,
    args: &Map<String, Value>,
    probe: &Probe<'_>,
    licenses: &BTreeMap<&'static str, Licensor>,
) -> License {
    match licenses.get(predicate) {
        Some(licensor) => licensor(probe, args),
        None => License {
            allowances: Vec::new(),
            unwritten: true,
        },
    }
}

// ---------------------------------------------------------------------------
// Scoring.
// ---------------------------------------------------------------------------

/// HOW CLOSE a row answer came, beside the verdict.
///
/// **The verdict stays all-or-nothing and this never changes it.** It exists
/// because "four of the five Emerald Bay rows, missing exactly the Locker one"
/// and "nothing at all" are the same score and completely different findings —
/// and the first one is the finding that case was built to produce. A score
/// that could not tell them apart would destroy its own most useful result.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Overlap {
    pub expected: usize,
    pub answered: usize,
    /// Expected rows the candidate returned.
    pub hit: usize,
    /// Expected rows it missed, by id.
    pub missing: Vec<String>,
    /// Rows it returned that the case does not expect, by id.
    pub extra: Vec<String>,
}

impl Overlap {
    /// Of the rows it returned, how many the case wanted.
    #[must_use]
    pub fn precision(&self) -> Option<f64> {
        #[expect(clippy::cast_precision_loss, reason = "counts of rows in one turn")]
        let value = self.hit as f64 / self.answered as f64;
        (self.answered > 0).then_some(value)
    }

    /// Of the rows the case wanted, how many it returned.
    #[must_use]
    pub fn recall(&self) -> Option<f64> {
        #[expect(clippy::cast_precision_loss, reason = "counts of rows in one turn")]
        let value = self.hit as f64 / self.expected as f64;
        (self.expected > 0).then_some(value)
    }

    /// **THE GRADED CREDIT FOR ONE ROWS TURN: F1, and F1 on purpose.**
    ///
    /// Recall alone would be the wrong metric and the suite can prove it:
    /// `EverythingOfEntity` returns the whole board for the expected entity
    /// and reaches 61.8% id recall while passing zero turns. A graded score
    /// built on recall would hand that instrument a majority and read as
    /// competence. F1 folds in precision, so an answer that is right by being
    /// large is punished by exactly the amount it is large — a board of forty
    /// rows containing the five that were wanted scores 0.22, not 1.00.
    ///
    /// Two edge cases, both decided rather than defaulted:
    ///
    /// * the case expects NOTHING (`s06/t3`, `s59/t2`) and the candidate
    ///   answered nothing: 1.0, because the empty answer is the right one;
    /// * the case expects nothing and the candidate answered rows: 0.0.
    ///
    /// Harmonic mean, not arithmetic: a candidate with perfect recall and
    /// negligible precision must not average its way to a half.
    #[must_use]
    pub fn f1(&self) -> f64 {
        if self.expected == 0 {
            return if self.answered == 0 { 1.0 } else { 0.0 };
        }
        match (self.precision(), self.recall()) {
            (Some(precision), Some(recall)) if precision + recall > 0.0 => {
                2.0 * precision * recall / (precision + recall)
            }
            _ => 0.0,
        }
    }
}

/// One turn, judged.
#[derive(Debug, Clone)]
pub struct TurnResult {
    pub request: String,
    pub passed: bool,
    /// Why it failed, in one sentence. `None` on a pass.
    pub complaint: Option<String>,
    /// What the candidate answered, kept so a report can say more than
    /// "wrong".
    pub plan: Plan,
    /// The reason the case expected, for a `no_action` case.
    pub expected_decline: Option<String>,
    /// Per-id detail, on a rows case. `None` for every other shape.
    pub overlap: Option<Overlap>,
    /// **EVERY ROW THE TURN MOVED**, from a digest taken either side of it.
    /// Carried whether the turn passed or failed, because "it did the right
    /// thing and four other things" is a finding a verdict cannot express.
    pub changes: Vec<RowChange>,
    /// **THE TURN'S GRADED CREDIT, in `0.0..=1.0`. Never the verdict.**
    ///
    /// A rows turn is graded by [`Overlap::f1`]; every other shape is 1.0 or
    /// 0.0, and that asymmetry is deliberate rather than unfinished:
    ///
    /// * a `value` is a sum, and a sum that is close is wrong — there is no
    ///   coherent partial credit for arithmetic;
    /// * a `write_set` is all-or-nothing by the same ruling that created the
    ///   shape: half a bulk edit is worse than none of it, because the member
    ///   believes it finished. Its per-write fraction is reported as a
    ///   diagnostic by [`Report::partial_write_sets`] and is not paid for;
    /// * a decline is one bit; there is no half-decline.
    pub grade: f64,
    /// Whether [`Self::grade`] can be anything but 0.0 or 1.0 — true only for
    /// a rows turn.
    pub graded: bool,
    /// **THIS TURN CANNOT BE SCORED ON ITS OWN.** It expects an empty answer,
    /// so answering nothing passes it, and only the turns around it give the
    /// emptiness any meaning (G7 — `s06/t3`, `s59/t2`). Reported so that no
    /// count of passed turns can be read without it.
    pub combination_only: bool,
    /// `ordered: true` with no `order_by` — the harness scores the sequence
    /// strictly, but the case never said which sort it is scoring.
    pub undeclared_ordering: bool,
    /// **WHAT THE TURN COST, beside what it was worth.** Door calls, rows
    /// handed back and the candidate's own wall clock. Never a term in
    /// [`Self::grade`] — see [`TurnCost`].
    pub cost: TurnCost,
    /// The HARNESS's own cost on this turn: the vault scan taken to learn
    /// which rows moved. Charged here rather than to the candidate, because
    /// no shipped runtime pays it.
    pub digest_micros: u128,
}

/// One session, judged.
#[derive(Debug, Clone)]
pub struct SessionResult {
    pub id: String,
    pub category: String,
    /// The correlation group this session declared, if any.
    pub correlation_group: Option<String>,
    pub turns: Vec<TurnResult>,
}

impl SessionResult {
    #[must_use]
    pub fn passed(&self) -> bool {
        self.turns.iter().all(|turn| turn.passed)
    }

    /// The session's graded credit: the MEAN of its turns' grades.
    ///
    /// A mean rather than a product, and rather than a turn total: sessions
    /// are one to four turns long, and a sum would quietly weight a long
    /// session more than a short one when nothing about the suite says a long
    /// conversation matters more. A product would collapse to zero on any
    /// single wrong turn, which is what the strict verdict already says.
    #[must_use]
    pub fn grade(&self) -> f64 {
        if self.turns.is_empty() {
            return 0.0;
        }
        #[expect(clippy::cast_precision_loss, reason = "a handful of turns")]
        let count = self.turns.len() as f64;
        self.turns.iter().map(|turn| turn.grade).sum::<f64>() / count
    }
}

/// How well a candidate's declining tracks the cases that want one.
///
/// **A bare pass count over `clarify` and `refuse` is misleading and it has
/// been measured: an always-clarify system passes 14 turns of 129 and an
/// always-refuse system 5.** Those are free points for a runtime that never
/// answers anything, so the headline must not fold them in. Precision is "when
/// it declined this way, how often was that right"; recall is "of the cases
/// that wanted it, how many did it find".
#[derive(Debug, Clone)]
pub struct DeclineScore {
    pub reason: String,
    /// Turns where the candidate declined with this reason.
    pub declined: usize,
    /// ...of which the case wanted exactly this.
    pub correct: usize,
    /// Turns where the case wanted this reason.
    pub wanted: usize,
}

impl DeclineScore {
    /// Of the turns it declined this way, how many were right.
    #[must_use]
    pub fn precision(&self) -> Option<f64> {
        #[expect(clippy::cast_precision_loss, reason = "counts of turns in one suite")]
        let value = self.correct as f64 / self.declined as f64;
        (self.declined > 0).then_some(value)
    }

    /// **WHAT THIS REASON CAN AND CANNOT TELL APART (G11).**
    ///
    /// Recall over `clarify`, `refuse` and `none` is 0% for every degenerate
    /// instrument in `nulls` that is not `AlwaysDecline` — because emitting a
    /// decline is a deliberate act, and an instrument that only retrieves
    /// never emits one. So these columns separate exactly one thing: a
    /// candidate that chooses to decline from a candidate that does not.
    ///
    /// In particular:
    ///
    /// * **precision here is not competence.** `AlwaysDecline` can reach
    ///   100% recall on one reason by emitting it on every turn, and it pays
    ///   for that only in precision — which is why the headline is sessions
    ///   and this is a side table;
    /// * **0% recall is not evidence of anything.** A retrieval-only
    ///   instrument scoring 0% on `refuse` has not been measured as bad at
    ///   refusing; it has been measured as never refusing;
    /// * `none` is the weakest of the three: it means the member withdrew,
    ///   and the correct outcome is that nothing happened — which is also
    ///   what happens when a candidate crashes into silence.
    ///
    /// Carried as data so a report cannot print the numbers without it.
    #[must_use]
    pub fn caveat(&self) -> &'static str {
        match self.reason.as_str() {
            "clarify" => {
                "separates a candidate that asks from one that guesses; \
                          0% means it never asks, not that it asks badly"
            }
            "refuse" => {
                "separates a candidate that refuses from one that complies; \
                         0% means it never refuses, not that it refuses badly"
            }
            "none" => {
                "the member withdrew — indistinguishable from a candidate \
                       that did nothing for any other reason"
            }
            _ => "an undeclared decline reason: it separates nothing the suite asked for",
        }
    }

    /// Of the turns that wanted it, how many it found.
    #[must_use]
    pub fn recall(&self) -> Option<f64> {
        #[expect(clippy::cast_precision_loss, reason = "counts of turns in one suite")]
        let value = self.correct as f64 / self.wanted as f64;
        (self.wanted > 0).then_some(value)
    }
}

/// The whole run.
#[derive(Debug, Clone)]
pub struct Report {
    pub candidate: String,
    pub sessions: Vec<SessionResult>,
    /// **FULL VAULT SCANS ACTUALLY TAKEN**, across every session's world, and
    /// the microseconds they cost. One per session's first turn was the shape
    /// before `Dealt::digest` learned to gate on SQLite's change counter; what
    /// is left is one per turn that MOVED A ROW. Reported so the saving is a
    /// number rather than a claim, and so a test can assert the gate is still
    /// closing.
    pub scans: usize,
    pub scan_micros: u128,
    /// **THE HARNESS'S OWN SETUP BILL**, microseconds: dealing one private
    /// world per session — a copy of the template, a vault open and a command
    /// registry. Reported so that a wall clock for the whole run can be read
    /// apart from what the candidate spent, which is the only part of it a
    /// shipped runtime would pay.
    pub setup_micros: u128,
}

/// **THE COST COLUMNS FOR A WHOLE RUN.** Totals, and the shape of the
/// distribution — a mean over turns hides the one turn that scanned eight
/// boards, and the one turn that scans eight boards is the finding.
#[derive(Debug, Clone, Default)]
pub struct CostReport {
    pub turns: usize,
    /// Every door's bill, summed over every turn.
    pub total: TurnCost,
    /// The harness's own scans, microseconds — never a candidate's cost.
    pub digest_micros: u128,
    /// Door calls per turn: p50, p95, max.
    pub calls: Percentiles,
    /// Rows returned per turn: p50, p95, max.
    pub rows: Percentiles,
    /// Wall clock per turn in microseconds: p50, p95, max.
    pub micros: Percentiles,
}

/// A distribution, as the three numbers worth printing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Percentiles {
    pub p50: u128,
    pub p95: u128,
    pub max: u128,
}

impl Percentiles {
    /// Nearest-rank percentiles over a sample. Empty is all zeros.
    #[must_use]
    pub fn of(sample: &[u128]) -> Self {
        if sample.is_empty() {
            return Self::default();
        }
        let mut sorted = sample.to_vec();
        sorted.sort_unstable();
        let rank = |fraction: f64| {
            #[expect(
                clippy::cast_precision_loss,
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                reason = "a rank into a sample of at most a few hundred turns"
            )]
            let index = ((sorted.len() as f64) * fraction).ceil() as usize;
            sorted[index.saturating_sub(1).min(sorted.len() - 1)]
        };
        Self {
            p50: rank(0.5),
            p95: rank(0.95),
            max: sorted[sorted.len() - 1],
        }
    }
}

impl Report {
    /// **WHAT THE RUN COST, as columns beside the score and never inside it.**
    ///
    /// The one question the harness could not answer before this existed: a
    /// candidate that opens every board and one that asks the FTS plane a
    /// single question can score identically, and the brief asks for a
    /// runtime that answers on a phone at interactive latency. Now the two
    /// are told apart by a column.
    #[must_use]
    pub fn cost(&self) -> CostReport {
        let mut total = TurnCost::default();
        let mut digest_micros = 0u128;
        let mut calls = Vec::new();
        let mut rows = Vec::new();
        let mut micros = Vec::new();
        for session in &self.sessions {
            for turn in &session.turns {
                total.absorb(&turn.cost);
                digest_micros += turn.digest_micros;
                calls.push(turn.cost.calls() as u128);
                rows.push(turn.cost.rows() as u128);
                micros.push(turn.cost.micros);
            }
        }
        CostReport {
            turns: calls.len(),
            total,
            digest_micros,
            calls: Percentiles::of(&calls),
            rows: Percentiles::of(&rows),
            micros: Percentiles::of(&micros),
        }
    }

    /// The most expensive turns by wall clock, worst first — `(key, request,
    /// cost)`.
    #[must_use]
    pub fn costliest(&self, how_many: usize) -> Vec<(String, String, TurnCost)> {
        let mut all: Vec<(String, String, TurnCost)> = self
            .keyed()
            .map(|(key, turn)| (key, turn.request.clone(), turn.cost.clone()))
            .collect();
        all.sort_by(|left, right| right.2.micros.cmp(&left.2.micros));
        all.truncate(how_many);
        all
    }

    /// `(category, passed, total)`, in name order.
    #[must_use]
    pub fn by_category(&self) -> Vec<(String, usize, usize)> {
        let mut tally: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for session in &self.sessions {
            let entry = tally.entry(session.category.clone()).or_default();
            entry.1 += 1;
            if session.passed() {
                entry.0 += 1;
            }
        }
        tally
            .into_iter()
            .map(|(name, (passed, total))| (name, passed, total))
            .collect()
    }

    /// Sessions with at least one failed turn.
    #[must_use]
    pub fn failures(&self) -> Vec<&SessionResult> {
        self.sessions
            .iter()
            .filter(|session| !session.passed())
            .collect()
    }

    /// `clarify`, `refuse` and `none`, each as precision and recall.
    #[must_use]
    pub fn decline_scores(&self) -> Vec<DeclineScore> {
        let mut tally: BTreeMap<String, (usize, usize, usize)> = BTreeMap::new();
        for reason in ["clarify", "refuse", "none"] {
            tally.entry(reason.to_owned()).or_default();
        }
        for turn in self.sessions.iter().flat_map(|session| &session.turns) {
            if let Plan::Declined { reason } = &turn.plan {
                let entry = tally.entry(reason.clone()).or_default();
                entry.0 += 1;
                if turn.expected_decline.as_ref() == Some(reason) {
                    entry.1 += 1;
                }
            }
            if let Some(wanted) = &turn.expected_decline {
                tally.entry(wanted.clone()).or_default().2 += 1;
            }
        }
        tally
            .into_iter()
            .map(|(reason, (declined, correct, wanted))| DeclineScore {
                reason,
                declined,
                correct,
                wanted,
            })
            .collect()
    }

    /// Every turn whose rows were partly right — the diagnostic a binary
    /// verdict throws away.
    #[must_use]
    pub fn partial_rows(&self) -> Vec<(&SessionResult, &TurnResult)> {
        self.sessions
            .iter()
            .flat_map(|session| session.turns.iter().map(move |turn| (session, turn)))
            .filter(|(_, turn)| {
                turn.overlap
                    .as_ref()
                    .is_some_and(|overlap| overlap.hit > 0 && !turn.passed)
            })
            .collect()
    }

    #[must_use]
    pub fn all_passed(&self) -> bool {
        self.failures().is_empty()
    }

    /// **THE HEADLINE: sessions passed, out of sessions run.**
    ///
    /// Strict, and it stays strict. It is the number that defeats a
    /// breadth-dumping instrument outright — `EverythingOfEntity` reaches
    /// 61.8% of the ids the suite names and passes 0 turns — and nothing
    /// graded is allowed to soften it.
    #[must_use]
    pub fn strict_sessions(&self) -> (usize, usize) {
        (
            self.sessions.iter().filter(|s| s.passed()).count(),
            self.sessions.len(),
        )
    }

    /// **THE SECOND COLUMN: the mean session grade.**
    ///
    /// Macro-averaged over sessions, for the same reason the headline counts
    /// sessions: 29% of this suite's turns fall to some instrument that
    /// understands nothing, and a turn-weighted mean would let a long session
    /// of easy turns outweigh a short hard one. Read beside the strict rate,
    /// never instead of it: a candidate with a high graded score and a low
    /// strict rate is one that is usually nearly right, which is a different
    /// product from one that is sometimes exactly right.
    #[must_use]
    pub fn graded_score(&self) -> f64 {
        if self.sessions.is_empty() {
            return 0.0;
        }
        #[expect(clippy::cast_precision_loss, reason = "tens of sessions")]
        let count = self.sessions.len() as f64;
        self.sessions.iter().map(SessionResult::grade).sum::<f64>() / count
    }

    /// `(category, sessions passed, sessions, mean session grade)`.
    #[must_use]
    pub fn by_category_graded(&self) -> Vec<(String, usize, usize, f64)> {
        let mut tally: BTreeMap<String, (usize, usize, f64)> = BTreeMap::new();
        for session in &self.sessions {
            let entry = tally.entry(session.category.clone()).or_default();
            entry.1 += 1;
            entry.2 += session.grade();
            if session.passed() {
                entry.0 += 1;
            }
        }
        tally
            .into_iter()
            .map(|(name, (passed, total, grade))| {
                #[expect(clippy::cast_precision_loss, reason = "tens of sessions")]
                let count = total as f64;
                (name, passed, total, grade / count)
            })
            .collect()
    }

    /// **THE SAME NUMBERS WITH CORRELATED SESSIONS COUNTED ONCE (G10).**
    ///
    /// Sessions that declared the same `correlation_group` are averaged into a
    /// single unit before the totals are taken, so `s71`/`s02` and `s65`/`s09`
    /// — the same rows asked in two shapes — contribute one unit each instead
    /// of two. Returns `(strict units, total units, graded score)`; the strict
    /// unit is fractional, because a candidate that passed one shape of a pair
    /// and failed the other has done neither the whole thing nor nothing.
    ///
    /// The raw numbers stay on the page next to this one. Collapsing is a
    /// second reading, not a correction.
    #[must_use]
    #[expect(
        clippy::cast_precision_loss,
        reason = "counts of sessions in one suite"
    )]
    pub fn deduplicated(&self) -> (f64, usize, f64) {
        let mut groups: BTreeMap<String, Vec<&SessionResult>> = BTreeMap::new();
        for (index, session) in self.sessions.iter().enumerate() {
            let key = session
                .correlation_group
                .clone()
                .unwrap_or_else(|| format!("\u{0}solo-{index}"));
            groups.entry(key).or_default().push(session);
        }
        let units = groups.len();
        let mut strict = 0.0;
        let mut graded = 0.0;
        for members in groups.values() {
            let size = members.len() as f64;
            strict += members.iter().filter(|s| s.passed()).count() as f64 / size;
            graded += members.iter().map(|s| s.grade()).sum::<f64>() / size;
        }
        let total = units as f64;
        (strict, units, if units == 0 { 0.0 } else { graded / total })
    }

    /// The correlation groups the suite declared, and who is in them.
    #[must_use]
    pub fn correlation_groups(&self) -> BTreeMap<String, Vec<String>> {
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for session in &self.sessions {
            if let Some(name) = &session.correlation_group {
                groups
                    .entry(name.clone())
                    .or_default()
                    .push(session.id.clone());
            }
        }
        groups
    }

    /// `session/turn` keys of every turn that cannot be scored on its own
    /// (G7) — it expects an empty answer, so answering nothing passes it.
    #[must_use]
    pub fn combination_only(&self) -> Vec<(String, String)> {
        self.keyed()
            .filter(|(_, turn)| turn.combination_only)
            .map(|(key, turn)| (key, turn.request.clone()))
            .collect()
    }

    /// `session/turn` keys of every turn whose ordering the suite scores but
    /// never defined (G15).
    #[must_use]
    pub fn undeclared_ordering(&self) -> Vec<(String, String)> {
        self.keyed()
            .filter(|(_, turn)| turn.undeclared_ordering)
            .map(|(key, turn)| (key, turn.request.clone()))
            .collect()
    }

    /// Every failed `write_set`, with how many of its writes did hold — the
    /// diagnostic the all-or-nothing grade deliberately does not pay for.
    #[must_use]
    pub fn partial_write_sets(&self) -> Vec<(String, String)> {
        self.keyed()
            .filter(|(_, turn)| !turn.passed)
            .filter_map(|(key, turn)| {
                turn.complaint
                    .as_ref()
                    .filter(|complaint| complaint.contains("expected write(s) did not hold"))
                    .map(|complaint| (key, complaint.clone()))
            })
            .collect()
    }

    fn keyed(&self) -> impl Iterator<Item = (String, &TurnResult)> {
        self.sessions.iter().flat_map(|session| {
            session
                .turns
                .iter()
                .enumerate()
                .map(move |(index, turn)| (format!("{}/t{}", session.id, index + 1), turn))
        })
    }
}

/// Judge one turn's plan against what the suite expects.
///
/// **TWO QUESTIONS ON A WRITE TURN, NOT ONE.** The predicate asks whether the
/// right thing happened; `changed` asks whether anything else did. A turn
/// passes only if both answer yes — see [`License`] and DEFECT #16.
fn judge(
    expected: &Expected,
    plan: &Plan,
    writes: usize,
    changed: &[RowChange],
    probe: &Probe<'_>,
    predicates: &BTreeMap<&'static str, Predicate>,
    licenses: &BTreeMap<&'static str, Licensor>,
) -> Option<String> {
    // **A READ MUST NOT WRITE.** For every shape but a write, the licensed
    // set is empty: a candidate that answered the right rows and moved one on
    // the way has not answered the question, it has edited the vault behind
    // the member's back. `no_action` counts writes as well, and keeps its own
    // older complaint, because a candidate can execute a command the vault
    // refuses — no row moves and it still declined while trying to write.
    if !matches!(expected, Expected::Write { .. } | Expected::WriteSet { .. })
        && !changed.is_empty()
    {
        return Some(format!(
            "the turn expects {} and no vault change at all, but {} row(s) moved: {}",
            shape_of_expected(expected),
            changed.len(),
            joined_changes(changed)
        ));
    }
    match (expected, plan) {
        (Expected::Ids { ids, ordered, .. }, Plan::Ids(answered)) => {
            if *ordered {
                (answered != ids)
                    .then(|| format!("answered {answered:?}, expected {ids:?} in order"))
            } else {
                let mut got: Vec<&String> = answered.iter().collect();
                let mut want: Vec<&String> = ids.iter().collect();
                got.sort_unstable();
                got.dedup();
                want.sort_unstable();
                (got != want).then(|| format!("answered {answered:?}, expected {ids:?}"))
            }
        }
        (Expected::Write { predicate, args }, Plan::Wrote) => {
            check_one(predicate, args, probe, predicates)
                .err()
                .or_else(|| collateral(&[(predicate.as_str(), args)], changed, probe, licenses))
        }
        (Expected::WriteSet { ordered: true, .. }, _) => Some(
            "this write_set declares an order between its writes, which the harness refuses \
             to score: predicates read the vault after the turn, and two orderings of the \
             same writes leave the same vault"
                .to_owned(),
        ),
        (Expected::WriteSet { writes, .. }, Plan::Wrote) => {
            let unmet: Vec<String> = writes
                .iter()
                .filter_map(|write| {
                    check_one(&write.predicate, &write.args, probe, predicates).err()
                })
                .collect();
            if !unmet.is_empty() {
                return Some(format!(
                    "{} of {} expected write(s) did not hold: {}",
                    unmet.len(),
                    writes.len(),
                    unmet.join("; ")
                ));
            }
            // THE LICENCES UNION. A bulk edit licenses each of its writes and
            // nothing more; three reschedules do not license a fourth.
            let named: Vec<(&str, &Map<String, Value>)> = writes
                .iter()
                .map(|write| (write.predicate.as_str(), &write.args))
                .collect();
            collateral(&named, changed, probe, licenses)
        }
        (Expected::Value { value, .. }, Plan::Value(answered)) => {
            // EXACTLY. A tolerance would be this harness deciding how wrong a
            // total is allowed to be, and money in minor units is an integer.
            #[expect(
                clippy::float_cmp,
                reason = "an exact total is the whole of the expectation"
            )]
            let agreed = answered == value;
            (!agreed).then(|| format!("answered {answered}, expected {value}"))
        }
        (Expected::NoAction { reason, .. }, Plan::Declined { reason: given }) => {
            if writes > 0 {
                Some(format!("declined but made {writes} write(s)"))
            } else if reason != given {
                Some(format!("declined to {given:?}, expected {reason:?}"))
            } else {
                None
            }
        }
        (expected, plan) => Some(format!(
            "answered {}, but the case expects {}",
            shape_of_plan(plan),
            shape_of_expected(expected)
        )),
    }
}

/// Per-id detail for a rows case — DIAGNOSTIC ONLY; it never moves a verdict.
fn overlap_of(expected: &Expected, plan: &Plan) -> Option<Overlap> {
    let Expected::Ids { ids, .. } = expected else {
        return None;
    };
    let answered: Vec<String> = match plan {
        Plan::Ids(answered) => answered.clone(),
        _ => Vec::new(),
    };
    let wanted: std::collections::BTreeSet<&String> = ids.iter().collect();
    let got: std::collections::BTreeSet<&String> = answered.iter().collect();
    Some(Overlap {
        expected: wanted.len(),
        answered: got.len(),
        hit: wanted.intersection(&got).count(),
        missing: wanted.difference(&got).map(|id| (*id).clone()).collect(),
        extra: got.difference(&wanted).map(|id| (*id).clone()).collect(),
    })
}

/// **WHAT THE TURN CHANGED THAT NO EXPECTATION ASKED FOR.**
///
/// The union of the named writes' licences, checked against the changed-row
/// set. A predicate with no licence written stops the turn by name rather than
/// waving it through — a silent pass here is exactly the hole this check
/// exists to close.
fn collateral(
    named: &[(&str, &Map<String, Value>)],
    changed: &[RowChange],
    probe: &Probe<'_>,
    licenses: &BTreeMap<&'static str, Licensor>,
) -> Option<String> {
    let mut union = License::default();
    for (predicate, args) in named {
        let license = license_for(predicate, args, probe, licenses);
        if license.unwritten {
            return Some(format!(
                "no side-effect licence is written for `{predicate}`, so this turn's                  collateral damage cannot be judged; add one to `licenses()`"
            ));
        }
        union.allowances.extend(license.allowances);
    }
    let unlicensed = union.unlicensed(changed);
    (!unlicensed.is_empty()).then(|| {
        format!(
            "the expected write(s) held, but {} row(s) moved that no expectation licenses: {}",
            unlicensed.len(),
            unlicensed.join(", ")
        )
    })
}

/// A changed-row set, short enough to read in a complaint.
fn joined_changes(changes: &[RowChange]) -> String {
    let shown: Vec<String> = changes.iter().take(6).map(RowChange::to_string).collect();
    if changes.len() > shown.len() {
        format!(
            "{}, and {} more",
            shown.join(", "),
            changes.len() - shown.len()
        )
    } else {
        shown.join(", ")
    }
}

fn check_one(
    predicate: &str,
    args: &Map<String, Value>,
    probe: &Probe<'_>,
    predicates: &BTreeMap<&'static str, Predicate>,
) -> Result<(), String> {
    match predicates.get(predicate) {
        None => Err(format!("no predicate named `{predicate}`")),
        Some(check) => check(probe, args),
    }
}

fn shape_of_plan(plan: &Plan) -> &'static str {
    match plan {
        Plan::Ids(_) => "rows",
        Plan::Wrote => "a write",
        Plan::Declined { .. } => "no action",
        Plan::Value(_) => "a number",
    }
}

fn shape_of_expected(expected: &Expected) -> &'static str {
    match expected {
        Expected::Ids { .. } => "rows",
        Expected::Value { .. } => "a number",
        Expected::Write { .. } | Expected::WriteSet { .. } => "a write",
        Expected::NoAction { .. } => "no action",
    }
}

/// Run a whole suite against a candidate runtime.
///
/// **Every session gets a FRESH world**, so a write in one cannot be read by
/// another, and a fresh candidate, so a conversation cannot be primed by the
/// one before it.
///
/// # Errors
///
/// The world cannot be dealt.
pub fn run(
    suite: &Suite,
    template: &WorldTemplate,
    runtime: &dyn CandidateRuntime,
) -> Result<Report, String> {
    let predicates = predicates();
    let licenses = licenses();
    let mut sessions = Vec::with_capacity(suite.sessions.len());
    let mut setup_micros = 0u128;
    let mut scans = 0usize;
    let mut scan_micros = 0u128;
    // THE BASELINE DIGEST, TAKEN ONCE FOR THE WHOLE RUN.
    //
    // Every session is dealt from the same template by the same code, so the
    // state before its first turn is the same state every time — 90 identical
    // scans of 140 tables to learn the same answer. It is taken from the first
    // session's world and reused, and `two_fresh_deals_digest_alike` in
    // `tests.rs` is what keeps that from being an assumption.
    let mut baseline: Option<VaultDigest> = None;
    for session in &suite.sessions {
        let dealing = std::time::Instant::now();
        let dealt = template.deal()?;
        setup_micros += dealing.elapsed().as_micros();
        if !dealt.now.starts_with(&suite.today) {
            return Err(format!(
                "the suite says today is {} and the world says {}",
                suite.today, dealt.now
            ));
        }
        let mut candidate = runtime.session(session);
        let mut ctx = Context::new(&dealt);
        let probe = Probe { dealt: &dealt };
        let mut turns = Vec::with_capacity(session.turns.len());
        // THE DIGEST BEFORE THE FIRST TURN. Each turn's after-state is the
        // next turn's before-state, so one scan per turn buys both ends.
        let mut before = match &baseline {
            Some(digest) => {
                dealt.prime(digest.clone());
                digest.clone()
            }
            None => {
                let digest = dealt.digest();
                baseline = Some(digest.clone());
                digest
            }
        };
        for turn in &session.turns {
            ctx.writes_this_turn = 0;
            *ctx.cost.borrow_mut() = TurnCost::default();
            let started = std::time::Instant::now();
            let plan = candidate.turn(&turn.request, &mut ctx);
            let elapsed = started.elapsed().as_micros();
            let mut cost = ctx.cost.borrow().clone();
            cost.micros = elapsed;
            let writes = ctx.writes_this_turn;
            let scanning = std::time::Instant::now();
            let after = dealt.digest();
            let digest_micros = scanning.elapsed().as_micros();
            let changed = diff(&before, &after);
            before = after;
            let complaint = judge(
                &turn.expected,
                &plan,
                writes,
                &changed,
                &probe,
                &predicates,
                &licenses,
            );
            let overlap = overlap_of(&turn.expected, &plan);
            let expected_decline = match &turn.expected {
                Expected::NoAction { reason, .. } => Some(reason.clone()),
                _ => None,
            };
            ctx.history.push(TurnRecord {
                request: turn.request.clone(),
                plan: plan.clone(),
            });
            let passed = complaint.is_none();
            // THE GRADE. A rows turn is graded by F1 over the ids; every
            // other shape is the verdict itself. Never the other way round —
            // a graded score that could pay a turn the verdict failed on
            // would be a second, softer verdict.
            let (grade, graded) = match &overlap {
                Some(found) => (found.f1(), true),
                None => (if passed { 1.0 } else { 0.0 }, false),
            };
            let (combination_only, undeclared_ordering) = match &turn.expected {
                Expected::Ids {
                    ids,
                    ordered,
                    order_by,
                    ..
                } => (ids.is_empty(), *ordered && order_by.is_none()),
                _ => (false, false),
            };
            turns.push(TurnResult {
                request: turn.request.clone(),
                passed,
                complaint,
                plan,
                expected_decline,
                overlap,
                changes: changed,
                grade,
                graded,
                combination_only,
                undeclared_ordering,
                cost,
                digest_micros,
            });
        }
        let (took, spent) = dealt.scan_cost();
        scans += took;
        scan_micros += spent;
        sessions.push(SessionResult {
            id: session.id.clone(),
            category: session.category.clone(),
            correlation_group: session.correlation_group.clone(),
            turns,
        });
    }
    Ok(Report {
        candidate: runtime.name().to_owned(),
        sessions,
        scans,
        scan_micros,
        setup_micros,
    })
}

// ---------------------------------------------------------------------------
// The app doors.
// ---------------------------------------------------------------------------

/// One app's rows, through the app crate's own reader.
///
/// `live` is left `true` here and stamped by [`Context::open`] from the row's
/// own `deleted_at`: what this function reports is what the DOOR says, and the
/// two are not the same thing for Tasks and Agenda.
/// HOW MANY ROWS A BOARD HANDS BACK.
///
/// It is the whole board, not a page of it. A limit below the world's size
/// would make "open the app and read it" quietly lossy — a candidate would be
/// marked down for rows the harness never showed it, and the scan-versus-search
/// question the world was grown to decide would be decided by a constant in
/// here. So this is larger than any world this crate seeds, and what a scan
/// costs is what a scan costs.
const BOARD_LIMIT: usize = 100_000;

#[expect(
    clippy::too_many_lines,
    reason = "eight apps, eight readers — splitting them would hide the one list a reader wants"
)]
fn board_of(
    app: App,
    door: &TestDoor<'_>,
    now: &str,
    now_ms: i64,
) -> Result<Vec<VaultRow>, String> {
    let id = app.id().to_owned();
    /// Several values in one extra, so a bag of strings can still carry a
    /// list. `\u{1f}` is the unit separator — no label in any app holds one.
    fn joined(values: &[String]) -> String {
        values.join("\u{1f}")
    }
    let row = |entity: &str,
               key: String,
               label: String,
               date: Option<String>,
               extra: Vec<(&str, String)>| VaultRow {
        id: key,
        entity: entity.to_owned(),
        app: id.clone(),
        label,
        date,
        live: true,
        extra: extra
            .into_iter()
            .map(|(name, value)| (name.to_owned(), value))
            .collect(),
    };
    Ok(match app {
        App::Tasks => {
            let (board, _denial) =
                centraid_apps_tasks::queries::load_board(door, Some(BOARD_LIMIT as i64), now)
                    .map_err(|error| error.to_string())?;
            fn flatten(
                tasks: &[centraid_apps_tasks::queries::TaskRow],
                into: &mut Vec<centraid_apps_tasks::queries::TaskRow>,
            ) {
                for task in tasks {
                    into.push(task.clone());
                    flatten(&task.children, into);
                }
            }
            let mut all = Vec::new();
            flatten(&board.open, &mut all);
            flatten(&board.logbook, &mut all);
            let mut tasks = all
                .into_iter()
                .map(|task| {
                    let due = task.due_at.clone();
                    let mut extra = vec![("status", task.status.clone())];
                    // WHEN IT WAS TICKED OFF, not just that it was. "What have
                    // I finished this week" is a window over this stamp, and
                    // without it on the row a candidate can only answer the
                    // unwindowed version — which, over a logbook of hundreds,
                    // is a different question.
                    if let Some(completed) = task.completed_at.clone() {
                        extra.push(("completed_at", completed));
                    }
                    if let Some(effort) = task.effort_min {
                        extra.push(("effort_min", effort.to_string()));
                    }
                    if let Some(parent) = task.parent_task_id.clone() {
                        extra.push(("parent_task_id", parent));
                    }
                    row("schedule.task", task.task_id, task.title, due, extra)
                })
                .collect::<Vec<VaultRow>>();
            // THE PROJECTS, which the board already folds beside the tasks.
            // `schedule.project` is declared `surface: "kind"` on the Tasks
            // door, so "which projects do I have" has to be answerable from
            // the same board the tasks came off — a Kind the executor cannot
            // serve is a Kind the grammar has no business naming.
            tasks.extend(board.projects.iter().map(|project| {
                row(
                    "schedule.project",
                    project.project_id.clone(),
                    project.name.clone().unwrap_or_default(),
                    None,
                    project
                        .area
                        .clone()
                        .map(|area| vec![("area", area)])
                        .unwrap_or_default(),
                )
            }));
            tasks
        }
        App::Agenda => {
            let (upcoming, _denial) = centraid_apps_agenda::queries::load_upcoming(
                door,
                Some("2000-01-01T00:00:00.000Z"),
                None,
                now,
            )
            .map_err(|error| error.to_string())?;
            upcoming
                .events
                .into_iter()
                // An expansion instance is the SAME row as its anchor; a board
                // that listed both would make "how many events" unanswerable.
                .filter(|event| !event.is_recurrence_instance)
                .map(|event| {
                    let start = event.dtstart.clone();
                    let mut extra = Vec::new();
                    if let Some(end) = event.dtend.clone() {
                        extra.push(("dtend", end));
                    }
                    if let Some(rrule) = event.rrule.clone() {
                        extra.push(("rrule", rrule));
                    }
                    if let Some(place) = event.location_place_id.clone() {
                        extra.push(("location_place_id", place));
                    }
                    if let Some(calendar) = event.calendar_id.clone() {
                        extra.push(("calendar_id", calendar));
                    }
                    let attendees = event
                        .attendees
                        .iter()
                        .map(|attendee| attendee.party_id.clone())
                        .collect::<Vec<_>>();
                    if !attendees.is_empty() {
                        extra.push(("attendee_party_ids", joined(&attendees)));
                    }
                    row(
                        "core.event",
                        event.event_id,
                        event.summary.unwrap_or_default(),
                        Some(start),
                        extra,
                    )
                })
                .collect()
        }
        App::Notes => {
            let cards = centraid_apps_notes::cards::OwnerCards::new(door);
            let (library, _denial) =
                centraid_apps_notes::queries::load_library(door, &cards, Some(BOARD_LIMIT as i64))
                    .map_err(|error| error.to_string())?;
            // THE NOTEBOOKS. `core.collection` is declared `surface: "kind"`
            // on the Notes door and the Notes door's own word for it is
            // `notebooks` (`create-notebook`, `library.notebooks`), so the
            // board hands them back as rows of their own and not only as the
            // `notebooks` extra on each note.
            let mut rows: Vec<VaultRow> = library
                .notebooks
                .iter()
                .map(|notebook| {
                    row(
                        "knowledge.notebook",
                        notebook.notebook_id.clone(),
                        notebook.name.clone().unwrap_or_default(),
                        None,
                        Vec::new(),
                    )
                })
                .collect();
            rows.extend(library.notes.into_iter().chain(library.trash).map(|note| {
                let extra = vec![
                    ("preview", note.preview.clone()),
                    ("notebooks", joined(&note.notebook_names)),
                ];
                row(
                    "knowledge.note",
                    note.note_id,
                    note.title.unwrap_or_default(),
                    note.updated_at,
                    extra,
                )
            }));
            rows
        }
        App::Docs => {
            let (drive, _denial) = centraid_apps_docs::queries::load_drive(
                door,
                centraid_apps_docs::queries::DriveInput {
                    limit: Some(BOARD_LIMIT),
                },
                now,
            )
            .map_err(|error| error.to_string())?;
            let folders: BTreeMap<String, String> = drive
                .folders
                .iter()
                .map(|folder| {
                    (
                        folder.folder_id.clone(),
                        folder.name.clone().unwrap_or_default(),
                    )
                })
                .collect();
            drive
                .documents
                .into_iter()
                .map(|document| {
                    let mut extra = vec![
                        ("starred", document.starred.to_string()),
                        ("trashed", document.trashed.to_string()),
                    ];
                    if let Some(folder) = document
                        .folder_id
                        .as_ref()
                        .and_then(|folder| folders.get(folder))
                    {
                        extra.push(("folder", folder.clone()));
                    }
                    row(
                        "core.document",
                        document.document_id,
                        document.title.unwrap_or_default(),
                        document.updated_at,
                        extra,
                    )
                })
                .collect()
        }
        App::People => {
            let mut rows: Vec<VaultRow>;
            let (people, _denial) = centraid_apps_people::roster::load_people(
                door,
                centraid_apps_people::roster::PeopleInput {
                    limit: Some(BOARD_LIMIT),
                },
            )
            .map_err(|error| error.to_string())?;
            rows = people
                .people
                .into_iter()
                .map(|person| {
                    let mut extra = vec![
                        ("role", person.role.clone()),
                        ("cadence_days", person.cadence_days.to_string()),
                        ("starred", person.starred.to_string()),
                    ];
                    if let Some(last) = person.last_contacted_at.clone() {
                        extra.push(("last_contacted_at", last));
                    }
                    let reminders = person
                        .reminders
                        .iter()
                        .map(|reminder| format!("{}={}", reminder.label, reminder.month_day))
                        .collect::<Vec<_>>();
                    if !reminders.is_empty() {
                        extra.push(("important_dates", joined(&reminders)));
                    }
                    // THE DEBTS THIS PERSON IS PART OF — People's own reader
                    // is the only one in the tree that reads Tally's
                    // obligation table, and "do I owe Neha anything" is a
                    // People question. Open ones only: a settled debt is
                    // history, not an answer.
                    for (column, name) in
                        [("to_party", "owed_to_them"), ("from_party", "owed_to_me")]
                    {
                        let query = centraid_apps_people::queries::obligations_statement(
                            "evalsuite.people.obligations",
                            column,
                            &person.party_id,
                        );
                        let open: Vec<String> = door
                            .page(&query, &PageRequest::first(50))
                            .map(|page| page.rows)
                            .unwrap_or_default()
                            .iter()
                            .filter(|found| text(found, "settled_at").is_none())
                            .filter_map(|found| text(found, "obligation_id"))
                            .collect();
                        if !open.is_empty() {
                            extra.push((name, joined(&open)));
                        }
                    }
                    row("core.party", person.party_id, person.name, None, extra)
                })
                .collect();
            // THE SUB-ROWS A PERSON CARRIES. "When is Ana's birthday", "what's
            // Neha's number" and "when did I last hear from Marco" are all
            // People questions whose ANSWER is not the party row: it is a
            // date, a channel or an activity hanging off it. A board that
            // stopped at the roster would make those unanswerable.
            let parties: Vec<(String, String)> = rows
                .iter()
                .map(|found| (found.id.clone(), found.label.clone()))
                .collect();
            for (party_id, name) in &parties {
                let dates = centraid_apps_people::queries::important_dates_statement(
                    "evalsuite.people.dates",
                    std::slice::from_ref(party_id),
                );
                if let Ok(query) = dates
                    && let Ok(page) = door.page(&query, &PageRequest::first(50))
                {
                    rows.extend(page.rows.iter().filter_map(|found| {
                        let date_id = text(found, "date_id")?;
                        let label = text(found, "label")?;
                        let month_day = text(found, "month_day")?;
                        Some(row(
                            "people.important_date",
                            date_id,
                            format!("{label} — {name}"),
                            // The next occurrence in the world's own year: a
                            // `MM-DD` is not a date a window can compare.
                            Some(format!("{}-{month_day}", &now[..4])),
                            vec![("party_id", party_id.clone()), ("month_day", month_day)],
                        ))
                    }));
                }
                let query = centraid_apps_people::queries::person_channels_statement(party_id);
                if let Ok(page) = door.page(&query, &PageRequest::first(50)) {
                    rows.extend(page.rows.iter().filter_map(|found| {
                        let channel_id = text(found, "channel_id")?;
                        let label = text(found, "label")?;
                        Some(row(
                            "social.contact_channel",
                            channel_id,
                            format!("{name} — {label}"),
                            None,
                            vec![
                                ("party_id", party_id.clone()),
                                ("kind", text(found, "kind").unwrap_or_default()),
                                ("value", text(found, "value").unwrap_or_default()),
                            ],
                        ))
                    }));
                }
            }
            // The logged touches, through the link People's own dashboard
            // walks: an activity belongs to the party its link names.
            let ids: Vec<String> = parties.iter().map(|(id, _)| id.clone()).collect();
            let names: BTreeMap<&str, &str> = parties
                .iter()
                .map(|(id, name)| (id.as_str(), name.as_str()))
                .collect();
            if let Ok(links) = centraid_apps_people::queries::activity_links_statement(&ids)
                && let Ok(page) = door.page(&links, &PageRequest::first(200))
            {
                for link in &page.rows {
                    let (Some(activity_id), Some(party_id)) =
                        (text(link, "from_id"), text(link, "to_id"))
                    else {
                        continue;
                    };
                    let Ok(Some(found)) = read_by_id(
                        door,
                        "evalsuite.people.activity",
                        "activity_id, kind_concept_id, started_at",
                        "core_activity",
                        "activity_id",
                        &activity_id,
                    ) else {
                        continue;
                    };
                    let who = names.get(party_id.as_str()).copied().unwrap_or_default();
                    let started = text(&found, "started_at");
                    rows.push(row(
                        "core.activity",
                        activity_id,
                        format!("interaction — {who}"),
                        started,
                        vec![("party_id", party_id)],
                    ));
                }
            }
            // THE JOURNAL, which is People's and not Notes'.
            //
            // A People journal entry is a `knowledge.note` carrying a marker
            // concept, and the Notes library does NOT hand it back — the note
            // exists and the app a member wrote it in is the only door to it.
            // A harness that stopped at the Notes library would make "what did
            // I write in my journal" unanswerable and score every candidate as
            // equally unable.
            if let Ok((journal, _denial)) = centraid_apps_people::journal::load_journal(door) {
                rows.extend(journal.entries.iter().filter_map(|entry| {
                    match entry {
                        centraid_apps_people::journal::JournalEntry::Owner {
                            id,
                            sort_at,
                            mood,
                            ..
                        } => Some(row(
                            "knowledge.note",
                            id.clone(),
                            format!("People journal · {mood}"),
                            Some(sort_at.clone()),
                            vec![("journal", "true".to_owned())],
                        )),
                        // An auto entry is the interaction already carried
                        // above; listing it twice would double-count a touch.
                        centraid_apps_people::journal::JournalEntry::Auto { .. } => None,
                    }
                }));
            }
            rows
        }
        App::Tally => {
            let tally = centraid_apps_tally::queries::load_tally(door)
                .map_err(|error| error.to_string())?;
            // THE GROUPS AND THE PEOPLE RIDE ALONG. A ledger read without them
            // cannot answer "what did we spend on the trip" or "what did Neha
            // pay for", because the group and the payer are where those
            // questions' subjects live — and the world seeds two groups and
            // three bare first names on purpose.
            let mut rows: Vec<VaultRow> = tally
                .groups
                .iter()
                .map(|group| {
                    let members = tally
                        .members_by_group
                        .get(&group.group_id)
                        .cloned()
                        .unwrap_or_default();
                    row(
                        "tally.group",
                        group.group_id.clone(),
                        group.name.clone(),
                        None,
                        vec![("member_party_ids", joined(&members))],
                    )
                })
                .collect();
            rows.extend(tally.people.values().map(|person| {
                row(
                    "core.party",
                    person.party_id.clone(),
                    person.name.clone(),
                    None,
                    vec![("is_me", person.is_me.to_string())],
                )
            }));
            // THE SETTLEMENTS. "We are square" is a payment somebody
            // recorded, and a balance read without them is a balance from
            // before anyone paid anybody back.
            rows.extend(tally.settlements.iter().map(|settlement| {
                row(
                    "tally.settlement",
                    settlement.settlement_id.clone(),
                    format!("settlement {}", settlement.amount_minor),
                    settlement.paid_on.clone(),
                    vec![
                        ("from_party", settlement.from_party.clone()),
                        ("to_party", settlement.to_party.clone()),
                        ("amount_minor", settlement.amount_minor.to_string()),
                        ("group_id", settlement.group_id.clone().unwrap_or_default()),
                    ],
                )
            }));
            rows.extend(tally.expenses.iter().map(|expense| {
                let mut extra = vec![
                    ("paid_by", expense.paid_by.clone()),
                    ("category", expense.category.clone()),
                    ("amount_minor", expense.amount_minor.to_string()),
                ];
                if let Some(group) = expense.group_id.clone() {
                    extra.push(("group_id", group));
                }
                if expense.deleted_at.is_some() {
                    extra.push(("deleted", "true".to_owned()));
                }
                // EACH MEMBER'S SHARE, as Tally's own fold computed it. "How
                // much does Marco still owe me" is a share minus a settlement,
                // and a candidate that re-divided the total by the head count
                // would be out by the remainder the payer absorbs.
                if let Some(splits) = tally.splits.get(&expense.expense_id) {
                    for (party, share) in splits {
                        extra.push((
                            Box::leak(format!("split:{party}").into_boxed_str()),
                            share.to_string(),
                        ));
                    }
                }
                row(
                    "tally.expense",
                    expense.expense_id.clone(),
                    expense.description.clone(),
                    Some(expense.spent_on.clone()),
                    extra,
                )
            }));
            // THE CIRCLES. A Tally group is a `social.circle` decorated by a
            // `tally.group` (see `GroupRow`), and the circle is the row a
            // member names when they say "who is in my circles" — the
            // declaration on Tally's `social.circle` scope is `kind`, so the
            // board serves it.
            rows.extend(tally.groups.iter().map(|group| {
                row(
                    "social.circle",
                    group.circle_id.clone(),
                    group.name.clone(),
                    None,
                    vec![("group_id", group.group_id.clone())],
                )
            }));
            // THE FINANCE PLANE — accounts and postings. Tally imports
            // statement lines and proposes cross-account matches, so a member
            // names both; the statements are Tally's own (`tally.matches.*`),
            // not queries invented here. An account with no posting in the
            // window is not reached, because `match_accounts_statement` asks
            // by id and the postings are where the ids come from.
            let postings = door
                .page(
                    &centraid_apps_tally::queries::match_transactions_statement(),
                    &PageRequest::first(BOARD_LIMIT),
                )
                .map(|page| page.rows)
                .unwrap_or_default();
            let mut account_ids: Vec<String> = Vec::new();
            for posting in &postings {
                let (Some(txn_id), Some(account_id)) =
                    (text(posting, "txn_id"), text(posting, "account_id"))
                else {
                    continue;
                };
                if !account_ids.contains(&account_id) {
                    account_ids.push(account_id.clone());
                }
                let amount = text(posting, "amount_minor").unwrap_or_default();
                rows.push(row(
                    "core.transaction",
                    txn_id,
                    text(posting, "description").unwrap_or_default(),
                    text(posting, "posted_at"),
                    vec![
                        ("account_id", account_id),
                        ("amount_minor", amount),
                        ("direction", text(posting, "direction").unwrap_or_default()),
                        ("currency", text(posting, "currency").unwrap_or_default()),
                    ],
                ));
            }
            if !account_ids.is_empty()
                && let Ok(query) =
                    centraid_apps_tally::queries::match_accounts_statement(&account_ids)
                && let Ok(page) = door.page(&query, &PageRequest::first(BOARD_LIMIT))
            {
                rows.extend(page.rows.iter().filter_map(|found| {
                    let account_id = text(found, "account_id")?;
                    Some(row(
                        "core.account",
                        account_id,
                        text(found, "name").unwrap_or_default(),
                        None,
                        text(found, "external_ref")
                            .map(|reference| vec![("external_ref", reference)])
                            .unwrap_or_default(),
                    ))
                }));
            }
            rows
        }
        App::Photos => {
            let library = centraid_apps_photos::queries::load_library(
                door,
                &centraid_apps_photos::queries::LibraryInput {
                    limit: Some(BOARD_LIMIT),
                    before: None,
                },
                now_ms,
            )
            .map_err(|error| error.to_string())?;
            let mut rows: Vec<VaultRow> = library
                .albums
                .iter()
                .map(|album| {
                    row(
                        "media.album",
                        album.album_id.clone(),
                        album.title.clone().unwrap_or_default(),
                        None,
                        Vec::new(),
                    )
                })
                .collect();
            rows.extend(library.places.iter().map(|place| {
                row(
                    "core.place",
                    place.place_id.clone(),
                    place.name.clone(),
                    None,
                    Vec::new(),
                )
            }));
            rows.extend(library.assets.into_iter().chain(library.trash).map(|grid| {
                let captured = grid.asset.captured_at.clone();
                let mut extra = vec![
                    ("favorite", grid.favorite.to_string()),
                    ("album_titles", joined(&grid.album_titles)),
                ];
                if let Some(place) = grid.place.as_ref() {
                    extra.push(("place_id", place.place_id.clone()));
                    extra.push(("place", place.name.clone()));
                }
                row(
                    "core.content_item",
                    grid.asset.asset_id,
                    grid.asset.title.unwrap_or_default(),
                    captured,
                    extra,
                )
            }));
            rows
        }
        App::Locker => {
            // LOCKER HAS NO `load_*`: the app hands a surface statements and a
            // decorator rather than one fold. The statement is the app's own,
            // so this is still the app's door and not a query of the harness's.
            let query = centraid_apps_locker::queries::items_statement(
                centraid_apps_locker::queries::Shelf::Live,
            );
            let page = door
                .page(&query, &PageRequest::first(BOARD_LIMIT))
                .map_err(|error| error.to_string())?;
            page.rows
                .iter()
                .map(|found| {
                    let item = centraid_apps_locker::queries::ItemRow::of(found);
                    let mut extra = vec![("type", item.item_type.clone())];
                    if let Some(username) = item.username.clone() {
                        extra.push(("username", username));
                    }
                    if let Some(url) = item.url.clone() {
                        extra.push(("url", url));
                    }
                    if let Some(network) = item.network.clone() {
                        extra.push(("network", network));
                    }
                    // ABSENT means the password has never been rotated —
                    // `locker.add_item` stamps it only when the member says it
                    // has been. "Which logins have I never rotated" is that
                    // absence, and it is a fact about the row rather than a
                    // score the app computed.
                    // `password_set_at` is stamped at CREATION for any item
                    // that carries a password, and re-stamped only by a real
                    // change (a retag must not make a three-year-old password
                    // look fresh). So "never rotated" is the two stamps being
                    // equal — and an item with no password has neither.
                    if let Some(stamp) = item.password_set_at.clone() {
                        extra.push(("password_set_at", stamp));
                    }
                    if let Some(created) = item.created_at.clone() {
                        extra.push(("created_at", created));
                    }
                    row("locker.item", item.item_id, item.title, None, extra)
                })
                .collect()
        }
    })
}

#[cfg(test)]
mod tests;
