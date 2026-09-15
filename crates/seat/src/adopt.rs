//! ADOPTING A BOOTSTRAP BLOB (#1025 S7, item 3).
//!
//! A bootstrap is a **blob**, and since this slice the blob is a REPLICA: the
//! gateway builds it uncompressed and already carrying the seat's own tables
//! (`centraid_vault::build_replica_snapshot` over `crate::seat_own_ddl`). So a
//! phone does not expand it, does not copy tables out of it, and does not write
//! a second full-size file beside the one it just downloaded. It **adopts** it:
//! the verified bytes are already a file in `<vault>.bytes`, it is hard-linked
//! to the replica's name, and one small transaction writes the two things the
//! gateway has never heard of — the pairing record and the cursor.
//!
//! ## Why this replaced an install
//!
//! The old path was: fetch, export the blob to `<replica>.incoming.gz`, inflate
//! that to `<replica>.incoming`, create the seat's tables on it, copy the old
//! file's queue across, rename, forget. That is **three full-size files on a
//! phone at once** — the blob in the store, the gzip, and the expanded database
//! — to produce one. On a 300 MB vault that is 900 MB of a device that may have
//! had 400 MB, and the failure arrived somewhere in the middle of a decompress
//! rather than as a refusal a member could act on.
//!
//! v0 swapped because OPFS imported wholesale; native SQLite has no such
//! constraint, which is why the S1 install ruling is superseded rather than
//! merely revised.
//!
//! ## THE IDENTITY IS CHECKED BEFORE THE DESTINATION IS TOUCHED
//!
//! The artifact names its vault in its own `core_vault` row, and it is asked
//! that question against the vault this seat PAIRED for. A mismatch refuses
//! here, on the adopted file, so the replica that was there is still there with
//! its outbox inside it. Until #1014 nothing tied the artifact to the seat and
//! the seat simply wrote its own id over whatever arrived — which left a
//! `Personal` seat holding `Family`'s rows and no seat tables at all, and every
//! later check agreed with it.
//!
//! ## A RE-BOOTSTRAP KEEPS THE QUEUE, AND ITS ORDER
//!
//! A re-bootstrap replaces what the GATEWAY gave this seat. The queued intents,
//! their order, the settled journal and the pairing record are the things the
//! gateway has never heard of ([`crate::SEAT_OWN_TABLES`]), so they survive it:
//! one `INSERT … SELECT` per table, in the **one transaction** that also writes
//! the cursor, with `created_order` **verbatim** — renumbering the queue would
//! reorder the member's work.
//!
//! **The rename is the publication and it is last.** A kill before it leaves
//! the old replica untouched, with its outbox, and the redo is idempotent:
//! every insert is `INSERT OR IGNORE` against a primary key, and the adopted
//! file is re-derived from a blob that is still in the store.

use std::path::Path;

use rusqlite::Connection;

use crate::error::{Result, SeatError};
use crate::state::{SeatPosition, init_seat_state};

/// What an adoption carried across.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Adopted {
    pub vault_id: String,
    pub epoch: String,
    pub applied_seq: i64,
    /// Outbox rows carried over from the replica being replaced. Zero on a
    /// first bootstrap, which has nothing to carry.
    pub carried_intents: usize,
    /// Settled answers carried over, so a screen can still say "this went
    /// through" after a repair nobody asked for.
    pub carried_settled: usize,
}

/// The vault id the artifact itself states.
///
/// `core_vault` is a replicated table, so a legitimate artifact always carries
/// exactly one row. An artifact with none cannot be verified and is refused
/// rather than assumed correct.
fn vault_id_of(connection: &Connection) -> Result<String> {
    connection
        .query_row(
            "SELECT vault_id FROM core_vault ORDER BY vault_id LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => SeatError::Invariant {
                context: "the bootstrap artifact carries no core_vault row".to_owned(),
            },
            other => SeatError::Sqlite(other),
        })
}

/// Make `adopted` into this seat's replica, carrying `live`'s queue across.
///
/// `adopted` is the verified artifact at a path of its own — hard-linked out of
/// the byte store by the caller, and not yet at the replica's name. `live` is
/// the replica this seat holds now, when it holds one. **Nothing here touches
/// `live`** — it is only read — and nothing here moves `adopted`: the caller
/// renames it into place once this returns, and the rename is the publication.
///
/// `gateway` is the pairing record, written in the same transaction as the
/// cursor. The two go together because they are the same fact — *this file is
/// this device's copy of that vault, taken from that gateway, at that position*
/// — and a file that reached the replica's name with one and not the other is
/// either a seat that does not know where to dial or one that does not know
/// where it is.
pub fn adopt_replica(
    adopted: &Path,
    live: Option<&Path>,
    expected_vault_id: &str,
    applied_seq: i64,
    ddl_version: i64,
    gateway: Option<&crate::gateway::PairedGateway>,
    now: &str,
) -> Result<Adopted> {
    let mut connection = Connection::open(adopted)?;

    // FIRST, AND BEFORE ANYTHING IS WRITTEN ANYWHERE.
    let vault_id = vault_id_of(&connection)?;
    if vault_id != expected_vault_id {
        return Err(SeatError::WrongVault {
            expected: expected_vault_id.to_owned(),
            found: vault_id,
        });
    }

    // The position comes from the ARTIFACT, which is where the snapshot builder
    // put it: the log is deleted and `floor_seq` is the seq it stands at.
    // Reading it from the artifact rather than trusting the answer that pointed
    // at the artifact is the same rule as the identity check above.
    let (epoch, floor, _) = centraid_vault::converge::position(&connection)?;
    let schema_epoch = schema_epoch_of(&connection)?;
    let landing_seq = applied_seq.max(floor);

    // THE SEAT'S OWN TABLES, AS BELT TO THE GATEWAY'S BRACES. The artifact is
    // built replica-shaped and already has them; every statement is
    // `IF NOT EXISTS`, so running them costs nothing and a gateway that did not
    // shape its blob produces a working replica rather than a file whose first
    // write fails on a missing table.
    crate::schema::lay_seat_tables(&connection)?;

    // THE OLD FILE IS ATTACHED BEFORE THE TRANSACTION OPENS, because SQLite
    // refuses an `ATTACH` inside one: a transaction has already taken locks
    // and a database joining it late is the "database is locked" it answers
    // with. It is detached after the commit, whatever happened — an attached
    // database is a file handle on the file this adoption is about to be
    // renamed over.
    let attached = match live {
        None => false,
        Some(live) => attach_live(&connection, live)?,
    };

    // ONE TRANSACTION. The queue, the pairing and the cursor land together or
    // not at all — and `seat_state` is what makes the file read as a replica,
    // so a partial adoption reads as "this seat has no copy" and costs the
    // fetch again rather than producing a file that half-works.
    let transaction = connection.transaction()?;
    let (carried_intents, carried_settled) = if attached {
        carry_over(&transaction)?
    } else {
        (0, 0)
    };
    if let Some(gateway) = gateway {
        crate::gateway::remember_gateway(&transaction, gateway, now)?;
    }
    init_seat_state(
        &transaction,
        &SeatPosition {
            vault_id: vault_id.clone(),
            epoch: epoch.clone(),
            schema_epoch,
            ddl_version,
            // THE SNAPSHOT'S OWN POSITION, not zero. A seat that started at
            // zero would ask for a log page below the floor and be told to
            // re-bootstrap by the gateway it just bootstrapped from — a loop,
            // not a repair.
            applied_seq: landing_seq,
            // NOTHING TO CLEAR AN OVERLAY AGAINST, and that is honest: the
            // artifact deleted the log the commit could have been read from.
            applied_commit_seq: 0,
        },
        now,
    )?;
    transaction.commit()?;
    if attached {
        connection.execute_batch("DETACH DATABASE live")?;
    }

    // The connection goes before the caller renames the file: an open handle
    // over a path that is about to be replaced is how a `-wal` outlives the
    // database it belonged to.
    connection
        .close()
        .map_err(|(_, error)| SeatError::Sqlite(error))?;

    Ok(Adopted {
        vault_id,
        epoch,
        applied_seq: landing_seq,
        carried_intents,
        carried_settled,
    })
}

fn schema_epoch_of(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row(
        "SELECT schema_epoch FROM replica_meta WHERE singleton = 1",
        [],
        |row| row.get(0),
    )?)
}

/// Copy the seat's own tables off the live replica onto the adopted one.
///
/// `INSERT OR IGNORE` and `SELECT *`: the columns are the same DDL on both
/// sides (this crate owns it, and the gateway shapes the artifact with the same
/// statements), and the ignore is what makes a replayed adoption — a kill
/// between the copy and the rename, then a retry — land the same rows once
/// rather than fail on a primary key.
///
/// `seat_state` is NOT carried. It is the one seat-own table whose value comes
/// from the ARTIFACT rather than from the file being replaced: carrying the old
/// cursor onto a fresh copy is exactly the position the gateway just refused to
/// serve from.
fn attach_live(adopted: &Connection, live: &Path) -> Result<bool> {
    // A live path that is not a replica at all (an empty file from a previous
    // aborted bootstrap) carries nothing, and saying so beats refusing: the
    // seat has no queue to lose.
    let live_connection = Connection::open(live)?;
    let is_a_replica = crate::state::seat_state(&live_connection).is_ok();
    drop(live_connection);
    if !is_a_replica {
        return Ok(false);
    }
    adopted.execute(
        "ATTACH DATABASE ?1 AS live",
        [live.to_string_lossy().as_ref()],
    )?;
    Ok(true)
}

fn carry_over(adopted: &rusqlite::Transaction<'_>) -> Result<(usize, usize)> {
    let live_has_a_pairing: bool = adopted.query_row(
        "SELECT EXISTS(SELECT 1 FROM live.sqlite_master
                        WHERE type = 'table' AND name = 'seat_gateway')",
        [],
        |row| row.get(0),
    )?;
    let intents = adopted.execute(
        "INSERT OR IGNORE INTO seat_outbox SELECT * FROM live.seat_outbox",
        [],
    )?;
    let settled = adopted.execute(
        "INSERT OR IGNORE INTO seat_outbox_settled SELECT * FROM live.seat_outbox_settled",
        [],
    )?;
    // THE PAIRING, when this adoption was not handed a fresh one. `INSERT OR
    // IGNORE` like its siblings, and the singleton primary key is what makes a
    // replayed adoption land it once.
    if live_has_a_pairing {
        adopted.execute(
            "INSERT OR IGNORE INTO seat_gateway SELECT * FROM live.seat_gateway",
            [],
        )?;
    }
    // AN INTENT WAITING FOR A COMMIT GOES BACK IN THE QUEUE.
    //
    // `sending` and `awaiting-change` are both a seat waiting on something
    // that lives in a log this file no longer has: `sending` is a socket
    // that is gone, and `awaiting-change` is a commit seq the fresh
    // artifact deleted the log for. Carried verbatim they would wait for
    // ever, which is a member's write that never lands and never fails.
    //
    // Every other state keeps its verdict. A `denied` intent stays denied
    // because the member is owed the refusal, and dropping it on a repair
    // nobody asked for would make a refusal look like a success.
    //
    // The `record_json` is rewritten with the same two fields, because the
    // row carries the record twice — columns for querying and JSON for
    // reading back — and a repair that moved one would leave a queue that
    // disagrees with itself.
    adopted.execute(
        "UPDATE seat_outbox
            SET state = 'queued',
                commit_seq = NULL,
                record_json = json_set(
                    json_remove(record_json, '$.commit_seq'),
                    '$.state', 'queued')
          WHERE state IN ('sending', 'awaiting-change')",
        [],
    )?;
    Ok((intents, settled))
}
