//! The seam a host uses to make the `-wal` sidecar PERSIST (#1029 W5, hand-off 5).
//!
//! ## Why this is a seam and not a pragma
//!
//! `SQLITE_FCNTL_PERSIST_WAL` is a **file control**, not a pragma: it is set by
//! `sqlite3_file_control(db, NULL, SQLITE_FCNTL_PERSIST_WAL, &on)`. rusqlite
//! 0.40 exposes no safe wrapper, and this crate is `#![forbid(unsafe_code)]` —
//! which is not an inconvenience to work around. The constitution puts every
//! unsafe block in `crates/core-ffi`, where the C ABI already is and where one
//! reviewer reads all of it. So the call lives there and this is where it is
//! plugged in.
//!
//! ## What it adds over `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE`, and what it does not
//!
//! `Vault::apply_pragmas` already sets `NO_CKPT_ON_CLOSE`, and W1 argued that
//! covered the requirement because SQLite only removes the `-wal` after the
//! close-time checkpoint it now skips. W3 then recorded the opposite — "it costs
//! a base on every restart" — and the two claims sat side by side in the receipt
//! with no measurement between them.
//!
//! **W5 measured it**, and W1's half was right on this platform:
//! [`crate::file`]'s `a_relaunch_does_not_break_the_generation` opens a vault,
//! captures, checkpoints, drops the connection and reopens — and capture comes
//! back on the SAME generation with `broke: false`, because the `-wal` survives
//! the close with its salts. **The vault does not owe a base per app launch
//! here.**
//!
//! The shim is installed anyway, and the reason is precise rather than
//! defensive. The two settings are not one guarantee:
//!
//! - `NO_CKPT_ON_CLOSE` says *do not checkpoint when the last connection
//!   closes*. SQLite then leaves the `-wal` because it will not delete one it
//!   has not checkpointed.
//! - `PERSIST_WAL` says *do not delete the `-wal` at close even when it has
//!   been checkpointed*.
//!
//! The gap between them is a WAL this product deliberately checkpoints
//! (`backup::capture::checkpoint`, since `wal_autocheckpoint = 0` makes
//! checkpoints the app's) followed by a close on a build whose close path takes
//! the deletion branch. **The measurement above is a Linux measurement against
//! this workspace's `libsqlite3-sys`. The phone runs Apple's system SQLite and
//! Android's, and neither has ever been measured in this container** — so the
//! honest state is "held here, unverified there", and the shim closes the gap
//! rather than betting on it.
//!
//! ## No host, no shim, no failure
//!
//! A process that installs nothing gets a vault with `NO_CKPT_ON_CLOSE` and
//! nothing else, which is exactly what it had before. The seam is not a
//! requirement: `crates/centraid`'s CLI paths and every test in this crate run
//! without it, and a seam whose absence failed an open would make the shim a
//! dependency of the vault rather than a hardening of it.

use std::sync::OnceLock;

use rusqlite::Connection;

/// What a host installs: apply the file control to one open connection.
///
/// It answers a `String` rather than a [`crate::error::VaultError`] because the
/// implementor is `crates/core-ffi` and the failure it can produce is an SQLite
/// result code, which has no variant here and does not deserve one.
pub type Persist = fn(&Connection) -> Result<(), String>;

static PERSIST: OnceLock<Persist> = OnceLock::new();

/// Install the host's file control. **Once per process**, and the first wins.
///
/// Answers `false` when one was already installed, which is not an error: two
/// callers installing the same shim is what a test binary and a shell both
/// calling `centraid_open` looks like. It is `false` rather than a panic
/// because a process that installed one is already in the state the caller
/// wanted.
pub fn install(persist: Persist) -> bool {
    PERSIST.set(persist).is_ok()
}

/// Whether a host has installed one. Read by tests and by nothing else.
#[must_use]
pub fn installed() -> bool {
    PERSIST.get().is_some()
}

/// Apply the installed control to a freshly opened connection.
///
/// **A failure is logged and not returned**, and that is deliberate: the
/// vault's durability does not depend on this — `NO_CKPT_ON_CLOSE` is set on
/// the same connection either way — so a file control that a particular SQLite
/// build refuses must not turn into a vault that will not open. What it must
/// not be is silent, because a shim that quietly did nothing is a shim nobody
/// would notice had stopped working.
pub(crate) fn apply(connection: &Connection) {
    let Some(persist) = PERSIST.get() else {
        return;
    };
    if let Err(reason) = persist(connection) {
        tracing::warn!(
            %reason,
            "the WAL-persistence file control was refused; the `-wal` may be removed when the \
             last connection closes, which costs a full base on the next capture"
        );
    }
}
