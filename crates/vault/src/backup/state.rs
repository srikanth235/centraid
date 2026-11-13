//! The device state of a phone's backup, in `<stem>.state.db` beside the vault
//! (#1191, E11, B14). It replaces the ledger.
//!
//! Three tables, every one a cache of somebody else's truth and none a
//! key-value store:
//!
//! | Table | Whose truth |
//! |---|---|
//! | `gateway` | the pairing (addresses, pinned certificate, label, the epoch this phone holds) and what this phone knows of that gateway: the head it set, its generation and writes, the blob cursor, how the last pass fared, the sample counter |
//! | `outbox` | per gateway, each name owed and how its last attempt went |
//! | `local_bytes` | where each hash's bytes are on this device |
//!
//! **The token is not here** (E12): the shell keeps it in the device secret
//! store, and the core holds it in memory only. **Nothing is recorded as
//! acknowledged**: an outbox row leaves when its `PUT` succeeds, and what a
//! gateway holds is whatever it answers to `exists`.
//!
//! The file carries `application_id = CBS1` and a `user_version` that counts
//! the rungs of `state_ladder/`, each applied in one transaction and never
//! edited after the first release; a newer rung is refused. A ledger
//! (`<stem>.backup.db`) found beside the vault is deleted without being read
//! (decision 8): dev state is not migrated.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OptionalExtension, params};

use super::naming::{Digest, Name, PlaintextHash};
use super::{Result, invariant};

/// `CBS1`: a Centraid backup state.
pub const STATE_APPLICATION_ID: i64 = 0x4342_5331;

/// The rungs of the ladder, in order. `user_version` is how many are applied.
const LADDER: &[&str] = &[include_str!("state_ladder/001_founding.sql")];

/// How a gateway's last pass fared, which decides what the status line says
/// and whether the next pass tries it (E4, E6, E13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Ok,
    Unreachable,
    PairAgain,
    RefusedDisk,
    RefusedLarge,
    RefusedOther,
    /// Another phone took over, and the gateway proved it with a claim.
    Moved,
    /// The person at the gateway machine paused the vault.
    Frozen,
    /// The gateway runs a protocol below the required one.
    GatewayOld,
    Busy,
    /// A machine answered that is not the gateway paired (its certificate differs).
    Untrusted,
}

impl Reach {
    /// The spelling the `gateway.reach` CHECK names.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Unreachable => "unreachable",
            Self::PairAgain => "pair_again",
            Self::RefusedDisk => "refused_disk",
            Self::RefusedLarge => "refused_large",
            Self::RefusedOther => "refused_other",
            Self::Moved => "moved",
            Self::Frozen => "frozen",
            Self::GatewayOld => "gateway_old",
            Self::Busy => "busy",
            Self::Untrusted => "untrusted",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "ok" => Self::Ok,
            "unreachable" => Self::Unreachable,
            "pair_again" => Self::PairAgain,
            "refused_disk" => Self::RefusedDisk,
            "refused_large" => Self::RefusedLarge,
            "refused_other" => Self::RefusedOther,
            "moved" => Self::Moved,
            "frozen" => Self::Frozen,
            "gateway_old" => Self::GatewayOld,
            "busy" => Self::Busy,
            "untrusted" => Self::Untrusted,
            _ => return None,
        })
    }
}

/// One paired gateway and what this phone knows of it.
#[derive(Clone, PartialEq, Eq)]
pub struct Gateway {
    /// 32 lower-case hex: the gateway's 16-byte id.
    pub gateway_id: String,
    /// Where it was last reachable, so a background upload needs no browse.
    pub addrs: Vec<String>,
    /// The certificate it minted at first `serve`, pinned by byte equality.
    pub cert_der: Vec<u8>,
    pub label: String,
    /// The writer epoch this phone's token there was minted at.
    pub epoch: u64,
    /// The head this phone last set there.
    pub head: Option<Name>,
    /// The generation and writes of that head: what the next signed record
    /// continues from (E3).
    pub generation: u64,
    pub writes: u64,
    /// The last `blob.seq` handed to the outbox (E11).
    pub cursor: u64,
    pub reach: Reach,
    /// With [`Reach::Moved`]: the epoch of the verified claim that moved it.
    pub moved_epoch: Option<u64>,
    pub reach_ms: Option<u64>,
    pub paired_ms: u64,
    pub seen_ms: Option<u64>,
    pub ack_ms: Option<u64>,
    /// Counts the passes' read-back draws, so a draw is a function of it and
    /// the keys and never of a clock (E10).
    pub sample_counter: u64,
    /// The member's gateways changed since the directory was written (E8).
    pub directory_dirty: bool,
    /// The `taken_at_ms` of the newest snapshot spooled for this gateway, in
    /// flight or set: where the hour runs from, and what a row's age is judged against.
    pub snapshot_ms: Option<u64>,
    /// The `taken_at_ms` of the snapshot the head names: how current the records there are.
    pub head_ms: Option<u64>,
    /// The manifest of the newest snapshot spooled for this gateway, in flight or set, with its
    /// `writes` (`snapshot_ms` is its `taken_at_ms`): what the head moves to once nothing of it
    /// is owed.
    pub snapshot: Option<Name>,
    pub snapshot_writes: u64,
}

impl std::fmt::Debug for Gateway {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Gateway")
            .field("gateway_id", &self.gateway_id)
            .field("addrs", &self.addrs)
            .field("cert_der_bytes", &self.cert_der.len())
            .field("label", &self.label)
            .field("epoch", &self.epoch)
            .field("head", &self.head)
            .field("generation", &self.generation)
            .field("writes", &self.writes)
            .field("cursor", &self.cursor)
            .field("reach", &self.reach)
            .field("moved_epoch", &self.moved_epoch)
            .finish_non_exhaustive()
    }
}

impl Gateway {
    /// A gateway just paired: nothing set there yet, the directory owed.
    #[must_use]
    pub fn paired(
        gateway_id: String,
        addrs: Vec<String>,
        cert_der: Vec<u8>,
        label: String,
        epoch: u64,
        now_ms: u64,
    ) -> Self {
        Self {
            gateway_id,
            addrs,
            cert_der,
            label,
            epoch,
            head: None,
            generation: 0,
            writes: 0,
            cursor: 0,
            reach: Reach::Ok,
            moved_epoch: None,
            reach_ms: None,
            paired_ms: now_ms,
            seen_ms: None,
            ack_ms: None,
            sample_counter: 0,
            directory_dirty: true,
            snapshot_ms: None,
            head_ms: None,
            snapshot: None,
            snapshot_writes: 0,
        }
    }
}

/// What an outbox row is, which decides when it may move.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum OutboxKind {
    /// A 64 KiB range of a snapshot.
    Range,
    /// A leaf of a manifest tree (E9).
    Leaf,
    /// A snapshot's root manifest: ordered after everything else.
    Manifest,
    /// The sealed gateway directory (E8).
    Directory,
    /// A part of a blob (an original, a thumbnail, a preview).
    Blob,
}

impl OutboxKind {
    /// The spelling the `outbox.kind` CHECK names.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Range => "range",
            Self::Leaf => "leaf",
            Self::Manifest => "manifest",
            Self::Directory => "directory",
            Self::Blob => "blob",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "range" => Self::Range,
            "leaf" => Self::Leaf,
            "manifest" => Self::Manifest,
            "directory" => Self::Directory,
            "blob" => Self::Blob,
            _ => return None,
        })
    }
}

/// Why an unsealed outbox row waits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waiting {
    /// A blob with no renter left, awaiting the vault's own collection.
    Lapsed,
    /// An original whose bytes are not on this phone yet.
    Bytes,
}

impl Waiting {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Lapsed => "lapsed",
            Self::Bytes => "bytes",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "lapsed" => Self::Lapsed,
            "bytes" => Self::Bytes,
            _ => return None,
        })
    }
}

/// One name a gateway is owed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outbox {
    pub gateway_id: String,
    pub name: Name,
    pub kind: OutboxKind,
    /// The plaintext hash of a blob part's file; `Some` exactly for a blob.
    pub hash: Option<PlaintextHash>,
    /// The sealed file in the spool; `None` while owed but not yet sealed.
    pub part_path: Option<PathBuf>,
    pub waiting: Option<Waiting>,
    pub size: Option<u64>,
    /// BLAKE3 of the sealed file as spooled; `Some` exactly with a path.
    pub digest: Option<Digest>,
    /// The media type of the file a blob part belongs to.
    pub media_type: Option<String>,
    pub created_ms: u64,
    /// When it was handed to the OS to move, on a platform that does.
    pub handed_ms: Option<u64>,
    pub attempts: u32,
    pub last_error: Option<String>,
    /// A thumbnail, preview or poster rather than an original (blobs only):
    /// what the member's rule weighs differently.
    pub derivative: bool,
}

impl Outbox {
    /// A sealed part, ready to move.
    #[must_use]
    pub fn sealed(
        gateway_id: &str,
        name: Name,
        kind: OutboxKind,
        part_path: PathBuf,
        size: u64,
        digest: Digest,
        created_ms: u64,
    ) -> Self {
        Self {
            gateway_id: gateway_id.to_owned(),
            name,
            kind,
            hash: None,
            part_path: Some(part_path),
            waiting: None,
            size: Some(size),
            digest: Some(digest),
            media_type: None,
            created_ms,
            handed_ms: None,
            attempts: 0,
            last_error: None,
            derivative: false,
        }
    }

    /// The part belongs to a moving image.
    #[must_use]
    pub fn is_video(&self) -> bool {
        self.media_type
            .as_deref()
            .is_some_and(|media_type| media_type.trim().to_ascii_lowercase().starts_with("video/"))
    }
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
    /// The member edited the item in the library: the rendition backed up is
    /// its current one, so it is never offered for deletion (A20).
    pub edited: bool,
}

/// The state file and its one connection.
pub struct DeviceState {
    connection: Connection,
    path: PathBuf,
    /// Commits this connection has made, so a test can assert on how many
    /// syncs a batch cost (counts, never durations).
    commits: Arc<AtomicU64>,
}

fn ms(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| invariant(format!("{value} does not fit the state file")))
}

fn read_u64(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn bad_text(
    column: usize,
    error: impl std::error::Error + Send + Sync + 'static,
) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, Box::new(error))
}

const GATEWAY_COLUMNS: &str = "gateway_id, addrs, cert_der, label, epoch, head, generation, writes,
     cursor, reach, moved_epoch, reach_ms, paired_ms, seen_ms, ack_ms, sample_counter, directory_dirty, snapshot_ms, head_ms, snapshot, snapshot_writes";

fn read_gateway(row: &rusqlite::Row<'_>) -> rusqlite::Result<Gateway> {
    let addrs: String = row.get(1)?;
    let head: Option<String> = row.get(5)?;
    let reach: String = row.get(9)?;
    let opt = |index: usize| -> rusqlite::Result<Option<u64>> {
        row.get::<_, Option<i64>>(index)?.map(read_u64).transpose()
    };
    Ok(Gateway {
        gateway_id: row.get(0)?,
        addrs: serde_json::from_str(&addrs).map_err(|error| bad_text(1, error))?,
        cert_der: row.get(2)?,
        label: row.get(3)?,
        epoch: read_u64(row.get(4)?)?,
        head: head
            .map(|text| Name::from_hex(&text).map_err(|error| bad_text(5, error)))
            .transpose()?,
        generation: read_u64(row.get(6)?)?,
        writes: read_u64(row.get(7)?)?,
        cursor: read_u64(row.get(8)?)?,
        reach: Reach::parse(&reach).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(9, reach.clone(), rusqlite::types::Type::Text)
        })?,
        moved_epoch: opt(10)?,
        reach_ms: opt(11)?,
        paired_ms: read_u64(row.get(12)?)?,
        seen_ms: opt(13)?,
        ack_ms: opt(14)?,
        sample_counter: read_u64(row.get(15)?)?,
        directory_dirty: row.get::<_, i64>(16)? != 0,
        snapshot_ms: opt(17)?,
        head_ms: opt(18)?,
        snapshot: row
            .get::<_, Option<String>>(19)?
            .map(|text| Name::from_hex(&text).map_err(|error| bad_text(19, error)))
            .transpose()?,
        snapshot_writes: read_u64(row.get(20)?)?,
    })
}

const OUTBOX_COLUMNS: &str = "gateway_id, name, kind, hash, part_path, waiting, size, digest,
     media_type, created_ms, handed_ms, attempts, last_error, derivative";

fn read_outbox(row: &rusqlite::Row<'_>) -> rusqlite::Result<Outbox> {
    let name: String = row.get(1)?;
    let kind: String = row.get(2)?;
    let hash: Option<String> = row.get(3)?;
    let path: Option<String> = row.get(4)?;
    let waiting: Option<String> = row.get(5)?;
    let digest: Option<String> = row.get(7)?;
    Ok(Outbox {
        gateway_id: row.get(0)?,
        name: Name::from_hex(&name).map_err(|error| bad_text(1, error))?,
        kind: OutboxKind::parse(&kind).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(2, kind.clone(), rusqlite::types::Type::Text)
        })?,
        hash: hash
            .map(|text| PlaintextHash::from_hex(&text).map_err(|error| bad_text(3, error)))
            .transpose()?,
        part_path: path.map(PathBuf::from),
        waiting: waiting
            .map(|text| {
                Waiting::parse(&text).ok_or_else(|| {
                    rusqlite::Error::InvalidColumnType(5, text, rusqlite::types::Type::Text)
                })
            })
            .transpose()?,
        size: row.get::<_, Option<i64>>(6)?.map(read_u64).transpose()?,
        digest: digest
            .map(|text| Digest::from_hex(&text).map_err(|error| bad_text(7, error)))
            .transpose()?,
        media_type: row.get(8)?,
        created_ms: read_u64(row.get(9)?)?,
        handed_ms: row.get::<_, Option<i64>>(10)?.map(read_u64).transpose()?,
        attempts: u32::try_from(row.get::<_, i64>(11)?)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(11, 0))?,
        last_error: row.get(12)?,
        derivative: row.get::<_, i64>(13)? != 0,
    })
}

fn read_local(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalBytes> {
    let hash: String = row.get(0)?;
    let source: String = row.get(1)?;
    Ok(LocalBytes {
        hash: PlaintextHash::from_hex(&hash).map_err(|error| bad_text(0, error))?,
        source: LocalSource::parse(&source).ok_or_else(|| {
            rusqlite::Error::InvalidColumnType(1, source.clone(), rusqlite::types::Type::Text)
        })?,
        os_ref: row.get(2)?,
        edited: row.get::<_, i64>(3)? != 0,
    })
}

impl DeviceState {
    /// `<stem>.state.db` beside the vault file.
    #[must_use]
    pub fn path_for(vault_path: &Path) -> PathBuf {
        vault_path.with_extension("state.db")
    }

    /// The ledger an earlier build kept beside the vault, which this build
    /// does not read (decision 8).
    #[must_use]
    pub fn old_ledger_path(vault_path: &Path) -> PathBuf {
        vault_path.with_extension("backup.db")
    }

    /// Open the state beside `vault_path`, creating it when absent. **An old
    /// ledger beside the vault is deleted without being read** (decision 8):
    /// its files, its journal and its shared memory.
    ///
    /// # Errors
    ///
    /// A file this build cannot open or refuses (see [`Self::open`]).
    pub fn open_beside(vault_path: &Path) -> Result<Self> {
        let old = Self::old_ledger_path(vault_path);
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let mut file = old.clone().into_os_string();
            file.push(suffix);
            match std::fs::remove_file(PathBuf::from(file)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Self::open(Self::path_for(vault_path))
    }

    /// Open the state, founding or climbing the ladder as needed.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, a file of another program (`application_id` not
    /// `CBS1`), or a rung newer than this build's: refused, untouched.
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
        let rungs = i64::try_from(LADDER.len()).unwrap_or(i64::MAX);
        let fresh = application_id == 0 && version == 0;
        if !fresh && application_id != STATE_APPLICATION_ID {
            return Err(invariant(format!(
                "{} is not a backup state file: application_id {application_id:#010x}",
                path.display()
            )));
        }
        if version > rungs {
            return Err(invariant(format!(
                "{} was written by a newer build (rung {version}); this one reads rung {rungs}",
                path.display()
            )));
        }
        for (index, rung) in LADDER
            .iter()
            .enumerate()
            .skip(usize::try_from(version).unwrap_or(0))
        {
            connection.execute_batch("BEGIN IMMEDIATE")?;
            let climbed = connection
                .execute_batch(rung)
                .and_then(|()| {
                    connection.pragma_update(None, "application_id", STATE_APPLICATION_ID)
                })
                .and_then(|()| {
                    connection.pragma_update(
                        None,
                        "user_version",
                        i64::try_from(index + 1).unwrap_or(i64::MAX),
                    )
                });
            if let Err(error) = climbed {
                let _ = connection.execute_batch("ROLLBACK");
                return Err(error.into());
            }
            connection.execute_batch("COMMIT")?;
        }
        let commits = Arc::new(AtomicU64::new(0));
        let counted = Arc::clone(&commits);
        connection.commit_hook(Some(move || {
            counted.fetch_add(1, Ordering::Relaxed);
            false
        }))?;
        Ok(Self {
            connection,
            path,
            commits,
        })
    }

    /// How many transactions this connection has committed.
    #[must_use]
    pub fn commit_count(&self) -> u64 {
        self.commits.load(Ordering::Relaxed)
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    // ─── gateways ───────────────────────────────────────────────────────────

    /// Record a pairing. A gateway paired again (a claim) starts clean: its
    /// reach is `ok`, no moved mark, nothing owed to it carries over.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn put_gateway(&self, gateway: &Gateway) -> Result<()> {
        let addrs = serde_json::to_string(&gateway.addrs)
            .map_err(|error| invariant(format!("the address list: {error}")))?;
        self.connection.execute(
            "INSERT INTO gateway (gateway_id, addrs, cert_der, label, epoch, head, generation,
                                  writes, cursor, reach, moved_epoch, reach_ms, paired_ms, seen_ms,
                                  ack_ms, sample_counter, directory_dirty, snapshot_ms, head_ms, snapshot, snapshot_writes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
             ON CONFLICT (gateway_id) DO UPDATE SET
               addrs = excluded.addrs, cert_der = excluded.cert_der, label = excluded.label,
               epoch = excluded.epoch, head = excluded.head, generation = excluded.generation,
               writes = excluded.writes, cursor = excluded.cursor, reach = excluded.reach,
               moved_epoch = excluded.moved_epoch, reach_ms = excluded.reach_ms,
               paired_ms = excluded.paired_ms, sample_counter = excluded.sample_counter,
               directory_dirty = excluded.directory_dirty, snapshot_ms = excluded.snapshot_ms, head_ms = excluded.head_ms, snapshot = excluded.snapshot,
               snapshot_writes = excluded.snapshot_writes",
            params![
                gateway.gateway_id,
                addrs,
                gateway.cert_der,
                gateway.label,
                ms(gateway.epoch)?,
                gateway.head.map(|name| name.to_hex()),
                ms(gateway.generation)?,
                ms(gateway.writes)?,
                ms(gateway.cursor)?,
                gateway.reach.as_str(),
                gateway.moved_epoch.map(ms).transpose()?,
                gateway.reach_ms.map(ms).transpose()?,
                ms(gateway.paired_ms)?,
                gateway.seen_ms.map(ms).transpose()?,
                gateway.ack_ms.map(ms).transpose()?,
                ms(gateway.sample_counter)?,
                i64::from(gateway.directory_dirty),
                gateway.snapshot_ms.map(ms).transpose()?,
                gateway.head_ms.map(ms).transpose()?,
                gateway.snapshot.map(|name| name.to_hex()),
                ms(gateway.snapshot_writes)?,
            ],
        )?;
        Ok(())
    }

    /// Every paired gateway, in pairing order.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn gateways(&self) -> Result<Vec<Gateway>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {GATEWAY_COLUMNS} FROM gateway ORDER BY paired_ms, gateway_id"
        ))?;
        let rows = statement.query_map([], read_gateway)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// One gateway.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn gateway(&self, gateway_id: &str) -> Result<Option<Gateway>> {
        Ok(self
            .connection
            .query_row(
                &format!("SELECT {GATEWAY_COLUMNS} FROM gateway WHERE gateway_id = ?1"),
                params![gateway_id],
                read_gateway,
            )
            .optional()?)
    }

    /// Forget a gateway: its row goes and its outbox rows with it (cascade).
    /// The caller removes the spool files nothing owes any more
    /// ([`Self::unowed_paths`]). Nothing else is touched, `local_bytes`
    /// included.
    ///
    /// # Errors
    ///
    /// SQLite's refusal; nothing is deleted then.
    pub fn remove_gateway(&self, gateway_id: &str) -> Result<()> {
        self.connection.execute(
            "DELETE FROM gateway WHERE gateway_id = ?1",
            params![gateway_id],
        )?;
        Ok(())
    }

    /// How the last pass to a gateway fared. [`Reach::Moved`] is recorded with
    /// [`Self::set_moved`], which carries its epoch.
    ///
    /// # Errors
    ///
    /// `Moved` here (it needs an epoch), or SQLite's refusal.
    pub fn set_reach(&self, gateway_id: &str, reach: Reach, now_ms: u64) -> Result<()> {
        if reach == Reach::Moved {
            return Err(invariant(
                "a moved gateway needs its claim's epoch: use set_moved",
            ));
        }
        self.connection.execute(
            "UPDATE gateway SET reach = ?2, moved_epoch = NULL, reach_ms = ?3 WHERE gateway_id = ?1",
            params![gateway_id, reach.as_str(), ms(now_ms)?],
        )?;
        Ok(())
    }

    /// Another phone took over at this gateway, proved by a claim above the
    /// epoch held (E4). Only this gateway's row changes.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn set_moved(&self, gateway_id: &str, epoch: u64, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET reach = 'moved', moved_epoch = ?2, reach_ms = ?3 WHERE gateway_id = ?1",
            params![gateway_id, ms(epoch)?, ms(now_ms)?],
        )?;
        Ok(())
    }

    /// The gateway answered something.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn touch_seen(&self, gateway_id: &str, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET seen_ms = ?2 WHERE gateway_id = ?1",
            params![gateway_id, ms(now_ms)?],
        )?;
        Ok(())
    }

    /// The gateway acknowledged a head.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn touch_ack(&self, gateway_id: &str, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET ack_ms = ?2 WHERE gateway_id = ?1",
            params![gateway_id, ms(now_ms)?],
        )?;
        Ok(())
    }

    /// The addresses a gateway was last reached at. Answers whether they
    /// changed.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn set_addrs(&self, gateway_id: &str, addrs: &[String]) -> Result<bool> {
        let text = serde_json::to_string(addrs)
            .map_err(|error| invariant(format!("the address list: {error}")))?;
        let changed = self.connection.execute(
            "UPDATE gateway SET addrs = ?2, directory_dirty = 1
             WHERE gateway_id = ?1 AND addrs <> ?2",
            params![gateway_id, text],
        )?;
        Ok(changed > 0)
    }

    /// This phone set `head` there, at this generation and writes (E3). The
    /// head, generation and writes move together: never one without the
    /// others.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn record_head(
        &self,
        gateway_id: &str,
        head: &Name,
        generation: u64,
        writes: u64,
        taken_at_ms: u64,
    ) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET head = ?2, generation = ?3, writes = ?4, head_ms = ?5
             WHERE gateway_id = ?1",
            params![
                gateway_id,
                head.to_hex(),
                ms(generation)?,
                ms(writes)?,
                ms(taken_at_ms)?
            ],
        )?;
        Ok(())
    }

    /// The snapshot `name`, taken at `taken_at_ms` with `writes` commits behind it, was spooled
    /// for this gateway: the head moves to it once nothing of it is owed.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn set_snapshot(
        &self,
        gateway_id: &str,
        name: &Name,
        taken_at_ms: u64,
        writes: u64,
    ) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET snapshot = ?2, snapshot_ms = ?3, snapshot_writes = ?4
             WHERE gateway_id = ?1",
            params![gateway_id, name.to_hex(), ms(taken_at_ms)?, ms(writes)?],
        )?;
        Ok(())
    }

    /// A signed delete or undo used `generation`, so the next record
    /// continues from it.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn record_generation(&self, gateway_id: &str, generation: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET generation = max(generation, ?2) WHERE gateway_id = ?1",
            params![gateway_id, ms(generation)?],
        )?;
        Ok(())
    }

    /// The gateway said what it holds now: take its generation and writes as
    /// the floor for the next signed record (the `OUT_OF_ORDER` retry, E3).
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn raise_generation(&self, gateway_id: &str, generation: u64, writes: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET generation = max(generation, ?2), writes = max(writes, ?3)
             WHERE gateway_id = ?1",
            params![gateway_id, ms(generation)?, ms(writes)?],
        )?;
        Ok(())
    }

    /// The last `blob.seq` handed to this gateway's outbox, with the outbox
    /// rows the pass wrote for it in the same transaction by the caller.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn set_cursor(&self, gateway_id: &str, cursor: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET cursor = ?2 WHERE gateway_id = ?1",
            params![gateway_id, ms(cursor)?],
        )?;
        Ok(())
    }

    /// Take the next sample counter for a pass's draw and record that it was
    /// used, in one statement. Answers the counter the draw uses.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a gateway that is not paired.
    pub fn next_sample_counter(&self, gateway_id: &str) -> Result<u64> {
        let counter: Option<i64> = self
            .connection
            .query_row(
                "UPDATE gateway SET sample_counter = sample_counter + 1
                 WHERE gateway_id = ?1 RETURNING sample_counter - 1",
                params![gateway_id],
                |row| row.get(0),
            )
            .optional()?;
        let counter = counter.ok_or_else(|| invariant(format!("{gateway_id} is not paired")))?;
        Ok(read_u64(counter)?)
    }

    /// The directory of the member's gateways changed (E8): every gateway
    /// owes a snapshot that writes it.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn mark_directories_dirty(&self) -> Result<()> {
        self.connection
            .execute("UPDATE gateway SET directory_dirty = 1", [])?;
        Ok(())
    }

    /// The directory the head at this gateway names is the current one.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn clear_directory_dirty(&self, gateway_id: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET directory_dirty = 0 WHERE gateway_id = ?1",
            params![gateway_id],
        )?;
        Ok(())
    }

    /// **Restore in place** (E11): the vault was replaced and this phone
    /// claimed at each gateway. Each gateway row takes the claim's epoch and
    /// the head claimed against, and starts counting again; the outbox is
    /// emptied (the caller removes its spool files); `local_bytes` is kept,
    /// being about this device and not the vault's history.
    ///
    /// # Errors
    ///
    /// SQLite's refusal; nothing changes then.
    pub fn reset_for_restore(&self, claimed: &[(String, u64, Option<Name>)]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM outbox", [])?;
        for (gateway_id, epoch, head) in claimed {
            transaction.execute(
                "UPDATE gateway SET epoch = ?2, head = ?3, generation = 0, writes = 0, cursor = 0,
                                    reach = 'ok', moved_epoch = NULL, sample_counter = 0,
                                    directory_dirty = 1
                 WHERE gateway_id = ?1",
                params![gateway_id, ms(*epoch)?, head.map(|name| name.to_hex())],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    // ─── outbox ─────────────────────────────────────────────────────────────

    /// Owe a gateway a name. An existing row for the name is left as it is
    /// (the first owing wins; a sealed part is not replaced by an unsealed
    /// one).
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row its CHECKs refuse.
    pub fn put_outbox(&self, row: &Outbox) -> Result<()> {
        self.connection.execute(
            "INSERT INTO outbox (gateway_id, name, kind, hash, part_path, waiting, size, digest,
                                 media_type, created_ms, handed_ms, attempts, last_error, derivative)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT (gateway_id, name) DO UPDATE SET
                 part_path = excluded.part_path, size = excluded.size, digest = excluded.digest,
                 waiting = NULL
             WHERE outbox.part_path IS NULL AND excluded.part_path IS NOT NULL",
            params![
                row.gateway_id,
                row.name.to_hex(),
                row.kind.as_str(),
                row.hash.as_ref().map(PlaintextHash::to_hex),
                row.part_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                row.waiting.map(Waiting::as_str),
                row.size.map(ms).transpose()?,
                row.digest.as_ref().map(Digest::to_hex),
                row.media_type,
                ms(row.created_ms)?,
                row.handed_ms.map(ms).transpose()?,
                i64::from(row.attempts),
                row.last_error,
                i64::from(row.derivative),
            ],
        )?;
        Ok(())
    }

    /// Owe a gateway several names in one transaction.
    ///
    /// # Errors
    ///
    /// As [`Self::put_outbox`]; nothing is written then.
    pub fn put_outbox_many(&self, rows: &[Outbox]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for row in rows {
            self.put_outbox(row)?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Fill in an unsealed row: its sealed file is ready.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn seal_outbox(
        &self,
        gateway_id: &str,
        name: &Name,
        part_path: &Path,
        size: u64,
        digest: &Digest,
    ) -> Result<()> {
        self.connection.execute(
            "UPDATE outbox SET part_path = ?3, size = ?4, digest = ?5, waiting = NULL
             WHERE gateway_id = ?1 AND name = ?2",
            params![
                gateway_id,
                name.to_hex(),
                part_path.to_string_lossy(),
                ms(size)?,
                digest.to_hex()
            ],
        )?;
        Ok(())
    }

    /// What a gateway is owed, in the order it must move: everything before
    /// the root manifest, oldest first.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn outbox(&self, gateway_id: &str) -> Result<Vec<Outbox>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE gateway_id = ?1
             ORDER BY kind = 'manifest', created_ms, name"
        ))?;
        let rows = statement.query_map(params![gateway_id], read_outbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The rows of a gateway's outbox that wait (`lapsed` or `bytes`), by name.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn outbox_waiting(&self, gateway_id: &str) -> Result<Vec<Outbox>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE gateway_id = ?1 AND waiting IS NOT NULL
             ORDER BY waiting, name"
        ))?;
        let rows = statement.query_map(params![gateway_id], read_outbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// One row.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn outbox_row(&self, gateway_id: &str, name: &Name) -> Result<Option<Outbox>> {
        Ok(self
            .connection
            .query_row(
                &format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE gateway_id = ?1 AND name = ?2"),
                params![gateway_id, name.to_hex()],
                read_outbox,
            )
            .optional()?)
    }

    /// The name reached the gateway (or the gateway already held it): the row
    /// goes. Answers whether there was one.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn done(&self, gateway_id: &str, name: &Name) -> Result<bool> {
        Ok(self.connection.execute(
            "DELETE FROM outbox WHERE gateway_id = ?1 AND name = ?2",
            params![gateway_id, name.to_hex()],
        )? > 0)
    }

    /// Several names reached the gateway, in one transaction.
    ///
    /// # Errors
    ///
    /// SQLite's refusal; nothing is deleted then.
    pub fn done_many(&self, gateway_id: &str, names: &[Name]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for name in names {
            transaction.execute(
                "DELETE FROM outbox WHERE gateway_id = ?1 AND name = ?2",
                params![gateway_id, name.to_hex()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// The gateway refused the sealed part as damaged: the sealed file is no
    /// good and the row waits to be sealed again. Answers how many times in a
    /// row that same refusal has come for this name (1 for the first).
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn unseal(&self, gateway_id: &str, name: &Name, error: &str) -> Result<u32> {
        let transaction = self.connection.unchecked_transaction()?;
        let before: Option<(i64, Option<String>)> = transaction
            .query_row(
                "SELECT attempts, last_error FROM outbox WHERE gateway_id = ?1 AND name = ?2",
                params![gateway_id, name.to_hex()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let count = match before {
            Some((attempts, Some(last))) if last == error => u32::try_from(attempts)
                .unwrap_or(u32::MAX)
                .saturating_add(1),
            _ => 1,
        };
        transaction.execute(
            "UPDATE outbox SET part_path = NULL, size = NULL, digest = NULL, handed_ms = NULL,
                               attempts = ?3, last_error = ?4
             WHERE gateway_id = ?1 AND name = ?2",
            params![gateway_id, name.to_hex(), i64::from(count), error],
        )?;
        transaction.commit()?;
        Ok(count)
    }

    /// The cursor walk's step, in one transaction: the rows it found and the cursor it reached.
    ///
    /// # Errors
    ///
    /// SQLite's refusal; nothing is written then.
    pub fn advance(&self, gateway_id: &str, rows: &[Outbox], cursor: u64) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for row in rows {
            self.put_outbox(row)?;
        }
        self.connection.execute(
            "UPDATE gateway SET cursor = ?2 WHERE gateway_id = ?1",
            params![gateway_id, ms(cursor)?],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// The blob rows a gateway owes that are not sealed yet and do not wait for anything else,
    /// newest first.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn outbox_unsealed(&self, gateway_id: &str) -> Result<Vec<Outbox>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox
             WHERE gateway_id = ?1 AND kind = 'blob' AND part_path IS NULL AND waiting IS NULL
             ORDER BY created_ms DESC, name"
        ))?;
        let rows = statement.query_map(params![gateway_id], read_outbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// A sealed copy of `name` some gateway's row already carries: the spool holds one file per
    /// name, shared by every gateway that owes it.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn sealed_copy(&self, name: &Name) -> Result<Option<Outbox>> {
        Ok(self
            .connection
            .query_row(
                &format!(
                    "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE name = ?1 AND part_path IS NOT NULL LIMIT 1"
                ),
                params![name.to_hex()],
                read_outbox,
            )
            .optional()?)
    }

    /// Fill every gateway's unsealed row of `name` with the sealed file just written. Answers
    /// how many rows it filled.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn seal_everywhere(
        &self,
        name: &Name,
        part_path: &Path,
        size: u64,
        digest: &Digest,
    ) -> Result<usize> {
        Ok(self.connection.execute(
            "UPDATE outbox SET part_path = ?2, size = ?3, digest = ?4, waiting = NULL
             WHERE name = ?1 AND part_path IS NULL",
            params![
                name.to_hex(),
                part_path.to_string_lossy(),
                ms(size)?,
                digest.to_hex()
            ],
        )?)
    }

    /// Mark a row as waiting for the vault's own collection (a lapsed blob), or as waiting no
    /// more.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn set_waiting(
        &self,
        gateway_id: &str,
        name: &Name,
        waiting: Option<Waiting>,
    ) -> Result<()> {
        self.connection.execute(
            "UPDATE outbox SET waiting = ?3 WHERE gateway_id = ?1 AND name = ?2 AND part_path IS NULL",
            params![gateway_id, name.to_hex(), waiting.map(Waiting::as_str)],
        )?;
        Ok(())
    }

    /// Which of `names` any gateway is still owed.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn owed_among(&self, names: &[Name]) -> Result<std::collections::BTreeSet<Name>> {
        let mut statement = self
            .connection
            .prepare("SELECT 1 FROM outbox WHERE name = ?1 LIMIT 1")?;
        let mut out = std::collections::BTreeSet::new();
        for name in names {
            if statement.exists(params![name.to_hex()])? {
                out.insert(*name);
            }
        }
        Ok(out)
    }

    /// The sealed rows owed since before `before_ms`, oldest first.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn outbox_older_than(&self, before_ms: u64) -> Result<Vec<Outbox>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE created_ms < ?1 AND waiting IS NULL
             ORDER BY created_ms, gateway_id, name"
        ))?;
        let rows = statement.query_map(params![ms(before_ms)?], read_outbox)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// A send failed: count it and keep why.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn record_attempt(&self, gateway_id: &str, name: &Name, error: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE outbox SET attempts = attempts + 1, last_error = ?3
             WHERE gateway_id = ?1 AND name = ?2",
            params![gateway_id, name.to_hex(), error],
        )?;
        Ok(())
    }

    /// The part was handed to the operating system to move.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn hand_off(&self, gateway_id: &str, name: &Name, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE outbox SET handed_ms = ?3 WHERE gateway_id = ?1 AND name = ?2",
            params![gateway_id, name.to_hex(), ms(now_ms)?],
        )?;
        Ok(())
    }

    /// The hand-off did not happen or came back: the part is ours to move.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn unhand_many(&self, gateway_id: &str, names: &[Name]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for name in names {
            transaction.execute(
                "UPDATE outbox SET handed_ms = NULL WHERE gateway_id = ?1 AND name = ?2",
                params![gateway_id, name.to_hex()],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Every name any gateway is owed, sorted: the names collection must not
    /// delete (E9).
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn owed_names(&self) -> Result<std::collections::BTreeSet<Name>> {
        let mut statement = self
            .connection
            .prepare("SELECT DISTINCT name FROM outbox ORDER BY name")?;
        let rows = statement.query_map([], |row| {
            let text: String = row.get(0)?;
            Name::from_hex(&text).map_err(|error| bad_text(0, error))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Every spool file an outbox row names, so a sweep removes the rest.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn owed_paths(&self) -> Result<std::collections::BTreeSet<PathBuf>> {
        let mut statement = self.connection.prepare(
            "SELECT DISTINCT part_path FROM outbox WHERE part_path IS NOT NULL ORDER BY part_path",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(PathBuf::from)
            .collect())
    }

    /// The sealed bytes a gateway is still owed.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn owed_bytes(&self, gateway_id: &str) -> Result<u64> {
        let total: i64 = self.connection.query_row(
            "SELECT COALESCE(SUM(size), 0) FROM outbox WHERE gateway_id = ?1",
            params![gateway_id],
            |row| row.get(0),
        )?;
        Ok(read_u64(total)?)
    }

    // ─── local bytes ────────────────────────────────────────────────────────

    /// Record where a hash's bytes are on this device.
    ///
    /// # Errors
    ///
    /// A library row with no identifier, a store row with one, or an edited
    /// store row: refused before SQLite's CHECK says so; or SQLite's refusal.
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
        // RECORDED LAST IS RECORDED NEWEST: a hash recorded again moves to the end of the order
        // ([`Self::locals`] reads by row id), which is how "the newer version of a ref" is told.
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM local_bytes WHERE hash = ?1",
            params![local.hash.to_hex()],
        )?;
        transaction.execute(
            "INSERT INTO local_bytes (hash, source, ref, edited) VALUES (?1, ?2, ?3, ?4)",
            params![
                local.hash.to_hex(),
                local.source.as_str(),
                local.os_ref,
                i64::from(local.edited),
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    /// Where a hash's bytes are, as recorded. `None` is no record, which a
    /// reader takes as "ask the store".
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn local(&self, hash: &PlaintextHash) -> Result<Option<LocalBytes>> {
        Ok(self
            .connection
            .query_row(
                "SELECT hash, source, ref, edited FROM local_bytes WHERE hash = ?1",
                params![hash.to_hex()],
                read_local,
            )
            .optional()?)
    }

    /// Every recorded hash, in hash order.
    ///
    /// # Errors
    ///
    /// SQLite's refusal, or a row this build cannot read.
    pub fn locals(&self) -> Result<Vec<LocalBytes>> {
        let mut statement = self
            .connection
            .prepare("SELECT hash, source, ref, edited FROM local_bytes ORDER BY rowid")?;
        let rows = statement.query_map([], read_local)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The bytes left this device: forget where they were.
    ///
    /// # Errors
    ///
    /// SQLite's refusal.
    pub fn forget_local(&self, hash: &PlaintextHash) -> Result<()> {
        self.connection.execute(
            "DELETE FROM local_bytes WHERE hash = ?1",
            params![hash.to_hex()],
        )?;
        Ok(())
    }
}
