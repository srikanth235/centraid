//! The `PERSIST_WAL` shim, which is why this crate has an unsafe block
//! (#1029 W5, hand-off 5).
//!
//! Three claims, and they are different claims:
//!
//! 1. **The file control is accepted.** `sqlite3_file_control` answers
//!    `SQLITE_OK` rather than `SQLITE_NOTFOUND`, so the VFS this build links
//!    implements it at all.
//! 2. **The setting is ON afterwards.** A call that returned `OK` and left the
//!    flag clear would be a shim that runs and does nothing, which is the shape
//!    that rots silently — so the flag is read back through the same control
//!    with a negative value, which SQLite treats as a query.
//! 3. **The `-wal` outlives the last connection** on a real [`Vault`], through
//!    the seam, without this test touching the vault's connection.
//!
//! The first two are asserted against a connection this test opens itself, and
//! deliberately: `Vault::connection` is `pub(crate)` so that nothing outside
//! `crates/vault` can reach the handle, and a test that needed it opened would
//! be a test that argued for widening the thing the `sql-confinement` rule
//! exists to keep narrow.

use centraid_core_ffi::wal;
use centraid_vault::Vault;
use centraid_vault::rusqlite::Connection;

fn scratch() -> std::path::PathBuf {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the scratch directory is made");
    dir
}

#[test]
fn the_shim_is_accepted_and_the_setting_reads_back_on() {
    let dir = scratch();
    let connection = Connection::open(dir.join("plain.db")).expect("a connection");
    connection
        .pragma_update(None, "journal_mode", "wal")
        .expect("wal mode");

    // THE FLAG BEFORE. SQLite does not persist the `-wal` by default, and
    // asserting the before is what makes the after mean something rather than
    // being the default it already was.
    assert_eq!(
        wal::persisting(&connection),
        Some(false),
        "SQLite does not persist the `-wal` by default; this is the state the \
         shim changes"
    );

    wal::persist(&connection).expect("the file control is accepted");

    assert_eq!(
        wal::persisting(&connection),
        Some(true),
        "the control returned OK and the setting has to be on: a shim that ran \
         and changed nothing is the failure this second assertion exists for"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// THE PROPERTY, END TO END: the sidecar outlives the connection.
///
/// `crates/vault`'s `a_relaunch_does_not_break_the_generation` proves the same
/// property holds on this host WITHOUT the shim, because
/// `SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE` is enough here. This one proves it holds
/// WITH the shim installed through the seam, which is the state a phone runs in
/// — and the two together are why the shim is a hardening rather than a fix:
/// neither phone's SQLite has ever been compiled in this container, and the
/// shim is what covers a build whose close path takes the deletion branch.
#[test]
fn the_wal_is_still_there_after_the_last_connection_closes() {
    let dir = scratch();
    let path = dir.join("v.db");
    let wal_path = dir.join("v.db-wal");

    // INSTALLED THROUGH THE SEAM, the way `centraid_open` installs it, rather
    // than called by hand on one connection: what the product does is register
    // it once and let every vault the process opens pick it up.
    centraid_vault::wal_persistence::install(wal::persist);
    assert!(
        centraid_vault::wal_persistence::installed(),
        "the seam reports a host; a second install answers false, which is not \
         a failure — two callers installing the same shim is what a test binary \
         and a shell both calling `centraid_open` look like"
    );

    {
        let vault = Vault::create(path).expect("a vault");
        vault.found("Persist", "Owner").expect("founded");
        // The app owns checkpoints, and a checkpointed WAL is the one SQLite
        // would otherwise delete at close. This is the case the shim is for.
        centraid_vault::backup::capture::checkpoint(
            &vault,
            &centraid_vault::backup::BackupHome::open(dir.join("backup"))
                .expect("a backup home")
                .spool()
                .expect("a spool"),
        )
        .expect("the app checkpoints");
    }

    assert!(
        wal_path.exists(),
        "the `-wal` outlives the last connection: capture reads a missing one \
         as a restart with new salts and owes a FULL BASE for it"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
