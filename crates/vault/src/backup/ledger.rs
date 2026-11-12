//! The ledger: what this device knows about its uploads, in
//! `<stem>.backup.db` beside the vault (#1080, "Ledger").
//!
//! Six tables, and every one is a cache of somebody else's truth:
//!
//! | Table | Whose truth |
//! |---|---|
//! | `destination` | the pairing: each gateway's addresses, pinned certificate, token and epoch |
//! | `queue` | the spool: each sealed part waiting to move, and how its last attempt went |
//! | `confirmed` | each gateway's `exists`: a name it acknowledged |
//! | `snapshot` | the snapshots this device took, with their manifests, and when each became the head |
//! | `local_bytes` | the operating system's library and the app's store: where each hash's bytes are on this device |
//! | `meta` | small facts, among them the head this device last set at each gateway |
//!
//! `local_bytes` is what lets the phone keep no second copy of what the
//! library holds (#1080 ruling 6): an original streamed from the library is
//! recorded here under the library's own identifier and never written to the
//! store, and the byte door answers a read of it with that identifier for the
//! shell to resolve. It is device-local twice over — an identifier means
//! nothing on another phone — which is why it is a ledger table and never a
//! vault row. `edited` marks a library item the member edited in the library
//! itself: the phone backs up the rendition it was handed, so such an item is
//! never offered for deletion from the library (the root's ruling A20).
//!
//! A queued part carries the media type of the file it belongs to, so a pass
//! can hold a video's original back from a metered link even after it was
//! sealed on an unmetered one, and can tell the operating system as much when
//! it hands the part over (the root's ruling A10).
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

use super::naming::{Digest, Name, PlaintextHash};
use super::{Result, invariant};

/// `CBL1`: a Centraid backup ledger.
pub const LEDGER_APPLICATION_ID: i64 = 0x4342_4c31;

/// The schema this build writes.
pub const LEDGER_VERSION: i64 = 2;

/// The largest part (sealed bytes as recorded) the everyday read-back sample reads whole into
/// memory; a confirmed part above it is only ever read back by the streamed read-back, one
/// per gateway per pass ([`Ledger::oldest_verified_large`]). Written into the `confirmed_large`
/// index, so the two stay one number.
pub const SAMPLE_MAX_BYTES: u64 = 1 << 20;

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
  media_type    TEXT CHECK ((kind IN ('original', 'derivative')) = (media_type IS NOT NULL)),
  created_ms    INTEGER NOT NULL CHECK (created_ms >= 0),
  handed_off_ms INTEGER CHECK (handed_off_ms IS NULL OR handed_off_ms >= 0),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    TEXT
) STRICT;

CREATE INDEX queue_in_order ON queue (kind = 'manifest', created_ms, name);

CREATE TABLE confirmed (
  name         TEXT NOT NULL CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  gateway_id   TEXT NOT NULL REFERENCES destination(gateway_id) ON DELETE CASCADE,
  confirmed_ms INTEGER NOT NULL CHECK (confirmed_ms >= 0),
  size         INTEGER NOT NULL CHECK (size >= 0),
  verified_ms  INTEGER CHECK (verified_ms IS NULL OR verified_ms >= 0),
  PRIMARY KEY (name, gateway_id)
) STRICT;

CREATE INDEX confirmed_by_gateway ON confirmed (gateway_id);
CREATE INDEX confirmed_large ON confirmed (gateway_id, verified_ms, name) WHERE size > 1048576;

CREATE TABLE snapshot (
  name          TEXT PRIMARY KEY CHECK (length(name) = 64 AND name NOT GLOB '*[^0-9a-f]*'),
  taken_at_ms   INTEGER NOT NULL CHECK (taken_at_ms >= 0),
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  acked_ms      INTEGER CHECK (acked_ms IS NULL OR acked_ms >= 0)
) STRICT;

CREATE TABLE local_bytes (
  hash        TEXT PRIMARY KEY CHECK (length(hash) = 64 AND hash NOT GLOB '*[^0-9a-f]*'),
  source      TEXT NOT NULL CHECK (source IN ('os', 'store')),
  ref         TEXT CHECK ((source = 'os') = (ref IS NOT NULL AND ref <> '')),
  verified_ms INTEGER CHECK (verified_ms IS NULL OR verified_ms >= 0),
  edited      INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1) AND (edited = 0 OR source = 'os'))
) STRICT;

CREATE TABLE meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
) STRICT;
";

/// Version 2 adds when a confirmed part was last read back from its gateway
/// (`confirmed.verified_ms`), which is what lets the read-back of large parts cover every
/// original over time. One transaction: a failure leaves a version 1 ledger.
fn migrate_1_to_2(connection: &Connection) -> Result<()> {
    let transaction = connection.unchecked_transaction()?;
    transaction.execute_batch(
        "ALTER TABLE confirmed ADD COLUMN verified_ms INTEGER
           CHECK (verified_ms IS NULL OR verified_ms >= 0);
         CREATE INDEX confirmed_large ON confirmed (gateway_id, verified_ms, name) WHERE size > 1048576;",
    )?;
    transaction.pragma_update(None, "user_version", 2)?;
    transaction.commit()?;
    Ok(())
}

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
    /// A 64 KiB range of a snapshot.
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
    /// The media type of the file an original's or a derivative's part
    /// belongs to; `None` for a range and a manifest, which are the vault's.
    pub media_type: Option<String>,
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

/// Where a hash's bytes are kept on this device (`local_bytes.source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalSource {
    /// The operating system's library, under [`LocalBytes::os_ref`].
    Os,
    /// The app's own content store.
    Store,
}

impl LocalSource {
    /// The spelling the `local_bytes.source` CHECK names.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Os => "os",
            Self::Store => "store",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "os" => Self::Os,
            "store" => Self::Store,
            _ => return None,
        })
    }
}

/// One row of `local_bytes`: where a hash's bytes are on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBytes {
    pub hash: PlaintextHash,
    pub source: LocalSource,
    /// The library's own identifier for the item, for [`LocalSource::Os`]
    /// only: the shell resolves it, and it means nothing on another phone.
    pub os_ref: Option<String>,
    /// When this device last read the bytes and found they hash to `hash`.
    pub verified_ms: Option<u64>,
    /// The member edited the item in the library: the bytes backed up are its
    /// current rendition, not the camera's original, so it is never offered
    /// for deletion from the library (A20). Only a library row is edited.
    pub edited: bool,
}

impl Queued {
    /// The part belongs to a moving image: an original or a derivative whose
    /// media type is a video's.
    #[must_use]
    pub fn is_video(&self) -> bool {
        self.media_type
            .as_deref()
            .is_some_and(|media_type| media_type.trim().to_ascii_lowercase().starts_with("video/"))
    }
}

/// The ledger file and its one connection.
pub struct Ledger {
    connection: Connection,
    path: PathBuf,
    /// Commits this connection has made, so a test can assert on how many syncs a batch cost
    /// (counts, never durations).
    commits: std::sync::Arc<std::sync::atomic::AtomicU64>,
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
        let mut connection = Connection::open(&path)?;
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
            (LEDGER_APPLICATION_ID, 1) => migrate_1_to_2(&connection)?,
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
        let commits = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let counted = std::sync::Arc::clone(&commits);
        connection.commit_hook(Some(move || {
            counted.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            false
        }))?;
        Ok(Self {
            connection,
            path,
            commits,
        })
    }

    /// How many transactions this connection has committed (an autocommit statement is one).
    /// What a test reads to prove a batch cost one sync and not one per part.
    #[must_use]
    pub fn commit_count(&self) -> u64 {
        self.commits.load(std::sync::atomic::Ordering::Relaxed)
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
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute_batch(
            "DELETE FROM confirmed;
             DELETE FROM queue;
             DELETE FROM snapshot;
             DELETE FROM local_bytes;
             DELETE FROM meta;
             DELETE FROM destination;",
        )?;
        transaction.commit()?;
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

    /// Unpair a gateway: its row, its confirmations and every fact kept about it (its head, the
    /// high-water mark, a rolled-back or moved or refused mark, the counts of parts it refused)
    /// go in ONE transaction, so a gateway paired again starts clean and never inherits an old
    /// rolled-back flag. The queue is untouched here — a pairing that is replaced (a claim)
    /// calls this and puts the row back; [`Self::sweep_unowed`] clears what nobody owes.
    ///
    /// # Errors
    /// SQLite's refusal; nothing is deleted then.
    pub fn remove_destination(&self, gateway_id: &str) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM destination WHERE gateway_id = ?1",
            params![gateway_id],
        )?;
        transaction.execute(
            "DELETE FROM meta WHERE k IN (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                head_key(gateway_id),
                moved_key(gateway_id),
                head_taken_key(gateway_id),
                head_acked_key(gateway_id),
                unauthorized_key(gateway_id),
                highwater_key(gateway_id),
                rolled_back_key(gateway_id),
            ],
        )?;
        let prefix = mismatch_prefix(gateway_id);
        transaction.execute(
            "DELETE FROM meta WHERE substr(k, 1, ?2) = ?1",
            params![prefix, i64::try_from(prefix.len()).unwrap_or(0)],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// With no gateway paired, nothing in the queue is owed to anyone: delete every queue
    /// row, answering the names that left. Does nothing while any gateway is paired. The
    /// caller removes the spool files ([`super::mover::sweep_unowed`] does both).
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn sweep_unowed(&self) -> Result<Vec<Name>> {
        let transaction = self.connection.unchecked_transaction()?;
        let paired: bool =
            transaction.query_row("SELECT EXISTS (SELECT 1 FROM destination)", [], |row| {
                row.get(0)
            })?;
        let mut swept = Vec::new();
        if !paired {
            let mut statement = transaction.prepare("SELECT name FROM queue")?;
            let rows = statement.query_map([], |row| read_name(&row.get::<_, String>(0)?))?;
            for row in rows {
                swept.push(row?);
            }
            drop(statement);
            transaction.execute("DELETE FROM queue", [])?;
        }
        transaction.commit()?;
        Ok(swept)
    }

    /// `gateway_id` answered `UNAUTHORIZED` to this device's token: it no
    /// longer knows it — its store was lost or its operator revoked the token
    /// — so nothing reaches it until the member pairs again (#1080, the
    /// sweep's F2). A `meta` fact, not a column: the ledger's schema is
    /// untouched.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_unauthorized(&self, gateway_id: &str) -> Result<()> {
        self.set_meta(&unauthorized_key(gateway_id), "1")
    }

    /// Whether `gateway_id` last refused this device's token.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn unauthorized(&self, gateway_id: &str) -> Result<bool> {
        Ok(self.meta(&unauthorized_key(gateway_id))?.is_some())
    }

    /// `gateway_id` accepted this device's token: the mark is spent.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn clear_unauthorized(&self, gateway_id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM meta WHERE k = ?1",
            params![unauthorized_key(gateway_id)],
        )?;
        Ok(())
    }

    /// `gateway_id` answered `MOVED`: a writer at `epoch` holds the vault
    /// there now, and this device's writes to it are refused.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_moved(&self, gateway_id: &str, epoch: u64) -> Result<()> {
        self.set_meta(&moved_key(gateway_id), &epoch.to_string())
    }

    /// The epoch that superseded this device at `gateway_id`, when one did.
    ///
    /// # Errors
    /// SQLite's refusal, or a value that is not a number.
    pub fn moved(&self, gateway_id: &str) -> Result<Option<u64>> {
        self.meta(&moved_key(gateway_id))?
            .map(|text| {
                text.parse::<u64>()
                    .map_err(|_| invariant(format!("`{text}` is not an epoch")))
            })
            .transpose()
    }

    /// This device holds the writer epoch at `gateway_id` again: a pairing or
    /// a restore claimed it.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn clear_moved(&self, gateway_id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM meta WHERE k = ?1",
            params![moved_key(gateway_id)],
        )?;
        Ok(())
    }

    /// Replace the addresses a paired gateway is dialled at, keeping its
    /// certificate, token and everything it acknowledged. Whether the ledger
    /// held the gateway.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_destination_addrs(&self, gateway_id: &str, addrs: &[String]) -> Result<bool> {
        let addrs = serde_json::to_string(addrs)
            .map_err(|error| invariant(format!("the address list: {error}")))?;
        let changed = self.connection.execute(
            "UPDATE destination SET addrs = ?2 WHERE gateway_id = ?1",
            params![gateway_id, addrs],
        )?;
        Ok(changed > 0)
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
        self.connection.execute(ENQUEUE, enqueue_params(queued)?)?;
        Ok(())
    }

    /// Every queued part in the order it moves: oldest first, and every
    /// manifest after every other part, so a manifest never reaches a
    /// destination ahead of a range it names.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn queued(&self) -> Result<Vec<Queued>> {
        let mut statement = self.connection.prepare(&format!(
            "{QUEUE_SELECT} ORDER BY kind = 'manifest', created_ms, name"
        ))?;
        let rows = statement.query_map([], read_queued)?;
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

    /// The OS did not move a part it was handed: it goes back to waiting,
    /// with `error` recorded as the attempt's outcome. Answers whether the
    /// queue held the part at all.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn requeue(&self, name: &Name, error: &str) -> Result<bool> {
        let changed = self.connection.execute(
            "UPDATE queue SET handed_off_ms = NULL, attempts = attempts + 1, last_error = ?2
              WHERE name = ?1",
            params![name.to_hex(), error],
        )?;
        Ok(changed > 0)
    }

    /// The part is no longer with the operating system: another gateway still
    /// owes it, so the next hand-off may carry it there. Not an attempt.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn unhand(&self, name: &Name) -> Result<()> {
        self.connection.execute(
            "UPDATE queue SET handed_off_ms = NULL WHERE name = ?1",
            params![name.to_hex()],
        )?;
        Ok(())
    }

    /// Several parts are no longer with the operating system: one transaction, as
    /// [`Self::unhand`] says for each.
    ///
    /// # Errors
    /// SQLite's refusal; nothing changes then.
    pub fn unhand_many(&self, names: &[Name]) -> Result<()> {
        if names.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement =
                transaction.prepare("UPDATE queue SET handed_off_ms = NULL WHERE name = ?1")?;
            for name in names {
                statement.execute(params![name.to_hex()])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// The paired gateways that do not hold `name`, in pairing order, leaving out one a
    /// newer writer superseded (it takes nothing from this phone). Every gateway is a full
    /// replica (#1188, B1): a part is owed to each of these until it is acknowledged or the
    /// wait for it ends.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn owing(&self, name: &Name) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT d.gateway_id FROM destination d
              WHERE NOT EXISTS (SELECT 1 FROM confirmed c
                                 WHERE c.name = ?1 AND c.gateway_id = d.gateway_id)
                AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.k = ?2 || d.gateway_id)
              ORDER BY d.paired_at_ms, d.gateway_id",
        )?;
        let rows = statement.query_map(params![name.to_hex(), MOVED_PREFIX], |row| {
            row.get::<_, String>(0)
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The part `name` as queued, when it is: one keyed lookup, never a scan of the queue.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn queued_part(&self, name: &Name) -> Result<Option<Queued>> {
        Ok(self
            .connection
            .query_row(
                &format!("{QUEUE_SELECT} WHERE name = ?1"),
                params![name.to_hex()],
                read_queued,
            )
            .optional()?)
    }

    /// Whether the queue holds `name`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn is_queued(&self, name: &Name) -> Result<bool> {
        Ok(self
            .connection
            .query_row(
                "SELECT 1 FROM queue WHERE name = ?1",
                params![name.to_hex()],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// The queued parts `gateway_id` does not hold, in the order they move: what a pass to
    /// that gateway sends. The filter is the database's (`NOT EXISTS` over the `confirmed`
    /// key), so a name the gateway holds is never materialised.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn queued_unconfirmed(&self, gateway_id: &str) -> Result<Vec<Queued>> {
        let mut statement = self.connection.prepare(&format!(
            "{QUEUE_SELECT} AS q
              WHERE NOT EXISTS (SELECT 1 FROM confirmed c
                                 WHERE c.name = q.name AND c.gateway_id = ?1)
              ORDER BY q.kind = 'manifest', q.created_ms, q.name"
        ))?;
        let rows = statement.query_map(params![gateway_id], read_queued)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The queued parts some paired gateway holds that no operating-system hand-off carries
    /// and that were queued at or before `created_by_ms` (`None`: any time): the candidates
    /// for ending the wait for the gateways that do not hold them.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn queued_held_anywhere(&self, created_by_ms: Option<u64>) -> Result<Vec<Queued>> {
        let mut statement = self.connection.prepare(&format!(
            "{QUEUE_SELECT} AS q
              WHERE q.handed_off_ms IS NULL AND q.created_ms <= ?1
                AND EXISTS (SELECT 1 FROM confirmed c WHERE c.name = q.name)
              ORDER BY q.kind = 'manifest', q.created_ms, q.name"
        ))?;
        let bound = created_by_ms.map_or(Ok(i64::MAX), ms)?;
        let rows = statement.query_map(params![bound], read_queued)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// Several parts leave the queue: one transaction.
    ///
    /// # Errors
    /// SQLite's refusal; nothing is dequeued then.
    pub fn dequeue_many(&self, names: &[Name]) -> Result<()> {
        if names.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare("DELETE FROM queue WHERE name = ?1")?;
            for name in names {
                statement.execute(params![name.to_hex()])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// Queue several sealed parts: one transaction, as [`Self::enqueue`] says for each.
    ///
    /// # Errors
    /// SQLite's refusal; nothing is queued then.
    pub fn enqueue_many(&self, parts: &[Queued]) -> Result<()> {
        if parts.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(ENQUEUE)?;
            for queued in parts {
                statement.execute(enqueue_params(queued)?)?;
            }
        }
        transaction.commit()?;
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

    /// `gateway_id` holds every one of `names`, as its own `exists` answered:
    /// one transaction, so a snapshot's hundreds of unchanged ranges cost one
    /// sync and not one each. `size` is what the caller knows of each — the
    /// plaintext length the manifest names, for a name nobody sent from here.
    ///
    /// # Errors
    /// SQLite's refusal, including a gateway that is not paired; nothing is
    /// recorded then.
    pub fn confirm_many(&self, names: &[(Name, u64)], gateway_id: &str, now_ms: u64) -> Result<()> {
        if names.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO confirmed (name, gateway_id, confirmed_ms, size)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (name, gateway_id) DO UPDATE SET
                   confirmed_ms = excluded.confirmed_ms, size = excluded.size",
            )?;
            for (name, size) in names {
                statement.execute(params![name.to_hex(), gateway_id, ms(now_ms)?, ms(*size)?])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    /// `gateway_id` acknowledged every one of `parts` (name and sealed size) at `now_ms`, as
    /// [`Self::confirm`] says for one: one transaction for the batch, so a bundle's answer costs
    /// one sync and not several per part. Each name's count of `DIGEST_MISMATCH` answers from
    /// this gateway is cleared with it.
    ///
    /// # Errors
    /// SQLite's refusal, including a gateway that is not paired; nothing is recorded then.
    pub fn acknowledge_many(
        &self,
        parts: &[(Name, u64)],
        gateway_id: &str,
        now_ms: u64,
    ) -> Result<()> {
        if parts.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut confirm = transaction.prepare(
                "INSERT INTO confirmed (name, gateway_id, confirmed_ms, size)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (name, gateway_id) DO UPDATE SET
                   confirmed_ms = excluded.confirmed_ms, size = excluded.size",
            )?;
            let mut forgive = transaction.prepare("DELETE FROM meta WHERE k = ?1")?;
            let prefix = mismatch_prefix(gateway_id);
            for (name, size) in parts {
                confirm.execute(params![name.to_hex(), gateway_id, ms(now_ms)?, ms(*size)?])?;
                forgive.execute(params![format!("{prefix}{}", name.to_hex())])?;
            }
        }
        transaction.execute(
            "UPDATE destination SET last_ack_ms = ?2 WHERE gateway_id = ?1",
            params![gateway_id, ms(now_ms)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// `gateway_id` answered `DIGEST_MISMATCH` to `name`: one more in a row. Answers the count
    /// now. An acknowledgement of the name from that gateway ([`Self::acknowledge_many`])
    /// clears it.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn count_mismatch(&self, name: &Name, gateway_id: &str) -> Result<u32> {
        let count: i64 = self.connection.query_row(
            "INSERT INTO meta (k, v) VALUES (?1, '1')
             ON CONFLICT (k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)
             RETURNING CAST(v AS INTEGER)",
            params![format!("{}{}", mismatch_prefix(gateway_id), name.to_hex())],
            |row| row.get(0),
        )?;
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    /// How many answers of `DIGEST_MISMATCH` in a row `gateway_id` gave for `name`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn mismatches(&self, name: &Name, gateway_id: &str) -> Result<u32> {
        Ok(self
            .meta(&format!("{}{}", mismatch_prefix(gateway_id), name.to_hex()))?
            .and_then(|text| text.parse::<u32>().ok())
            .unwrap_or(0))
    }

    /// The confirmed part above [`SAMPLE_MAX_BYTES`] that `gateway_id` was least recently read
    /// back for — one never read back first, by name — with its recorded size. Over the passes
    /// every large part comes up. Planned through `confirmed_large`.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn oldest_verified_large(&self, gateway_id: &str) -> Result<Option<(Name, u64)>> {
        Ok(self
            .connection
            .query_row(
                "SELECT name, size FROM confirmed
                  WHERE gateway_id = ?1 AND size > 1048576
                  ORDER BY verified_ms, name LIMIT 1",
                params![gateway_id],
                |row| Ok((read_name(&row.get::<_, String>(0)?)?, read_ms(row.get(1)?)?)),
            )
            .optional()?)
    }

    /// `name` was read back from `gateway_id` at `now_ms` and opened.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn mark_verified(&self, name: &Name, gateway_id: &str, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE confirmed SET verified_ms = ?3 WHERE name = ?1 AND gateway_id = ?2",
            params![name.to_hex(), gateway_id, ms(now_ms)?],
        )?;
        Ok(())
    }

    /// Which of `names` `gateway_id` has not acknowledged, in the order given: one keyed
    /// lookup per name on the primary key, never the gateway's whole set.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn unconfirmed_among(
        &self,
        names: impl IntoIterator<Item = Name>,
        gateway_id: &str,
    ) -> Result<Vec<Name>> {
        let mut statement = self
            .connection
            .prepare("SELECT 1 FROM confirmed WHERE name = ?1 AND gateway_id = ?2")?;
        let mut out = Vec::new();
        for name in names {
            if !statement.exists(params![name.to_hex(), gateway_id])? {
                out.push(name);
            }
        }
        Ok(out)
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

    /// `gateway_id` no longer holds any of `names`: one transaction, as
    /// [`Self::confirm_many`] is.
    ///
    /// # Errors
    /// SQLite's refusal; nothing is changed then.
    pub fn unconfirm_many(&self, names: &[Name], gateway_id: &str) -> Result<()> {
        if names.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.unchecked_transaction()?;
        {
            let mut statement =
                transaction.prepare("DELETE FROM confirmed WHERE name = ?1 AND gateway_id = ?2")?;
            for name in names {
                statement.execute(params![name.to_hex(), gateway_id])?;
            }
        }
        transaction.commit()?;
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

    /// Every name any paired gateway acknowledged.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn confirmed_anywhere(&self) -> Result<BTreeSet<Name>> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT name FROM confirmed")?;
        let rows = statement.query_map([], |row| read_name(&row.get::<_, String>(0)?))?;
        Ok(rows.collect::<rusqlite::Result<BTreeSet<_>>>()?)
    }

    /// The bytes `gateway_id` acknowledged, as each acknowledgement recorded
    /// them: what "Holds 5.1 GB" says (#1144).
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn held_bytes(&self, gateway_id: &str) -> Result<u64> {
        let total: i64 = self.connection.query_row(
            "SELECT coalesce(sum(size), 0) FROM confirmed WHERE gateway_id = ?1",
            params![gateway_id],
            |row| row.get(0),
        )?;
        Ok(u64::try_from(total).unwrap_or(0))
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

    /// Whether this device took the snapshot `name`: one keyed lookup.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn has_snapshot(&self, name: &Name) -> Result<bool> {
        Ok(self
            .connection
            .query_row(
                "SELECT 1 FROM snapshot WHERE name = ?1",
                params![name.to_hex()],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// The head at `gateway_id` is now the snapshot `name`, taken at `taken_at_ms`, and the
    /// ledger says so in ONE transaction: the head, when it was taken, the high-water mark
    /// (which only rises), the rolled-back mark cleared, and the snapshot's acknowledgement at
    /// `now_ms`. A crash leaves all of it or none.
    ///
    /// # Errors
    /// SQLite's refusal, or a value that is not a time; nothing is recorded then.
    pub fn record_head_set(
        &self,
        gateway_id: &str,
        name: &Name,
        taken_at_ms: u64,
        now_ms: u64,
    ) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        let upsert = "INSERT INTO meta (k, v) VALUES (?1, ?2)
                      ON CONFLICT (k) DO UPDATE SET v = excluded.v";
        transaction.execute(upsert, params![head_key(gateway_id), name.to_hex()])?;
        transaction.execute(
            upsert,
            params![head_taken_key(gateway_id), taken_at_ms.to_string()],
        )?;
        // Only ever up: kept when the stored mark is higher.
        transaction.execute(
            "INSERT INTO meta (k, v) VALUES (?1, ?2)
             ON CONFLICT (k) DO UPDATE SET v = excluded.v
              WHERE CAST(excluded.v AS INTEGER) > CAST(v AS INTEGER)",
            params![highwater_key(gateway_id), taken_at_ms.to_string()],
        )?;
        transaction.execute(
            "DELETE FROM meta WHERE k = ?1",
            params![rolled_back_key(gateway_id)],
        )?;
        transaction.execute(
            "UPDATE snapshot SET acked_ms = ?2 WHERE name = ?1",
            params![name.to_hex(), ms(now_ms)?],
        )?;
        transaction.commit()?;
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

    // ─── local bytes ────────────────────────────────────────────────────────

    /// Record where a hash's bytes are on this device, replacing whatever was
    /// recorded for it.
    ///
    /// # Errors
    /// A library row with no identifier, or a store row with one — the
    /// `local_bytes` CHECK refuses both, and this says so before SQLite does —
    /// or SQLite's refusal.
    pub fn put_local(&self, local: &LocalBytes) -> Result<()> {
        let identified = local.os_ref.as_deref().is_some_and(|text| !text.is_empty());
        if local.edited && local.source != LocalSource::Os {
            return Err(invariant(format!(
                "a `{}` row for {} cannot be an edited library item",
                local.source.as_str(),
                local.hash
            )));
        }
        if identified != (local.source == LocalSource::Os) {
            return Err(invariant(format!(
                "a `{}` row for {} {} an identifier",
                local.source.as_str(),
                local.hash,
                if identified {
                    "may not carry"
                } else {
                    "must carry"
                }
            )));
        }
        self.connection.execute(
            "INSERT INTO local_bytes (hash, source, ref, verified_ms, edited)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (hash) DO UPDATE SET
               source = excluded.source, ref = excluded.ref,
               verified_ms = excluded.verified_ms, edited = excluded.edited",
            params![
                local.hash.to_hex(),
                local.source.as_str(),
                local.os_ref,
                local.verified_ms.map(ms).transpose()?,
                i64::from(local.edited),
            ],
        )?;
        Ok(())
    }

    /// Where a hash's bytes are on this device, as recorded. `None` is no
    /// record, which a reader takes as "ask the store".
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn local(&self, hash: &PlaintextHash) -> Result<Option<LocalBytes>> {
        Ok(self
            .connection
            .query_row(
                "SELECT hash, source, ref, verified_ms, edited FROM local_bytes WHERE hash = ?1",
                params![hash.to_hex()],
                read_local,
            )
            .optional()?)
    }

    /// Every recorded hash, in hash order.
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn locals(&self) -> Result<Vec<LocalBytes>> {
        let mut statement = self.connection.prepare(
            "SELECT hash, source, ref, verified_ms, edited FROM local_bytes ORDER BY hash",
        )?;
        let rows = statement.query_map([], read_local)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The bytes left this device: forget where they were.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn forget_local(&self, hash: &PlaintextHash) -> Result<()> {
        self.connection.execute(
            "DELETE FROM local_bytes WHERE hash = ?1",
            params![hash.to_hex()],
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

    /// Every small fact whose key starts with `prefix`, as `(key, value)`, by
    /// key. The garbage list keeps one per name it is holding back.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn meta_with_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let mut statement = self
            .connection
            .prepare("SELECT k, v FROM meta WHERE substr(k, 1, ?2) = ?1 ORDER BY k")?;
        let rows = statement
            .query_map(
                params![prefix, i64::try_from(prefix.len()).unwrap_or(0)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Forget one small fact.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn forget_meta(&self, key: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM meta WHERE k = ?1", params![key])?;
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

    /// When the snapshot `gateway_id`'s head names was taken, on the vault's clock: the moment
    /// the records at that gateway are current as of. Set with the head.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_head_taken(&self, gateway_id: &str, taken_at_ms: u64) -> Result<()> {
        self.set_meta(&head_taken_key(gateway_id), &taken_at_ms.to_string())
    }

    /// When the snapshot `gateway_id`'s head names was taken; `None` for a gateway this phone
    /// has set no head at.
    ///
    /// # Errors
    /// SQLite's refusal, or a value that is not a number.
    pub fn head_taken(&self, gateway_id: &str) -> Result<Option<u64>> {
        self.meta(&head_taken_key(gateway_id))?
            .map(|text| {
                text.parse::<u64>()
                    .map_err(|_| invariant(format!("`{text}` is not a time")))
            })
            .transpose()
    }

    /// The newest snapshot this device has ever set as the head at `gateway_id`, by the
    /// moment it was taken: the **high-water mark** a head that goes backwards is judged
    /// against (#1188, B4). It only rises.
    ///
    /// # Errors
    /// SQLite's refusal, or a value that is not a number.
    pub fn highwater(&self, gateway_id: &str) -> Result<Option<u64>> {
        self.meta(&highwater_key(gateway_id))?
            .map(|text| {
                text.parse::<u64>()
                    .map_err(|_| invariant(format!("`{text}` is not a time")))
            })
            .transpose()
    }

    /// Raise the high-water mark at `gateway_id` to `taken_at_ms` when it is higher.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn raise_highwater(&self, gateway_id: &str, taken_at_ms: u64) -> Result<()> {
        if self
            .highwater(gateway_id)?
            .is_none_or(|held| taken_at_ms > held)
        {
            self.set_meta(&highwater_key(gateway_id), &taken_at_ms.to_string())?;
        }
        Ok(())
    }

    /// `gateway_id`'s head went backwards: it names an older snapshot than this device set,
    /// or none. Kept until this device sets a head there again.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_rolled_back(&self, gateway_id: &str, rolled_back: bool) -> Result<()> {
        let key = rolled_back_key(gateway_id);
        if rolled_back {
            self.set_meta(&key, "1")
        } else {
            self.forget_meta(&key)
        }
    }

    /// Whether `gateway_id`'s head was found to have gone backwards.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn rolled_back(&self, gateway_id: &str) -> Result<bool> {
        Ok(self.meta(&rolled_back_key(gateway_id))?.is_some())
    }

    /// Up to `limit` of the parts `gateway_id` acknowledged that are at most `max_size` bytes
    /// sealed-side (as recorded), chosen at random: what a pass reads back to see the
    /// gateway still holds what it said it did (#1188, B4).
    ///
    /// # Errors
    /// SQLite's refusal, or a row this build cannot read.
    pub fn confirmed_sample(
        &self,
        gateway_id: &str,
        max_size: u64,
        limit: usize,
    ) -> Result<Vec<Name>> {
        let mut statement = self.connection.prepare(
            "SELECT name FROM confirmed WHERE gateway_id = ?1 AND size <= ?2
              ORDER BY random() LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                gateway_id,
                ms(max_size)?,
                i64::try_from(limit).unwrap_or(i64::MAX)
            ],
            |row| read_name(&row.get::<_, String>(0)?),
        )?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// `gateway_id` moved the head to a snapshot this device took, at
    /// `gateway_ms` on the GATEWAY's clock — the only moment a member may be
    /// shown as "last backed up" (#1029 §2).
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_head_acked(&self, gateway_id: &str, gateway_ms: u64) -> Result<()> {
        self.set_meta(&head_acked_key(gateway_id), &gateway_ms.to_string())
    }

    /// When `gateway_id` last moved the head for this device, on its own
    /// clock.
    ///
    /// # Errors
    /// SQLite's refusal, or a value that is not a number.
    pub fn head_acked(&self, gateway_id: &str) -> Result<Option<u64>> {
        self.meta(&head_acked_key(gateway_id))?
            .map(|text| {
                text.parse::<u64>()
                    .map_err(|_| invariant(format!("`{text}` is not a time")))
            })
            .transpose()
    }
}

const QUEUE_SELECT: &str = "SELECT name, part_path, size, digest, kind, media_type, created_ms,
                    handed_off_ms, attempts, last_error FROM queue";

const ENQUEUE: &str = "INSERT INTO queue
               (name, part_path, size, digest, kind, media_type, created_ms,
                handed_off_ms, attempts, last_error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (name) DO UPDATE SET
               part_path = excluded.part_path, size = excluded.size,
               digest = excluded.digest, kind = excluded.kind,
               media_type = excluded.media_type,
               created_ms = excluded.created_ms,
               handed_off_ms = excluded.handed_off_ms,
               attempts = excluded.attempts, last_error = excluded.last_error";

fn enqueue_params(queued: &Queued) -> Result<[Box<dyn rusqlite::ToSql>; 10]> {
    Ok([
        Box::new(queued.name.to_hex()),
        Box::new(queued.part_path.to_string_lossy().into_owned()),
        Box::new(ms(queued.size)?),
        Box::new(queued.digest.to_hex()),
        Box::new(queued.kind.as_str()),
        Box::new(queued.media_type.clone()),
        Box::new(ms(queued.created_ms)?),
        Box::new(queued.handed_off_ms.map(ms).transpose()?),
        Box::new(i64::from(queued.attempts)),
        Box::new(queued.last_error.clone()),
    ])
}

fn read_queued(row: &rusqlite::Row<'_>) -> rusqlite::Result<Queued> {
    let kind: String = row.get(4)?;
    Ok(Queued {
        name: read_name(&row.get::<_, String>(0)?)?,
        part_path: PathBuf::from(row.get::<_, String>(1)?),
        size: read_ms(row.get(2)?)?,
        digest: read_digest(&row.get::<_, String>(3)?)?,
        kind: PartKind::parse(&kind).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(4, kind.clone(), rusqlite::types::Type::Text)
        })?,
        media_type: row.get(5)?,
        created_ms: read_ms(row.get(6)?)?,
        handed_off_ms: row.get::<_, Option<i64>>(7)?.map(read_ms).transpose()?,
        attempts: u32::try_from(row.get::<_, i64>(8)?).unwrap_or(u32::MAX),
        last_error: row.get(9)?,
    })
}

const MOVED_PREFIX: &str = "moved:";

fn highwater_key(gateway_id: &str) -> String {
    format!("highwater:{gateway_id}")
}

fn rolled_back_key(gateway_id: &str) -> String {
    format!("rolled-back:{gateway_id}")
}

/// The prefix of the counts of parts `gateway_id` answered `DIGEST_MISMATCH` to.
fn mismatch_prefix(gateway_id: &str) -> String {
    format!("mismatch:{gateway_id}:")
}

fn head_key(gateway_id: &str) -> String {
    format!("head:{gateway_id}")
}

fn moved_key(gateway_id: &str) -> String {
    format!("{MOVED_PREFIX}{gateway_id}")
}

fn head_taken_key(gateway_id: &str) -> String {
    format!("head-taken:{gateway_id}")
}

fn head_acked_key(gateway_id: &str) -> String {
    format!("head-acked:{gateway_id}")
}

fn unauthorized_key(gateway_id: &str) -> String {
    format!("unauthorized:{gateway_id}")
}

fn read_local(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalBytes> {
    let hash: String = row.get(0)?;
    let source: String = row.get(1)?;
    Ok(LocalBytes {
        hash: PlaintextHash::from_hex(&hash).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        source: LocalSource::parse(&source).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(1, source.clone(), rusqlite::types::Type::Text)
        })?,
        os_ref: row.get(2)?,
        verified_ms: row.get::<_, Option<i64>>(3)?.map(read_ms).transpose()?,
        edited: row.get::<_, i64>(4)? != 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::naming::PlaintextHash;

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

    fn library_item(label: &str, os_ref: &str) -> LocalBytes {
        LocalBytes {
            hash: PlaintextHash::of(label.as_bytes()),
            source: LocalSource::Os,
            os_ref: Some(os_ref.to_owned()),
            verified_ms: Some(7),
            edited: false,
        }
    }

    fn queued(label: &str, created_ms: u64) -> Queued {
        Queued {
            name: name_of(label),
            part_path: PathBuf::from(format!("/spool/{label}")),
            size: 4_096,
            digest: Digest::of(label.as_bytes()),
            kind: PartKind::Range,
            media_type: None,
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
    fn a_destinations_addresses_change_and_nothing_else_does() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("creates");
        ledger.put_destination(&destination("gw")).expect("pairs");
        ledger.touch_seen("gw", 5_000).expect("seen");
        let moved = vec![
            "192.168.1.44:7443".to_owned(),
            "192.168.1.20:7443".to_owned(),
        ];
        assert!(ledger.set_destination_addrs("gw", &moved).expect("sets"));
        let after = ledger.destination("gw").expect("reads").expect("held");
        assert_eq!(after.addrs, moved);
        // THE CERTIFICATE, THE TOKEN AND WHEN IT WAS LAST SEEN ARE UNTOUCHED:
        // a new address is not a new pairing.
        let before = destination("gw");
        assert_eq!(after.cert_der, before.cert_der);
        assert_eq!(after.token, before.token);
        assert_eq!(after.epoch, before.epoch);
        assert_eq!(after.last_seen_ms, Some(5_000));
        // A GATEWAY THE LEDGER DOES NOT HOLD IS NOT CREATED BY THIS.
        assert!(!ledger.set_destination_addrs("other", &moved).expect("sets"));
        assert_eq!(ledger.destinations().expect("reads").len(), 1);
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
        let mut manifest = queued("manifest", 1);
        manifest.kind = PartKind::Manifest;
        ledger.enqueue(&manifest).expect("queues");
        ledger.enqueue(&queued("second", 20)).expect("queues");
        ledger.enqueue(&queued("first", 10)).expect("queues");
        let names: Vec<Name> = ledger
            .queued()
            .expect("reads")
            .iter()
            .map(|q| q.name)
            .collect();
        assert_eq!(
            names,
            vec![name_of("first"), name_of("second"), name_of("manifest")],
            "oldest first, and a manifest after the parts it names"
        );
        ledger.dequeue(&name_of("manifest")).expect("dequeues");
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

    /// **A GATEWAY THAT REFUSED THIS DEVICE'S TOKEN IS MARKED** (#1080, the
    /// sweep's F2), and the mark goes when the token is accepted again or the
    /// gateway is paired afresh: a pairing starts its record over.
    #[test]
    fn a_refused_token_is_marked_until_it_is_accepted_or_the_gateway_is_paired_again() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("creates");
        ledger.put_destination(&destination("gw")).expect("pairs");
        assert!(!ledger.unauthorized("gw").expect("reads"));
        ledger.set_unauthorized("gw").expect("marks");
        assert!(ledger.unauthorized("gw").expect("reads"));
        assert!(
            !ledger.unauthorized("other").expect("reads"),
            "the mark is one gateway's"
        );
        ledger.clear_unauthorized("gw").expect("clears");
        assert!(!ledger.unauthorized("gw").expect("reads"));
        ledger.set_unauthorized("gw").expect("marks");
        ledger.remove_destination("gw").expect("unpairs");
        assert!(
            !ledger.unauthorized("gw").expect("reads"),
            "a pairing starts the record over"
        );
    }

    #[test]
    fn small_facts_are_listed_by_prefix_and_forgotten_one_at_a_time() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("creates");
        ledger.set_meta("grave:b", "20").expect("sets");
        ledger.set_meta("grave:a", "10").expect("sets");
        ledger.set_meta("graveyard", "not a grave").expect("sets");
        ledger.set_meta("head:gw", "x").expect("sets");
        assert_eq!(
            ledger.meta_with_prefix("grave:").expect("lists"),
            vec![
                ("grave:a".to_owned(), "10".to_owned()),
                ("grave:b".to_owned(), "20".to_owned())
            ],
            "by key, and only what starts with the prefix"
        );
        ledger.forget_meta("grave:a").expect("forgets");
        ledger
            .forget_meta("grave:never")
            .expect("forgetting nothing is fine");
        assert_eq!(ledger.meta_with_prefix("grave:").expect("lists").len(), 1);
        assert_eq!(ledger.meta("head:gw").expect("reads"), Some("x".to_owned()));
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
        ledger
            .put_local(&library_item("photo", "library-item-1"))
            .expect("records");
        ledger.reset().expect("resets");
        assert!(ledger.locals().expect("reads").is_empty());
        assert!(ledger.snapshots().expect("reads").is_empty());
        assert!(ledger.queued().expect("reads").is_empty());
        assert!(ledger.destinations().expect("reads").is_empty());
        assert_eq!(ledger.meta("k").expect("reads"), None);
    }

    /// WHERE A HASH'S BYTES ARE ON THIS DEVICE (#1080 ruling 6): a library item
    /// carries the library's identifier and a store item carries none, and a
    /// row that says otherwise is refused by the ledger and by the table.
    #[test]
    fn local_bytes_say_where_a_hash_is_and_a_library_item_carries_its_identifier() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("creates");
        let photo = library_item("photo", "library-item-1");
        assert_eq!(ledger.local(&photo.hash).expect("reads"), None, "no record");
        ledger.put_local(&photo).expect("records");
        assert_eq!(
            ledger.local(&photo.hash).expect("reads"),
            Some(photo.clone())
        );

        // A library item copied into the store (an edit) is replaced, not
        // doubled: one hash, one answer.
        let edited = LocalBytes {
            source: LocalSource::Store,
            os_ref: None,
            verified_ms: Some(9),
            ..photo.clone()
        };
        ledger.put_local(&edited).expect("replaces");
        assert_eq!(ledger.local(&photo.hash).expect("reads"), Some(edited));
        let document = LocalBytes {
            hash: PlaintextHash::of(b"a document"),
            source: LocalSource::Store,
            os_ref: None,
            verified_ms: None,
            edited: false,
        };
        ledger.put_local(&document).expect("records");
        let mut hashes = vec![photo.hash, document.hash];
        hashes.sort();
        assert_eq!(
            ledger
                .locals()
                .expect("reads")
                .iter()
                .map(|local| local.hash)
                .collect::<Vec<_>>(),
            hashes,
            "in hash order"
        );
        ledger.forget_local(&photo.hash).expect("forgets");
        assert_eq!(ledger.local(&photo.hash).expect("reads"), None);

        // THE REFUSALS, in Rust and in the table.
        let anonymous = LocalBytes {
            os_ref: None,
            ..library_item("video", "unused")
        };
        assert!(
            ledger.put_local(&anonymous).is_err(),
            "a library item names itself"
        );
        let blank = LocalBytes {
            os_ref: Some(String::new()),
            ..library_item("video", "unused")
        };
        assert!(
            ledger.put_local(&blank).is_err(),
            "an empty identifier is none"
        );
        let stray = LocalBytes {
            source: LocalSource::Store,
            ..library_item("video", "library-item-2")
        };
        assert!(
            ledger.put_local(&stray).is_err(),
            "a store item has no identifier"
        );
        for (source, reference) in [
            ("os", None),
            ("os", Some("")),
            ("store", Some("x")),
            ("cloud", None),
        ] {
            assert!(
                ledger
                    .connection
                    .execute(
                        "INSERT INTO local_bytes (hash, source, ref) VALUES (?1, ?2, ?3)",
                        params![PlaintextHash::of(b"raw").to_hex(), source, reference],
                    )
                    .is_err(),
                "the table refuses source {source} with ref {reference:?}"
            );
        }
    }

    fn plan_of(ledger: &Ledger, sql: &str, binds: &[&dyn rusqlite::ToSql]) -> String {
        let mut statement = ledger
            .connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .expect("plans");
        let rows = statement
            .query_map(binds, |row| row.get::<_, String>(3))
            .expect("runs")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("rows");
        rows.join("\n")
    }

    /// **EVERY KEYED READ PLANS THROUGH AN INDEX** and none sorts after reading.
    #[test]
    fn the_keyed_reads_plan_through_an_index() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("opens");
        let hex = name_of("x").to_hex();
        let keyed: [(&str, String); 3] = [
            (
                "queue by name",
                plan_of(&ledger, &format!("{QUEUE_SELECT} WHERE name = ?1"), &[&hex]),
            ),
            (
                "is_queued",
                plan_of(&ledger, "SELECT 1 FROM queue WHERE name = ?1", &[&hex]),
            ),
            (
                "confirmed by key",
                plan_of(
                    &ledger,
                    "SELECT 1 FROM confirmed WHERE name = ?1 AND gateway_id = ?2",
                    &[&hex, &"gw"],
                ),
            ),
        ];
        for (what, plan) in &keyed {
            assert!(
                plan.contains("SEARCH"),
                "{what} must search an index: {plan}"
            );
            assert!(!plan.contains("SCAN"), "{what} must not scan: {plan}");
        }
        let large = plan_of(
            &ledger,
            "SELECT name, size FROM confirmed
              WHERE gateway_id = ?1 AND size > 1048576
              ORDER BY verified_ms, name LIMIT 1",
            &[&"gw"],
        );
        assert!(
            large.contains("confirmed_large"),
            "the partial index serves it: {large}"
        );
        assert!(
            !large.contains("TEMP B-TREE"),
            "no sort after the read: {large}"
        );
        let unconfirmed = plan_of(
            &ledger,
            &format!(
                "{QUEUE_SELECT} AS q WHERE NOT EXISTS (SELECT 1 FROM confirmed c
                   WHERE c.name = q.name AND c.gateway_id = ?1)
                 ORDER BY q.kind = 'manifest', q.created_ms, q.name"
            ),
            &[&"gw"],
        );
        assert!(
            unconfirmed.contains("SEARCH c USING COVERING INDEX"),
            "the confirmed lookup is keyed: {unconfirmed}"
        );
        assert!(!unconfirmed.contains("TEMP B-TREE"), "{unconfirmed}");
        let held = plan_of(
            &ledger,
            &format!(
                "{QUEUE_SELECT} AS q WHERE q.handed_off_ms IS NULL AND q.created_ms <= ?1
                   AND EXISTS (SELECT 1 FROM confirmed c WHERE c.name = q.name)"
            ),
            &[&0_i64],
        );
        assert!(
            held.contains("SEARCH c EXISTS USING COVERING INDEX"),
            "{held}"
        );
    }

    /// A version 1 ledger (before `verified_ms`) opens, gains the column and the index, and
    /// keeps its rows.
    #[test]
    fn a_version_1_ledger_migrates_in_place() {
        let dir = tempfile::tempdir().expect("a directory");
        let path = dir.path().join("old.backup.db");
        {
            let ledger = Ledger::open(&path).expect("creates");
            ledger.put_destination(&destination("gw")).expect("pairs");
            ledger
                .confirm(&name_of("kept"), "gw", 5, 9)
                .expect("confirms");
            // Put it back as version 1 wrote it.
            ledger
                .connection
                .execute_batch(
                    "DROP INDEX confirmed_large;
                     ALTER TABLE confirmed DROP COLUMN verified_ms;
                     PRAGMA user_version = 1;",
                )
                .expect("downgrades");
        }
        let ledger = Ledger::open(&path).expect("migrates");
        assert!(ledger.is_confirmed(&name_of("kept"), "gw").expect("asks"));
        ledger
            .mark_verified(&name_of("kept"), "gw", 77)
            .expect("the column is there");
        let version: i64 = ledger
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("reads");
        assert_eq!(version, LEDGER_VERSION);
    }

    /// **FORGET THEN PAIR AGAIN STARTS CLEAN:** nothing of the old pairing — a rolled-back flag,
    /// a high-water mark, a head, a moved or refused mark, a mismatch count, an
    /// acknowledgement — survives, and it all goes in one commit.
    #[test]
    fn forgetting_a_gateway_leaves_nothing_for_a_pairing_to_inherit() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("opens");
        let name = name_of("part");
        ledger.put_destination(&destination("gw")).expect("pairs");
        ledger
            .put_destination(&destination("other"))
            .expect("pairs");
        ledger.confirm(&name, "gw", 1, 4).expect("confirms");
        ledger.set_head("gw", &name).expect("head");
        ledger.set_head_taken("gw", 9).expect("taken");
        ledger.set_head_acked("gw", 9).expect("acked");
        ledger.raise_highwater("gw", 9).expect("high water");
        ledger.set_rolled_back("gw", true).expect("rolled back");
        ledger.set_moved("gw", 3).expect("moved");
        ledger.set_unauthorized("gw").expect("unauthorized");
        ledger.count_mismatch(&name, "gw").expect("counts");
        ledger
            .set_rolled_back("other", true)
            .expect("another's flag");
        let before = ledger.commit_count();
        ledger.remove_destination("gw").expect("forgets");
        assert_eq!(ledger.commit_count() - before, 1, "one transaction");
        ledger
            .put_destination(&destination("gw"))
            .expect("pairs again");
        assert!(!ledger.rolled_back("gw").expect("reads"));
        assert_eq!(ledger.highwater("gw").expect("reads"), None);
        assert_eq!(ledger.head("gw").expect("reads"), None);
        assert_eq!(ledger.head_taken("gw").expect("reads"), None);
        assert_eq!(ledger.head_acked("gw").expect("reads"), None);
        assert_eq!(ledger.moved("gw").expect("reads"), None);
        assert!(!ledger.unauthorized("gw").expect("reads"));
        assert_eq!(ledger.mismatches(&name, "gw").expect("reads"), 0);
        assert!(!ledger.is_confirmed(&name, "gw").expect("reads"));
        assert!(
            ledger.rolled_back("other").expect("reads"),
            "another gateway's facts are untouched"
        );
    }

    /// `reset` is one transaction and leaves the connection usable.
    #[test]
    fn reset_clears_everything_and_leaves_no_transaction_open() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("opens");
        ledger.put_destination(&destination("gw")).expect("pairs");
        ledger.enqueue(&queued("a", 1)).expect("queues");
        ledger.reset().expect("resets");
        assert!(ledger.destinations().expect("reads").is_empty());
        assert!(ledger.queued().expect("reads").is_empty());
        ledger.reset().expect("a second reset begins cleanly");
        assert!(ledger.connection.is_autocommit());
    }

    /// The head's facts are written in one commit, and the high-water mark only rises.
    #[test]
    fn a_head_set_is_one_commit_and_the_high_water_mark_only_rises() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("opens");
        ledger.put_destination(&destination("gw")).expect("pairs");
        let newer = name_of("newer");
        ledger.record_snapshot(&newer, 200, "{}").expect("records");
        ledger.set_rolled_back("gw", true).expect("flags");
        let before = ledger.commit_count();
        ledger.record_head_set("gw", &newer, 200, 5).expect("sets");
        assert_eq!(ledger.commit_count() - before, 1);
        assert!(!ledger.rolled_back("gw").expect("reads"));
        assert_eq!(ledger.highwater("gw").expect("reads"), Some(200));
        let older = name_of("older");
        ledger.record_head_set("gw", &older, 100, 6).expect("sets");
        assert_eq!(
            ledger.highwater("gw").expect("reads"),
            Some(200),
            "never falls"
        );
        assert_eq!(ledger.head("gw").expect("reads"), Some(older));
    }

    /// Queue rows go in as one commit for a batch, and the keyed lookups answer.
    #[test]
    fn a_batch_of_queue_rows_is_one_commit() {
        let dir = tempfile::tempdir().expect("a directory");
        let ledger = Ledger::open(dir.path().join("l.backup.db")).expect("opens");
        let parts: Vec<Queued> = (0..50)
            .map(|index| queued(&format!("p{index}"), index))
            .collect();
        let before = ledger.commit_count();
        ledger.enqueue_many(&parts).expect("queues");
        assert_eq!(ledger.commit_count() - before, 1);
        assert!(ledger.is_queued(&parts[7].name).expect("asks"));
        assert_eq!(
            ledger.queued_part(&parts[7].name).expect("reads"),
            Some(parts[7].clone())
        );
        assert_eq!(ledger.queued_part(&name_of("absent")).expect("reads"), None);
        let names: Vec<Name> = parts.iter().map(|part| part.name).collect();
        ledger.dequeue_many(&names).expect("dequeues");
        assert_eq!(ledger.commit_count() - before, 2);
        assert!(ledger.queued().expect("reads").is_empty());
    }
}
