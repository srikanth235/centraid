//! `StateStore` over one SQLite file (#1029 §3).
//!
//! **This module stores; it does not decide.** Every value it writes was
//! produced by a rule in `centraid-gateway-core`, and every value it reads goes
//! straight back to one. The only judgement here is how a typed field becomes a
//! column and back, and the only correctness property it owns is the one the
//! port says is the adapter's:
//!
//! # THE COMPARE-AND-SET IS `BEGIN IMMEDIATE` (F7)
//!
//! [`StateStore::compare_and_set_head`] is the one operation whose atomicity a
//! pure function cannot supply. A single-request-at-a-time store gets it from running one
//! request at a time; this gets it from taking SQLite's write lock *before* the
//! read, so the read and the write are one step and a second writer waits
//! instead of reading a head that is about to move. The rule inside the
//! transaction is still `commit::compare_and_set` — three mechanisms, one rule.
//!
//! An implementation that read the head, decided in Rust and then wrote is the
//! bug the port exists to prevent, and `BEGIN DEFERRED` would be that bug with
//! a transaction around it: a deferred transaction takes a read lock first and
//! upgrades, which SQLite answers with `SQLITE_BUSY` and a retry loop that a
//! careless author turns into exactly the read-decide-write it was avoiding.
//!
//! # THE GATEWAY IS BLIND, AND THIS FILE IS WHERE THAT IS CHECKED
//!
//! Every column written here is a public key, a hash of ciphertext, a padded
//! size, a state word or a millisecond. There is no plaintext, no plaintext
//! hash and no key, and `tests/canary.rs` reads this file back with a planted
//! plaintext to prove it.

use std::path::Path;

use centraid_gateway_core::checksum::AttestedChecksum;
use centraid_gateway_core::commit;
use centraid_gateway_core::ids::{AccountId, Generation, Key32, ObjectKind, ObjectName, VaultId};
use centraid_gateway_core::lease::{Lease, LeaseState};
use centraid_gateway_core::plan::Plan;
use centraid_gateway_core::retention::BaseRecord;
use centraid_gateway_core::store::{ObjectState, StateStore, StoreFault, StoredObject, VaultState};
use centraid_gateway_core::time::ServerTime;
use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};

use crate::sql;

/// The gateway's state, in one SQLite file.
///
/// # WHY THE CONNECTION IS BEHIND A MUTEX
///
/// `rusqlite::Connection` is `Send` and **not** `Sync`, and the HTTP surface
/// holds the whole gateway across an `await`. A handler's future is only `Send`
/// if what it borrows is `Sync`, so without this the axum layer would not
/// compile at all — which is the compiler catching something true rather than
/// being awkward: a `&Connection` is not safe to use from two threads.
///
/// The lock is taken and released inside each method and is **never held across
/// an `await`**: every rusqlite call is synchronous, so the port's `async` is
/// only the shape the trait needs for a Worker's sake.
#[derive(Debug)]
pub struct SqliteState {
    connection: std::sync::Mutex<Connection>,
}

impl SqliteState {
    /// Open or create the state file and apply both schemas.
    ///
    /// # Errors
    ///
    /// A store fault if the file cannot be opened or the schema cannot be
    /// applied.
    pub fn open(path: &Path) -> Result<Self, StoreFault> {
        let connection = Connection::open(path).map_err(fault)?;
        Self::prepared(connection)
    }

    /// The same store, in memory. Used by the conformance harness, which resets
    /// between cases and must not leave a file behind for the next one.
    ///
    /// # Errors
    ///
    /// A store fault if the schema cannot be applied.
    pub fn in_memory() -> Result<Self, StoreFault> {
        Self::prepared(Connection::open_in_memory().map_err(fault)?)
    }

    fn prepared(connection: Connection) -> Result<Self, StoreFault> {
        // WAL so a reader (a scrub sweep) does not block the writer, and
        // `foreign_keys` so the schema's ON DELETE rules are real rather than
        // decorative — SQLite leaves them off by default and a schema whose
        // cascades never fire is a schema that documents a promise it does not
        // keep.
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(fault)?;
        connection
            .pragma_update(None, "foreign_keys", true)
            .map_err(fault)?;
        // A writer that finds the lock held waits rather than failing the
        // phone's commit. The compare-and-set is the only place two writers
        // meet, and it is short.
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(fault)?;
        connection
            .execute_batch(centraid_gateway_core::SCHEMA_SQL)
            .map_err(fault)?;
        connection
            .execute_batch(sql::STANDALONE_SCHEMA)
            .map_err(fault)?;
        Ok(Self {
            connection: std::sync::Mutex::new(connection),
        })
    }

    /// The connection, for the invite table and the admin reads that are this
    /// adapter's rather than the protocol's.
    ///
    /// # Errors
    ///
    /// A store fault if the lock was poisoned by a panic in another thread.
    pub fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, StoreFault> {
        self.connection
            .lock()
            .map_err(|_| StoreFault::new("the state connection lock was poisoned"))
    }

    /// Every vault this server holds, for the sweeps.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn vaults(&self) -> Result<Vec<VaultId>, StoreFault> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(sql::VAULTS_SELECT).map_err(fault)?;
        let rows = statement
            .query_map([], |row| row.get::<_, Vec<u8>>(0))
            .map_err(fault)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(key32(&row.map_err(fault)?)?);
        }
        Ok(out)
    }

    /// Everything in the state file, rendered. The canary's second window, and
    /// deliberately the widest one this adapter can open on itself.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn dump(&self) -> Result<String, StoreFault> {
        let connection = self.connection()?;
        let mut tables = connection.prepare(sql::TABLES_SELECT).map_err(fault)?;
        let names: Vec<String> = tables
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(fault)?
            .collect::<Result<_, _>>()
            .map_err(fault)?;
        drop(tables);

        let mut out = String::new();
        for name in names {
            // The table name came out of SQLite's own catalogue, never out of a
            // request, and the statement is `contracts/gateway/queries/`'s.
            let mut rows = connection.prepare(&sql::table_dump(&name)).map_err(fault)?;
            let count = rows.column_count();
            let mut query = rows.query([]).map_err(fault)?;
            while let Some(row) = query.next().map_err(fault)? {
                out.push_str(&name);
                for index in 0..count {
                    let value: rusqlite::types::Value = row.get(index).map_err(fault)?;
                    out.push('|');
                    match value {
                        rusqlite::types::Value::Null => out.push_str("NULL"),
                        rusqlite::types::Value::Integer(number) => {
                            out.push_str(&number.to_string());
                        }
                        rusqlite::types::Value::Real(number) => {
                            out.push_str(&number.to_string());
                        }
                        rusqlite::types::Value::Text(text) => out.push_str(&text),
                        rusqlite::types::Value::Blob(bytes) => {
                            out.push_str(&hex::encode(&bytes));
                        }
                    }
                }
                out.push('\n');
            }
        }
        Ok(out)
    }

    /// The raw file bytes, for the canary's rawest read.
    ///
    /// # Errors
    ///
    /// A store fault if the file cannot be read.
    pub fn file_bytes(path: &Path) -> Result<Vec<u8>, StoreFault> {
        std::fs::read(path).map_err(|error| StoreFault::new(error.to_string()))
    }
}

fn fault(error: rusqlite::Error) -> StoreFault {
    StoreFault::new(error.to_string())
}

fn key32(bytes: &[u8]) -> Result<Key32, StoreFault> {
    Key32::from_slice(bytes).ok_or_else(|| StoreFault::new("a stored key is not 32 bytes"))
}

/// The column value for an object state.
const fn object_state_word(state: ObjectState) -> &'static str {
    match state {
        ObjectState::Declared => "declared",
        ObjectState::Committed => "committed",
        ObjectState::Tombstoned { .. } => "tombstoned",
    }
}

/// An object kind, back from its column value.
///
/// `ObjectKind::as_str` is the forward direction and lives in `gateway-core`
/// so both adapters spell it the same way; this is its inverse, and an unknown
/// word is a fault rather than a guess — a gateway that guessed a kind would be
/// a gateway guessing at retention.
fn object_kind_of(word: &str) -> Result<ObjectKind, StoreFault> {
    for kind in [
        ObjectKind::Base,
        ObjectKind::Segment,
        ObjectKind::Manifest,
        ObjectKind::Blob,
        ObjectKind::Pack,
    ] {
        if kind.as_str() == word {
            return Ok(kind);
        }
    }
    Err(StoreFault::new(format!("unknown object kind {word:?}")))
}

fn stored_object(row: &Row<'_>) -> Result<StoredObject, StoreFault> {
    let name = key32(&row.get::<_, Vec<u8>>(0).map_err(fault)?)?;
    let checksum_bytes: Vec<u8> = row.get(1).map_err(fault)?;
    let checksum = AttestedChecksum::from_slice(&checksum_bytes)
        .ok_or_else(|| StoreFault::new("a stored checksum is not 32 bytes"))?;
    let kind = object_kind_of(&row.get::<_, String>(2).map_err(fault)?)?;
    let padded_size: i64 = row.get(3).map_err(fault)?;
    let state_word: String = row.get(4).map_err(fault)?;
    let received_at: i64 = row.get(5).map_err(fault)?;
    let purge_after: Option<i64> = row.get(6).map_err(fault)?;
    let generation_text: String = row.get(7).map_err(fault)?;

    let state = match state_word.as_str() {
        "declared" => ObjectState::Declared,
        "committed" => ObjectState::Committed,
        "tombstoned" => ObjectState::Tombstoned {
            purge_after: ServerTime::from_millis(
                purge_after
                    .ok_or_else(|| StoreFault::new("a tombstoned object has no purge_after_ms"))?,
            ),
        },
        other => return Err(StoreFault::new(format!("unknown object state {other:?}"))),
    };

    Ok(StoredObject {
        name,
        checksum,
        kind,
        padded_size: padded_size.try_into().unwrap_or(0),
        state,
        received_at: ServerTime::from_millis(received_at),
        generation: Generation::parse(&generation_text)
            .ok_or_else(|| StoreFault::new("a stored generation is not 32 hex characters"))?,
    })
}

/// `u64` into the `INTEGER` a STRICT column holds.
///
/// Saturating rather than wrapping: a padded size near `u64::MAX` is a
/// malformed declaration the rules already refused, and a wrap would store a
/// small number that looks legitimate.
fn as_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

impl StateStore for SqliteState {
    async fn vault(&self, vault: &VaultId) -> Result<Option<VaultState>, StoreFault> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(sql::VAULT_SELECT).map_err(fault)?;
        let row = statement
            .query_row(params![vault.as_bytes().as_slice()], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Option<Vec<u8>>>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<Vec<u8>>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                ))
            })
            .optional()
            .map_err(fault)?;
        let Some((
            vault_key,
            account_key,
            lease_device,
            lease_epoch,
            lease_taken,
            head,
            moved_at,
            append_only,
            used_bytes,
            quota_bytes,
        )) = row
        else {
            return Ok(None);
        };

        let current = match (lease_device, lease_epoch, lease_taken) {
            // Epoch 0 is "never claimed" (`lease.rs`), so a row with a device
            // and a zero epoch is a row from before the first claim.
            (Some(device), epoch, Some(taken)) if epoch > 0 => Some(Lease {
                device: key32(&device)?,
                epoch: epoch.try_into().unwrap_or(0),
                taken_at: ServerTime::from_millis(taken),
            }),
            _ => None,
        };

        Ok(Some(VaultState {
            vault: key32(&vault_key)?,
            account: key32(&account_key)?,
            lease: LeaseState {
                current,
                moved_at: moved_at.map(ServerTime::from_millis),
            },
            head: head.as_deref().map(key32).transpose()?,
            append_only: append_only != 0,
            plan: Plan {
                quota_bytes: quota_bytes.try_into().unwrap_or(0),
                used_bytes: used_bytes.try_into().unwrap_or(0),
            },
        }))
    }

    async fn put_vault(&mut self, state: &VaultState) -> Result<(), StoreFault> {
        let now = crate::clock::now().millis();
        // The account first: `vault.account_key` REFERENCES it, and with
        // `foreign_keys` on, the other order fails.
        self.connection()?
            .execute(
                sql::ACCOUNT_UPSERT,
                params![
                    state.account.as_bytes().as_slice(),
                    now,
                    as_i64(state.plan.quota_bytes),
                ],
            )
            .map_err(fault)?;
        self.connection()?
            .execute(
                sql::VAULT_UPSERT,
                params![
                    state.vault.as_bytes().as_slice(),
                    state.account.as_bytes().as_slice(),
                    now,
                    state
                        .lease
                        .current
                        .map(|lease| lease.device.as_bytes().to_vec()),
                    state
                        .lease
                        .current
                        .map_or(0_i64, |lease| as_i64(lease.epoch)),
                    state.lease.current.map(|lease| lease.taken_at.millis()),
                    state.head.map(|head| head.as_bytes().to_vec()),
                    state.head.map(|_| now),
                    state.lease.moved_at.map(ServerTime::millis),
                    i64::from(state.append_only),
                    as_i64(state.plan.used_bytes),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    async fn object(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredObject>, StoreFault> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(sql::OBJECT_SELECT).map_err(fault)?;
        let mut rows = statement
            .query(params![
                vault.as_bytes().as_slice(),
                name.as_bytes().as_slice()
            ])
            .map_err(fault)?;
        match rows.next().map_err(fault)? {
            Some(row) => Ok(Some(stored_object(row)?)),
            None => Ok(None),
        }
    }

    async fn put_object(
        &mut self,
        vault: &VaultId,
        object: &StoredObject,
    ) -> Result<(), StoreFault> {
        let purge_after = match object.state {
            ObjectState::Tombstoned { purge_after } => Some(purge_after.millis()),
            ObjectState::Declared | ObjectState::Committed => None,
        };
        let committed_at = match object.state {
            ObjectState::Declared => None,
            ObjectState::Committed | ObjectState::Tombstoned { .. } => {
                Some(object.received_at.millis())
            }
        };
        self.connection()?
            .execute(
                sql::OBJECT_UPSERT,
                params![
                    vault.as_bytes().as_slice(),
                    object.name.as_bytes().as_slice(),
                    object.checksum.as_bytes().as_slice(),
                    object.kind.as_str(),
                    as_i64(object.padded_size),
                    object_state_word(object.state),
                    object.received_at.millis(),
                    committed_at,
                    purge_after,
                    object.generation.as_str(),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    async fn objects(&self, vault: &VaultId) -> Result<Vec<StoredObject>, StoreFault> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(sql::OBJECTS_SELECT).map_err(fault)?;
        let mut rows = statement
            .query(params![vault.as_bytes().as_slice()])
            .map_err(fault)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(fault)? {
            out.push(stored_object(row)?);
        }
        Ok(out)
    }

    async fn bases(&self, vault: &VaultId) -> Result<Vec<BaseRecord>, StoreFault> {
        let key = vault.as_bytes().as_slice();
        let mut membership: Vec<(ObjectName, ObjectName)> = Vec::new();
        {
            let connection = self.connection()?;
            let mut statement = connection
                .prepare(sql::BASE_OBJECTS_SELECT)
                .map_err(fault)?;
            let mut rows = statement.query(params![key]).map_err(fault)?;
            while let Some(row) = rows.next().map_err(fault)? {
                membership.push((
                    key32(&row.get::<_, Vec<u8>>(0).map_err(fault)?)?,
                    key32(&row.get::<_, Vec<u8>>(1).map_err(fault)?)?,
                ));
            }
        }

        let connection = self.connection()?;
        let mut statement = connection.prepare(sql::BASES_SELECT).map_err(fault)?;
        let mut rows = statement.query(params![key]).map_err(fault)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(fault)? {
            let id = key32(&row.get::<_, Vec<u8>>(0).map_err(fault)?)?;
            let generation_text: String = row.get(1).map_err(fault)?;
            let received_at: i64 = row.get(2).map_err(fault)?;
            let padded_size: i64 = row.get(3).map_err(fault)?;
            let tombstoned: i64 = row.get(4).map_err(fault)?;
            out.push(BaseRecord {
                id,
                generation: Generation::parse(&generation_text).ok_or_else(|| {
                    StoreFault::new("a stored generation is not 32 hex characters")
                })?,
                received_at: ServerTime::from_millis(received_at),
                padded_size: padded_size.try_into().unwrap_or(0),
                objects: membership
                    .iter()
                    .filter(|(base, _)| *base == id)
                    .map(|(_, object)| *object)
                    .collect(),
                tombstoned: tombstoned != 0,
            });
        }
        Ok(out)
    }

    async fn put_base(&mut self, vault: &VaultId, base: &BaseRecord) -> Result<(), StoreFault> {
        let key = vault.as_bytes().to_vec();
        // One transaction: a base whose row landed and whose membership did not
        // is a base the floor would judge as empty.
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(fault)?;
        transaction
            .execute(
                sql::BASE_UPSERT,
                params![
                    key.as_slice(),
                    base.id.as_bytes().as_slice(),
                    base.generation.as_str(),
                    base.received_at.millis(),
                    as_i64(base.padded_size),
                    i64::from(base.tombstoned),
                ],
            )
            .map_err(fault)?;
        transaction
            .execute(
                sql::BASE_OBJECT_CLEAR,
                params![key.as_slice(), base.id.as_bytes().as_slice()],
            )
            .map_err(fault)?;
        for (ordinal, object) in base.objects.iter().enumerate() {
            transaction
                .execute(
                    sql::BASE_OBJECT_INSERT,
                    params![
                        key.as_slice(),
                        base.id.as_bytes().as_slice(),
                        object.as_bytes().as_slice(),
                        as_i64(ordinal as u64),
                    ],
                )
                .map_err(fault)?;
        }
        transaction.commit().map_err(fault)?;
        Ok(())
    }

    /// **THE COMPARE-AND-SET, UNDER `BEGIN IMMEDIATE`** (F7).
    ///
    /// The write lock is taken by the transaction's own first statement, before
    /// the head is read, so no second writer can read the same head and both
    /// win. The decision itself is `commit::compare_and_set` — the same
    /// function the in-memory adapter and the Worker call.
    async fn compare_and_set_head(
        &mut self,
        vault: &VaultId,
        expected: Option<ObjectName>,
        next: ObjectName,
    ) -> Result<Option<ObjectName>, StoreFault> {
        let key = vault.as_bytes().to_vec();
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(fault)?;

        let current: Option<Vec<u8>> = transaction
            .query_row(sql::HEAD_SELECT, params![key.as_slice()], |row| row.get(0))
            .optional()
            .map_err(fault)?
            .flatten();
        let current = current.as_deref().map(key32).transpose()?;

        if commit::compare_and_set(current, expected, next).is_ok() {
            transaction
                .execute(
                    sql::HEAD_UPDATE,
                    params![
                        key.as_slice(),
                        next.as_bytes().as_slice(),
                        crate::clock::now().millis(),
                    ],
                )
                .map_err(fault)?;
            transaction.commit().map_err(fault)?;
            return Ok(Some(next));
        }
        transaction.commit().map_err(fault)?;
        Ok(current)
    }

    async fn last_client_base_delete(
        &self,
        vault: &VaultId,
    ) -> Result<Option<ServerTime>, StoreFault> {
        let at: Option<i64> = self
            .connection()?
            .query_row(
                sql::CLIENT_BASE_DELETE_SELECT,
                params![vault.as_bytes().as_slice()],
                |row| row.get(0),
            )
            .optional()
            .map_err(fault)?;
        Ok(at.map(ServerTime::from_millis))
    }

    async fn record_client_base_delete(
        &mut self,
        vault: &VaultId,
        at: ServerTime,
    ) -> Result<(), StoreFault> {
        self.connection()?
            .execute(
                sql::CLIENT_BASE_DELETE_UPSERT,
                params![vault.as_bytes().as_slice(), at.millis()],
            )
            .map_err(fault)?;
        Ok(())
    }

    /// The per-object audit ledger. Four columns, every one of them already on
    /// the `object` row for the same object — what this adds is that it
    /// outlives the purge that removes that row.
    async fn record_client_delete(
        &mut self,
        vault: &VaultId,
        name: &ObjectName,
        kind: ObjectKind,
        at: ServerTime,
    ) -> Result<(), StoreFault> {
        self.connection()?
            .execute(
                sql::CLIENT_DELETE_INSERT,
                params![
                    vault.as_bytes().as_slice(),
                    name.as_bytes().as_slice(),
                    kind.as_str(),
                    at.millis(),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }
}

/// Register a vault and its account without going through a rule.
///
/// This is **admission**, which is the one thing the two deployments do
/// differently: the hosted adapter admits by purchase, and this one by an
/// invite the owner minted (Q13). Everything downstream is the shared schema
/// and the shared rules.
///
/// # Errors
///
/// A store fault.
pub async fn register(
    store: &mut SqliteState,
    vault: VaultId,
    account: AccountId,
    plan: Plan,
    // Q24: APPEND-ONLY IS OFF BY DEFAULT, and the default is
    // `crate::config::Config`'s rather than a literal here — a household that
    // turns it on is choosing that its phones can never prune, and a household
    // that never heard of it must not discover it as a backup that only grows.
    append_only: bool,
) -> Result<(), StoreFault> {
    store
        .put_vault(&VaultState {
            vault,
            account,
            lease: LeaseState::unclaimed(),
            head: None,
            append_only,
            plan,
        })
        .await
}
