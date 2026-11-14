//! SQLite's memory statistics, off for this process (#1188).
//!
//! SQLite keeps memory statistics by default, and while it does every `sqlite3_malloc` and
//! `sqlite3_free` of the process takes one mutex. What a world does is mostly that (each solved
//! scenario copies the vault file and opens it twice), so worlds on several threads ran at one
//! thread's speed. The workspace's build flags are not this crate's to change, so the setting is
//! made at run time: `sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 0)`, which SQLite accepts only
//! before it initialises, that is before the first connection of the process is opened.
//!
//! The statistics only feed `sqlite3_memory_used` and the soft heap limit, which nothing here
//! reads, so what a world holds is the same bytes with or without them.

// The one place this crate calls into C: the workspace links SQLite already (through the vault),
// and `sqlite3_config` is not reachable through any safe API of it.
#![allow(unsafe_code)]

use std::ffi::c_int;
use std::sync::OnceLock;

use anyhow::{Result, bail};

/// `SQLITE_CONFIG_MEMSTATUS`, from `sqlite3.h`.
const CONFIG_MEMSTATUS: c_int = 9;
/// `SQLITE_OK`.
const OK: c_int = 0;
/// `SQLITE_MISUSE`: SQLite was already initialised.
const MISUSE: c_int = 21;

unsafe extern "C" {
    fn sqlite3_config(op: c_int, ...) -> c_int;
}

/// The result of the one attempt, as its return code.
static CODE: OnceLock<c_int> = OnceLock::new();

/// Turn SQLite's memory statistics off. Idempotent: the first call makes the setting and every
/// later one reports its outcome.
///
/// # Errors
///
/// If SQLite refuses: it was initialised already (a connection was opened before this call, so the
/// setting would not take effect) or it was built without the option. Never ignored, because a
/// silently slow run is the failure this exists to prevent.
pub fn off() -> Result<()> {
    // SAFETY: `sqlite3_config` takes an option and, for this option, one `int`; it is called with
    // exactly that, before any other thread of this process can have opened a connection (every
    // entry point calls this first, and a second call does not reach here).
    let code = *CODE.get_or_init(|| unsafe { sqlite3_config(CONFIG_MEMSTATUS, 0 as c_int) });
    match code {
        OK => Ok(()),
        MISUSE => bail!(
            "SQLite was initialised before its memory statistics were turned off (SQLITE_MISUSE): a connection was opened first"
        ),
        other => bail!("sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 0) failed with code {other}"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_setting_is_made_once_and_reported_the_same_after() {
        let first = super::off();
        let second = super::off();
        assert_eq!(first.is_ok(), second.is_ok());
    }
}
