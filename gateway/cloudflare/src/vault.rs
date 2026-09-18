//! `StateStore` over one Durable Object's SQLite, one object per vault
//! (#1029 §3).
//!
//! **This module stores; it does not decide.** Every value it writes was
//! produced by a rule in `centraid-gateway-core`, and every value it reads goes
//! straight back to one. The only judgement here is how a typed field becomes a
//! column and back.
//!
//! # THE DURABLE OBJECT IS THE FENCE (F7)
//!
//! [`StateStore::compare_and_set_head`] is the one operation whose atomicity a
//! pure function cannot supply. The standalone adapter takes SQLite's write
//! lock with `BEGIN IMMEDIATE`; **this one needs no transaction at all**,
//! because a Durable Object runs one request at a time. There is exactly one
//! object per vault, every request for that vault is routed to it, and the
//! runtime delivers them one after another — so the read, the decision and the
//! write cannot be interleaved by anything. That is not a claim about this
//! code; it is the execution model, and it is why the hosted adapter was
//! designed around a Durable Object rather than around a shared database.
//!
//! The rule inside it is still `commit::compare_and_set` — the same function
//! the in-memory adapter and the standalone server call. **Three mechanisms,
//! one rule.**
//!
//! # ONE OBJECT PER VAULT, AND WHY NOT PER ITEM
//!
//! A Durable Object's SQLite caps at **10 GB**. Per-*object* index rows fit
//! comfortably: an object row is a name, a checksum, a kind, a size, a state
//! and two times — under 200 bytes — so ten million objects is about 2 GB, and
//! a vault with ten million objects is one holding 160 TB of bytes at the
//! 16 MiB cap. Per-*item* rows would not fit and are not here: the vault's own
//! item ledger is on the phone, where it is readable, and the gateway is blind.
//!
//! # THE GATEWAY IS BLIND, AND THIS FILE IS WHERE THAT IS CHECKED
//!
//! Every column written here is a public key, a hash of ciphertext, a padded
//! size, a state word or a millisecond. There is no plaintext, no plaintext
//! hash and no key, and the conformance suite's canary reads this object's
//! whole state back with a planted plaintext to prove it.

use centraid_gateway_core::checksum::AttestedChecksum;
use centraid_gateway_core::commit;
use centraid_gateway_core::ids::{Generation, Key32, ObjectKind, ObjectName, VaultId};
use centraid_gateway_core::lease::{Lease, LeaseState};
use centraid_gateway_core::plan::{self, Plan};
use centraid_gateway_core::retention::BaseRecord;
use centraid_gateway_core::store::{ObjectState, StateStore, StoreFault, StoredObject, VaultState};
use centraid_gateway_core::time::ServerTime;
use worker::{SqlStorage, SqlStorageValue};

use crate::sql;

/// The gateway's state for one vault, in one Durable Object's SQLite.
///
/// Holds a `SqlStorage` handle rather than any state of its own: the state is
/// in the database, and a cached copy in Rust would be a second answer that
/// could disagree with it.
pub struct DurableState {
    sql: SqlStorage,
}

impl core::fmt::Debug for DurableState {
    fn fmt(&self, formatter: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        formatter.write_str("DurableState")
    }
}

/// Tables a Durable Object keeps for itself. They are not ours and the canary's
/// dump skips them, so a future runtime column cannot be mistaken for something
/// this gateway wrote.
const RUNTIME_TABLE_PREFIXES: [&str; 2] = ["_cf_", "sqlite_"];

impl DurableState {
    /// Open the store and apply the **shared** schema.
    ///
    /// `CREATE TABLE IF NOT EXISTS` throughout, so this is idempotent and runs
    /// on every request rather than behind a "have I migrated" flag that could
    /// disagree with the database.
    ///
    /// # Errors
    ///
    /// A store fault if the schema cannot be applied.
    pub fn open(sql: SqlStorage) -> Result<Self, StoreFault> {
        // The whole schema in one `exec` with no bindings. It is the same
        // string `centraid_gateway_core::SCHEMA_SQL` hands the standalone
        // adapter — `contracts/gateway/schema.sql`, by `include_str!`.
        sql.exec(centraid_gateway_core::SCHEMA_SQL, None)
            .map_err(fault)?;
        Ok(Self { sql })
    }

    /// Throw everything away. **The conformance harness only**, and it is here
    /// rather than in the harness because only this module knows the table
    /// names — which it gets from SQLite's catalogue rather than a list.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn reset(&self) -> Result<(), StoreFault> {
        // CHILDREN FIRST, AND THAT IS NOT A DETAIL. A Durable Object's SQLite
        // **enforces foreign keys**, unlike a plain SQLite connection where
        // they are off until a pragma turns them on — so emptying `account`
        // while a `vault` row still references it fails with
        // `SQLITE_CONSTRAINT_TRIGGER`, and every case after it in the run
        // reports "setup failed" with nothing naming the cause. It is written
        // down here because that is exactly how it was found.
        //
        // `defer_foreign_keys` would be the other answer and is not available:
        // it defers only to the end of a transaction, and each `exec` here is
        // its own.
        //
        // The order is the schema's own: everything hangs off `vault`, and
        // `vault` hangs off `account`.
        const LAST: [&str; 2] = ["vault", "account"];
        let tables = self.tables()?;
        for table in tables.iter().filter(|name| !LAST.contains(&name.as_str())) {
            self.sql
                .exec(&sql::table_clear(table), None)
                .map_err(fault)?;
        }
        for table in LAST {
            if tables.iter().any(|name| name == table) {
                self.sql
                    .exec(&sql::table_clear(table), None)
                    .map_err(fault)?;
            }
        }
        Ok(())
    }

    fn tables(&self) -> Result<Vec<String>, StoreFault> {
        let cursor = self.sql.exec(sql::TABLES_SELECT, None).map_err(fault)?;
        let mut names = Vec::new();
        for row in cursor.raw() {
            let row = row.map_err(fault)?;
            if let Some(SqlStorageValue::String(name)) = row.first()
                && !RUNTIME_TABLE_PREFIXES
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            {
                names.push(name.clone());
            }
        }
        Ok(names)
    }

    /// Everything this object holds, rendered. **The canary's second window**,
    /// and deliberately the widest one this adapter can open on itself: every
    /// table, every row, every column, blobs in hex.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn dump(&self) -> Result<String, StoreFault> {
        let mut out = String::new();
        for table in self.tables()? {
            // The table name came out of SQLite's own catalogue, never out of a
            // request, and the statement is `contracts/gateway/queries/`'s.
            let cursor = self
                .sql
                .exec(&sql::table_dump(&table), None)
                .map_err(fault)?;
            for row in cursor.raw() {
                out.push_str(&table);
                for value in row.map_err(fault)? {
                    out.push('|');
                    match value {
                        SqlStorageValue::Null => out.push_str("NULL"),
                        SqlStorageValue::Boolean(flag) => out.push_str(&flag.to_string()),
                        SqlStorageValue::Integer(number) => out.push_str(&number.to_string()),
                        SqlStorageValue::Float(number) => out.push_str(&number.to_string()),
                        SqlStorageValue::String(text) => out.push_str(&text),
                        SqlStorageValue::Blob(bytes) => out.push_str(&hex::encode(&bytes)),
                    }
                }
                out.push('\n');
            }
        }
        Ok(out)
    }

    /// How many bytes this object's SQLite holds, against the 10 GB ceiling.
    /// Reported rather than enforced: the index cannot reach it (see the module
    /// docs), and a number an operator can watch is worth more than a guard
    /// that would never fire.
    #[must_use]
    pub fn database_size(&self) -> usize {
        self.sql.database_size()
    }

    fn query(
        &self,
        statement: &str,
        bindings: Vec<SqlStorageValue>,
    ) -> Result<Vec<Vec<SqlStorageValue>>, StoreFault> {
        let cursor = self.sql.exec(statement, bindings).map_err(fault)?;
        let mut rows = Vec::new();
        for row in cursor.raw() {
            rows.push(row.map_err(fault)?);
        }
        Ok(rows)
    }

    fn execute(&self, statement: &str, bindings: Vec<SqlStorageValue>) -> Result<(), StoreFault> {
        self.sql.exec(statement, bindings).map_err(fault)?;
        Ok(())
    }
}

fn fault(error: worker::Error) -> StoreFault {
    StoreFault::new(error.to_string())
}

fn key32(value: Option<&SqlStorageValue>) -> Result<Key32, StoreFault> {
    match value {
        Some(SqlStorageValue::Blob(bytes)) => {
            Key32::from_slice(bytes).ok_or_else(|| StoreFault::new("a stored key is not 32 bytes"))
        }
        other => Err(StoreFault::new(format!(
            "a stored key is not a blob: {other:?}"
        ))),
    }
}

fn maybe_key32(value: Option<&SqlStorageValue>) -> Result<Option<Key32>, StoreFault> {
    match value {
        None | Some(SqlStorageValue::Null) => Ok(None),
        other => key32(other).map(Some),
    }
}

fn integer(value: Option<&SqlStorageValue>) -> Result<i64, StoreFault> {
    match value {
        Some(SqlStorageValue::Integer(number)) => Ok(*number),
        Some(SqlStorageValue::Boolean(flag)) => Ok(i64::from(*flag)),
        Some(SqlStorageValue::Float(number)) => Ok(*number as i64),
        other => Err(StoreFault::new(format!(
            "a stored integer is not one: {other:?}"
        ))),
    }
}

fn maybe_integer(value: Option<&SqlStorageValue>) -> Result<Option<i64>, StoreFault> {
    match value {
        None | Some(SqlStorageValue::Null) => Ok(None),
        other => integer(other).map(Some),
    }
}

fn text(value: Option<&SqlStorageValue>) -> Result<String, StoreFault> {
    match value {
        Some(SqlStorageValue::String(value)) => Ok(value.clone()),
        other => Err(StoreFault::new(format!(
            "a stored text column is not text: {other:?}"
        ))),
    }
}

/// `u64` into the `INTEGER` a STRICT column holds.
///
/// Saturating rather than wrapping, for the standalone adapter's reason: a
/// padded size near `u64::MAX` is a malformed declaration the rules already
/// refused, and a wrap would store a small number that looks legitimate.
fn as_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// The column value for a plan state. The words are
/// `contracts/gateway/schema.sql`'s and **not this adapter's**.
const fn plan_state_word(state: plan::State) -> &'static str {
    match state {
        plan::State::Active => "active",
        plan::State::Lapsed => "lapsed",
        plan::State::Expired => "expired",
    }
}

fn plan_state_of(word: &str) -> Result<plan::State, StoreFault> {
    match word {
        "active" => Ok(plan::State::Active),
        "lapsed" => Ok(plan::State::Lapsed),
        "expired" => Ok(plan::State::Expired),
        other => Err(StoreFault::new(format!("unknown plan state {other:?}"))),
    }
}

const fn object_state_word(state: ObjectState) -> &'static str {
    match state {
        ObjectState::Declared => "declared",
        ObjectState::Committed => "committed",
        ObjectState::Tombstoned { .. } => "tombstoned",
    }
}

/// An object kind, back from its column value.
///
/// `ObjectKind::as_str` is the forward direction and lives in `gateway-core` so
/// both adapters spell it the same way; this is its inverse, and an unknown
/// word is a fault rather than a guess — a gateway that guessed a kind would be
/// a gateway guessing at retention.
fn object_kind_of(word: &str) -> Result<ObjectKind, StoreFault> {
    for kind in [
        ObjectKind::Base,
        ObjectKind::Segment,
        ObjectKind::Manifest,
        ObjectKind::Blob,
        ObjectKind::Pack,
        ObjectKind::ShareEntry,
    ] {
        if kind.as_str() == word {
            return Ok(kind);
        }
    }
    Err(StoreFault::new(format!("unknown object kind {word:?}")))
}

fn stored_object(row: &[SqlStorageValue]) -> Result<StoredObject, StoreFault> {
    let name = key32(row.first())?;
    let checksum_bytes = match row.get(1) {
        Some(SqlStorageValue::Blob(bytes)) => bytes.clone(),
        other => {
            return Err(StoreFault::new(format!(
                "a stored checksum is not a blob: {other:?}"
            )));
        }
    };
    let checksum = AttestedChecksum::from_slice(&checksum_bytes)
        .ok_or_else(|| StoreFault::new("a stored checksum is not 32 bytes"))?;
    let kind = object_kind_of(&text(row.get(2))?)?;
    let padded_size = integer(row.get(3))?;
    let state_word = text(row.get(4))?;
    let received_at = integer(row.get(5))?;
    let purge_after = maybe_integer(row.get(6))?;
    let generation_text = text(row.get(7))?;

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

fn blob(value: &[u8]) -> SqlStorageValue {
    SqlStorageValue::Blob(value.to_vec())
}

fn maybe_blob(value: Option<Vec<u8>>) -> SqlStorageValue {
    value.map_or(SqlStorageValue::Null, SqlStorageValue::Blob)
}

fn maybe_number(value: Option<i64>) -> SqlStorageValue {
    value.map_or(SqlStorageValue::Null, SqlStorageValue::Integer)
}

impl StateStore for DurableState {
    async fn vault(&self, vault: &VaultId) -> Result<Option<VaultState>, StoreFault> {
        let rows = self.query(sql::VAULT_SELECT, vec![blob(vault.as_bytes())])?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };

        let lease_device = maybe_key32(row.get(2))?;
        let lease_epoch = integer(row.get(3))?;
        let lease_taken = maybe_integer(row.get(4))?;
        // Epoch 0 is "never claimed" (`lease.rs`), so a row with a device and a
        // zero epoch is a row from before the first claim.
        let current = match (lease_device, lease_taken) {
            (Some(device), Some(taken)) if lease_epoch > 0 => Some(Lease {
                device,
                epoch: lease_epoch.try_into().unwrap_or(0),
                taken_at: ServerTime::from_millis(taken),
            }),
            _ => None,
        };

        Ok(Some(VaultState {
            vault: key32(row.first())?,
            account: key32(row.get(1))?,
            lease: LeaseState {
                current,
                moved_at: maybe_integer(row.get(6))?.map(ServerTime::from_millis),
            },
            head: maybe_key32(row.get(5))?,
            append_only: integer(row.get(7))? != 0,
            plan: Plan {
                state: plan_state_of(&text(row.get(9))?)?,
                quota_bytes: integer(row.get(10))?.try_into().unwrap_or(0),
                used_bytes: integer(row.get(8))?.try_into().unwrap_or(0),
                retain_until: maybe_integer(row.get(11))?.map(ServerTime::from_millis),
            },
        }))
    }

    async fn put_vault(&mut self, state: &VaultState) -> Result<(), StoreFault> {
        // A Durable Object has no ambient clock either: `Date::now()` is the
        // platform's and is read once, here, for the bookkeeping columns the
        // rules do not set. Every column a RULE decides comes from `state`.
        let now = worker::Date::now().as_millis() as i64;
        // The account first: `vault.account_key` REFERENCES it, and the other
        // order is wrong even where the constraint is not enforced.
        self.execute(
            sql::ACCOUNT_UPSERT,
            vec![
                blob(state.account.as_bytes()),
                SqlStorageValue::Integer(now),
                SqlStorageValue::String(plan_state_word(state.plan.state).to_owned()),
                SqlStorageValue::Integer(as_i64(state.plan.quota_bytes)),
                maybe_number(state.plan.retain_until.map(ServerTime::millis)),
            ],
        )?;
        self.execute(
            sql::VAULT_UPSERT,
            vec![
                blob(state.vault.as_bytes()),
                blob(state.account.as_bytes()),
                SqlStorageValue::Integer(now),
                maybe_blob(
                    state
                        .lease
                        .current
                        .map(|lease| lease.device.as_bytes().to_vec()),
                ),
                SqlStorageValue::Integer(
                    state
                        .lease
                        .current
                        .map_or(0_i64, |lease| as_i64(lease.epoch)),
                ),
                maybe_number(state.lease.current.map(|lease| lease.taken_at.millis())),
                maybe_blob(state.head.map(|head| head.as_bytes().to_vec())),
                maybe_number(state.head.map(|_| now)),
                maybe_number(state.lease.moved_at.map(ServerTime::millis)),
                SqlStorageValue::Integer(i64::from(state.append_only)),
                SqlStorageValue::Integer(as_i64(state.plan.used_bytes)),
            ],
        )
    }

    async fn object(
        &self,
        vault: &VaultId,
        name: &ObjectName,
    ) -> Result<Option<StoredObject>, StoreFault> {
        let rows = self.query(
            sql::OBJECT_SELECT,
            vec![blob(vault.as_bytes()), blob(name.as_bytes())],
        )?;
        rows.first().map(|row| stored_object(row)).transpose()
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
        self.execute(
            sql::OBJECT_UPSERT,
            vec![
                blob(vault.as_bytes()),
                blob(object.name.as_bytes()),
                blob(object.checksum.as_bytes()),
                SqlStorageValue::String(object.kind.as_str().to_owned()),
                SqlStorageValue::Integer(as_i64(object.padded_size)),
                SqlStorageValue::String(object_state_word(object.state).to_owned()),
                SqlStorageValue::Integer(object.received_at.millis()),
                maybe_number(committed_at),
                maybe_number(purge_after),
                SqlStorageValue::String(object.generation.as_str().to_owned()),
            ],
        )
    }

    async fn objects(&self, vault: &VaultId) -> Result<Vec<StoredObject>, StoreFault> {
        self.query(sql::OBJECTS_SELECT, vec![blob(vault.as_bytes())])?
            .iter()
            .map(|row| stored_object(row))
            .collect()
    }

    async fn bases(&self, vault: &VaultId) -> Result<Vec<BaseRecord>, StoreFault> {
        let membership = self.query(sql::BASE_OBJECTS_SELECT, vec![blob(vault.as_bytes())])?;
        let mut pairs = Vec::with_capacity(membership.len());
        for row in &membership {
            pairs.push((key32(row.first())?, key32(row.get(1))?));
        }

        let mut out = Vec::new();
        for row in self.query(sql::BASES_SELECT, vec![blob(vault.as_bytes())])? {
            let id = key32(row.first())?;
            out.push(BaseRecord {
                id,
                generation: Generation::parse(&text(row.get(1))?).ok_or_else(|| {
                    StoreFault::new("a stored generation is not 32 hex characters")
                })?,
                received_at: ServerTime::from_millis(integer(row.get(2))?),
                padded_size: integer(row.get(3))?.try_into().unwrap_or(0),
                objects: pairs
                    .iter()
                    .filter(|(base, _)| *base == id)
                    .map(|(_, object)| *object)
                    .collect(),
                tombstoned: integer(row.get(4))? != 0,
            });
        }
        Ok(out)
    }

    async fn put_base(&mut self, vault: &VaultId, base: &BaseRecord) -> Result<(), StoreFault> {
        // NO EXPLICIT TRANSACTION, AND IT IS NOT A GAP. The standalone adapter
        // wraps these three writes because another connection could observe the
        // gap; here there is no other connection — one Durable Object, one
        // request at a time — so the sequence is already indivisible from every
        // observer's point of view. A transaction would be a comment with a
        // cost.
        self.execute(
            sql::BASE_UPSERT,
            vec![
                blob(vault.as_bytes()),
                blob(base.id.as_bytes()),
                SqlStorageValue::String(base.generation.as_str().to_owned()),
                SqlStorageValue::Integer(base.received_at.millis()),
                SqlStorageValue::Integer(as_i64(base.padded_size)),
                SqlStorageValue::Integer(i64::from(base.tombstoned)),
            ],
        )?;
        self.execute(
            sql::BASE_OBJECT_CLEAR,
            vec![blob(vault.as_bytes()), blob(base.id.as_bytes())],
        )?;
        for (ordinal, object) in base.objects.iter().enumerate() {
            self.execute(
                sql::BASE_OBJECT_INSERT,
                vec![
                    blob(vault.as_bytes()),
                    blob(base.id.as_bytes()),
                    blob(object.as_bytes()),
                    SqlStorageValue::Integer(as_i64(ordinal as u64)),
                ],
            )?;
        }
        Ok(())
    }

    /// **THE COMPARE-AND-SET, UNDER A DURABLE OBJECT'S SINGLE-REQUEST
    /// EXECUTION** (F7).
    ///
    /// No transaction and no lock: the runtime delivers one request at a time
    /// to this object, and every request for this vault comes here. The read
    /// below and the write after it cannot be interleaved by anything, which is
    /// the property `BEGIN IMMEDIATE` buys the standalone adapter and this one
    /// gets for free. The decision itself is `commit::compare_and_set` — the
    /// same function both other adapters call.
    async fn compare_and_set_head(
        &mut self,
        vault: &VaultId,
        expected: Option<ObjectName>,
        next: ObjectName,
    ) -> Result<Option<ObjectName>, StoreFault> {
        let rows = self.query(sql::HEAD_SELECT, vec![blob(vault.as_bytes())])?;
        let current = match rows.first() {
            Some(row) => maybe_key32(row.first())?,
            None => None,
        };

        if commit::compare_and_set(current, expected, next).is_ok() {
            let now = worker::Date::now().as_millis() as i64;
            self.execute(
                sql::HEAD_UPDATE,
                vec![
                    blob(vault.as_bytes()),
                    blob(next.as_bytes()),
                    SqlStorageValue::Integer(now),
                ],
            )?;
            return Ok(Some(next));
        }
        Ok(current)
    }

    async fn last_client_base_delete(
        &self,
        vault: &VaultId,
    ) -> Result<Option<ServerTime>, StoreFault> {
        let rows = self.query(sql::CLIENT_BASE_DELETE_SELECT, vec![blob(vault.as_bytes())])?;
        match rows.first() {
            Some(row) => Ok(maybe_integer(row.first())?.map(ServerTime::from_millis)),
            None => Ok(None),
        }
    }

    async fn record_client_base_delete(
        &mut self,
        vault: &VaultId,
        at: ServerTime,
    ) -> Result<(), StoreFault> {
        self.execute(
            sql::CLIENT_BASE_DELETE_UPSERT,
            vec![
                blob(vault.as_bytes()),
                SqlStorageValue::Integer(at.millis()),
            ],
        )
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
        self.execute(
            sql::CLIENT_DELETE_INSERT,
            vec![
                blob(vault.as_bytes()),
                blob(name.as_bytes()),
                SqlStorageValue::String(kind.as_str().to_owned()),
                SqlStorageValue::Integer(at.millis()),
            ],
        )
    }
}
