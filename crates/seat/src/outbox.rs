//! `seat_outbox`: the queue, and the settled journal beside it.
//!
//! ## Why the outbox lives in the seat's own database
//!
//! v0's web seat kept intents in a *second* IndexedDB database, and the cost
//! was that an executed answer could not clear its overlay in the transaction
//! that carried its commit — two stores, two transactions, and a window in
//! which the rows had landed and the paint had not. Here the outbox is a table
//! in the same file as the mirrored rows, which is the whole reason
//! [`crate::applier::ApplyHooks::on_commit_in_transaction`] can exist.
//!
//! ## What is indexed and what is not
//!
//! The indexed columns are the ones the queue **orders**, **filters** and
//! **clears** on: `created_order`, `state`, `commit_seq`. Everything else about
//! an intent is `record_json`. That is not a shortcut — an intent carries a
//! dozen optional fields and a column per field is a migration per field, on a
//! table whose rows are transient by design.

use rusqlite::Connection;

use crate::error::{Result, SeatError};
use crate::intent::{IntentRecord, IntentState, WaitingOn, WaitingOnSeat};

/// The queue's DDL, as v0's.
pub const SEAT_OUTBOX_DDL: &str = r"
CREATE TABLE IF NOT EXISTS seat_outbox (
  intent_id          TEXT PRIMARY KEY,
  created_order      INTEGER NOT NULL,
  app_id             TEXT NOT NULL,
  action             TEXT NOT NULL,
  input_json         TEXT NOT NULL,
  payload_hash       TEXT NOT NULL,
  state              TEXT NOT NULL CHECK (state IN ('queued','sending','awaiting-change',
    'parked','executed','denied','conflict','conflict-base-missing','expired','failed')),
  attempts           INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  depends_on_json    TEXT,
  base_versions_json TEXT,
  optimistic_json    TEXT,
  commit_seq         INTEGER,
  waiting_on_json    TEXT,
  needs_blobs_json   TEXT,
  enqueued_at        TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  record_json        TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS seat_outbox_order_idx ON seat_outbox(created_order);
CREATE INDEX IF NOT EXISTS seat_outbox_awaiting_idx
  ON seat_outbox(commit_seq) WHERE commit_seq IS NOT NULL;
CREATE TABLE IF NOT EXISTS seat_outbox_settled (
  intent_id   TEXT PRIMARY KEY,
  settled_at  TEXT NOT NULL,
  outcome_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS seat_outbox_settled_at_idx ON seat_outbox_settled(settled_at);
";

/// How many settled answers the journal keeps.
///
/// A bound and not a retention window: the journal exists so a screen can say
/// "this went through" after the overlay is gone, and that question has a
/// horizon measured in the member's attention, not in days.
pub const SETTLED_JOURNAL_LIMIT: i64 = 5_000;

/// The queue over one seat file.
pub struct Outbox<'conn> {
    connection: &'conn Connection,
}

impl<'conn> Outbox<'conn> {
    /// Create the tables if they are not there, and take the handle.
    pub fn open(connection: &'conn Connection) -> Result<Self> {
        connection.execute_batch(SEAT_OUTBOX_DDL)?;
        Ok(Self { connection })
    }

    /// Queue one intent.
    ///
    /// `created_order` is allocated here rather than taken from the caller, so
    /// two intents enqueued in the same millisecond still have an order — a
    /// timestamp would not, and the chain is built by walking the queue in
    /// order.
    pub fn enqueue(&self, record: &IntentRecord, now: &str) -> Result<i64> {
        if record.online_only {
            // The refusal is here, at the point of QUEUING, and not at the
            // point of sending: a Locker reveal or an export that reached the
            // durable store is a mass reveal waiting for the next drain.
            return Err(SeatError::OnlineOnly {
                app_id: record.app_id.clone(),
                action: record.action.clone(),
            });
        }
        let order: i64 = self.connection.query_row(
            "SELECT COALESCE(MAX(created_order), 0) + 1 FROM seat_outbox",
            [],
            |row| row.get(0),
        )?;
        self.connection
            .execute(
                "INSERT INTO seat_outbox
                   (intent_id, created_order, app_id, action, input_json, payload_hash,
                    state, attempts, depends_on_json, base_versions_json, optimistic_json,
                    commit_seq, waiting_on_json, needs_blobs_json, enqueued_at, updated_at,
                    record_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, ?16)",
                rusqlite::params![
                    record.intent_id,
                    order,
                    record.app_id,
                    record.action,
                    serde_json::to_string(&record.input)?,
                    record.payload_hash,
                    record.state.as_str(),
                    record.attempts,
                    json_or_null(&record.depends_on)?,
                    base_versions_json(&record.base_versions)?,
                    record
                        .optimistic
                        .as_ref()
                        .map(serde_json::to_string)
                        .transpose()?,
                    record.commit_seq,
                    waiting_on_json(&record.waiting_on)?,
                    json_or_null(&record.needs_blobs)?,
                    now,
                    record_json(record)?,
                ],
            )
            .map_err(|error| SeatError::from_sqlite("queuing an intent", error))?;
        Ok(order)
    }

    /// Every intent still in the queue, in outbox order.
    pub fn all(&self) -> Result<Vec<IntentRecord>> {
        let mut statement = self
            .connection
            .prepare("SELECT record_json FROM seat_outbox ORDER BY created_order")?;
        let records = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        records.iter().map(|text| read_record(text)).collect()
    }

    /// One intent, or nothing.
    pub fn get(&self, intent_id: &str) -> Result<Option<IntentRecord>> {
        let found: Option<String> = self
            .connection
            .query_row(
                "SELECT record_json FROM seat_outbox WHERE intent_id = ?1",
                [intent_id],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        found.as_deref().map(read_record).transpose()
    }

    /// Move an intent to a new state, keeping the record in step.
    ///
    /// The record and the indexed columns are written together, always: a state
    /// written to one and not the other is a queue whose order and whose
    /// contents disagree, and the symptom is an intent that is both queued and
    /// settled.
    pub fn transition(
        &self,
        intent_id: &str,
        state: IntentState,
        now: &str,
        edit: impl FnOnce(&mut IntentRecord),
    ) -> Result<IntentRecord> {
        let Some(mut record) = self.get(intent_id)? else {
            return Err(SeatError::Invariant {
                context: format!("`{intent_id}` is not in this outbox"),
            });
        };
        record.state = state;
        record.updated_at = now.to_owned();
        edit(&mut record);
        self.connection
            .execute(
                "UPDATE seat_outbox
                    SET state = ?2, attempts = ?3, commit_seq = ?4,
                        waiting_on_json = ?5, base_versions_json = ?6,
                        depends_on_json = ?7, updated_at = ?8, record_json = ?9
                  WHERE intent_id = ?1",
                rusqlite::params![
                    intent_id,
                    record.state.as_str(),
                    record.attempts,
                    record.commit_seq,
                    waiting_on_json(&record.waiting_on)?,
                    base_versions_json(&record.base_versions)?,
                    json_or_null(&record.depends_on)?,
                    now,
                    record_json(&record)?,
                ],
            )
            .map_err(|error| SeatError::from_sqlite("transitioning an intent", error))?;
        Ok(record)
    }

    /// Settle an intent: out of the queue, into the journal.
    ///
    /// Both statements, one transaction — or rather, one statement pair the
    /// CALLER runs inside its transaction. That is deliberate: the atomic
    /// overlay clear needs this to happen inside the applier's per-commit
    /// transaction, and an inner `BEGIN` there would fail.
    pub fn settle(&self, intent_id: &str, settled_at: &str) -> Result<bool> {
        let Some(record) = self.get(intent_id)? else {
            return Ok(false);
        };
        let outcome = serde_json::json!({
            "intentId": record.intent_id,
            "appId": record.app_id,
            "action": record.action,
            "state": IntentState::Executed.as_str(),
            "commitSeq": record.commit_seq,
        });
        self.connection.execute(
            "INSERT INTO seat_outbox_settled (intent_id, settled_at, outcome_json)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (intent_id) DO UPDATE SET
               settled_at = excluded.settled_at,
               outcome_json = excluded.outcome_json",
            rusqlite::params![intent_id, settled_at, serde_json::to_string(&outcome)?],
        )?;
        self.connection
            .execute("DELETE FROM seat_outbox WHERE intent_id = ?1", [intent_id])?;
        self.trim_journal()?;
        Ok(true)
    }

    /// Keep the journal to its bound, oldest first.
    pub fn trim_journal(&self) -> Result<usize> {
        Ok(self.connection.execute(
            "DELETE FROM seat_outbox_settled
              WHERE intent_id IN (
                SELECT intent_id FROM seat_outbox_settled
                 ORDER BY settled_at DESC, intent_id DESC
                 LIMIT -1 OFFSET ?1)",
            [SETTLED_JOURNAL_LIMIT],
        )?)
    }

    /// Whether the journal remembers this intent settling.
    pub fn was_settled(&self, intent_id: &str) -> Result<bool> {
        Ok(self.connection.query_row(
            "SELECT COUNT(*) FROM seat_outbox_settled WHERE intent_id = ?1",
            [intent_id],
            |row| row.get::<_, i64>(0),
        )? > 0)
    }

    /// The intents whose overlay clears at or below `cursor_commit_seq`.
    ///
    /// `commit_seq <= cursor`, and `awaiting-change` only: a `queued` intent
    /// carrying a stale `commit_seq` from an earlier attempt must not clear.
    pub fn awaiting_at_or_below(&self, cursor_commit_seq: i64) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare(
            "SELECT intent_id FROM seat_outbox
              WHERE state = 'awaiting-change' AND commit_seq IS NOT NULL AND commit_seq <= ?1
              ORDER BY created_order",
        )?;
        Ok(statement
            .query_map([cursor_commit_seq], |row| row.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The intents still holding an overlay.
    pub fn overlaid(&self) -> Result<Vec<IntentRecord>> {
        Ok(self
            .all()?
            .into_iter()
            .filter(|record| record.state.holds_overlay())
            .collect())
    }

    #[must_use]
    pub const fn connection(&self) -> &'conn Connection {
        self.connection
    }
}

// --------------------------------------------------------------- encoding ----

/// The record as one JSON object. Hand-rolled rather than `derive(Serialize)`
/// because [`centraid_vault::intents::BaseVersion`] is the gateway's type and
/// carries no serde derive — and because the spelling here is v0's camelCase,
/// which a derive would have to be told field by field anyway.
fn record_json(record: &IntentRecord) -> Result<String> {
    Ok(serde_json::to_string(&serde_json::json!({
        "intentId": record.intent_id,
        "createdOrder": record.created_order,
        "appId": record.app_id,
        "action": record.action,
        "input": record.input,
        "payloadHash": record.payload_hash,
        "state": record.state.as_str(),
        "attempts": record.attempts,
        "dependsOn": record.depends_on,
        "baseVersions": record
            .base_versions
            .iter()
            .map(base_version_value)
            .collect::<Vec<_>>(),
        "optimistic": record.optimistic,
        "commitSeq": record.commit_seq,
        "waitingOn": record
            .waiting_on
            .iter()
            .map(|wait| serde_json::json!({ "seat": wait.seat.as_str(), "label": wait.label }))
            .collect::<Vec<_>>(),
        "needsBlobs": record.needs_blobs,
        "enqueuedAt": record.enqueued_at,
        "updatedAt": record.updated_at,
        "reason": record.reason,
        "conflicts": record
            .conflicts
            .iter()
            .map(|conflict| serde_json::json!({
                "entity": conflict.entity,
                "rowId": conflict.row_id,
                "shapeId": conflict.shape_id,
                "expectedVersion": conflict.expected_version,
                "actualVersion": conflict.actual_version,
            }))
            .collect::<Vec<_>>(),
        "onlineOnly": record.online_only,
    }))?)
}

fn base_version_value(version: &centraid_vault::intents::BaseVersion) -> serde_json::Value {
    serde_json::json!({
        "entity": version.entity,
        "rowId": version.row_id,
        "shapeId": version.shape_id,
        "version": version.version,
    })
}

/// Read a record back.
pub fn read_record(text: &str) -> Result<IntentRecord> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    let string = |key: &str| -> Result<String> {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| SeatError::Invariant {
                context: format!("an outbox record has no `{key}`"),
            })
    };
    let strings = |key: &str| -> Vec<String> {
        value
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    };
    Ok(IntentRecord {
        intent_id: string("intentId")?,
        created_order: value
            .get("createdOrder")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        app_id: string("appId")?,
        action: string("action")?,
        input: value
            .get("input")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        payload_hash: string("payloadHash")?,
        state: IntentState::parse(&string("state")?)?,
        attempts: value
            .get("attempts")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        depends_on: strings("dependsOn"),
        base_versions: value
            .get("baseVersions")
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().filter_map(read_base_version).collect())
            .unwrap_or_default(),
        optimistic: value
            .get("optimistic")
            .filter(|found| !found.is_null())
            .cloned(),
        commit_seq: value.get("commitSeq").and_then(serde_json::Value::as_i64),
        waiting_on: value
            .get("waitingOn")
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().filter_map(read_waiting_on).collect())
            .unwrap_or_default(),
        needs_blobs: strings("needsBlobs"),
        enqueued_at: string("enqueuedAt")?,
        updated_at: string("updatedAt")?,
        reason: value
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        conflicts: value
            .get("conflicts")
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().filter_map(read_conflict).collect())
            .unwrap_or_default(),
        online_only: value
            .get("onlineOnly")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
    })
}

fn read_base_version(value: &serde_json::Value) -> Option<centraid_vault::intents::BaseVersion> {
    Some(centraid_vault::intents::BaseVersion {
        entity: value.get("entity")?.as_str()?.to_owned(),
        row_id: value.get("rowId")?.as_str()?.to_owned(),
        shape_id: value
            .get("shapeId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        version: value.get("version")?.as_i64()?,
    })
}

fn read_waiting_on(value: &serde_json::Value) -> Option<WaitingOn> {
    let seat = match value.get("seat")?.as_str()? {
        "owner" => WaitingOnSeat::Owner,
        "origin" => WaitingOnSeat::Origin,
        "gateway" => WaitingOnSeat::Gateway,
        "intent" => WaitingOnSeat::Intent,
        _ => return None,
    };
    Some(WaitingOn {
        seat,
        label: value
            .get("label")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_owned(),
    })
}

fn read_conflict(value: &serde_json::Value) -> Option<crate::occ::Conflict> {
    Some(crate::occ::Conflict {
        entity: value.get("entity")?.as_str()?.to_owned(),
        row_id: value.get("rowId")?.as_str()?.to_owned(),
        shape_id: value
            .get("shapeId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        expected_version: value.get("expectedVersion")?.as_i64()?,
        actual_version: value.get("actualVersion")?.as_i64()?,
    })
}

fn waiting_on_json(waits: &[WaitingOn]) -> Result<Option<String>> {
    if waits.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(
        &waits
            .iter()
            .map(|wait| serde_json::json!({ "seat": wait.seat.as_str(), "label": wait.label }))
            .collect::<Vec<_>>(),
    )?))
}

fn json_or_null(items: &[String]) -> Result<Option<String>> {
    if items.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(items)?))
}

fn base_versions_json(versions: &[centraid_vault::intents::BaseVersion]) -> Result<Option<String>> {
    if versions.is_empty() {
        return Ok(None);
    }
    Ok(Some(serde_json::to_string(
        &versions.iter().map(base_version_value).collect::<Vec<_>>(),
    )?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str, state: IntentState) -> IntentRecord {
        IntentRecord {
            intent_id: id.to_owned(),
            created_order: 0,
            app_id: "notes".to_owned(),
            action: "edit".to_owned(),
            input: serde_json::json!({ "title": id }),
            payload_hash: "a".repeat(64),
            state,
            attempts: 0,
            depends_on: Vec::new(),
            base_versions: Vec::new(),
            optimistic: None,
            commit_seq: None,
            waiting_on: Vec::new(),
            needs_blobs: Vec::new(),
            enqueued_at: "2026-01-01T00:00:00.000Z".to_owned(),
            updated_at: "2026-01-01T00:00:00.000Z".to_owned(),
            reason: None,
            conflicts: Vec::new(),
            online_only: false,
        }
    }

    fn seat() -> Connection {
        Connection::open_in_memory().expect("opens")
    }

    #[test]
    fn an_intent_round_trips_through_the_record_json() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("it opens");
        let mut queued = record("i-1", IntentState::Queued);
        queued
            .base_versions
            .push(centraid_vault::intents::BaseVersion {
                entity: "note".to_owned(),
                row_id: "\u{10000}".to_owned(),
                shape_id: Some("s1".to_owned()),
                version: 3,
            });
        queued.waiting_on.push(WaitingOn {
            seat: WaitingOnSeat::Intent,
            label: "i-0".to_owned(),
        });
        queued.depends_on.push("i-0".to_owned());
        queued.conflicts.push(crate::occ::Conflict {
            entity: "note".to_owned(),
            row_id: "n1".to_owned(),
            shape_id: None,
            expected_version: 2,
            actual_version: 0,
        });
        queued.optimistic = Some(serde_json::json!({ "mirror": { "n1": { "title": "x" } } }));
        queued.reason = Some("the note is gone".to_owned());
        outbox.enqueue(&queued, "t").expect("it queues");

        let read = outbox.get("i-1").expect("it reads").expect("it is there");
        assert_eq!(read.base_versions, queued.base_versions);
        assert_eq!(read.waiting_on, queued.waiting_on);
        assert_eq!(read.conflicts, queued.conflicts);
        assert_eq!(read.optimistic, queued.optimistic);
        assert_eq!(read.reason.as_deref(), Some("the note is gone"));
        assert_eq!(read.created_order, 0, "the record's own field is untouched");
    }

    #[test]
    fn created_order_is_allocated_by_the_queue_and_not_by_the_clock() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        // The SAME timestamp for both. A timestamp cannot order these.
        assert_eq!(
            outbox
                .enqueue(&record("i-1", IntentState::Queued), "t")
                .expect("queues"),
            1
        );
        assert_eq!(
            outbox
                .enqueue(&record("i-2", IntentState::Queued), "t")
                .expect("queues"),
            2
        );
        let order: Vec<String> = outbox
            .all()
            .expect("reads")
            .into_iter()
            .map(|entry| entry.intent_id)
            .collect();
        assert_eq!(order, ["i-1", "i-2"]);
    }

    /// THE REFUSAL IS AT QUEUING. An export that reached the durable store is a
    /// mass reveal waiting for the next drain.
    #[test]
    fn an_online_only_action_is_refused_at_the_point_of_queuing() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        let mut reveal = record("i-1", IntentState::Queued);
        reveal.app_id = "locker".to_owned();
        reveal.action = "export".to_owned();
        reveal.online_only = true;
        let error = outbox.enqueue(&reveal, "t").expect_err("it refuses");
        assert!(matches!(error, SeatError::OnlineOnly { .. }));
        assert!(
            outbox.get("i-1").expect("reads").is_none(),
            "nothing landed"
        );
    }

    #[test]
    fn a_transition_writes_the_indexed_columns_and_the_record_together() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox
            .enqueue(&record("i-1", IntentState::Queued), "t")
            .expect("queues");
        outbox
            .transition("i-1", IntentState::AwaitingChange, "t2", |entry| {
                entry.commit_seq = Some(12);
                entry.attempts = 2;
            })
            .expect("it transitions");
        let column: (String, Option<i64>, i64) = connection
            .query_row(
                "SELECT state, commit_seq, attempts FROM seat_outbox WHERE intent_id = 'i-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the columns read");
        assert_eq!(column, ("awaiting-change".to_owned(), Some(12), 2));
        let record = outbox.get("i-1").expect("reads").expect("there");
        assert_eq!(record.state, IntentState::AwaitingChange);
        assert_eq!(record.commit_seq, Some(12));
    }

    #[test]
    fn only_awaiting_change_intents_clear_at_a_commit_seq() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        for (id, state) in [
            ("awaiting", IntentState::Queued),
            ("queued-with-stale-seq", IntentState::Queued),
        ] {
            outbox.enqueue(&record(id, state), "t").expect("queues");
        }
        outbox
            .transition("awaiting", IntentState::AwaitingChange, "t", |entry| {
                entry.commit_seq = Some(5)
            })
            .expect("transitions");
        // A `queued` intent carrying a stale seq from an earlier attempt.
        outbox
            .transition("queued-with-stale-seq", IntentState::Queued, "t", |entry| {
                entry.commit_seq = Some(1)
            })
            .expect("transitions");
        assert_eq!(
            outbox.awaiting_at_or_below(9).expect("it reads"),
            ["awaiting"]
        );
        // And the cursor's boundary is inclusive, as v0's `<=`.
        assert_eq!(outbox.awaiting_at_or_below(5).expect("reads").len(), 1);
        assert_eq!(outbox.awaiting_at_or_below(4).expect("reads").len(), 0);
    }

    #[test]
    fn settling_moves_an_intent_out_of_the_queue_and_into_the_journal() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        outbox
            .enqueue(&record("i-1", IntentState::Queued), "t")
            .expect("queues");
        assert!(outbox.settle("i-1", "t2").expect("it settles"));
        assert!(outbox.get("i-1").expect("reads").is_none());
        assert!(outbox.was_settled("i-1").expect("reads"));
        // And settling an intent that is not there is not an error: a duplicate
        // answer for a settled intent is exactly the case this must survive.
        assert!(!outbox.settle("i-1", "t3").expect("it is a no-op"));
    }

    #[test]
    fn the_journal_is_bounded_and_drops_the_oldest() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        // Writing 5,001 real intents is slow; the bound is what is under test,
        // so the journal is filled directly and trimmed.
        for index in 0..(SETTLED_JOURNAL_LIMIT + 10) {
            connection
                .execute(
                    "INSERT INTO seat_outbox_settled (intent_id, settled_at, outcome_json)
                     VALUES (?1, ?2, '{}')",
                    rusqlite::params![format!("i-{index:06}"), format!("2026-01-01T00:00:{index}")],
                )
                .expect("it inserts");
        }
        outbox.trim_journal().expect("it trims");
        let kept: i64 = connection
            .query_row("SELECT COUNT(*) FROM seat_outbox_settled", [], |row| {
                row.get(0)
            })
            .expect("counts");
        assert_eq!(kept, SETTLED_JOURNAL_LIMIT);
        // The oldest went.
        assert!(!outbox.was_settled("i-000000").expect("reads"));
    }

    #[test]
    fn the_check_constraint_holds_the_ten_states_and_nothing_else() {
        let connection = seat();
        Outbox::open(&connection).expect("opens");
        for state in crate::intent::ALL_STATES {
            connection
                .execute(
                    "INSERT INTO seat_outbox
                       (intent_id, created_order, app_id, action, input_json, payload_hash,
                        state, enqueued_at, updated_at, record_json)
                     VALUES (?1, 1, 'a', 'b', '{}', 'h', ?1, 't', 't', '{}')",
                    [state.as_str()],
                )
                .unwrap_or_else(|error| panic!("`{}` is refused: {error}", state.as_str()));
        }
        assert!(
            connection
                .execute(
                    "INSERT INTO seat_outbox
                       (intent_id, created_order, app_id, action, input_json, payload_hash,
                        state, enqueued_at, updated_at, record_json)
                     VALUES ('x', 1, 'a', 'b', '{}', 'h', 'settled', 't', 't', '{}')",
                    [],
                )
                .is_err(),
            "an eleventh state is refused by the file, not only by the type"
        );
    }

    #[test]
    fn overlaid_is_nine_of_the_ten_states() {
        let connection = seat();
        let outbox = Outbox::open(&connection).expect("opens");
        for state in crate::intent::ALL_STATES {
            let mut entry = record(state.as_str(), IntentState::Queued);
            entry.state = state;
            outbox.enqueue(&entry, "t").expect("queues");
            outbox
                .transition(state.as_str(), state, "t", |_| {})
                .expect("transitions");
        }
        assert_eq!(outbox.overlaid().expect("reads").len(), 9);
    }
}
