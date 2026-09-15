//! `seat_gateway`: WHICH gateway this replica is paired to, durably (#1025 S5).
//!
//! ## The defect this closes
//!
//! The pairing record lived in one place: a `Mutex<Option<PairedGateway>>`
//! inside `centraid_seat_link::SeatLink`, set by `pair()` and by an `adopt()`
//! whose only caller in the whole repository was a test. Its doc comment said
//! "re-adopt a gateway the shell persisted" — and no shell persisted one,
//! because there was nowhere to persist it to.
//!
//! So a seat that reopened had no address to dial. `SeatLink::sync` begins
//! `let Some(gateway) = self.gateway() else { return unreachable }`, which is
//! why a relaunched seat reported itself offline with **no connection
//! attempt at all**: not refused by the gateway, never dialled. S5's other half
//! made the endpoint KEY durable, which on its own is a durable identity for a
//! seat that no longer knows who to present it to. Both halves are needed and
//! neither is enough.
//!
//! ## Why its own table and not columns on `seat_state`
//!
//! `seat_state` is the seat's POSITION — epoch, cursor, watermark — and it is
//! UPSERT-ed whole by `init_seat_state` on every bootstrap. The pairing is a
//! different fact with a different lifetime: it survives the bootstrap that
//! rewrites the position, and it is written at a moment when no position exists
//! yet. Folding them together would mean an install either clobbering the
//! pairing or carrying an exception list through the one function that is meant
//! to state a fresh position outright.
//!
//! ## THE FOURTH THING THE GATEWAY HAS NEVER HEARD OF
//!
//! `crates/seat/src/install.rs` lists three — the queue, its order, and the
//! settled journal — and carries them across a re-bootstrap. This is the
//! fourth, and for the same reason: a repair that lost the pairing would leave
//! a seat holding a fresh copy of a vault it could no longer reach.

use rusqlite::Connection;

use crate::error::{Result, SeatError};

/// The DDL. A singleton, like `seat_state`: one replica, one pairing.
pub const SEAT_GATEWAY_DDL: &str = r"
CREATE TABLE IF NOT EXISTS seat_gateway (
  singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
  endpoint_id  TEXT NOT NULL CHECK (length(endpoint_id) = 64),
  relay_url    TEXT NOT NULL DEFAULT '',
  direct_addrs TEXT NOT NULL DEFAULT '[]',
  vault_id     TEXT NOT NULL,
  vault_name   TEXT NOT NULL DEFAULT '',
  device_id    TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL
) STRICT;
";

/// Where this seat's gateway is, and what it is called.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedGateway {
    /// THE AUTHORITY. 64 lowercase hex characters — iroh's TLS proves this and
    /// nothing else here is proved by anything.
    pub endpoint_id: String,
    /// A dialling hint. Empty is "no relay", which is a LAN-only deployment.
    pub relay_url: String,
    /// Dialling hints, `<ip>:<port>`. NO AUTHORITY: a stale or tampered
    /// address reaches the right gateway or nothing at all.
    pub direct_addrs: Vec<String>,
    pub vault_id: String,
    pub vault_name: String,
    /// The device id the gateway filed this seat under. Empty when the gateway
    /// did not say.
    pub device_id: String,
}

/// Write the pairing, creating the table if this replica has not got one.
///
/// **A CHANGED `endpoint_id` IS LOGGED, NOT SILENT.** Re-pairing to a different
/// machine is legitimate — an owner moves the vault and the gateway's identity
/// moves with it — so this overwrites rather than refusing. What it will not do
/// is let the one value that carries authority change without saying so, which
/// is the difference between a vault that moved and a ticket that was not what
/// the member thought it was.
pub fn remember_gateway(connection: &Connection, gateway: &PairedGateway, now: &str) -> Result<()> {
    connection.execute_batch(SEAT_GATEWAY_DDL)?;
    if let Some(held) = paired_gateway(connection)?
        && held.endpoint_id != gateway.endpoint_id
    {
        tracing::warn!(
            was = %held.endpoint_id,
            now = %gateway.endpoint_id,
            "this replica is now paired to a different gateway identity"
        );
    }
    let addrs =
        serde_json::to_string(&gateway.direct_addrs).map_err(|error| SeatError::Invariant {
            context: format!("the gateway's address hints would not encode: {error}"),
        })?;
    connection
        .execute(
            "INSERT INTO seat_gateway
           (singleton, endpoint_id, relay_url, direct_addrs, vault_id, vault_name,
            device_id, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (singleton) DO UPDATE SET
           endpoint_id = excluded.endpoint_id,
           relay_url = excluded.relay_url,
           direct_addrs = excluded.direct_addrs,
           vault_id = excluded.vault_id,
           vault_name = excluded.vault_name,
           device_id = excluded.device_id,
           updated_at = excluded.updated_at",
            rusqlite::params![
                gateway.endpoint_id,
                gateway.relay_url,
                addrs,
                gateway.vault_id,
                gateway.vault_name,
                gateway.device_id,
                now
            ],
        )
        .map_err(|error| SeatError::from_sqlite("recording this seat's gateway", error))?;
    Ok(())
}

/// The pairing this replica holds, if it holds one.
///
/// `None` covers both "no table" and "no row", which are one seat fact: this
/// replica has never been paired. Neither may become a guess.
pub fn paired_gateway(connection: &Connection) -> Result<Option<PairedGateway>> {
    let read = connection.query_row(
        "SELECT endpoint_id, relay_url, direct_addrs, vault_id, vault_name, device_id
           FROM seat_gateway WHERE singleton = 1",
        [],
        |row| {
            Ok(PairedGateway {
                endpoint_id: row.get(0)?,
                relay_url: row.get(1)?,
                direct_addrs: serde_json::from_str::<Vec<String>>(&row.get::<_, String>(2)?)
                    // A HINT LIST THAT WILL NOT PARSE IS NO HINTS, not a
                    // refusal. The relay and the endpoint id still reach the
                    // gateway; losing the shortcut must not lose the pairing.
                    .unwrap_or_default(),
                vault_id: row.get(3)?,
                vault_name: row.get(4)?,
                device_id: row.get(5)?,
            })
        },
    );
    match read {
        Ok(gateway) => Ok(Some(gateway)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) if error.to_string().contains("no such table: seat_gateway") => Ok(None),
        Err(error) => Err(SeatError::Sqlite(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-01-01T00:00:00.000Z";

    fn gateway(endpoint: &str) -> PairedGateway {
        PairedGateway {
            endpoint_id: endpoint.repeat(64 / endpoint.len()),
            relay_url: "https://relay.example".to_owned(),
            direct_addrs: vec!["192.168.1.20:41234".to_owned(), "[::1]:41234".to_owned()],
            vault_id: "v-1".to_owned(),
            vault_name: "Personal".to_owned(),
            device_id: "d-1".to_owned(),
        }
    }

    #[test]
    fn a_replica_with_no_pairing_says_so_rather_than_guessing() {
        let connection = Connection::open_in_memory().expect("opens");
        assert_eq!(paired_gateway(&connection).expect("reads"), None);
        connection
            .execute_batch(SEAT_GATEWAY_DDL)
            .expect("the DDL runs");
        // The table without its row is still "never paired", not a default.
        assert_eq!(paired_gateway(&connection).expect("reads"), None);
    }

    /// THE WHOLE POINT: what goes in comes back out, hints and all, off a file
    /// that was closed in between.
    #[test]
    fn the_pairing_survives_a_close_and_reopen() {
        let dir = std::env::temp_dir().join("centraid-seat-gateway-roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("a scratch dir");
        let path = dir.join("replica.db");
        let written = gateway("ab");
        {
            let connection = Connection::open(&path).expect("opens");
            remember_gateway(&connection, &written, NOW).expect("written");
        }
        let connection = Connection::open(&path).expect("reopens");
        assert_eq!(paired_gateway(&connection).expect("reads"), Some(written));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A SECOND PAIRING REPLACES THE FIRST rather than accumulating. One
    /// replica has one gateway; two rows would be two answers to "where is it".
    #[test]
    fn a_second_pairing_replaces_the_first() {
        let connection = Connection::open_in_memory().expect("opens");
        remember_gateway(&connection, &gateway("ab"), NOW).expect("written");
        let moved = PairedGateway {
            vault_name: "Personal (moved)".to_owned(),
            ..gateway("cd")
        };
        remember_gateway(&connection, &moved, NOW).expect("written");
        assert_eq!(paired_gateway(&connection).expect("reads"), Some(moved));
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM seat_gateway", [], |row| row.get(0))
            .expect("counts");
        assert_eq!(rows, 1);
    }

    /// A HINT LIST THAT WILL NOT PARSE IS NO HINTS. The relay and the endpoint
    /// id still reach the gateway, so losing the shortcut must not lose the
    /// pairing — which is the difference between a slower dial and a seat that
    /// has to be paired again.
    #[test]
    fn an_unreadable_hint_list_does_not_lose_the_pairing() {
        let connection = Connection::open_in_memory().expect("opens");
        remember_gateway(&connection, &gateway("ab"), NOW).expect("written");
        connection
            .execute("UPDATE seat_gateway SET direct_addrs = 'not json'", [])
            .expect("the column is text");
        let held = paired_gateway(&connection)
            .expect("reads")
            .expect("the pairing is still here");
        assert!(held.direct_addrs.is_empty());
        assert_eq!(held.endpoint_id, gateway("ab").endpoint_id);
    }
}
