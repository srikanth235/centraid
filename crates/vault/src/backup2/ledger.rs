//! The ledger: what this device knows about its uploads, in
//! `<stem>.backup.db` beside the vault (#1080, "Ledger").
//!
//! Five tables, and every one is a cache of somebody else's truth:
//!
//! | Table | Whose truth |
//! |---|---|
//! | `destination` | the pairing: each gateway's addresses, pinned certificate, token and epoch |
//! | `queue` | the spool: each sealed part waiting to move, and how its last attempt went |
//! | `confirmed` | each gateway's `exists`: a name it acknowledged |
//! | `snapshot` | the snapshots this device took, with their manifests, and when each became the head |
//! | `meta` | small facts, among them the head this device last set at each gateway |
//!
//! **Acknowledgement is the `PUT`'s success** (#1080 ruling 7), recorded here
//! and reconciled against the gateway's own `exists` on every launch, so the
//! ledger cannot drift from what is held. It is device-local, never inside the
//! vault and never in a snapshot, and the shells exclude it from OS backup.
//! Losing it costs a re-pair and a reconcile, never a backup.
//!
//! The file carries `application_id = CBL1` so neither it nor a vault can be
//! opened as the other, and `user_version` counts this schema; a ledger a
//! newer build wrote is refused rather than guessed down.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use super::naming::{Digest, Name};
use super::{Result, invariant};

/// `CBL1`: a Centraid backup ledger.
pub const LEDGER_APPLICATION_ID: i64 = 0x4342_4c31;

/// The schema this build writes.
pub const LEDGER_VERSION: i64 = 1;

const SCHEMA: &str = "
CREATE TABLE destination (
  gateway_id   TEXT PRIMARY KEY,
  addrs        TEXT NOT NULL CHECK (json_valid(addrs) AND json_type(addrs) = 'array'),
  cert_der     BLOB NOT NULL,
  token        TEXT NOT NULL,
  epoch        INTEGER NOT NULL CHECK (epoch >= 0),
  label        TEXT NOT NULL,
  paired_at_ms INTEGER NOT NULL CHECK (paired_at_ms >= 0),
  last_seen_ms INTEGER CHECK (last_seen_ms IS NULL OR last_seen_ms >= 0),
  last_ack_ms  INTEGER CHECK (last_ack_ms IS NULL OR last_ack_ms >= 0)
) STRICT;

CREATE TABLE queue (
  name          TEXT PRIMARY KEY CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  part_path     TEXT NOT NULL,
  size          INTEGER NOT NULL CHECK (size >= 0),
  digest        TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  kind          TEXT NOT NULL CHECK (kind IN ('range', 'manifest', 'original', 'derivative')),
  created_ms    INTEGER NOT NULL CHECK (created_ms >= 0),
  handed_off_ms INTEGER CHECK (handed_off_ms IS NULL OR handed_off_ms >= 0),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    TEXT
) STRICT;

CREATE INDEX queue_in_order ON queue (created_ms, name);

CREATE TABLE confirmed (
  name         TEXT NOT NULL CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  gateway_id   TEXT NOT NULL REFERENCES destination(gateway_id) ON DELETE CASCADE,
  confirmed_ms INTEGER NOT NULL CHECK (confirmed_ms >= 0),
  size         INTEGER NOT NULL CHECK (size >= 0),
  PRIMARY KEY (name, gateway_id)
) STRICT;

CREATE INDEX confirmed_by_gateway ON confirmed (gateway_id);

CREATE TABLE snapshot (
  name          TEXT PRIMARY KEY CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  taken_at_ms   INTEGER NOT NULL CHECK (taken_at_ms >= 0),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  acked_ms      INTEGER CHECK (acked_ms IS NULL OR acked_ms >= 0)
) STRICT;

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) STRICT;
";

/// One paired gateway.
#[derive(Clone, PartialEq, Eq)]
pub struct Destination {
    pub gateway_id: String,
    /// The last addresses it was reachable at, so a background upload needs no
    /// browse.
    pub addrs: Vec<String>,
    /// The certificate it minted at first `serve`, pinned by byte equality.
    pub cert_der: Vec<u8>,
    /// The bearer token `pair` minted. Never printed.
    pub token: String,
    /// The writer epoch the token was minted at.
    pub epoch: u64,
    pub label: String,
    pub paired_at_ms: u64,
    pub last_seen_ms: Option<u64>,
    pub last_ack_ms: Option<u64>,
}

impl std::fmt::Debug for Destination {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Destination")
            .field("gateway_id", &self.gateway_id)
            .field("addrs", &self.addrs)
            .field("cert_der_bytes", &self.cert_der.len())
            .field("token", &"<redacted>")
            .field("epoch", &self.epoch)
            .field("label", &self.label)
            .field("paired_at_ms", &self.paired_at_ms)
            .field("last_seen_ms", &self.last_seen_ms)
            .field("last_ack_ms", &self.last_ack_ms)
            .finish()
    }
}

/// What a queued part is, which decides when it may move.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PartKind {
    /// A 4 MiB range of a snapshot.
    Range,
    /// A snapshot's manifest.
    Manifest,
    /// A part of an original.
    Original,
    /// A thumbnail, a preview or a poster.
    Derivative,
}

impl PartKind {
    /// The spelling the `queue.kind` CHECK names.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Range => "range",
            Self::Manifest => "manifest",
            Self::Original => "original",
            Self::Derivative => "derivative",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "range" => Self::Range,
            "manifest" => Self::Manifest,
            "original" => Self::Original,
            "derivative" => Self::Derivative,
            _ => return None,
        })
    }
}

/// One sealed part in the spool, waiting to move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Queued {
    pub name: Name,
    pub part_path: PathBuf,
    pub size: u64,
    pub digest: Digest,
    pub kind: PartKind,
    pub created_ms: u64,
    /// When it was handed to the OS to move, on a platform that does.
    pub handed_off_ms: Option<u64>,
    pub attempts: u32,
    pub last_error: Option<String>,
}

/// One snapshot this device took.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LedgerSnapshot {
    /// Its manifest's name.
    pub name: Name,
    pub taken_at_ms: u64,
    pub manifest_json: String,
    /// When the head was set to it, at the destination it was moved to.
    pub acked_ms: Option<u64>,
}

/// The ledger file and its one connection.
pub struct Ledger {
    connection: Connection,
    path: PathBuf,
}

fn ms(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| invariant(format!("{value} ms does not fit the ledger")))
}

fn read_ms(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn read_name(text: &str) -> rusqlite::Result<Name> {
    Name::from_hex(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn read_digest(text: &str) -> rusqlite::Result<Digest> {
    Digest::from_hex(text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

impl Ledger {
    /// `<stem>.backup.db` beside the vault file.
    #[must_use]
    pub fn path_for(vault_path: &Path) -> PathBuf {
        vault_path.with_extension("backup.db")
    }

    /// Open the ledger, creating it when absent.
    ///
    /// # Errors
    /// A file that is not a ledger, one a newer build wrote, or SQLite's
    /// refusal.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&path)?;
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;

        let application_id: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        match (application_id, version) {
            (0, 0) => {
                connection.execute_batch("BEGIN IMMEDIATE")?;
                let created = connection
                    .execute_batch(SCHEMA)
                    .and_then(|()| {
                        connection.pragma_update(None, "application_id", LEDGER_APPLICATION_ID)
                    })
                    .and_then(|()| connection.pragma_update(None, "user_version", LEDGER_VERSION));
                if let Err(error) = created {
                    let _ = connection.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                connection.execute_batch("COMMIT")?;
            }
            (LEDGER_APPLICATION_ID, LEDGER_VERSION) => {}
            (LEDGER_APPLICATION_ID, found) if found > LEDGER_VERSION => {
                return Err(invariant(format!(
                    "{} is a ledger at version {found}; this build writes {LEDGER_VERSION}",
                    path.display()
                )));
            }
            (found, _) => {
                return Err(invariant(format!(
                    "{} is not a backup ledger: application_id {found:#010x}",
                    path.display()
                )));
            }
        }
        Ok(Self { connection, path })
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Forget everything, in one transaction. The pairing goes too: a reset
    /// ledger is a device that has never paired.
    ///
    /// # Errors
    /// SQLite's refusal; nothing is deleted then.
    pub fn reset(&self) -> Result<()> {
        self.connection.execute_batch(
            "BEGIN IMMEDIATE;
             DELETE FROM confirmed;
             DELETE FROM queue;
             DELETE FROM snapshot;
             DELETE FROM meta;
             DELETE FROM destination;
             COMMIT;",
        )?;
        Ok(())
    }

    // ─── destinations ───────────────────────────────────────────────────────

    /// Record a pairing, replacing any earlier one with the same gateway.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn put_destination(&self, destination: &Destination) -> Result<()> {
        let addrs = serde_json::to_string(&destination.addrs)
            .map_err(|error| invariant(format!("the address list: {error}")))?;
        self.connection.execute(
            "INSERT INTO destination
               (gateway_id, addrs, cert_der, token, epoch, label, paired_at_ms,
                last_seen_ms, last_ack_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (gateway_id) DO UPDATE SET
               addrs = excluded.addrs, cert_der = excluded.cert_der,
               token = excluded.token, epoch = excluded.epoch,
               label = excluded.label, paired_at_ms = excluded.paired_at_ms,
               last_seen_ms = excluded.last_seen_ms, last_ack_ms = excluded.last_ack_ms",
            params![
                destination.gateway_id,
                addrs,
                destination.cert_der,
                destination.token,
                ms(destination.epoch)?,
                destination.label,
                ms(destination.paired_at_ms)?,
                destination.last_seen_ms.map(ms).transpose()?,
                destination.last_ack_ms.map(ms).transpose()?,
            ],
        )?;
        Ok(())
    }

    /// Every paired gateway, in the order they were paired.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn destinations(&self) -> Result<Vec<Destination>> {
        let mut statement = self.connection.prepare(
            "SELECT gateway_id, addrs, cert_der, token, epoch, label, paired_at_ms,
                    last_seen_ms, last_ack_ms
               FROM destination ORDER BY paired_at_ms, gateway_id",
        )?;
        let rows = statement.query_map([], |row| {
            let addrs: String = row.get(1)?;
            Ok(Destination {
                gateway_id: row.get(0)?,
                addrs: serde_json::from_str(&addrs).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        1,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?,
                cert_der: row.get(2)?,
                token: row.get(3)?,
                epoch: read_ms(row.get(4)?)?,
                label: row.get(5)?,
                paired_at_ms: read_ms(row.get(6)?)?,
                last_seen_ms: row.get::<_, Option<i64>>(7)?.map(read_ms).transpose()?,
                last_ack_ms: row.get::<_, Option<i64>>(8)?.map(read_ms).transpose()?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// One paired gateway.
    ///
    /// # Errors
    /// As [`Self::destinations`].
    pub fn destination(&self, gateway_id: &str) -> Result<Option<Destination>> {
        Ok(self
            .destinations()?
            .into_iter()
            .find(|destination| destination.gateway_id == gateway_id))
    }

    /// Unpair a gateway; its confirmations go with it.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn remove_destination(&self, gateway_id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM destination WHERE gateway_id = ?1",
            params![gateway_id],
        )?;
        self.connection.execute(
            "DELETE FROM meta WHERE k = ?1",
            params![head_key(gateway_id)],
        )?;
        Ok(())
    }

    /// The gateway answered at `now_ms`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn touch_seen(&self, gateway_id: &str, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE destination SET last_seen_ms = ?2 WHERE gateway_id = ?1",
            params![gateway_id, ms(now_ms)?],
        )?;
        Ok(())
    }

    // ─── the queue ──────────────────────────────────────────────────────────

    /// Queue a sealed part. Queuing a name again replaces it: a re-sealed part
    /// has a new digest and a fresh count of attempts.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn enqueue(&self, queued: &Queued) -> Result<()> {
        self.connection.execute(
            "INSERT INTO queue
               (name, part_path, size, digest, kind, created_ms, handed_off_ms,
                attempts, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (name) DO UPDATE SET
               part_path = excluded.part_path, size = excluded.size,
               digest = excluded.digest, kind = excluded.kind,
               created_ms = excluded.created_ms,
               handed_off_ms = excluded.handed_off_ms,
               attempts = excluded.attempts, last_error = excluded.last_error",
            params![
                queued.name.to_hex(),
                queued.part_path.to_string_lossy(),
                ms(queued.size)?,
                queued.digest.to_hex(),
                queued.kind.as_str(),
                ms(queued.created_ms)?,
                queued.handed_off_ms.map(ms).transpose()?,
                i64::from(queued.attempts),
                queued.last_error,
            ],
        )?;
        Ok(())
    }

    /// Every queued part, oldest first.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn queued(&self) -> Result<Vec<Queued>> {
        let mut statement = self.connection.prepare(
            "SELECT name, part_path, size, digest, kind, created_ms, handed_off_ms,
                    attempts, last_error
               FROM queue ORDER BY created_ms, name",
        )?;
        let rows = statement.query_map([], |row| {
            let kind: String = row.get(4)?;
            Ok(Queued {
                name: read_name(&row.get::<_, String>(0)?)?,
                part_path: PathBuf::from(row.get::<_, String>(1)?),
                size: read_ms(row.get(2)?)?,
                digest: read_digest(&row.get::<_, String>(3)?)?,
                kind: PartKind::parse(&kind).ok_or_else(|| {
                    rusqlite::Error::InvalidColumnType(4, kind.clone(), rusqlite::types::Type::Text)
                })?,
                created_ms: read_ms(row.get(5)?)?,
                handed_off_ms: row.get::<_, Option<i64>>(6)?.map(read_ms).transpose()?,
                attempts: u32::try_from(row.get::<_, i64>(7)?).unwrap_or(u32::MAX),
                last_error: row.get(8)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The bytes the queue is waiting to move.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn queued_bytes(&self) -> Result<u64> {
        let total: i64 =
            self.connection
                .query_row("SELECT coalesce(sum(size), 0) FROM queue", [], |row| {
                    row.get(0)
                })?;
        Ok(u64::try_from(total).unwrap_or(0))
    }

    /// The part moved, or will be re-sealed: it leaves the queue.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn dequeue(&self, name: &Name) -> Result<()> {
        self.connection
            .execute("DELETE FROM queue WHERE name = ?1", params![name.to_hex()])?;
        Ok(())
    }

    /// An attempt to move the part failed, and why.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn record_attempt(&self, name: &Name, error: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE queue SET attempts = attempts + 1, last_error = ?2 WHERE name = ?1",
            params![name.to_hex(), error],
        )?;
        Ok(())
    }

    /// The part was handed to the OS to move.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn hand_off(&self, name: &Name, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE queue SET handed_off_ms = ?2 WHERE name = ?1",
            params![name.to_hex(), ms(now_ms)?],
        )?;
        Ok(())
    }

    // ─── confirmations ──────────────────────────────────────────────────────

    /// `gateway_id` acknowledged `name` at `now_ms`.
    ///
    /// # Errors
    /// SQLite's refusal, including a gateway that is not paired.
    pub fn confirm(&self, name: &Name, gateway_id: &str, now_ms: u64, size: u64) -> Result<()> {
        self.connection.execute(
            "INSERT INTO confirmed (name, gateway_id, confirmed_ms, size)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (name, gateway_id) DO UPDATE SET
               confirmed_ms = excluded.confirmed_ms, size = excluded.size",
            params![name.to_hex(), gateway_id, ms(now_ms)?, ms(size)?],
        )?;
        self.connection.execute(
            "UPDATE destination SET last_ack_ms = ?2 WHERE gateway_id = ?1",
            params![gateway_id, ms(now_ms)?],
        )?;
        Ok(())
    }

    /// `gateway_id` no longer holds `name`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn unconfirm(&self, name: &Name, gateway_id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM confirmed WHERE name = ?1 AND gateway_id = ?2",
            params![name.to_hex(), gateway_id],
        )?;
        Ok(())
    }

    /// Every name `gateway_id` acknowledged.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn confirmed_names(&self, gateway_id: &str) -> Result<BTreeSet<Name>> {
        let mut statement = self
            .connection
            .prepare("SELECT name FROM confirmed WHERE gateway_id = ?1")?;
        let rows = statement.query_map(params![gateway_id], |row| {
            read_name(&row.get::<_, String>(0)?)
        })?;
        Ok(rows.collect::<rusqlite::Result<BTreeSet<_>>>()?)
    }

    /// Whether `gateway_id` acknowledged `name`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn is_confirmed(&self, name: &Name, gateway_id: &str) -> Result<bool> {
        Ok(self
            .connection
            .query_row(
                "SELECT 1 FROM confirmed WHERE name = ?1 AND gateway_id = ?2",
                params![name.to_hex(), gateway_id],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    // ─── snapshots ──────────────────────────────────────────────────────────

    /// Record a snapshot this device took.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn record_snapshot(
        &self,
        name: &Name,
        taken_at_ms: u64,
        manifest_json: &str,
    ) -> Result<()> {
        self.connection.execute(
            "INSERT INTO snapshot (name, taken_at_ms, manifest_json) VALUES (?1, ?2, ?3)
             ON CONFLICT (name) DO NOTHING",
            params![name.to_hex(), ms(taken_at_ms)?, manifest_json],
        )?;
        Ok(())
    }

    /// The head was set to the snapshot `name` at `now_ms`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn ack_snapshot(&self, name: &Name, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE snapshot SET acked_ms = ?2 WHERE name = ?1",
            params![name.to_hex(), ms(now_ms)?],
        )?;
        Ok(())
    }

    /// Every snapshot this device took, oldest first.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn snapshots(&self) -> Result<Vec<LedgerSnapshot>> {
        let mut statement = self.connection.prepare(
            "SELECT name, taken_at_ms, manifest_json, acked_ms
               FROM snapshot ORDER BY taken_at_ms, name",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(LedgerSnapshot {
                name: read_name(&row.get::<_, String>(0)?)?,
                taken_at_ms: read_ms(row.get(1)?)?,
                manifest_json: row.get(2)?,
                acked_ms: row.get::<_, Option<i64>>(3)?.map(read_ms).transpose()?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Forget a snapshot retention dropped.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn forget_snapshot(&self, name: &Name) -> Result<()> {
        self.connection.execute(
            "DELETE FROM snapshot WHERE name = ?1",
            params![name.to_hex()],
        )?;
        Ok(())
    }

    // ─── meta ───────────────────────────────────────────────────────────────

    /// One small fact.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn meta(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .connection
            .query_row("SELECT v FROM meta WHERE k = ?1", params![key], |row| {
                row.get(0)
            })
            .optional()?)
    }

    /// Set one small fact.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO meta (k, v) VALUES (?1, ?2)
             ON CONFLICT (k) DO UPDATE SET v = excluded.v",
            params![key, value],
        )?;
        Ok(())
    }

    /// The manifest this device last set as the head at `gateway_id`: the
    /// `prev` of its next compare-and-set.
    ///
    /// # Errors
    /// SQLite's refusal, or a value that is not a name.
    pub fn head(&self, gateway_id: &str) -> Result<Option<Name>> {
        self.meta(&head_key(gateway_id))?
            .map(|text| Name::from_hex(&text).map_err(Into::into))
            .transpose()
    }

    /// Record the head this device just set at `gateway_id`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_head(&self, gateway_id: &str, name: &Name) -> Result<()> {
        self.set_meta(&head_key(gateway_id), &name.to_hex())
    }
}

fn head_key(gateway_id: &str) -> String {
    format!("head:{gateway_id}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup2::naming::PlaintextHash;

    fn name_of(label: &str) -> Name {
        Name::from_bytes(*PlaintextHash::of(label.as_bytes()).as_bytes())
    }

    fn destination(gateway_id: &str) -> Destination {
        Destination {
            gateway_id: gateway_id.to_owned(),
            addrs: vec!["192.168.1.20:7443".to_owned()],
            cert_der: vec![0x30, 0x82],
            token: "a".repeat(64),
            epoch: 1,
            label: "The laptop".to_owned(),
            paired_at_ms: 1_000,
            last_seen_ms: None,
            last_ack_ms: None,
        }
    }

    fn queued(label: &str, created_ms: u64) -> Queued {
        Queued {
            name: name_of(label),
            part_path: PathBuf::from(format!("/spool/{label}")),
            size: 4_096,
            digest: Digest::of(label.as_bytes()),
            kind: PartKind::Range,
            created_ms,
            handed_off_ms: None,
            attempts: 0,
            last_error: None,
        }
    }

    #[test]
    fn the_ledger_sits_beside_the_vault_and_reopens() {
        let dir = tempfile::tempdir().expect("a directory");
        let path = Ledger::path_for(&dir.path().join("vault.db"));
        assert_eq!(path, dir.path().join("vault.backup.db"));
        {
            let ledger = Ledger::open(&path).expect("creates");
            ledger.put_destination(&destination("gw")).expect("pairs");
        }
        let ledger = Ledger::open(&path).expect("reopens");
        assert_eq!(
            ledger.destinations().expect("reads"),
            vec![destination("gw")]
        );
        let printed = format!("{:?}", ledger.destination("gw").expect("reads"));
        assert!(
            !printed.contains(&"a".repeat(64)),
            "the token is never printed"
        );
    }

    #[test]
    fn a_file_that_is_not_this_ledger_is_refused() {
        let dir = tempfile::tempdir().expect("a directory");
        let vault = crate::Vault::create(dir.path().join("vault.db")).expect("a vault");
        vault.close().expect("closes");
        assert!(Ledger::open(dir.path().join("vault.db")).is_err());

        let newer = dir.path().join("newer.backup.db");
        Ledger::open(&newer).expect("creates");
        let connection = Connection::open(&newer).expect("opens");
        connection
            .pragma_update(None, "user_version", LEDGER_VERSION + 1)
            .expect("stamps");
        drop(connection);
        assert!(Ledger::open(&newer).is_err(), "never guessed down");
    }

    #[test]
    fn the_queue_is_in_order_and_requeuing_replaces() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("creates");
        ledger.enqueue(&queued("second", 20)).expect("queues");
        ledger.enqueue(&queued("first", 10)).expect("queues");
        let names: Vec<Name> = ledger
            .queued()
            .expect("reads")
            .iter()
            .map(|q| q.name)
            .collect();
        assert_eq!(names, vec![name_of("first"), name_of("second")]);
        assert_eq!(ledger.queued_bytes().expect("sums"), 8_192);

        ledger
            .record_attempt(&name_of("first"), "unreachable")
            .expect("records");
        ledger.hand_off(&name_of("first"), 30).expect("records");
        let first = &ledger.queued().expect("reads")[0];
        assert_eq!(first.attempts, 1);
        assert_eq!(first.last_error.as_deref(), Some("unreachable"));
        assert_eq!(first.handed_off_ms, Some(30));

        let mut resealed = queued("first", 40);
        resealed.digest = Digest::of(b"a new seal");
        ledger.enqueue(&resealed).expect("requeues");
        let names: Vec<Name> = ledger
            .queued()
            .expect("reads")
            .iter()
            .map(|q| q.name)
            .collect();
        assert_eq!(names, vec![name_of("second"), name_of("first")]);
        assert_eq!(ledger.queued().expect("reads")[1].attempts, 0);
        ledger.dequeue(&name_of("first")).expect("dequeues");
        assert_eq!(ledger.queued().expect("reads").len(), 1);
    }

    #[test]
    fn confirmations_belong_to_a_paired_gateway_and_leave_with_it() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("creates");
        assert!(
            ledger.confirm(&name_of("a"), "nobody", 1, 1).is_err(),
            "a confirmation from an unpaired gateway is refused"
        );
        ledger.put_destination(&destination("gw")).expect("pairs");
        ledger
            .confirm(&name_of("a"), "gw", 50, 10)
            .expect("confirms");
        ledger
            .confirm(&name_of("b"), "gw", 60, 10)
            .expect("confirms");
        assert!(ledger.is_confirmed(&name_of("a"), "gw").expect("asks"));
        assert_eq!(ledger.confirmed_names("gw").expect("reads").len(), 2);
        assert_eq!(
            ledger
                .destination("gw")
                .expect("reads")
                .and_then(|d| d.last_ack_ms),
            Some(60)
        );
        ledger.unconfirm(&name_of("a"), "gw").expect("unconfirms");
        assert!(!ledger.is_confirmed(&name_of("a"), "gw").expect("asks"));
        ledger.set_head("gw", &name_of("m")).expect("records");
        assert_eq!(ledger.head("gw").expect("reads"), Some(name_of("m")));
        ledger.remove_destination("gw").expect("unpairs");
        assert!(ledger.confirmed_names("gw").expect("reads").is_empty());
        assert_eq!(ledger.head("gw").expect("reads"), None);
    }

    #[test]
    fn snapshots_are_recorded_acked_and_forgotten_and_reset_forgets_all() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("creates");
        ledger
            .record_snapshot(&name_of("m1"), 100, "{\"v\":2}")
            .expect("records");
        ledger
            .record_snapshot(&name_of("m2"), 200, "{\"v\":2}")
            .expect("records");
        assert!(
            ledger
                .record_snapshot(&name_of("m3"), 300, "not json")
                .is_err()
        );
        ledger.ack_snapshot(&name_of("m2"), 250).expect("acks");
        let snapshots = ledger.snapshots().expect("reads");
        assert_eq!(snapshots.len(), 2);
        assert_eq!(snapshots[1].acked_ms, Some(250));
        ledger.forget_snapshot(&name_of("m1")).expect("forgets");
        assert_eq!(ledger.snapshots().expect("reads").len(), 1);

        ledger.put_destination(&destination("gw")).expect("pairs");
        ledger.enqueue(&queued("q", 1)).expect("queues");
        ledger.set_meta("k", "v").expect("sets");
        ledger.reset().expect("resets");
        assert!(ledger.snapshots().expect("reads").is_empty());
        assert!(ledger.queued().expect("reads").is_empty());
        assert!(ledger.destinations().expect("reads").is_empty());
        assert_eq!(ledger.meta("k").expect("reads"), None);
    }
}
