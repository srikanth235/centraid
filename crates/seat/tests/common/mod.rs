//! A founded gateway vault plus a real seat file cut from its snapshot.
//!
//! `dead_code` is allowed for the reason the vault crate's helper gives: each
//! integration test is its own binary and compiles this whole module, so a
//! helper used by one and not another is dead in one binary and live in the
//! next.
#![allow(dead_code)]

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use centraid_vault::clock::{FixedClock, SeededIds};
use centraid_vault::{Vault, log};

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

    /// Cut a snapshot and open it as a seat, `seat_state` and all.
    ///
    /// The snapshot BUILDER is what makes the copy, not a file copy: a
    /// hand-rolled copy would prove convergence for a file no seat ever holds.
    pub fn bootstrap_seat(&self, name: &str) -> Seat {
        let snapshot_dir = self.join(&format!("{name}-snap"));
        let head = centraid_vault::build_snapshot(&self.vault, &snapshot_dir)
            .expect("the snapshot builds");
        let path = self.join(&format!("{name}.db"));
        inflate_gz(&snapshot_dir.join(&head.name), &path);
        let connection = rusqlite::Connection::open(&path).expect("the copy opens");
        let (epoch, floor): (String, i64) = connection
            .query_row(
                "SELECT epoch, floor_seq FROM replica_meta WHERE singleton = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the copy carries its position");
        assert_eq!(floor, head.seq, "the log went, the cursor stayed");
        let state = centraid_seat::init_seat_state(
            &connection,
            &centraid_seat::SeatPosition {
                vault_id: head.vault_id.clone(),
                epoch: epoch.clone(),
                schema_epoch: head.schema_epoch,
                ddl_version: log::constants().ddl_version,
                applied_seq: floor,
                // A bootstrapped seat knows its seq and not the commit that
                // seq belonged to: the snapshot deleted the log it could read
                // that from. Zero is the honest answer, and an overlay that
                // clears against it clears against nothing.
                applied_commit_seq: 0,
            },
            "2026-01-01T00:00:00.000Z",
        )
        .expect("the seat state initialises");
        Seat {
            path,
            connection,
            epoch,
            floor,
            schema_epoch: state.schema_epoch,
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

fn inflate_gz(source: &Path, target: &Path) {
    let bytes = std::fs::read(source).expect("the artifact reads");
    let mut decoder = flate2::read::GzDecoder::new(&bytes[..]);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).expect("it inflates");
    std::fs::write(target, out).expect("the copy writes");
}
