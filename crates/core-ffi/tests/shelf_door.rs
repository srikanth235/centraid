//! The shell hands the ABI a directory, and the core behind the one handle holds
//! every vault in it (#1135, lane H2). Through the C entry points, as a shell
//! calls them.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core_ffi::{
    CENTRAID_OK, centraid_call, centraid_close, centraid_free, centraid_next_event, centraid_open,
};
use prost::Message as _;

fn call(handle: *mut centraid_core::Handle, request: wire::Request) -> wire::Response {
    let bytes = wire::Envelope {
        request_id: 0,
        body: Some(wire::envelope::Body::Request(request)),
    }
    .encode_to_vec();
    let (mut out, mut len) = (std::ptr::null_mut(), 0usize);
    // SAFETY: `handle` came from `centraid_open` and is live; `bytes` is readable
    // for its length; both out-pointers are writable.
    let status = unsafe {
        centraid_call(
            handle,
            bytes.as_ptr(),
            bytes.len(),
            &raw mut out,
            &raw mut len,
        )
    };
    assert_eq!(status, CENTRAID_OK);
    // SAFETY: the library handed back `len` bytes at `out`.
    let answer = unsafe { std::slice::from_raw_parts(out, len) }.to_vec();
    // SAFETY: `out`/`len` are exactly what the call returned.
    unsafe { centraid_free(out, len) };
    match wire::Envelope::decode(answer.as_slice())
        .expect("an envelope")
        .body
    {
        Some(wire::envelope::Body::Response(response)) => response,
        other => panic!("the call answered {other:?}"),
    }
}

#[test]
fn a_directory_opens_one_handle_that_holds_no_vault_and_makes_no_file() {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let config = format!(r#"{{"shelf":"{}"}}"#, dir.display());
    let mut handle = std::ptr::null_mut();
    // SAFETY: `config` is readable and `handle` is writable storage for a pointer.
    let status = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
    assert_eq!(status, CENTRAID_OK);
    assert!(!handle.is_null());

    // The screen runtime is attached: the first call opens the tabs and the
    // shelf's service asks the shell to read its secrets.
    let snapshot = call(
        handle,
        wire::Request {
            kind: Some(wire::request::Kind::Screen(Box::new(wire::ScreenRequest {
                kind: Some(wire::screen_request::Kind::Snapshot(
                    wire::SnapshotRequest {},
                )),
            }))),
        },
    );
    let Some(wire::response::Kind::Screen(screen)) = snapshot.kind else {
        panic!("a screen request answered {:?}", snapshot.kind);
    };
    let update = screen.update.expect("an update");
    assert!(
        update.effects.iter().any(|effect| matches!(
            effect.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::Secrets(_))
        )),
        "the shelf reads the phone's secrets through the shell"
    );

    // `shell.holdings` is the front's own read, and the shelf has not read its
    // directory: not loaded is not empty.
    let loaded = call(
        handle,
        wire::Request {
            kind: Some(wire::request::Kind::Load(Box::new(wire::LoadRequest {
                app: "shell".to_owned(),
                query: "holdings".to_owned(),
                ..Default::default()
            }))),
        },
    );
    let Some(wire::response::Kind::Load(loaded)) = loaded.kind else {
        panic!("a load answered {:?}", loaded.kind);
    };
    let Some(wire::app_query_response::Answer::Holdings(holdings)) =
        loaded.answer.and_then(|a| a.answer)
    else {
        panic!("holdings did not answer");
    };
    assert!(!holdings.loaded);
    assert!(holdings.vaults.is_empty());

    // A read of a vault, with none held, is the unpaired state and not a failure
    // of the door.
    assert!(!dir.join("custody-probe.sqlite3").exists());

    // The event door is the front's: nothing to say, and a timeout is not an error.
    let (mut out, mut len) = (std::ptr::null_mut(), 0usize);
    // SAFETY: as above.
    let status = unsafe { centraid_next_event(handle, 10, &raw mut out, &raw mut len) };
    assert!(status == CENTRAID_OK || status == centraid_core_ffi::CENTRAID_TIMEOUT);
    if status == CENTRAID_OK {
        // SAFETY: the library handed back `len` bytes at `out`.
        unsafe { centraid_free(out, len) };
    }
    std::thread::sleep(Duration::from_millis(10));
    // SAFETY: `handle` is live and not used again.
    assert_eq!(unsafe { centraid_close(handle) }, CENTRAID_OK);
    let _ = std::fs::remove_dir_all(&dir);
}
