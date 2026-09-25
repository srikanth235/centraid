//! `SQLITE_FCNTL_PERSIST_WAL`, which needs C (#1029 W5, hand-off 5).
//!
//! ## Why the unsafe is here
//!
//! `crates/vault` is `#![forbid(unsafe_code)]` and so is `crates/core`. The
//! constitution puts every unsafe block in this crate, where the C ABI already
//! is and where one reviewer reads all of it — so a vault-shaped need for a C
//! call comes HERE and plugs into a seam over there
//! ([`centraid_vault::wal_persistence`]), rather than opening an `unsafe` block
//! in the crate that owns the file.
//!
//! ## What the call is, and why it is not a pragma
//!
//! `PRAGMA persist_wal` does not exist. Persistence of the `-wal` sidecar is a
//! **file control**: `sqlite3_file_control(db, NULL, SQLITE_FCNTL_PERSIST_WAL,
//! &on)`, where `NULL` names the `main` database and `on` is an `int` the call
//! reads and writes back (passing `-1` queries it, which is how
//! [`persisting`] asks without changing anything). rusqlite 0.40 has no safe
//! wrapper for it.
//!
//! ## What it buys over the pragma that is already set
//!
//! `Vault::apply_pragmas` sets `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`, and the two
//! are different promises: that one says *do not checkpoint at close*, and this
//! one says *do not delete the `-wal` at close even when it has been
//! checkpointed*. `centraid_vault::wal_persistence`'s header has the
//! measurement — on this workspace's SQLite the first is enough, and neither
//! phone's SQLite has ever been measured in this container.

use std::ffi::c_int;

use centraid_vault::rusqlite::Connection;

/// Ask this connection's `main` database to keep its `-wal` across a close.
///
/// Installed into `centraid_vault` by [`crate::install_wal_persistence`] and
/// called by the vault on every connection it opens.
///
/// # Errors
///
/// The SQLite result code, as text, when the file control is refused. A VFS
/// that does not implement it answers `SQLITE_NOTFOUND`, which is a refusal
/// and not a fault — the caller logs it and carries on, because the vault's
/// durability does not depend on this.
pub fn persist(connection: &Connection) -> Result<(), String> {
    match file_control(connection, 1) {
        code if code == centraid_vault::rusqlite::ffi::SQLITE_OK => Ok(()),
        code => Err(format!("sqlite3_file_control(PERSIST_WAL) answered {code}")),
    }
}

/// Whether this connection's `main` database is currently persisting its WAL.
///
/// Reads without writing: SQLite treats a negative value as a query. Used by
/// this crate's own test, because "the call did not fail" and "the setting is
/// on" are different claims and only the second one is the one that matters.
#[must_use]
pub fn persisting(connection: &Connection) -> Option<bool> {
    let mut flag: c_int = -1;
    let code = file_control_with(connection, &raw mut flag);
    if code == centraid_vault::rusqlite::ffi::SQLITE_OK {
        Some(flag != 0)
    } else {
        None
    }
}

fn file_control(connection: &Connection, on: c_int) -> c_int {
    let mut flag: c_int = on;
    file_control_with(connection, &raw mut flag)
}

/// The one unsafe call.
///
/// # Safety
///
/// Three things are required and all three hold here:
///
/// 1. **`handle()` must be used only while `connection` is alive.** It is
///    borrowed for the length of this function and never stored; the raw
///    pointer does not outlive the `&Connection` it came from.
/// 2. **`flag` must point to a writable `int`.** It is a caller-owned local in
///    every call site above, passed by raw pointer to its own stack slot.
/// 3. **The database name may be NULL**, which SQLite documents as `main`. It
///    is what the product wants — there is one database on this connection and
///    nothing is ever `ATTACH`ed (`crates/vault`'s one-connection invariant).
///
/// SQLite is single-threaded per connection here: `Vault` holds one
/// `Connection` behind its own `!Sync` guard depth, so nothing else is inside
/// this handle while the call runs.
fn file_control_with(connection: &Connection, flag: *mut c_int) -> c_int {
    // SAFETY: clauses 1-3 above. `handle` is unsafe because the caller must not
    // outlive the connection, and this call does not: the pointer is used
    // inside the same expression that produces it and never escapes.
    unsafe {
        centraid_vault::rusqlite::ffi::sqlite3_file_control(
            connection.handle(),
            std::ptr::null(),
            centraid_vault::rusqlite::ffi::SQLITE_FCNTL_PERSIST_WAL,
            flag.cast::<std::ffi::c_void>(),
        )
    }
}
