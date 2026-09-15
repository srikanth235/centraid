//! `replica_meta` and `replica_log`: reading the position, writing the rows.

use rusqlite::Connection;

use crate::clock::Clock;
use crate::error::{Result, VaultError};
use crate::file::Vault;
use crate::log::capture::{DecodedRow, LogOp};
use crate::value::{
    RowImage, Value, key_from_json, key_to_json, row_image_from_json, row_image_to_json,
};

/// The singleton position row.
#[derive(Debug, Clone)]
pub struct Meta {
    pub epoch: String,
    pub floor_seq: i64,
    pub schema_epoch: i64,
    pub ddl_version: i64,
    pub commit_seq: i64,
    pub active_commit_id: Option<String>,
    pub epoch_reason: String,
}

/// One log row, as the file holds it.
#[derive(Debug, Clone)]
pub struct LogRow {
    pub seq: i64,
    pub commit_seq: i64,
    pub epoch: String,
    pub schema_epoch: i64,
    pub ddl_version: i64,
    pub table: String,
    pub op: LogOp,
    pub primary_key: Vec<Value>,
    pub row: Option<RowImage>,
    pub prior: Option<RowImage>,
    pub indirect: bool,
    pub producer: String,
    pub deferred: bool,
    pub local: bool,
    pub committed_at: String,
}

impl LogRow {
    /// The full prior image: `{...row_json, ...prior_json}`.
    ///
    /// The reconstruction, written here so no consumer invents its own. An
    /// update's `prior_json` holds only the touched columns, and an untouched
    /// column is identical in both images — so the new image supplies the rest.
    /// Returns `None` when no prior is known, which is the claim that forces a
    /// re-bootstrap rather than a guess.
    #[must_use]
    pub fn full_prior(&self) -> Option<RowImage> {
        let prior = self.prior.as_ref()?;
        let mut full = self.row.clone().unwrap_or_default();
        for (column, value) in prior {
            full.insert(column.clone(), value.clone());
        }
        Some(full)
    }
}

/// Seed `replica_meta` for a freshly founded vault.
///
/// The epoch is a fresh uuid. `epoch_reason` starts `created`, and `floor_seq`
/// at 0 — a vault whose log has never been pruned has a floor of zero, which is
/// a real position and not a missing one.
pub fn seed_replica_meta(vault: &Vault) -> Result<()> {
    let now = vault.clock().now_text();
    let epoch = vault.ids().next();
    vault.connection().execute(
        "INSERT INTO replica_meta
           (singleton, epoch, floor_seq, schema_epoch, ddl_version, commit_seq,
            active_commit_id, epoch_reason, epoch_started_at, updated_at)
         VALUES (1, ?1, 0, ?2, ?3, 0, NULL, 'created', ?4, ?4)",
        rusqlite::params![
            epoch,
            crate::log::constants().schema_epoch,
            crate::log::constants().ddl_version,
            now
        ],
    )?;
    Ok(())
}

/// Read the singleton.
pub fn meta(connection: &Connection) -> Result<Meta> {
    connection
        .query_row(
            "SELECT epoch, floor_seq, schema_epoch, ddl_version, commit_seq,
                    active_commit_id, epoch_reason
               FROM replica_meta WHERE singleton = 1",
            [],
            |row| {
                Ok(Meta {
                    epoch: row.get(0)?,
                    floor_seq: row.get(1)?,
                    schema_epoch: row.get(2)?,
                    ddl_version: row.get(3)?,
                    commit_seq: row.get(4)?,
                    active_commit_id: row.get(5)?,
                    epoch_reason: row.get(6)?,
                })
            },
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => VaultError::Invariant {
                context: "replica_meta has no singleton row; this file was never seeded".to_owned(),
            },
            other => VaultError::Sqlite(other),
        })
}

/// What one capture wrote.
#[derive(Debug, Clone)]
pub struct WriteOutcome {
    pub commit_seq: i64,
    pub rows: usize,
    pub tables: Vec<String>,
    pub compressed_bytes: usize,
    pub deferred: bool,
}

/// Allocate the next `commit_seq` and insert one row per decoded change.
///
/// Every statement here runs inside the caller's transaction. `commit_seq` is
/// written back inside it too, so a rolled-back commit leaves no gap a reader
/// can see.
pub fn write_rows(
    connection: &Connection,
    clock: &dyn Clock,
    producer: &str,
    committed_at: Option<&str>,
    decoded: &[DecodedRow],
    tables: Vec<String>,
) -> Result<WriteOutcome> {
    let current = meta(connection)?;
    let commit_seq = current.commit_seq + 1;
    let now = clock.now_text();
    connection.execute(
        "UPDATE replica_meta SET commit_seq = ?1, updated_at = ?2 WHERE singleton = 1",
        rusqlite::params![commit_seq, now],
    )?;
    let committed_at = committed_at.map_or(now, str::to_owned);

    let images: Vec<Option<String>> = decoded
        .iter()
        .map(|row| row.row.as_ref().map(row_image_to_json))
        .collect();
    let priors: Vec<Option<String>> = decoded
        .iter()
        .map(|row| row.prior.as_ref().map(row_image_to_json))
        .collect();

    // A CONFORMING PRODUCER IS NEVER MEASURED — BUT "CONFORMING" IS ABOUT
    // BYTES (#1014 G20). The bound is stated in ROWS, and the guarantee behind
    // it holds only for rows of ordinary size: a 2,000-row commit of BLOB
    // images is tens of megabytes and used to report `deferred: false`, so the
    // one commit a metered seat most needed to skip was the one the threshold
    // could not see. The uncompressed size is already in hand — a sum, not a
    // compression — so a commit is measured when EITHER could reach it.
    let raw_bytes: usize = images
        .iter()
        .map(|image| image.as_ref().map_or(0, String::len))
        .sum();
    let constants = crate::log::constants();
    let compressed_bytes = if decoded.len() > constants.producer_max_rows
        || raw_bytes > constants.defer_threshold_bytes
    {
        gzip_len(&join_images(&images))?
    } else {
        0
    };
    let deferred = compressed_bytes > constants.defer_threshold_bytes;

    let mut insert = connection.prepare_cached(
        r#"INSERT INTO replica_log
             (commit_seq, epoch, schema_epoch, ddl_version, "table", op,
              pk_json, row_json, prior_json, indirect, producer, deferred, local,
              committed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"#,
    )?;
    for (index, row) in decoded.iter().enumerate() {
        insert
            .execute(rusqlite::params![
                commit_seq,
                current.epoch,
                constants.schema_epoch,
                constants.ddl_version,
                row.table,
                row.op.as_str(),
                key_to_json(&row.key),
                images[index],
                priors[index],
                i64::from(row.indirect),
                producer,
                i64::from(deferred),
                i64::from(row.local),
                committed_at,
            ])
            .map_err(|error| VaultError::from_sqlite("inserting a log row", error))?;
    }

    Ok(WriteOutcome {
        commit_seq,
        rows: decoded.len(),
        tables,
        compressed_bytes,
        deferred,
    })
}

/// The images joined the way v0 measures them, so the byte count is the same
/// number on both sides.
fn join_images(images: &[Option<String>]) -> String {
    images
        .iter()
        .map(|image| image.as_deref().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Compressed length at gzip level 6 — v0's level, because the threshold is
/// stated in compressed bytes and a different level is a different threshold.
fn gzip_len(text: &str) -> Result<usize> {
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write as _;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
    encoder.write_all(text.as_bytes())?;
    Ok(encoder.finish()?.len())
}

/// Read one log row off a statement whose SELECT is [`LOG_ROW_COLUMNS`].
pub fn log_row_from(row: &rusqlite::Row<'_>) -> Result<LogRow> {
    let pk_json: String = row.get(7)?;
    let row_json: Option<String> = row.get(8)?;
    let prior_json: Option<String> = row.get(9)?;
    Ok(LogRow {
        seq: row.get(0)?,
        commit_seq: row.get(1)?,
        epoch: row.get(2)?,
        schema_epoch: row.get(3)?,
        ddl_version: row.get(4)?,
        table: row.get(5)?,
        op: LogOp::parse(&row.get::<_, String>(6)?)?,
        primary_key: key_from_json(&pk_json)?,
        row: row_json.as_deref().map(row_image_from_json).transpose()?,
        prior: prior_json.as_deref().map(row_image_from_json).transpose()?,
        indirect: row.get::<_, i64>(10)? != 0,
        producer: row.get(11)?,
        deferred: row.get::<_, i64>(12)? != 0,
        local: row.get::<_, i64>(13)? != 0,
        committed_at: row.get(14)?,
    })
}

/// The column list every log-row SELECT uses, in the order `log_row_from`
/// reads. One list, so a reordered SELECT is a compile-time-adjacent change
/// rather than a silently shifted column.
pub const LOG_ROW_COLUMNS: &str = r#"seq, commit_seq, epoch, schema_epoch, ddl_version,
    "table", op, pk_json, row_json, prior_json, indirect, producer, deferred, local,
    committed_at"#;
