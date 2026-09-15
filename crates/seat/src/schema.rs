//! THE SEAT'S OWN TABLES, IN ONE PLACE (#1025 S7, item 3).
//!
//! A replica is the gateway's replicated tables plus a handful the gateway has
//! never heard of: the cursor, the outbox, the settled journal and the pairing
//! record. Until this module the four were created by whoever happened to reach
//! them first — `Outbox::open` ran its DDL, `prepare_replica` ran
//! `SEAT_GATEWAY_DDL`, `init_seat_state` ran its own — and there was no list of
//! them anywhere, so nothing could be said about the set.
//!
//! Two things need the set as a set, and both are what item 3 turns the
//! bootstrap into:
//!
//! * **The gateway builds the blob replica-shaped.** It runs [`SEAT_OWN_DDL`]
//!   on the snapshot copy, so the artifact a phone adopts is already a replica
//!   — every table it will need, empty — and adoption is a rename rather than a
//!   table copy.
//! * **A re-bootstrap keeps what the gateway never had.** It is one
//!   `INSERT … SELECT` per name in [`SEAT_OWN_TABLES`], from the old file into
//!   the new one, in one transaction. A list that could go stale is the reason
//!   this is a constant beside the DDL that creates them rather than a query
//!   over `sqlite_master`: a `seat_` prefix match would also catch a table some
//!   future app happened to name that way, and silently carry it.
//!
//! SQL literals are allowed here: `crates/seat` is one of the five crates the
//! `sql-confinement` rule names, and these tables are this crate's own.

/// Every table a seat owns and the gateway has never heard of.
///
/// The order is the order a re-bootstrap copies them in, and it is
/// **dependency-free on purpose**: none of these references another, so a
/// carry-over cannot be half-valid. `seat_state` is last because it is the
/// file's own "this is a replica" mark, and a file that reached its
/// destination without one reads as "this seat has no copy".
pub const SEAT_OWN_TABLES: [&str; 6] = [
    "seat_outbox",
    "seat_outbox_settled",
    "seat_pending_rows",
    // A LANDED BYTE IS A ROW (#1025, D-1025-S7-20). It is carried across a
    // re-bootstrap like the rest — and unlike the rest it is also REBUILT from
    // the byte store at every core open, so a carry-over that went wrong
    // cannot outlive one launch. Both, rather than either: the carry keeps the
    // grid drawn through an adoption, and the rebuild is what makes drift
    // impossible.
    "seat_blob_held",
    "seat_gateway",
    "seat_state",
];

/// The DDL for all of them, as one batch.
///
/// Composed from the three constants that already existed rather than a fourth
/// copy of the same statements: two spellings of one table is the defect the
/// mount rules are about, one level down. Every statement is `IF NOT EXISTS`,
/// so running it over a file that already has them is the ordinary case and not
/// an error — which is what makes a re-bootstrap's redo idempotent.
#[must_use]
pub fn seat_own_ddl() -> String {
    format!(
        "{}{}{}{}{}",
        crate::outbox::SEAT_OUTBOX_DDL,
        crate::pending::SEAT_PENDING_DDL,
        crate::held::SEAT_BLOB_HELD_DDL,
        crate::gateway::SEAT_GATEWAY_DDL,
        crate::state::SEAT_STATE_DDL,
    )
}

/// Lay the seat's own tables on a connection.
///
/// The one call a gateway makes when it shapes a bootstrap blob, and the one a
/// bootstrap makes when it adopts one.
pub fn lay_seat_tables(connection: &rusqlite::Connection) -> crate::error::Result<()> {
    connection.execute_batch(&seat_own_ddl())?;
    Ok(())
}
