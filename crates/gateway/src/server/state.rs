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

use crate::rules::ids::{Digest, Name, SecretHash, TokenHash, VaultId};
use crate::rules::state::{
    Fault, HeadRecord, ObjectRecord, SecretRecord, State, StoreFault, TokenRecord, Tombstone,
    VaultRecord,
};
use crate::rules::wire::{PairKind, SnapshotView};
use crate::server::sql;

/// The gateway's state in SQLite.
#[derive(Debug)]
pub struct SqliteState {
    connection: Connection,
}

/// The state file inside a data directory.
pub const STATE_FILE: &str = "state.db";

impl SqliteState {
    /// Open or create the state file and apply the schema.
    ///
    /// # Errors
    ///
    /// A store fault if the file cannot be opened or the schema applied.
    pub fn open(path: &Path) -> Result<Self, StoreFault> {
        Self::prepared(Connection::open(path).map_err(fault)?)
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
        connection.execute_batch(sql::SCHEMA).map_err(fault)?;
        Ok(Self { connection })
    }
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

fn kind_of(word: &str) -> Result<PairKind, StoreFault> {
    [PairKind::Secret, PairKind::Claim, PairKind::Read]
        .into_iter()
        .find(|kind| kind.as_str() == word)
        .ok_or_else(|| StoreFault::new(format!("an unknown token kind {word:?}")))
}

fn vault_record(row: &Row<'_>) -> Result<VaultRecord, StoreFault> {
    Ok(VaultRecord {
        vault: VaultId::from_bytes(blob(row, 0)?),
        writer_epoch: unsigned(row.get(1).map_err(fault)?)?,
        paired_at_ms: row.get(2).map_err(fault)?,
        moved_at_ms: row.get(3).map_err(fault)?,
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

/// An object row, its columns starting at `at`.
fn object_record(row: &Row<'_>, at: usize) -> Result<ObjectRecord, StoreFault> {
    let tombstoned_at: Option<i64> = row.get(at + 4).map_err(fault)?;
    let purge_after: Option<i64> = row.get(at + 5).map_err(fault)?;
    Ok(ObjectRecord {
        name: Name::from_bytes(blob(row, at)?),
        digest: Digest::from_bytes(blob(row, at + 1)?),
        size: unsigned(row.get(at + 2).map_err(fault)?)?,
        stored_at_ms: row.get(at + 3).map_err(fault)?,
        tombstone: match (tombstoned_at, purge_after) {
            (Some(at_ms), Some(purge_after_ms)) => Some(Tombstone {
                at_ms,
                purge_after_ms,
            }),
            _ => None,
        },
        damaged_at_ms: row.get(at + 6).map_err(fault)?,
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

impl State for SqliteState {
    fn atomically<T>(
        &mut self,
        op: impl FnOnce(&mut Self) -> Result<T, Fault>,
    ) -> Result<T, Fault> {
        self.connection.execute_batch(sql::BEGIN).map_err(fault)?;
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
        let writer_epoch = signed(record.writer_epoch)?;
        self.connection
            .prepare_cached(sql::VAULT_UPSERT)
            .and_then(|mut statement| {
                statement.execute(params![
                    record.vault.as_bytes(),
                    writer_epoch,
                    record.paired_at_ms,
                    record.moved_at_ms,
                ])
            })
            .map_err(fault)?;
        Ok(())
    }

    fn vaults(&self) -> Result<Vec<VaultRecord>, StoreFault> {
        rows(&self.connection, sql::VAULTS_SELECT, [], vault_record)
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
        let epoch = signed(record.epoch)?;
        self.connection
            .prepare_cached(sql::TOKEN_INSERT)
            .and_then(|mut statement| {
                statement.execute(params![
                    record.hash.as_bytes(),
                    record.vault.as_bytes(),
                    epoch,
                    record.kind.as_str(),
                    record.label,
                    record.created_at_ms,
                ])
            })
            .map_err(fault)?;
        Ok(())
    }

    fn remove_token(&mut self, hash: &TokenHash) -> Result<bool, StoreFault> {
        let removed = self
            .connection
            .prepare_cached(sql::TOKEN_DELETE)
            .and_then(|mut statement| statement.execute(params![hash.as_bytes()]))
            .map_err(fault)?;
        Ok(removed > 0)
    }

    fn tokens(&self) -> Result<Vec<TokenRecord>, StoreFault> {
        rows(&self.connection, sql::TOKENS_SELECT, [], token_record)
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
        self.connection
            .prepare_cached(sql::SECRET_UPSERT)
            .and_then(|mut statement| {
                statement.execute(params![
                    record.hash.as_bytes(),
                    record.created_at_ms,
                    record.expires_at_ms,
                    record.used_at_ms,
                    record.used_by.as_ref().map(VaultId::as_bytes),
                ])
            })
            .map_err(fault)?;
        Ok(())
    }

    fn secrets(&self) -> Result<Vec<SecretRecord>, StoreFault> {
        rows(&self.connection, sql::SECRETS_SELECT, [], secret_record)
    }

    fn head(&self, vault: &VaultId) -> Result<Option<HeadRecord>, StoreFault> {
        self.connection
            .prepare_cached(sql::HEAD_SELECT)
            .and_then(|mut statement| {
                statement
                    .query_row(params![vault.as_bytes()], |row| {
                        Ok((
                            row.get::<_, Vec<u8>>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })
                    .optional()
            })
            .map_err(fault)?
            .map(|(name, taken_at_ms, set_at_ms)| {
                Ok(HeadRecord {
                    name: Name::from_slice(&name)
                        .ok_or_else(|| StoreFault::new("a stored head has the wrong width"))?,
                    taken_at_ms,
                    set_at_ms,
                })
            })
            .transpose()
    }

    fn put_head(&mut self, vault: &VaultId, head: &HeadRecord) -> Result<(), StoreFault> {
        self.connection
            .prepare_cached(sql::HEAD_UPSERT)
            .and_then(|mut statement| {
                statement.execute(params![
                    vault.as_bytes(),
                    head.name.as_bytes(),
                    head.taken_at_ms,
                    head.set_at_ms,
                ])
            })
            .map_err(fault)?;
        Ok(())
    }

    fn snapshots(&self, vault: &VaultId) -> Result<Vec<SnapshotView>, StoreFault> {
        rows(
            &self.connection,
            sql::SNAPSHOTS_SELECT,
            params![vault.as_bytes()],
            |row| {
                Ok(SnapshotView {
                    name: Name::from_bytes(blob(row, 0)?),
                    taken_at_ms: row.get(1).map_err(fault)?,
                    registered_at_ms: row.get(2).map_err(fault)?,
                })
            },
        )
    }

    fn put_snapshot(&mut self, vault: &VaultId, snapshot: &SnapshotView) -> Result<(), StoreFault> {
        self.connection
            .prepare_cached(sql::SNAPSHOT_INSERT)
            .and_then(|mut statement| {
                statement.execute(params![
                    vault.as_bytes(),
                    snapshot.name.as_bytes(),
                    snapshot.taken_at_ms,
                    snapshot.registered_at_ms,
                ])
            })
            .map_err(fault)?;
        Ok(())
    }

    fn remove_snapshot(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault> {
        self.connection
            .prepare_cached(sql::SNAPSHOT_DELETE)
            .and_then(|mut statement| statement.execute(params![vault.as_bytes(), name.as_bytes()]))
            .map_err(fault)?;
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
        let size = signed(record.size)?;
        self.connection
            .prepare_cached(sql::OBJECT_UPSERT)
            .and_then(|mut statement| {
                statement.execute(params![
                    vault.as_bytes(),
                    record.name.as_bytes(),
                    record.digest.as_bytes(),
                    size,
                    record.stored_at_ms,
                    record.tombstone.map(|tombstone| tombstone.at_ms),
                    record.tombstone.map(|tombstone| tombstone.purge_after_ms),
                    record.damaged_at_ms,
                ])
            })
            .map_err(fault)?;
        Ok(())
    }

    fn remove_object(&mut self, vault: &VaultId, name: &Name) -> Result<(), StoreFault> {
        self.connection
            .prepare_cached(sql::OBJECT_DELETE)
            .and_then(|mut statement| statement.execute(params![vault.as_bytes(), name.as_bytes()]))
            .map_err(fault)?;
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
            params![vault.as_bytes(), after.map(Name::as_bytes), limit(page)],
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
                after.map(|(vault, _)| vault.as_bytes()),
                after.map(|(_, name)| name.as_bytes()),
                limit(page)
            ],
            |row| Ok((VaultId::from_bytes(blob(row, 0)?), object_record(row, 1)?)),
        )
    }

    fn purgeable(&self, now_ms: i64, page: usize) -> Result<Vec<(VaultId, Name)>, StoreFault> {
        rows(
            &self.connection,
            sql::PURGEABLE_SELECT,
            params![now_ms, limit(page)],
            |row| {
                Ok((
                    VaultId::from_bytes(blob(row, 0)?),
                    Name::from_bytes(blob(row, 1)?),
                ))
            },
        )
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
            state.put_vault(&VaultRecord {
                vault,
                writer_epoch: 1,
                paired_at_ms: 0,
                moved_at_ms: None,
            })?;
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
        };
        state.put_vault(&record).expect("writes");
        assert_eq!(state.vault(&vault).expect("reads"), Some(record));
        let object = ObjectRecord {
            name: Name::from_bytes([2; 32]),
            digest: Digest::of(b"sealed"),
            size: 6,
            stored_at_ms: 30,
            tombstone: Some(Tombstone {
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
            state.purgeable(50, 10).expect("reads"),
            vec![(vault, object.name)]
        );
        assert!(
            state
                .live_objects(&vault, None, 10)
                .expect("reads")
                .is_empty()
        );
        let head = HeadRecord {
            name: object.name,
            taken_at_ms: 1,
            set_at_ms: 2,
        };
        state.put_head(&vault, &head).expect("writes");
        assert_eq!(state.head(&vault).expect("reads"), Some(head));
    }

    /// The rules run over SQLite exactly as they do over memory: one pairing,
    /// end to end.
    #[test]
    fn the_rules_run_over_sqlite() {
        let mut gateway = Gateway::new(
            SqliteState::in_memory().expect("opens"),
            GatewayId::from_bytes([3; 16]),
        );
        let secret = crate::rules::ids::Secret::from_bytes([4; 16]);
        gateway.mint_secret(&secret, 0).expect("mints");
        let key = ed25519_dalek::SigningKey::from_bytes(&[5; 32]);
        let request = crate::rules::wire::PairRequest {
            vault_id: VaultId::from_bytes(key.verifying_key().to_bytes()),
            label: "phone".to_owned(),
            kind: PairKind::Secret,
            secret: Some(secret),
            claim: None,
            read: None,
        };
        let token = crate::rules::ids::Token::from_bytes([6; 32]);
        let paired = gateway.pair(&request, &token, 1).expect("pairs");
        assert_eq!(paired.epoch, 1);
        let tokens = gateway.state.tokens().expect("reads");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].hash, token.hash());
    }
}
