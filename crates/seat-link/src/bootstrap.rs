//! A seat that has never synced (#1020, D-1020-B6).
//!
//! There are two ways a replica starts, and this module is the second one.
//!
//! **From a snapshot.** The gateway cuts one, the seat inflates it, and it
//! arrives holding rows and a cursor at the snapshot's floor. That is what
//! `crates/seat/tests/common` builds and it is the right path for a vault with
//! history: a million-row log replayed from seq 1 is a download nobody wants.
//!
//! **From the floor.** An empty file, `applied_seq = 0`, and the whole log
//! applied in pages. Slower for a big vault and exactly right for a new one —
//! and it is the only path that needs nothing but the seat lane, which makes it
//! the one a phone can take with a QR code and no other channel.
//!
//! ## Why the epoch comes from a page and not from pairing
//!
//! `PairOk` carries `vault_id` and not the epoch. The epoch is the log's
//! identity and it changes on a restore, so a seat that assumed one would be
//! writing a cursor against a log that may not exist. So [`bootstrap_from`]
//! takes the header of a page the gateway actually served: the epoch,
//! `schema_epoch` and `ddl_version` in it are what that gateway is serving
//! right now, which is the only version of those facts worth storing.
//!
//! ## `applied_commit_seq` starts at zero, and that is honest
//!
//! A seat bootstrapped from the floor has applied nothing, so there is no
//! commit for an overlay to clear against. Zero says that. A snapshot-cut seat
//! says the same thing for a different reason — the snapshot deleted the log it
//! could have read the commit from — and `crates/seat/tests/common` records it
//! in those words.

use centraid_seat::applier::PageHeader;
use centraid_seat::{SeatPosition, state};
use rusqlite::Connection;

/// Whether this file already carries a replica's position.
///
/// A missing `seat_state` TABLE and a missing ROW are the same answer: neither
/// is a replica. Asking for the row and treating any failure as "no" is what
/// makes this work on a file that has never been touched.
#[must_use]
pub fn is_bootstrapped(connection: &Connection) -> bool {
    state::seat_state(connection).is_ok()
}

/// Lay down the replicated schema and the seat's own tables, at the floor.
///
/// `header` must come from a page this gateway served. Idempotent: running it
/// on a file that is already a replica leaves the position alone, because
/// `init_seat_state` upserts and a re-bootstrap that reset `applied_seq` would
/// re-apply the entire log over rows that already hold it.
pub fn bootstrap_from(
    connection: &Connection,
    vault_id: &str,
    header: &PageHeader,
    now: &str,
) -> Result<(), String> {
    if is_bootstrapped(connection) {
        return Ok(());
    }
    // THE BASELINE IS COMPILED IN, so a phone carries its own schema and does
    // not fetch one. `IF NOT EXISTS` is not assumed: the file is empty by the
    // check above, and a partial schema is a file to refuse rather than patch.
    connection
        .execute_batch(centraid_vault::migrations::BASELINE_SQL)
        .map_err(|error| format!("the replica's schema would not lay down: {error}"))?;
    state::init_seat_state(
        connection,
        &SeatPosition {
            vault_id: vault_id.to_owned(),
            epoch: header.epoch.clone(),
            schema_epoch: header.schema_epoch,
            ddl_version: header.ddl_version,
            applied_seq: 0,
            applied_commit_seq: 0,
        },
        now,
    )
    .map_err(|error| format!("the replica's position would not initialise: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header() -> PageHeader {
        PageHeader {
            epoch: "epoch-1".to_owned(),
            schema_epoch: 1,
            ddl_version: 0,
            watermark: 12,
        }
    }

    #[test]
    fn an_empty_file_is_not_a_replica_until_it_is_bootstrapped() {
        let connection = Connection::open_in_memory().expect("memory");
        assert!(!is_bootstrapped(&connection));
        bootstrap_from(
            &connection,
            "vault-1",
            &header(),
            "2026-01-01T00:00:00.000Z",
        )
        .expect("it bootstraps");
        assert!(is_bootstrapped(&connection));
        let state = state::seat_state(&connection).expect("a position");
        assert_eq!(
            state.applied_seq, 0,
            "a floor bootstrap has applied nothing"
        );
        assert_eq!(state.epoch, "epoch-1");
        assert_eq!(state.vault_id, "vault-1");
    }

    /// THE ONE THAT WOULD HURT. A second bootstrap on a synced replica must not
    /// reset the cursor — that would re-apply the whole log over rows that
    /// already hold it, on every pass, forever.
    #[test]
    fn bootstrapping_twice_does_not_rewind_a_synced_replica() {
        let connection = Connection::open_in_memory().expect("memory");
        bootstrap_from(
            &connection,
            "vault-1",
            &header(),
            "2026-01-01T00:00:00.000Z",
        )
        .expect("it bootstraps");
        connection
            .execute(
                "UPDATE seat_state SET applied_seq = 400 WHERE singleton = 1",
                [],
            )
            .expect("the seat advances");
        bootstrap_from(
            &connection,
            "vault-1",
            &header(),
            "2026-01-02T00:00:00.000Z",
        )
        .expect("the second is a no-op");
        assert_eq!(
            state::seat_state(&connection)
                .expect("a position")
                .applied_seq,
            400
        );
    }

    /// The replicated tables really are there, so the first page has somewhere
    /// to land. `core_content_item` specifically, because the byte plane plans
    /// over it.
    #[test]
    fn the_replicated_schema_is_laid_down() {
        let connection = Connection::open_in_memory().expect("memory");
        bootstrap_from(
            &connection,
            "vault-1",
            &header(),
            "2026-01-01T00:00:00.000Z",
        )
        .expect("it bootstraps");
        for table in [
            "core_entity",
            "core_content_item",
            "core_content_derivative",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("sqlite_master reads");
            assert_eq!(count, 1, "{table} is missing from a bootstrapped replica");
        }
    }
}
