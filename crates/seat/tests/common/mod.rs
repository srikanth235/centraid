//! A founded gateway vault plus a real seat file cut from its snapshot.
//!
//! `dead_code` is allowed for the reason the vault crate's helper gives: each
//! integration test is its own binary and compiles this whole module, so a
//! helper used by one and not another is dead in one binary and live in the
//! next.
#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::Arc;

use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::{Vault, log};

/// The seat's own DDL, leaked once so the snapshot builder can take a
/// `&'static str`. One leak per test binary, of a string that lives as long as
/// the process would have kept it anyway.
static SEAT_DDL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

/// A gateway and, once [`Harness::bootstrap_seat`] has run, a seat beside it.
pub struct Harness {
    dir: PathBuf,
    pub vault: Vault,
    pub clock: Arc<FixedClock>,
}

impl Harness {
    /// A founded vault on a deterministic clock and id sequence.
    pub fn founded(seed: &str) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        let clock = Arc::new(FixedClock::frozen());
        let vault = Vault::create_with(
            dir.join("vault.db"),
            Box::new(Arc::clone(&clock)),
            Box::new(SeededIds::new(seed)),
        )
        .expect("a vault is created");
        vault.found("Test", "Test Owner").expect("it is founded");
        Self { dir, vault, clock }
    }

    #[must_use]
    pub fn join(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Cut a REPLICA-SHAPED snapshot and adopt it as a seat (#1025 S7, item 3).
    ///
    /// The snapshot BUILDER is what makes the copy and `adopt_replica` is what
    /// turns it into a replica — not a file copy and not a hand-rolled
    /// `init_seat_state`: a harness that built its seat by other means would
    /// prove convergence for a file no phone ever holds.
    pub fn bootstrap_seat(&self, name: &str) -> Seat {
        let snapshot_dir = self.join(&format!("{name}-snap"));
        let head = centraid_vault::build_replica_snapshot(
            &self.vault,
            &snapshot_dir,
            SEAT_DDL.get_or_init(|| centraid_seat::seat_own_ddl().leak()),
        )
        .expect("the snapshot builds");
        let path = self.join(&format!("{name}.db"));
        // ADOPTED, which on a phone is a hard link out of the byte store. A
        // copy here, because the artifact is also what the next test cuts.
        std::fs::copy(snapshot_dir.join(&head.name), &path).expect("the artifact lands");
        let adopted = centraid_seat::adopt_replica(
            &path,
            None,
            &head.vault_id,
            head.seq,
            log::constants().ddl_version,
            None,
            "2026-01-01T00:00:00.000Z",
        )
        .expect("the artifact is adopted");
        let connection = rusqlite::Connection::open(&path).expect("the copy opens");
        let floor: i64 = connection
            .query_row(
                "SELECT floor_seq FROM replica_meta WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .expect("the copy carries its position");
        assert_eq!(floor, head.seq, "the log went, the cursor stayed");
        let epoch = adopted.epoch.clone();
        Seat {
            path,
            connection,
            epoch,
            floor,
            schema_epoch: head.schema_epoch,
        }
    }

    /// Run one scripted commit, as the `contracts/applier` fixtures declare
    /// them.
    pub fn run_commit(&self, commit: &serde_json::Value) -> Option<i64> {
        let producer = commit["producer"].as_str().unwrap_or("script").to_owned();
        let statements: Vec<String> = commit["statements"]
            .as_array()
            .expect("a commit declares statements")
            .iter()
            .map(|statement| statement.as_str().expect("a statement is text").to_owned())
            .collect();
        self.vault
            .commit(|tx| {
                tx.set_producer(&producer);
                for statement in &statements {
                    tx.connection().execute_batch(statement)?;
                }
                Ok(())
            })
            .unwrap_or_else(|error| panic!("`{}`: {error}", commit["label"]))
            .commit_seq
    }

    /// One page of the log from `since`, through the real door.
    pub fn page(&self, since: i64, epoch: &str, limit: i64) -> log::LogPage {
        log::read_log_page(
            &self.vault,
            &log::Cursor {
                epoch: epoch.to_owned(),
                seq: since,
            },
            limit,
        )
        .expect("the page serves")
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A seat file, open.
pub struct Seat {
    pub path: PathBuf,
    pub connection: rusqlite::Connection,
    pub epoch: String,
    /// The seq the snapshot was cut at.
    pub floor: i64,
    pub schema_epoch: i64,
}

impl Seat {
    /// A page header for this seat's epoch.
    #[must_use]
    pub fn header(&self, watermark: i64) -> centraid_seat::applier::PageHeader {
        centraid_seat::applier::PageHeader {
            epoch: self.epoch.clone(),
            schema_epoch: self.schema_epoch,
            ddl_version: log::constants().ddl_version,
            watermark,
        }
    }

    /// Close and reopen the file, which is what a process restart is.
    pub fn reopen(self) -> Self {
        let Self {
            path,
            connection,
            epoch,
            floor,
            schema_epoch,
        } = self;
        drop(connection);
        let connection = rusqlite::Connection::open(&path).expect("the seat reopens");
        Self {
            path,
            connection,
            epoch,
            floor,
            schema_epoch,
        }
    }
}

/// Every row of every replicated table the file carries, as comparable values.
///
/// Ordered by the whole projection, so two files holding the same rows in a
/// different physical order compare equal — the claim is about VALUES, not
/// about page layout.
pub fn replicated_state(
    connection: &rusqlite::Connection,
) -> std::collections::BTreeMap<String, Vec<String>> {
    let mut statement = connection
        .prepare(
            r"SELECT name FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\'
                ORDER BY name",
        )
        .expect("the query prepares");
    let tables: Vec<String> = statement
        .query_map([], |row| row.get(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<Vec<_>>>()
        .expect("the names read");

    let mut state = std::collections::BTreeMap::new();
    for table in tables {
        if !centraid_ontology::registries::is_replicated_table(&table) {
            continue;
        }
        let columns = log::table_columns(connection, &table).expect("columns read");
        let projection = columns
            .iter()
            .map(|column| log::quoted(column))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {projection} FROM {} ORDER BY {projection}",
            log::quoted(&table)
        );
        let mut statement = connection.prepare(&sql).expect("the query prepares");
        let rows: Vec<String> = statement
            .query_map([], |row| {
                let mut image = centraid_vault::RowImage::new();
                for (index, column) in columns.iter().enumerate() {
                    image.insert(
                        column.clone(),
                        centraid_vault::Value::from_ref(row.get_ref(index)?)
                            .expect("a value reads"),
                    );
                }
                Ok(centraid_vault::value::row_image_to_json(&image))
            })
            .expect("the query runs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("the rows read");
        state.insert(table, rows);
    }
    state
}

/// One of the `contracts/applier` fixtures.
pub fn fixture(name: &str) -> serde_json::Value {
    let path = centraid_ontology::golden::repo_root()
        .join("contracts/applier")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is committed: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is JSON: {error}", path.display()))
}

/// One scripted commit, for a test that writes its own statements.
pub fn commit(label: &str, statements: &[&str]) -> serde_json::Value {
    serde_json::json!({
        "label": label,
        "producer": format!("test.{label}"),
        "statements": statements,
    })
}

/// A queued intent, for a test that needs one in the outbox.
pub fn intent(id: &str) -> centraid_seat::IntentRecord {
    centraid_seat::IntentRecord {
        intent_id: id.to_owned(),
        created_order: 0,
        app_id: "notes".to_owned(),
        action: "edit".to_owned(),
        input: serde_json::json!({ "title": id }),
        payload_hash: "a".repeat(64),
        state: centraid_seat::IntentState::Queued,
        attempts: 0,
        depends_on: Vec::new(),
        base_versions: Vec::new(),
        optimistic: Some(serde_json::json!({ "core_party": { id: { "display_name": id } } })),
        commit_seq: None,
        waiting_on: Vec::new(),
        needs_blobs: Vec::new(),
        enqueued_at: "2026-01-01T00:00:00.000Z".to_owned(),
        updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
        reason: None,
        conflicts: Vec::new(),
        online_only: false,
    }
}
