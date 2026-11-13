//! [`State`] over one SQLite file, `<data-dir>/state.db` (#1080).
//!
//! **This module stores; it does not decide.** Every value it writes came out
//! of a rule in [`crate::rules::engine`], and the only property it owns is the
//! one the port says is the adapter's:
//!
//! # `atomically` IS `BEGIN IMMEDIATE`
//!
//! The write lock is taken before the first read, so an operation's reads and
//! writes are one step and a second writer waits rather than reading a head
//! that is about to move. A deferred transaction would read first and upgrade,
//! which SQLite answers with `SQLITE_BUSY` — the read-decide-write race with a
//! transaction drawn around it. A refusal rolls back like any error.
//!
//! # DURABLE BEFORE ACKNOWLEDGED
//!
//! `synchronous = FULL` under WAL: a commit is on disk before the answer that
//! reports it leaves, because a `201` is the only backup claim there is.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension as _, Row, params};

use crate::rules::ids::{Digest, Name, Nonce, SecretHash, Signature, TokenHash, VaultId};
use crate::rules::state::{
    ClaimRecord, Fault, HeadRecord, Hold, ObjectRecord, RevokedToken, SecretRecord, SnapshotRecord,
    State, StoreFault, TokenRecord, VaultRecord,
};
use crate::rules::wire::PairKind;
use crate::server::sql;

/// The gateway's state in SQLite.
#[derive(Debug)]
pub struct SqliteState {
    connection: Connection,
    /// Transactions begun, for the test that proves a bundle commits in one.
    begun: std::sync::atomic::AtomicU64,
}

/// The state file inside a data directory.
pub const STATE_FILE: &str = "state.db";

/// `PRAGMA application_id` of a gateway's `state.db`: `CGW3`, so no other
/// SQLite file, and no gateway of an earlier protocol, is mistaken for one
/// (#1191, E13).
pub const APPLICATION_ID: i32 = 0x4347_5733;

/// What `serve` and `pairings` say, with exit code 2, to a data folder an
/// earlier gateway made. The words are the owner's (decision 8).
pub const OLDER_DATA_DIRECTORY: &str = "This data folder was made by an earlier version of the gateway, and this version cannot open it. Nothing was changed. Move the folder aside and start again; every phone will need to pair again.";

/// Why a state file would not open.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OpenStateError {
    /// The file is not one this build may open, and was left exactly as it
    /// was. The text is the sentence to print.
    #[error("{0}")]
    Refused(String),
    /// The store failed.
    #[error(transparent)]
    Fault(#[from] StoreFault),
}

impl SqliteState {
    /// Open or create the state file, found it at rung 1 or apply the rungs
    /// it lacks.
    ///
    /// A file this build must not open — an earlier gateway's, another
    /// program's, or one from a newer rung — is **refused before anything
    /// writes to it**: it is inspected through a read-only connection, so its
    /// bytes are the bytes they were.
    ///
    /// # Errors
    ///
    /// [`OpenStateError::Refused`] with the sentence to say, or a store fault.
    pub fn open(path: &Path) -> Result<Self, OpenStateError> {
        if path.is_file() {
            inspect(path)?;
        }
        Ok(Self::prepared(Connection::open(path).map_err(fault)?)?)
    }

    /// The same state in memory, for a test that wants no file.
    ///
    /// # Errors
    ///
    /// A store fault if the schema cannot be applied.
    pub fn in_memory() -> Result<Self, StoreFault> {
        Self::prepared(Connection::open_in_memory().map_err(fault)?)
    }

    fn prepared(connection: Connection) -> Result<Self, StoreFault> {
        // WAL so a scrub's reads do not block a phone's write; FULL so an
        // acknowledged write survives a power cut; foreign keys so the
        // schema's cascades are real rather than decorative.
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(fault)?;
        connection
            .pragma_update(None, "synchronous", "FULL")
            .map_err(fault)?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(fault)?;
        // A second process — `pair` or `scrub` beside a running `serve` —
        // waits for the lock rather than failing.
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(fault)?;
        climb(&connection)?;
        Ok(Self {
            connection,
            begun: std::sync::atomic::AtomicU64::new(0),
        })
    }
}

/// What the file holds, read without writing: `(application_id,
/// user_version, tables)`.
fn inspect(path: &Path) -> Result<(), OpenStateError> {
    let connection = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(fault)?;
    let application: i32 = connection
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(fault)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(fault)?;
    let tables: i64 = connection
        .query_row(sql::TABLES_COUNT, [], |row| row.get(0))
        .map_err(fault)?;
    let rungs = i64::try_from(sql::LADDER.len()).unwrap_or(i64::MAX);
    if application == 0 && version == 0 && tables == 0 {
        // Founded by nobody yet: an empty file a crash or a `touch` left.
        return Ok(());
    }
    if application != APPLICATION_ID {
        return Err(OpenStateError::Refused(OLDER_DATA_DIRECTORY.to_owned()));
    }
    if version > rungs {
        return Err(OpenStateError::Refused(format!(
            "This gateway's data was written by a newer version of the gateway (rung {version}); this one reads rung {rungs}. Update the gateway; nothing was changed."
        )));
    }
    Ok(())
}

/// Apply every rung the file lacks, each in its own transaction, founding the
/// file (its `application_id`) with the first.
fn climb(connection: &Connection) -> Result<(), StoreFault> {
    let version: usize = connection
        .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
        .map_err(fault)
        .and_then(|value| {
            usize::try_from(value).map_err(|_| StoreFault::new("a negative user_version"))
        })?;
    for (index, rung) in sql::LADDER.iter().enumerate().skip(version) {
        connection.execute_batch(sql::BEGIN).map_err(fault)?;
        let applied = (|| {
            connection.execute_batch(rung)?;
            if index == 0 {
                connection.pragma_update(None, "application_id", APPLICATION_ID)?;
            }
            connection.pragma_update(
                None,
                "user_version",
                i64::try_from(index + 1).unwrap_or(i64::MAX),
            )
        })();
        match applied {
            Ok(()) => connection.execute_batch(sql::COMMIT).map_err(fault)?,
            Err(error) => {
                let _ = connection.execute_batch(sql::ROLLBACK);
                return Err(fault(error));
            }
        }
    }
    Ok(())
}

fn fault(error: rusqlite::Error) -> StoreFault {
    StoreFault::new(error.to_string())
}

fn signed(value: u64) -> Result<i64, StoreFault> {
    i64::try_from(value).map_err(|_| StoreFault::new("a counter past i64"))
}

fn unsigned(value: i64) -> Result<u64, StoreFault> {
    u64::try_from(value).map_err(|_| StoreFault::new("a negative counter in the state file"))
}

fn blob<const N: usize>(row: &Row<'_>, index: usize) -> Result<[u8; N], StoreFault> {
    let bytes: Vec<u8> = row.get(index).map_err(fault)?;
    <[u8; N]>::try_from(bytes.as_slice())
        .map_err(|_| StoreFault::new("a stored identifier has the wrong width"))
}

fn optional_name(row: &Row<'_>, index: usize) -> Result<Option<Name>, StoreFault> {
    let bytes: Option<Vec<u8>> = row.get(index).map_err(fault)?;
    bytes
        .map(|bytes| {
            Name::from_slice(&bytes)
                .ok_or_else(|| StoreFault::new("a stored name has the wrong width"))
        })
        .transpose()
}

fn kind_of(word: &str) -> Result<PairKind, StoreFault> {
    [PairKind::Secret, PairKind::Claim, PairKind::Read]
        .into_iter()
        .find(|kind| kind.as_str() == word)
        .ok_or_else(|| StoreFault::new(format!("an unknown token kind {word:?}")))
}

/// The cursor before every key: an empty blob sorts before any 32 bytes, so
/// "after nothing" is the same statement as "after this name".
const BEFORE_ANY: &[u8] = &[];

fn vault_record(row: &Row<'_>) -> Result<VaultRecord, StoreFault> {
    Ok(VaultRecord {
        vault: VaultId::from_bytes(blob(row, 0)?),
        writer_epoch: unsigned(row.get(1).map_err(fault)?)?,
        paired_at_ms: row.get(2).map_err(fault)?,
        moved_at_ms: row.get(3).map_err(fault)?,
        generation: unsigned(row.get(4).map_err(fault)?)?,
        writes: unsigned(row.get(5).map_err(fault)?)?,
        frozen_at_ms: row.get(6).map_err(fault)?,
    })
}

fn token_record(row: &Row<'_>) -> Result<TokenRecord, StoreFault> {
    Ok(TokenRecord {
        hash: TokenHash::from_bytes(blob(row, 0)?),
        vault: VaultId::from_bytes(blob(row, 1)?),
        epoch: unsigned(row.get(2).map_err(fault)?)?,
        kind: kind_of(&row.get::<_, String>(3).map_err(fault)?)?,
        label: row.get(4).map_err(fault)?,
        created_at_ms: row.get(5).map_err(fault)?,
    })
}

fn secret_record(row: &Row<'_>) -> Result<SecretRecord, StoreFault> {
    let used_by: Option<Vec<u8>> = row.get(4).map_err(fault)?;
    Ok(SecretRecord {
        hash: SecretHash::from_bytes(blob(row, 0)?),
        created_at_ms: row.get(1).map_err(fault)?,
        expires_at_ms: row.get(2).map_err(fault)?,
        used_at_ms: row.get(3).map_err(fault)?,
        used_by: match used_by {
            Some(bytes) => Some(
                VaultId::from_slice(&bytes)
                    .ok_or_else(|| StoreFault::new("a stored vault id has the wrong width"))?,
            ),
            None => None,
        },
    })
}

fn hold_of(row: &Row<'_>, at: usize) -> Result<Option<Hold>, StoreFault> {
    let held: Option<i64> = row.get(at).map_err(fault)?;
    let purge_after: Option<i64> = row.get(at + 1).map_err(fault)?;
    Ok(match (held, purge_after) {
        (Some(at_ms), Some(purge_after_ms)) => Some(Hold {
            at_ms,
            purge_after_ms,
        }),
        _ => None,
    })
}

/// An object row, its columns starting at `at`.
fn object_record(row: &Row<'_>, at: usize) -> Result<ObjectRecord, StoreFault> {
    Ok(ObjectRecord {
        name: Name::from_bytes(blob(row, at)?),
        digest: Digest::from_bytes(blob(row, at + 1)?),
        size: unsigned(row.get(at + 2).map_err(fault)?)?,
        stored_at_ms: row.get(at + 3).map_err(fault)?,
        hold: hold_of(row, at + 4)?,
        damaged_at_ms: row.get(at + 6).map_err(fault)?,
    })
}

fn snapshot_record(row: &Row<'_>) -> Result<SnapshotRecord, StoreFault> {
    Ok(SnapshotRecord {
        name: Name::from_bytes(blob(row, 0)?),
        taken_at_ms: row.get(1).map_err(fault)?,
        registered_at_ms: row.get(2).map_err(fault)?,
        epoch: unsigned(row.get(3).map_err(fault)?)?,
        generation: unsigned(row.get(4).map_err(fault)?)?,
        writes: unsigned(row.get(5).map_err(fault)?)?,
        prev: optional_name(row, 6)?,
        signature: Signature::from_bytes(blob(row, 7)?),
        hold: hold_of(row, 8)?,
    })
}

/// Collect a query's rows through a fallible mapper.
fn rows<T>(
    connection: &Connection,
    statement: &str,
    parameters: impl rusqlite::Params,
    map: impl Fn(&Row<'_>) -> Result<T, StoreFault>,
) -> Result<Vec<T>, StoreFault> {
    let mut prepared = connection.prepare_cached(statement).map_err(fault)?;
    let mut query = prepared.query(parameters).map_err(fault)?;
    let mut out = Vec::new();
    while let Some(row) = query.next().map_err(fault)? {
        out.push(map(row)?);
    }
    Ok(out)
}

fn limit(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

impl SqliteState {
    fn run(&self, statement: &str, parameters: impl rusqlite::Params) -> Result<usize, StoreFault> {
        self.connection
            .prepare_cached(statement)
            .and_then(|mut prepared| prepared.execute(parameters))
            .map_err(fault)
    }

    fn count(&self, statement: &str, parameters: impl rusqlite::Params) -> Result<u64, StoreFault> {
        let found: i64 = self
            .connection
            .prepare_cached(statement)
            .and_then(|mut prepared| prepared.query_row(parameters, |row| row.get(0)))
            .map_err(fault)?;
        unsigned(found)
    }

    /// How many transactions this state has begun: the count a test reads to
    /// prove a bundle commits in one.
    #[must_use]
    pub fn transactions(&self) -> u64 {
        self.begun.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// The plan SQLite would run `statement` with, one line per step, for the
    /// plan test. Every parameter is bound NULL.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn query_plan(&self, statement: &str) -> Result<Vec<String>, StoreFault> {
        let mut prepared = self
            .connection
            .prepare(&format!("EXPLAIN QUERY PLAN {statement}"))
            .map_err(fault)?;
        let count = prepared.parameter_count();
        let mut query = prepared
            .query(rusqlite::params_from_iter(std::iter::repeat_n(
                rusqlite::types::Null,
                count,
            )))
            .map_err(fault)?;
        let mut out = Vec::new();
        while let Some(row) = query.next().map_err(fault)? {
            out.push(row.get::<_, String>(3).map_err(fault)?);
        }
        Ok(out)
    }

    /// The nonce table's rows as bytes, for a test that looks underneath.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn nonce_rows(&self) -> Result<Vec<Vec<u8>>, StoreFault> {
        rows(&self.connection, sql::NONCE_ROWS_SELECT, [], |row| {
            let mut bytes: Vec<u8> = row.get(0).map_err(fault)?;
            bytes.extend_from_slice(&row.get::<_, i64>(1).map_err(fault)?.to_be_bytes());
            Ok(bytes)
        })
    }

    /// The epochs of a vault's tokens, for a test that looks underneath.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn token_epochs(&self, vault: &VaultId) -> Result<Vec<u64>, StoreFault> {
        rows(
            &self.connection,
            sql::TOKEN_EPOCHS_SELECT,
            params![vault.as_bytes()],
            |row| unsigned(row.get(0).map_err(fault)?),
        )
    }

    /// How many revoked-token tombstones a vault keeps.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn revoked_count(&self, vault: &VaultId) -> Result<u64, StoreFault> {
        self.count(sql::REVOKED_COUNT, params![vault.as_bytes()])
    }
}

impl State for SqliteState {
    fn atomically<T>(
        &mut self,
        op: impl FnOnce(&mut Self) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        self.connection.execute_batch(sql::BEGIN).map_err(fault)?;
        self.begun.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match op(self) {
            Ok(value) => {
                if let Err(error) = self.connection.execute_batch(sql::COMMIT) {
                    let _ = self.connection.execute_batch(sql::ROLLBACK);
                    return Err(fault(error).into());
                }
                Ok(value)
            }
            Err(failure) => {
                self.connection
                    .execute_batch(sql::ROLLBACK)
                    .map_err(fault)?;
                Err(failure)
            }
        }
    }

    fn vault(&self, vault: &VaultId) -> Result<Option<VaultRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::VAULT_SELECT,
            params![vault.as_bytes()],
            vault_record,
        )?
        .pop())
    }

    fn put_vault(&mut self, record: &VaultRecord) -> Result<(), StoreFault> {
        self.run(
            sql::VAULT_UPSERT,
            params![
                record.vault.as_bytes(),
                signed(record.writer_epoch)?,
                record.paired_at_ms,
                record.moved_at_ms,
                signed(record.generation)?,
                signed(record.writes)?,
                record.frozen_at_ms,
            ],
        )?;
        Ok(())
    }

    fn vaults(&self, after: Option<&VaultId>, page: usize) -> Result<Vec<VaultRecord>, StoreFault> {
        rows(
            &self.connection,
            sql::VAULTS_SELECT,
            params![
                after.map_or(BEFORE_ANY, |vault| &vault.as_bytes()[..]),
                limit(page)
            ],
            vault_record,
        )
    }

    fn remove_vault(&mut self, vault: &VaultId) -> Result<(), StoreFault> {
        // The tables hang off the vault with cascades; the keys run
        // head -> snapshot -> object, so the head and snapshots go first.
        self.remove_heads_and_snapshots(vault)?;
        self.run(sql::VAULT_DELETE, params![vault.as_bytes()])?;
        Ok(())
    }

    fn token(&self, hash: &TokenHash) -> Result<Option<TokenRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::TOKEN_SELECT,
            params![hash.as_bytes()],
            token_record,
        )?
        .pop())
    }

    fn put_token(&mut self, record: &TokenRecord) -> Result<(), StoreFault> {
        self.run(
            sql::TOKEN_INSERT,
            params![
                record.hash.as_bytes(),
                record.vault.as_bytes(),
                signed(record.epoch)?,
                record.kind.as_str(),
                record.label,
                record.created_at_ms,
            ],
        )?;
        Ok(())
    }

    fn remove_token(&mut self, hash: &TokenHash) -> Result<bool, StoreFault> {
        Ok(self.run(sql::TOKEN_DELETE, params![hash.as_bytes()])? > 0)
    }

    fn tokens_of(
        &self,
        vault: &VaultId,
        after: Option<(i64, &TokenHash)>,
        page: usize,
    ) -> Result<Vec<TokenRecord>, StoreFault> {
        rows(
            &self.connection,
            sql::TOKENS_OF_SELECT,
            params![
                vault.as_bytes(),
                after.map_or(i64::MIN, |(at, _)| at),
                after.map_or(BEFORE_ANY, |(_, hash)| &hash.as_bytes()[..]),
                limit(page)
            ],
            token_record,
        )
    }

    fn take_tokens(&mut self, vault: &VaultId) -> Result<Vec<TokenRecord>, StoreFault> {
        let mut taken = Vec::new();
        loop {
            let page = self.tokens_of(
                vault,
                taken
                    .last()
                    .map(|last: &TokenRecord| (last.created_at_ms, &last.hash)),
                1_000,
            )?;
            let done = page.len() < 1_000;
            taken.extend(page);
            if done {
                break;
            }
        }
        self.run(sql::TOKENS_OF_DELETE, params![vault.as_bytes()])?;
        Ok(taken)
    }

    fn revoked_token(&self, hash: &TokenHash) -> Result<Option<RevokedToken>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::REVOKED_SELECT,
            params![hash.as_bytes()],
            |row| {
                Ok(RevokedToken {
                    hash: TokenHash::from_bytes(blob(row, 0)?),
                    vault: VaultId::from_bytes(blob(row, 1)?),
                    epoch: unsigned(row.get(2).map_err(fault)?)?,
                    revoked_at_ms: row.get(3).map_err(fault)?,
                })
            },
        )?
        .pop())
    }

    fn put_revoked(&mut self, record: &RevokedToken) -> Result<(), StoreFault> {
        self.run(
            sql::REVOKED_UPSERT,
            params![
                record.hash.as_bytes(),
                record.vault.as_bytes(),
                signed(record.epoch)?,
                record.revoked_at_ms
            ],
        )?;
        Ok(())
    }

    fn trim_revoked(&mut self, vault: &VaultId, keep: u64) -> Result<(), StoreFault> {
        self.run(sql::REVOKED_TRIM, params![vault.as_bytes(), signed(keep)?])?;
        Ok(())
    }

    fn prune_revoked(&mut self, before_ms: i64) -> Result<u64, StoreFault> {
        Ok(self.run(sql::REVOKED_PRUNE, params![before_ms])? as u64)
    }

    fn claim(&self, vault: &VaultId) -> Result<Option<ClaimRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::CLAIM_SELECT,
            params![vault.as_bytes()],
            |row| {
                Ok(ClaimRecord {
                    vault: VaultId::from_bytes(blob(row, 0)?),
                    epoch: unsigned(row.get(1).map_err(fault)?)?,
                    head_seen: optional_name(row, 2)?,
                    nonce: Nonce::from_bytes(blob(row, 3)?),
                    signature: Signature::from_bytes(blob(row, 4)?),
                    claimed_at_ms: row.get(5).map_err(fault)?,
                })
            },
        )?
        .pop())
    }

    fn put_claim(&mut self, record: &ClaimRecord) -> Result<(), StoreFault> {
        self.run(
            sql::CLAIM_UPSERT,
            params![
                record.vault.as_bytes(),
                signed(record.epoch)?,
                record.head_seen.as_ref().map(Name::as_bytes),
                record.nonce.as_bytes(),
                record.signature.as_bytes(),
                record.claimed_at_ms,
            ],
        )?;
        Ok(())
    }

    fn put_nonce(&mut self, nonce: &Nonce, issued_at_ms: i64) -> Result<(), StoreFault> {
        self.run(sql::NONCE_INSERT, params![nonce.as_bytes(), issued_at_ms])?;
        Ok(())
    }

    fn take_nonce(&mut self, nonce: &Nonce, not_before_ms: i64) -> Result<bool, StoreFault> {
        let issued: Option<i64> = self
            .connection
            .prepare_cached(sql::NONCE_TAKE)
            .and_then(|mut prepared| {
                prepared
                    .query_row(params![nonce.as_bytes()], |row| row.get(0))
                    .optional()
            })
            .map_err(fault)?;
        Ok(issued.is_some_and(|issued| issued > not_before_ms))
    }

    fn live_nonces(&self, not_before_ms: i64) -> Result<u64, StoreFault> {
        self.count(sql::NONCE_COUNT, params![not_before_ms])
    }

    fn prune_nonces(&mut self, before_ms: i64) -> Result<u64, StoreFault> {
        Ok(self.run(sql::NONCE_PRUNE, params![before_ms])? as u64)
    }

    fn secret(&self, hash: &SecretHash) -> Result<Option<SecretRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::SECRET_SELECT,
            params![hash.as_bytes()],
            secret_record,
        )?
        .pop())
    }

    fn put_secret(&mut self, record: &SecretRecord) -> Result<(), StoreFault> {
        self.run(
            sql::SECRET_UPSERT,
            params![
                record.hash.as_bytes(),
                record.created_at_ms,
                record.expires_at_ms,
                record.used_at_ms,
                record.used_by.as_ref().map(VaultId::as_bytes),
            ],
        )?;
        Ok(())
    }

    fn secrets(
        &self,
        after: Option<(i64, &SecretHash)>,
        page: usize,
    ) -> Result<Vec<SecretRecord>, StoreFault> {
        rows(
            &self.connection,
            sql::SECRETS_SELECT,
            params![
                after.map_or(i64::MIN, |(at, _)| at),
                after.map_or(BEFORE_ANY, |(_, hash)| &hash.as_bytes()[..]),
                limit(page)
            ],
            secret_record,
        )
    }

    fn live_secrets(&self, now_ms: i64) -> Result<u64, StoreFault> {
        self.count(sql::SECRETS_LIVE_COUNT, params![now_ms])
    }

    fn oldest_live_secret(&self, now_ms: i64) -> Result<Option<SecretRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::SECRET_OLDEST_LIVE,
            params![now_ms],
            secret_record,
        )?
        .pop())
    }

    fn remove_secret(&mut self, hash: &SecretHash) -> Result<(), StoreFault> {
        self.run(sql::SECRET_DELETE, params![hash.as_bytes()])?;
        Ok(())
    }

    fn prune_secrets(
        &mut self,
        used_before_ms: i64,
        expired_before_ms: i64,
    ) -> Result<u64, StoreFault> {
        Ok(self.run(
            sql::SECRETS_PRUNE,
            params![used_before_ms, expired_before_ms],
        )? as u64)
    }

    fn head(&self, vault: &VaultId) -> Result<Option<HeadRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::HEAD_SELECT,
            params![vault.as_bytes()],
            |row| {
                Ok(HeadRecord {
                    name: Name::from_bytes(blob(row, 0)?),
                    prev: optional_name(row, 1)?,
                    taken_at_ms: row.get(2).map_err(fault)?,
                    epoch: unsigned(row.get(3).map_err(fault)?)?,
                    generation: unsigned(row.get(4).map_err(fault)?)?,
                    writes: unsigned(row.get(5).map_err(fault)?)?,
                    set_at_ms: row.get(6).map_err(fault)?,
                    signature: Signature::from_bytes(blob(row, 7)?),
                })
            },
        )?
        .pop())
    }

    fn put_head(&mut self, vault: &VaultId, head: &HeadRecord) -> Result<(), StoreFault> {
        self.run(
            sql::HEAD_UPSERT,
            params![
                vault.as_bytes(),
                head.name.as_bytes(),
                head.prev.as_ref().map(Name::as_bytes),
                head.taken_at_ms,
                signed(head.epoch)?,
                signed(head.generation)?,
                signed(head.writes)?,
                head.set_at_ms,
                head.signature.as_bytes(),
            ],
        )?;
        Ok(())
    }

    fn snapshot(&self, vault: &VaultId, name: &Name) -> Result<Option<SnapshotRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::SNAPSHOT_SELECT,
            params![vault.as_bytes(), name.as_bytes()],
            snapshot_record,
        )?
        .pop())
    }

    fn snapshots(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        page: usize,
    ) -> Result<Vec<SnapshotRecord>, StoreFault> {
        rows(
            &self.connection,
            sql::SNAPSHOTS_SELECT,
            params![
                vault.as_bytes(),
                after.map_or(BEFORE_ANY, |name| &name.as_bytes()[..]),
                limit(page)
            ],
            snapshot_record,
        )
    }

    fn put_snapshot(
        &mut self,
        vault: &VaultId,
        snapshot: &SnapshotRecord,
    ) -> Result<(), StoreFault> {
        self.run(
            sql::SNAPSHOT_UPSERT,
            params![
                vault.as_bytes(),
                snapshot.name.as_bytes(),
                snapshot.taken_at_ms,
                snapshot.registered_at_ms,
                signed(snapshot.epoch)?,
                signed(snapshot.generation)?,
                signed(snapshot.writes)?,
                snapshot.prev.as_ref().map(Name::as_bytes),
                snapshot.signature.as_bytes(),
                snapshot.hold.map(|hold| hold.at_ms),
                snapshot.hold.map(|hold| hold.purge_after_ms),
            ],
        )?;
        Ok(())
    }

    fn remove_snapshot(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault> {
        self.run(
            sql::SNAPSHOT_DELETE,
            params![vault.as_bytes(), name.as_bytes()],
        )?;
        Ok(())
    }

    fn remove_heads_and_snapshots(&mut self, vault: &VaultId) -> Result<(), StoreFault> {
        self.run(sql::HEAD_DELETE, params![vault.as_bytes()])?;
        self.run(sql::SNAPSHOTS_DELETE_VAULT, params![vault.as_bytes()])?;
        self.run(sql::CLAIM_DELETE, params![vault.as_bytes()])?;
        self.run(sql::REVOKED_DELETE_VAULT, params![vault.as_bytes()])?;
        Ok(())
    }

    fn object(&self, vault: &VaultId, name: &Name) -> Result<Option<ObjectRecord>, StoreFault> {
        Ok(rows(
            &self.connection,
            sql::OBJECT_SELECT,
            params![vault.as_bytes(), name.as_bytes()],
            |row| object_record(row, 0),
        )?
        .pop())
    }

    fn put_object(&mut self, vault: &VaultId, record: &ObjectRecord) -> Result<(), StoreFault> {
        self.run(
            sql::OBJECT_UPSERT,
            params![
                vault.as_bytes(),
                record.name.as_bytes(),
                record.digest.as_bytes(),
                signed(record.size)?,
                record.stored_at_ms,
                record.hold.map(|hold| hold.at_ms),
                record.hold.map(|hold| hold.purge_after_ms),
                record.damaged_at_ms,
            ],
        )?;
        Ok(())
    }

    fn remove_object(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault> {
        self.run(
            sql::OBJECT_DELETE,
            params![vault.as_bytes(), name.as_bytes()],
        )?;
        Ok(())
    }

    fn set_hold(
        &mut self,
        vault: &VaultId,
        name: &Name,
        hold: Option<Hold>,
    ) -> Result<(), StoreFault> {
        let (at, until) = (
            hold.map(|hold| hold.at_ms),
            hold.map(|hold| hold.purge_after_ms),
        );
        self.run(
            sql::HOLD_OBJECT_SET,
            params![vault.as_bytes(), name.as_bytes(), at, until],
        )?;
        self.run(
            sql::HOLD_SNAPSHOT_SET,
            params![vault.as_bytes(), name.as_bytes(), at, until],
        )?;
        Ok(())
    }

    fn live_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        page: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault> {
        rows(
            &self.connection,
            sql::OBJECTS_LIVE_SELECT,
            params![
                vault.as_bytes(),
                after.map_or(BEFORE_ANY, |name| &name.as_bytes()[..]),
                limit(page)
            ],
            |row| object_record(row, 0),
        )
    }

    fn held_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        page: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault> {
        rows(
            &self.connection,
            sql::OBJECTS_HELD_SELECT,
            params![
                vault.as_bytes(),
                after.map_or(BEFORE_ANY, |name| &name.as_bytes()[..]),
                limit(page)
            ],
            |row| object_record(row, 0),
        )
    }

    fn vault_objects(
        &self,
        vault: &VaultId,
        after: Option<&Name>,
        page: usize,
    ) -> Result<Vec<ObjectRecord>, StoreFault> {
        rows(
            &self.connection,
            sql::OBJECTS_VAULT_SELECT,
            params![
                vault.as_bytes(),
                after.map_or(BEFORE_ANY, |name| &name.as_bytes()[..]),
                limit(page)
            ],
            |row| object_record(row, 0),
        )
    }

    fn all_objects(
        &self,
        after: Option<(&VaultId, &Name)>,
        page: usize,
    ) -> Result<Vec<(VaultId, ObjectRecord)>, StoreFault> {
        rows(
            &self.connection,
            sql::OBJECTS_ALL_SELECT,
            params![
                after.map_or(BEFORE_ANY, |(vault, _)| &vault.as_bytes()[..]),
                after.map_or(BEFORE_ANY, |(_, name)| &name.as_bytes()[..]),
                limit(page)
            ],
            |row| Ok((VaultId::from_bytes(blob(row, 0)?), object_record(row, 1)?)),
        )
    }

    fn purgeable(
        &self,
        after: Option<(i64, &VaultId, &Name)>,
        now_ms: i64,
        page: usize,
    ) -> Result<Vec<(i64, VaultId, Name)>, StoreFault> {
        rows(
            &self.connection,
            sql::PURGEABLE_SELECT,
            params![
                after.map_or(i64::MIN, |(at, _, _)| at),
                after.map_or(BEFORE_ANY, |(_, vault, _)| &vault.as_bytes()[..]),
                after.map_or(BEFORE_ANY, |(_, _, name)| &name.as_bytes()[..]),
                now_ms,
                limit(page)
            ],
            |row| {
                Ok((
                    row.get(0).map_err(fault)?,
                    VaultId::from_bytes(blob(row, 1)?),
                    Name::from_bytes(blob(row, 2)?),
                ))
            },
        )
    }

    fn clear_holds(&mut self, vault: &VaultId) -> Result<u64, StoreFault> {
        let cleared = self.run(sql::HOLDS_CLEAR_OBJECTS, params![vault.as_bytes()])?;
        self.run(sql::HOLDS_CLEAR_SNAPSHOTS, params![vault.as_bytes()])?;
        Ok(cleared as u64)
    }

    fn shift_holds(&mut self, vault: &VaultId, delta_ms: i64) -> Result<(), StoreFault> {
        self.run(
            sql::HOLDS_SHIFT_OBJECTS,
            params![vault.as_bytes(), delta_ms],
        )?;
        self.run(
            sql::HOLDS_SHIFT_SNAPSHOTS,
            params![vault.as_bytes(), delta_ms],
        )?;
        Ok(())
    }

    fn make_holds_due(&mut self, vault: &VaultId, due_ms: i64) -> Result<u64, StoreFault> {
        let made = self.run(sql::HOLDS_DUE_OBJECTS, params![vault.as_bytes(), due_ms])?;
        self.run(sql::HOLDS_DUE_SNAPSHOTS, params![vault.as_bytes(), due_ms])?;
        Ok(made as u64)
    }

    fn rebase_holds(&mut self, purge_after_ms: i64) -> Result<(), StoreFault> {
        self.run(sql::HOLDS_REBASE_OBJECTS, params![purge_after_ms])?;
        self.run(sql::HOLDS_REBASE_SNAPSHOTS, params![purge_after_ms])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::engine::Gateway;
    use crate::rules::ids::GatewayId;

    /// A refusal inside `atomically` leaves nothing behind: the write before
    /// it is rolled back with it.
    #[test]
    fn a_refused_operation_writes_nothing() {
        let mut state = SqliteState::in_memory().expect("opens");
        let vault = VaultId::from_bytes([1; 32]);
        let outcome: Result<(), Fault> = state.atomically(|state| {
            state.put_vault(&VaultRecord::founded(vault, 0))?;
            Err(crate::rules::code::Refusal::BadRequest.into())
        });
        assert!(outcome.is_err());
        assert_eq!(state.vault(&vault).expect("reads"), None);
    }

    /// Every record survives the round trip through its columns.
    #[test]
    fn records_round_trip_through_their_columns() {
        let mut state = SqliteState::in_memory().expect("opens");
        let vault = VaultId::from_bytes([1; 32]);
        let record = VaultRecord {
            vault,
            writer_epoch: 3,
            paired_at_ms: 10,
            moved_at_ms: Some(20),
            generation: 7,
            writes: 9,
            frozen_at_ms: Some(30),
        };
        state.put_vault(&record).expect("writes");
        assert_eq!(state.vault(&vault).expect("reads"), Some(record));
        let object = ObjectRecord {
            name: Name::from_bytes([2; 32]),
            digest: Digest::of(b"sealed"),
            size: 6,
            stored_at_ms: 30,
            hold: Some(Hold {
                at_ms: 40,
                purge_after_ms: 50,
            }),
            damaged_at_ms: Some(45),
        };
        state.put_object(&vault, &object).expect("writes");
        assert_eq!(
            state.object(&vault, &object.name).expect("reads"),
            Some(object)
        );
        assert_eq!(
            state.purgeable(None, 50, 10).expect("reads"),
            vec![(50, vault, object.name)]
        );
        assert!(
            state
                .live_objects(&vault, None, 10)
                .expect("reads")
                .is_empty()
        );
        let snapshot = SnapshotRecord {
            name: object.name,
            taken_at_ms: 1,
            registered_at_ms: 2,
            epoch: 3,
            generation: 4,
            writes: 5,
            prev: Some(Name::from_bytes([9; 32])),
            signature: Signature::from_bytes([8; 64]),
            hold: object.hold,
        };
        state.put_snapshot(&vault, &snapshot).expect("writes");
        assert_eq!(
            state.snapshot(&vault, &snapshot.name).expect("reads"),
            Some(snapshot)
        );
        let head = HeadRecord {
            name: object.name,
            prev: snapshot.prev,
            taken_at_ms: 1,
            epoch: 3,
            generation: 4,
            writes: 5,
            set_at_ms: 2,
            signature: snapshot.signature,
        };
        state.put_head(&vault, &head).expect("writes");
        assert_eq!(state.head(&vault).expect("reads"), Some(head));
    }

    /// The rules run over SQLite exactly as they do over memory: one pairing,
    /// end to end.
    #[test]
    fn the_rules_run_over_sqlite() {
        let gateway_id = GatewayId::from_bytes([3; 16]);
        let mut gateway = Gateway::new(SqliteState::in_memory().expect("opens"), gateway_id);
        let secret = crate::rules::ids::Secret::from_bytes([4; 16]);
        gateway.mint_secret(&secret, 0).expect("mints");
        let nonce = Nonce::from_bytes([7; 16]);
        gateway.issue_nonce(&nonce, 0).expect("issues");
        let key = ed25519_dalek::SigningKey::from_bytes(&[5; 32]);
        let request = crate::rules::wire::PairRequest {
            vault_id: VaultId::from_bytes(key.verifying_key().to_bytes()),
            label: "phone".to_owned(),
            kind: PairKind::Secret,
            nonce,
            secret: Some(crate::rules::wire::SecretBody {
                secret,
                signature: crate::rules::signing::sign_pair(&key, &gateway_id, &secret, &nonce),
            }),
            claim: None,
            read: None,
        };
        let token = crate::rules::ids::Token::from_bytes([6; 32]);
        let paired = gateway.pair(&request, &token, 1).expect("pairs");
        assert_eq!(paired.epoch, 1);
        let vault = VaultId::from_bytes(key.verifying_key().to_bytes());
        let tokens = gateway.state.tokens_of(&vault, None, 10).expect("reads");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].hash, token.hash());
    }
}
