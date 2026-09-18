//! ONE DURABLE OBJECT PER MAILBOX, AND ITS ALARM IS THE TTL (#1029 §3).
//!
//! A mailbox is addressed by the **recipient's identity key**, and the object
//! is named by that key: `/m/{identity_key}` routes to exactly one object, on
//! one machine, running one request at a time. That is what makes the
//! per-capability rate limit a count rather than a distributed counter.
//!
//! # WHAT A MAILBOX MUST NOT LEARN
//!
//! **A deposit is not signed by the sender at the gateway.** The recipient's
//! gateway never learns who is writing; authorisation is the capability the
//! recipient issued in the link ceremony, and the sender's signature is inside
//! the sealed bundle where only the recipient can read it. So there is no
//! sender column here and nowhere for one to arrive.
//!
//! What this object holds per entry is: which capability deposited it, when,
//! when it expires, and **how many bytes** — never the bytes themselves beyond
//! the small ones, and never who sent them.
//!
//! # THE ALARM, AND WHY IT IS NOT A SWEEP
//!
//! The standalone adapter sweeps its mailboxes on a timer, because it is a
//! process that is always running. A Worker is not: there is nothing to run a
//! timer in. A Durable Object alarm is the runtime's answer — the object asks
//! to be woken at an instant and the platform wakes it, once, even if nothing
//! else has touched it for a month.
//!
//! Both ask `mailbox::expired`, which is the rule. **The alarm is a mechanism
//! for reaching the rule, not a second copy of it**, and that distinction is
//! the difference between two deployments that agree about a TTL and two that
//! drift apart by however long one of their sweeps happens to take.
//!
//! The alarm is armed for the EARLIEST expiry the mailbox holds, re-armed after
//! every sweep, and cleared when the mailbox empties: an alarm per entry would
//! be a wake-up per deposit on an object that can take thousands.

use centraid_gateway_core::error::Refusal;
use centraid_gateway_core::ids::Key32;
use centraid_gateway_core::mailbox::{self, Capability};
use centraid_gateway_core::store::StoreFault;
use centraid_gateway_core::time::ServerTime;
use worker::{SqlStorage, SqlStorageValue};

/// This object's own statements.
///
/// They are not in `contracts/gateway/queries/` because the mailbox tables are
/// in the **shared** schema and the standalone adapter has its own reads over
/// them; when that adapter grows its mailbox routes, these move there and both
/// use them. Until then a statement with one caller in one file is honest about
/// how many callers it has. `tests/shared_sql.rs` is what notices when a second
/// one appears.
mod statements {
    /// Every entry in this mailbox that has not expired, oldest first: a drain
    /// is a read in deposit order, because a recipient's cursor is a position
    /// in that order.
    pub const DRAIN: &str = "SELECT entry_id, capability_id, deposited_at_ms, \
                             expires_at_ms, sealed_bytes FROM mailbox_entry \
                             WHERE mailbox_key = ?1 AND expires_at_ms >= ?2 \
                             ORDER BY deposited_at_ms, entry_id;";
    /// One deposit.
    pub const DEPOSIT: &str = "INSERT INTO mailbox_entry (mailbox_key, entry_id, \
                               capability_id, deposited_at_ms, expires_at_ms, \
                               sealed_bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6);";
    /// How many deposits this CAPABILITY made inside the rate window. Per
    /// capability and not per mailbox: a mailbox-wide limit would let one
    /// leaked capability starve every honest sender.
    pub const RECENT: &str = "SELECT COUNT(*) FROM mailbox_entry WHERE \
                              mailbox_key = ?1 AND capability_id = ?2 AND \
                              deposited_at_ms > ?3;";
    /// The ack: a recipient has the entry and it may go.
    pub const ACK: &str =
        "DELETE FROM mailbox_entry WHERE mailbox_key = ?1 AND entry_id = ?2;";
    /// Everything past its TTL. The alarm's own statement.
    pub const EXPIRE: &str =
        "DELETE FROM mailbox_entry WHERE mailbox_key = ?1 AND expires_at_ms < ?2;";
    /// When the next entry expires, for re-arming the alarm.
    pub const NEXT_EXPIRY: &str = "SELECT MIN(expires_at_ms) FROM mailbox_entry \
                                   WHERE mailbox_key = ?1;";
    /// The capability a deposit presented, as the recipient issued it.
    pub const CAPABILITY: &str = "SELECT capability_id, expires_at_ms, \
                                  max_deposit_bytes, deposits_per_hour, revoked \
                                  FROM mailbox_capability WHERE mailbox_key = ?1 \
                                  AND capability_id = ?2;";
    /// A capability the recipient issued.
    pub const ISSUE: &str = "INSERT INTO mailbox_capability (mailbox_key, \
                             capability_id, expires_at_ms, max_deposit_bytes, \
                             deposits_per_hour, revoked) VALUES (?1, ?2, ?3, ?4, ?5, 0) \
                             ON CONFLICT (mailbox_key, capability_id) DO UPDATE SET \
                             expires_at_ms = excluded.expires_at_ms, \
                             max_deposit_bytes = excluded.max_deposit_bytes, \
                             deposits_per_hour = excluded.deposits_per_hour;";
    /// Revocation, which takes effect immediately.
    pub const REVOKE: &str = "UPDATE mailbox_capability SET revoked = 1 WHERE \
                              mailbox_key = ?1 AND capability_id = ?2;";
}

/// One mailbox's storage.
pub struct MailboxStore {
    sql: SqlStorage,
    mailbox: Key32,
}

/// One entry, as the gateway holds it. **No sender.**
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub entry_id: Key32,
    pub capability_id: Key32,
    pub deposited_at: ServerTime,
    pub expires_at: ServerTime,
    pub sealed_bytes: u64,
}

impl MailboxStore {
    /// Open one mailbox's storage over the shared schema.
    ///
    /// # Errors
    ///
    /// A store fault if the schema cannot be applied.
    pub fn open(sql: SqlStorage, mailbox: Key32) -> Result<Self, StoreFault> {
        sql.exec(centraid_gateway_core::SCHEMA_SQL, None)
            .map_err(fault)?;
        Ok(Self { sql, mailbox })
    }

    fn key(&self) -> SqlStorageValue {
        SqlStorageValue::Blob(self.mailbox.as_bytes().to_vec())
    }

    fn rows(
        &self,
        statement: &str,
        bindings: Vec<SqlStorageValue>,
    ) -> Result<Vec<Vec<SqlStorageValue>>, StoreFault> {
        let cursor = self.sql.exec(statement, bindings).map_err(fault)?;
        let mut out = Vec::new();
        for row in cursor.raw() {
            out.push(row.map_err(fault)?);
        }
        Ok(out)
    }

    /// Record a capability the recipient issued.
    ///
    /// Its signature has already been verified against this mailbox's identity
    /// key by the route; what is stored is what the rules read.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn issue(&self, capability: &Capability) -> Result<(), StoreFault> {
        self.sql
            .exec(
                statements::ISSUE,
                vec![
                    self.key(),
                    SqlStorageValue::Blob(capability.capability_id.as_bytes().to_vec()),
                    SqlStorageValue::Integer(capability.expires_at.millis()),
                    SqlStorageValue::Integer(
                        i64::try_from(capability.max_deposit_bytes).unwrap_or(i64::MAX),
                    ),
                    SqlStorageValue::Integer(i64::from(capability.deposits_per_hour)),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    /// Revoke one recipient's capability. **Immediately**: the next deposit
    /// reads the flag.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn revoke(&self, capability_id: Key32) -> Result<(), StoreFault> {
        self.sql
            .exec(
                statements::REVOKE,
                vec![
                    self.key(),
                    SqlStorageValue::Blob(capability_id.as_bytes().to_vec()),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    /// The capability a deposit presented.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn capability(&self, capability_id: Key32) -> Result<Option<Capability>, StoreFault> {
        let rows = self.rows(
            statements::CAPABILITY,
            vec![
                self.key(),
                SqlStorageValue::Blob(capability_id.as_bytes().to_vec()),
            ],
        )?;
        let Some(row) = rows.first() else {
            return Ok(None);
        };
        Ok(Some(Capability {
            mailbox: self.mailbox,
            capability_id,
            expires_at: ServerTime::from_millis(integer(row.get(1))?),
            max_deposit_bytes: integer(row.get(2))?.max(0) as u64,
            deposits_per_hour: u32::try_from(integer(row.get(3))?.max(0)).unwrap_or(u32::MAX),
            revoked: integer(row.get(4))? != 0,
        }))
    }

    /// ACCEPT ONE DEPOSIT, THROUGH THE RULE.
    ///
    /// The count inside the window is storage and is done here; the threshold
    /// is `mailbox::accept_deposit`, in `gateway-core`, and this module does
    /// not restate it. The TTL the rule returns is what the entry is filed
    /// with and what the alarm is armed for.
    ///
    /// # Errors
    ///
    /// The rule's [`Refusal`], or a store fault.
    pub fn deposit(
        &self,
        capability: &Capability,
        entry_id: Key32,
        sealed_bytes: u64,
        now: ServerTime,
    ) -> Result<Result<Entry, Refusal>, StoreFault> {
        let window_start = now.millis() - mailbox::RATE_WINDOW.millis();
        let recent = self.rows(
            statements::RECENT,
            vec![
                self.key(),
                SqlStorageValue::Blob(capability.capability_id.as_bytes().to_vec()),
                SqlStorageValue::Integer(window_start),
            ],
        )?;
        let recent_deposits = match recent.first().and_then(|row| row.first()) {
            Some(SqlStorageValue::Integer(count)) => u32::try_from(*count).unwrap_or(u32::MAX),
            _ => 0,
        };

        let expires_at =
            match mailbox::accept_deposit(capability, sealed_bytes, recent_deposits, now) {
                Ok(expires_at) => expires_at,
                Err(refusal) => return Ok(Err(refusal)),
            };

        self.sql
            .exec(
                statements::DEPOSIT,
                vec![
                    self.key(),
                    SqlStorageValue::Blob(entry_id.as_bytes().to_vec()),
                    SqlStorageValue::Blob(capability.capability_id.as_bytes().to_vec()),
                    SqlStorageValue::Integer(now.millis()),
                    SqlStorageValue::Integer(expires_at.millis()),
                    SqlStorageValue::Integer(i64::try_from(sealed_bytes).unwrap_or(i64::MAX)),
                ],
            )
            .map_err(fault)?;
        Ok(Ok(Entry {
            entry_id,
            capability_id: capability.capability_id,
            deposited_at: now,
            expires_at,
            sealed_bytes,
        }))
    }

    /// Everything still live, oldest first.
    ///
    /// The `expires_at_ms >= now` predicate is not belt-and-braces over the
    /// alarm: an object can be read between an entry expiring and the alarm
    /// firing, and serving an expired entry in that window would make the TTL a
    /// suggestion.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn drain(&self, now: ServerTime) -> Result<Vec<Entry>, StoreFault> {
        let rows = self.rows(
            statements::DRAIN,
            vec![self.key(), SqlStorageValue::Integer(now.millis())],
        )?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            out.push(Entry {
                entry_id: key32(row.first())?,
                capability_id: key32(row.get(1))?,
                deposited_at: ServerTime::from_millis(integer(row.get(2))?),
                expires_at: ServerTime::from_millis(integer(row.get(3))?),
                sealed_bytes: integer(row.get(4))?.max(0) as u64,
            });
        }
        Ok(out)
    }

    /// The ack: the recipient has it and it may go.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn ack(&self, entry_id: Key32) -> Result<(), StoreFault> {
        self.sql
            .exec(
                statements::ACK,
                vec![
                    self.key(),
                    SqlStorageValue::Blob(entry_id.as_bytes().to_vec()),
                ],
            )
            .map_err(fault)?;
        Ok(())
    }

    /// THE ALARM'S WORK: drop everything past its TTL, and say when to wake
    /// next.
    ///
    /// `None` means the mailbox is empty and the alarm is cleared rather than
    /// re-armed for a far-off instant — an object that keeps waking to find
    /// nothing is an object that costs money to hold nothing.
    ///
    /// # Errors
    ///
    /// A store fault.
    pub fn expire_and_next(
        &self,
        now: ServerTime,
    ) -> Result<Option<ServerTime>, StoreFault> {
        self.sql
            .exec(
                statements::EXPIRE,
                vec![self.key(), SqlStorageValue::Integer(now.millis())],
            )
            .map_err(fault)?;
        let rows = self.rows(statements::NEXT_EXPIRY, vec![self.key()])?;
        match rows.first().and_then(|row| row.first()) {
            Some(SqlStorageValue::Integer(at)) => Ok(Some(ServerTime::from_millis(*at))),
            _ => Ok(None),
        }
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

fn integer(value: Option<&SqlStorageValue>) -> Result<i64, StoreFault> {
    match value {
        Some(SqlStorageValue::Integer(number)) => Ok(*number),
        Some(SqlStorageValue::Boolean(flag)) => Ok(i64::from(*flag)),
        Some(SqlStorageValue::Null) | None => Ok(0),
        other => Err(StoreFault::new(format!(
            "a stored integer is not one: {other:?}"
        ))),
    }
}
