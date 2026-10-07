//! A VAULT CLOSED OVER THE ABI OPENS AGAIN IN THE SAME PROCESS.
//!
//! `mobile/core`'s `AbiRoundTripSpec` runs `open → close → open` on one path,
//! from one JVM, and a phone switching back to a vault it left does the same.
//! The second open must return, and the core it returns must hold its byte
//! store again rather than text only. The store is a directory of files with
//! no lock and no index (#1080), so nothing the first core held can stand in
//! the second one's way; this test is what keeps that true.
//!
//! The sequence at the C boundary, with nothing added: one founded file,
//! `centraid_open` → `centraid_close` → `centraid_open`. The second open runs
//! on a thread of its own because a regression here is a hang, and a hang is
//! the one failure a test runner reports as a timeout rather than as the
//! sentence below.

use std::sync::mpsc;
use std::time::Duration;

use centraid_core_ffi::{CENTRAID_OK, centraid_close, centraid_open};

/// Far above a cold open on a slow CI machine, far below "hung".
const REOPEN_DEADLINE: Duration = Duration::from_secs(60);

fn open(config: &str) -> *mut centraid_core::Handle {
    let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
    // SAFETY: `config` lives for the call, and `handle` is a live local.
    let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
    assert_eq!(code, CENTRAID_OK, "the core opens: {config}");
    assert!(!handle.is_null());
    handle
}

#[test]
fn a_vault_closed_over_the_abi_opens_again_in_the_same_process() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let path = dir.join("vault.db");

    // FOUNDED ONCE, AS `spike-fixture` DOES, then opened as a shell opens it.
    let founding = format!(
        r#"{{"path":{:?},"create":true}}"#,
        path.display().to_string()
    );
    let first = open(&founding);
    // SAFETY: the handle is live and this thread is its only user.
    let core = unsafe { &*first };
    core.with_vault(|vault| Ok(vault.found("Reopen", "Owner")?))
        .expect("it founds");
    assert!(
        core.owns_its_bytes(),
        "`centraid_open` opens `<vault>.bytes` beside the file — without it this \
         test would not be exercising the store a reopen must find again"
    );
    // SAFETY: the handle came from `centraid_open` and is closed exactly once.
    assert_eq!(unsafe { centraid_close(first) }, CENTRAID_OK);

    let config = format!(
        r#"{{"path":{:?},"create":false}}"#,
        path.display().to_string()
    );
    let (sent, received) = mpsc::channel();
    std::thread::spawn(move || {
        let handle = open(&config);
        // SAFETY: the handle is live and this thread is its only user.
        let owns = unsafe { &*handle }.owns_its_bytes();
        // SAFETY: the handle came from `centraid_open` and is closed once.
        let closed = unsafe { centraid_close(handle) };
        sent.send((owns, closed)).ok();
    });
    let (owns, closed) = received.recv_timeout(REOPEN_DEADLINE).unwrap_or_else(|_| {
        panic!(
            "the second `centraid_open` on {} did not return within {REOPEN_DEADLINE:?}: \
             something the first core held is still in the second one's way",
            path.display()
        )
    });
    assert!(
        owns,
        "the reopened core holds its byte store again, rather than text only"
    );
    assert_eq!(closed, CENTRAID_OK);

    let _ = std::fs::remove_dir_all(&dir);
}
