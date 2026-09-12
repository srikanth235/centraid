//! One test per clause of `CONTRACT.md`, named after the clause.
//!
//! Every test calls through the C entry points rather than through
//! `crates/core`'s Rust surface: the contract is about what a shell sees, and a
//! test that went round the boundary would prove the core works and say nothing
//! about the ABI.
//!
//! `tests/symbols.rs` holds clause 10's two tests, because one of them builds
//! the `cdylib` and loads it — which is slow, and belongs in its own binary so
//! it can be run on its own.

use std::ffi::c_void;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core_ffi::{
    CENTRAID_BAD_ARGUMENT, CENTRAID_CLOSED, CENTRAID_OK, CENTRAID_PANICKED, CENTRAID_TIMEOUT,
    centraid_call, centraid_close, centraid_free, centraid_next_event, centraid_open,
};
use prost::Message as _;

// -------------------------------------------------------------- harness -----

struct Opened {
    dir: std::path::PathBuf,
    handle: *mut centraid_core::Handle,
}

impl Opened {
    /// A gateway core over a fresh file, through `centraid_open`.
    fn gateway() -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let config = format!(
            r#"{{"path":{:?},"role":"gateway","create":true}}"#,
            dir.join("vault.db").display().to_string()
        );
        let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
        // SAFETY: `config` lives for the call, and `handle` is a live local.
        let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
        assert_eq!(code, CENTRAID_OK, "the core opens: {config}");
        assert!(!handle.is_null());
        let opened = Self { dir, handle };
        // A founded vault, so the command and page doors have something to
        // answer about. Through the Rust surface, because founding is not part
        // of the ABI.
        // SAFETY: the handle is live and this thread is the only user.
        unsafe { &*opened.handle }
            .with_vault(|vault| Ok(vault.found("Contract", "Owner")?))
            .expect("it founds");
        opened
    }
}

impl Drop for Opened {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            // SAFETY: the handle came from `centraid_open` and is closed once.
            unsafe { centraid_close(self.handle) };
            self.handle = std::ptr::null_mut();
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A request envelope's bytes.
fn envelope(request_id: u64, kind: wire::request::Kind) -> Vec<u8> {
    wire::Envelope {
        request_id,
        body: Some(wire::envelope::Body::Request(wire::Request {
            kind: Some(kind),
        })),
    }
    .encode_to_vec()
}

fn hello() -> Vec<u8> {
    envelope(
        0,
        wire::request::Kind::Hello(wire::Hello {
            identity: None,
            schema_version: centraid_protocol::SCHEMA_VERSION,
            min_supported: centraid_protocol::MIN_SUPPORTED,
            product_version: "contract-test".to_owned(),
            capabilities: Vec::new(),
        }),
    )
}

/// Call through the ABI and take the answer's bytes, freeing the buffer the way
/// the contract says to.
fn call(handle: *mut centraid_core::Handle, request: &[u8]) -> (i32, Vec<u8>) {
    let mut buf: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    // SAFETY: `handle` is live, `request` outlives the call, and both
    // out-pointers are live locals.
    let code = unsafe {
        centraid_call(
            handle,
            request.as_ptr(),
            request.len(),
            &raw mut buf,
            &raw mut len,
        )
    };
    if buf.is_null() {
        return (code, Vec::new());
    }
    // SAFETY: `buf`/`len` are what the call reported.
    let bytes = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
    // CLAUSE 1: released only through `free`, with the exact length.
    // SAFETY: as above; the buffer is freed exactly once.
    unsafe { centraid_free(buf, len) };
    (code, bytes)
}

// ----------------------------------------------------------- the clauses ----

/// CLAUSE 1.
#[test]
fn buffers_are_callee_allocated_and_released_only_through_free() {
    let opened = Opened::gateway();
    let request = hello();

    let mut buf: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    // SAFETY: live handle, borrowed request, live out-pointers.
    let code = unsafe {
        centraid_call(
            opened.handle,
            request.as_ptr(),
            request.len(),
            &raw mut buf,
            &raw mut len,
        )
    };
    assert_eq!(code, CENTRAID_OK);
    assert!(!buf.is_null(), "the callee allocated the answer");
    assert!(len > 0);
    // The pointer is not inside the request: the buffer is the callee's.
    assert!(!std::ptr::eq(buf.cast::<c_void>(), request.as_ptr().cast()));
    // SAFETY: `buf`/`len` are what the call reported.
    unsafe { centraid_free(buf, len) };

    // A NULL `buf` IS A NO-OP, so a shell need not branch on the timeout case.
    // SAFETY: a null pointer is explicitly permitted.
    unsafe { centraid_free(std::ptr::null_mut(), 0) };
    unsafe { centraid_free(std::ptr::null_mut(), 99) };

    // And many buffers in a row: an allocator mismatch or a double free would
    // show here rather than once in production.
    for _ in 0..200 {
        let (code, bytes) = call(opened.handle, &request);
        assert_eq!(code, CENTRAID_OK);
        assert!(!bytes.is_empty());
    }
}

/// CLAUSE 2.
#[test]
fn inputs_are_borrowed_for_the_call_and_never_retained() {
    let opened = Opened::gateway();
    // The request is built, called with, and DROPPED. If the library retained
    // it, the second call would read freed memory — which miri would catch and
    // which a 200-iteration churn makes likely to show even without it.
    for index in 0..200 {
        let request = envelope(
            0,
            wire::request::Kind::Hello(wire::Hello {
                identity: None,
                schema_version: centraid_protocol::SCHEMA_VERSION,
                min_supported: centraid_protocol::MIN_SUPPORTED,
                product_version: format!("borrowed-{index}"),
                capabilities: Vec::new(),
            }),
        );
        let (code, _) = call(opened.handle, &request);
        assert_eq!(code, CENTRAID_OK);
        drop(request);
    }

    // A null pointer with length ZERO is the empty slice, which is what "no
    // configuration" naturally produces.
    let mut buf: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    // SAFETY: a null pointer with length zero is explicitly permitted.
    let code = unsafe {
        centraid_call(
            opened.handle,
            std::ptr::null(),
            0,
            &raw mut buf,
            &raw mut len,
        )
    };
    // Empty bytes decode to an envelope with no body, which is unsupported —
    // a successful CALL with a refusing answer, not a bad argument.
    assert_eq!(code, CENTRAID_OK);
    if !buf.is_null() {
        // SAFETY: what the call reported.
        unsafe { centraid_free(buf, len) };
    }

    // A null pointer with a NON-ZERO length is a bad argument.
    // SAFETY: refused before any dereference; that is the property.
    let code = unsafe {
        centraid_call(
            opened.handle,
            std::ptr::null(),
            16,
            &raw mut buf,
            &raw mut len,
        )
    };
    assert_eq!(code, CENTRAID_BAD_ARGUMENT);
}

/// CLAUSE 3.
#[test]
fn call_is_reentrant_across_threads_and_the_ffi_adds_no_lock() {
    let opened = Opened::gateway();
    let pointer = opened.handle as usize;
    let mut threads = Vec::new();
    for _ in 0..8 {
        threads.push(std::thread::spawn(move || {
            let handle = pointer as *mut centraid_core::Handle;
            let request = hello();
            let mut answered = 0;
            for _ in 0..50 {
                let (code, bytes) = call(handle, &request);
                assert_eq!(code, CENTRAID_OK);
                assert!(!bytes.is_empty());
                answered += 1;
            }
            answered
        }));
    }
    let total: usize = threads
        .into_iter()
        .map(|thread| thread.join().expect("no thread panicked"))
        .sum();
    assert_eq!(total, 8 * 50, "every call from every thread was answered");
}

/// CLAUSE 4.
#[test]
fn every_request_carries_a_request_id_and_cancel_names_one() {
    let opened = Opened::gateway();

    // A NON-ZERO ID IS USED AS-IS: the answer comes back under it.
    let request = envelope(
        4_242,
        wire::request::Kind::Hello(wire::Hello {
            identity: None,
            schema_version: centraid_protocol::SCHEMA_VERSION,
            min_supported: centraid_protocol::MIN_SUPPORTED,
            product_version: "ids".to_owned(),
            capabilities: Vec::new(),
        }),
    );
    let (code, bytes) = call(opened.handle, &request);
    assert_eq!(code, CENTRAID_OK);
    let answer = wire::Envelope::decode(&bytes[..]).expect("the answer decodes");
    assert_eq!(
        answer.request_id, 4_242,
        "the core answers under the id the caller minted, not one of its own"
    );

    // A CANCEL NAMING NOBODY is a no-op: ids are monotonic and never reused.
    let cancel = wire::Envelope {
        request_id: 9_999,
        body: Some(wire::envelope::Body::Cancel(wire::Cancel {})),
    }
    .encode_to_vec();
    let (code, _) = call(opened.handle, &cancel);
    assert_eq!(code, CENTRAID_OK);

    // A CANCEL WITH ID 0 names nothing and is refused.
    let nameless = wire::Envelope {
        request_id: 0,
        body: Some(wire::envelope::Body::Cancel(wire::Cancel {})),
    }
    .encode_to_vec();
    let (code, bytes) = call(opened.handle, &nameless);
    assert_eq!(code, CENTRAID_BAD_ARGUMENT);
    let refusal = wire::Envelope::decode(&bytes[..]).expect("a refusal decodes");
    let Some(wire::envelope::Body::Error(error)) = refusal.body else {
        panic!("the refusal is an Error body");
    };
    assert_eq!(error.code, wire::ErrorCode::InvalidRequest as i32);

    // A BOUNDED READ REFUSES TO BE CANCELLED, and the body says why. The id is
    // registered by making a call under it first, then cancelling it.
    // (The read is already finished by then, so this exercises the late-cancel
    // no-op; the refusal itself is asserted in `crates/core`'s own tests, where
    // an in-flight bounded id can be held.)
    let bounded = envelope(
        7,
        wire::request::Kind::Log(wire::LogRequest {
            since: None,
            limit: 10,
        }),
    );
    let (code, _) = call(opened.handle, &bounded);
    assert_eq!(code, CENTRAID_OK);
}

/// CLAUSE 5.
#[test]
fn next_event_surfaces_bounded_queue_backpressure_as_a_health_event() {
    let opened = Opened::gateway();
    // SAFETY: the handle is live.
    let queue = unsafe { &*opened.handle }.events();
    queue.set_behind(1_234);
    // Fill it. One event per table, so nothing coalesces away.
    for index in 0..centraid_core::EVENT_QUEUE_CAP {
        assert!(
            queue.push(wire::Event {
                kind: Some(wire::event::Kind::Change(wire::ChangeEvent {
                    table: format!("t{index}"),
                    pk_set: Vec::new(),
                    commit_seq: index as u64,
                })),
            }),
            "slot {index} was refused early"
        );
    }
    // THE STALL: the push is refused, and nothing was dropped.
    assert!(
        !queue.push(wire::Event {
            kind: Some(wire::event::Kind::Change(wire::ChangeEvent {
                table: "one-too-many".to_owned(),
                pk_set: Vec::new(),
                commit_seq: 9_999,
            })),
        }),
        "a full queue refuses rather than dropping"
    );
    assert!(queue.is_stalled());
    assert_eq!(queue.depth(), centraid_core::EVENT_QUEUE_CAP);

    // And the shell is told, through the ABI, that sync stalled.
    let mut saw_stall = false;
    for _ in 0..(centraid_core::EVENT_QUEUE_CAP + 4) {
        let mut buf: *mut u8 = std::ptr::null_mut();
        let mut len: usize = 0;
        // SAFETY: live handle and live out-pointers.
        let code = unsafe { centraid_next_event(opened.handle, 5, &raw mut buf, &raw mut len) };
        if code == CENTRAID_TIMEOUT {
            break;
        }
        assert_eq!(code, CENTRAID_OK);
        // SAFETY: what the call reported.
        let bytes = unsafe { std::slice::from_raw_parts(buf, len) }.to_vec();
        // SAFETY: as above; freed once.
        unsafe { centraid_free(buf, len) };
        let event = wire::Envelope::decode(&bytes[..]).expect("an event decodes");
        assert_eq!(event.request_id, 0, "an event answers nothing");
        if let Some(wire::envelope::Body::Event(wire::Event {
            kind: Some(wire::event::Kind::Health(health)),
        })) = event.body
            && health.stalled
        {
            assert_eq!(health.capacity, centraid_core::EVENT_QUEUE_CAP as u32);
            // A DISTANCE IN LOG POSITIONS, not rows and not seconds.
            assert_eq!(health.behind, 1_234);
            saw_stall = true;
            break;
        }
    }
    assert!(saw_stall, "the stall never reached the shell");
}

/// CLAUSE 6.
#[test]
fn a_timeout_allocates_nothing() {
    let opened = Opened::gateway();
    // A sentinel, so "untouched" is checkable rather than merely hoped for.
    let sentinel = 0xdead_beef_usize as *mut u8;
    let mut buf: *mut u8 = sentinel;
    let mut len: usize = 0xabcd;
    // SAFETY: live handle and live out-pointers.
    let code = unsafe { centraid_next_event(opened.handle, 1, &raw mut buf, &raw mut len) };
    assert_eq!(code, CENTRAID_TIMEOUT);
    assert!(
        std::ptr::eq(buf, sentinel),
        "the out-pointer was written on a timeout; a shell's `defer free` would free garbage"
    );
    assert_eq!(len, 0xabcd, "the out-length was written on a timeout");
    // NOTHING TO FREE — and the null no-op is what makes the naive wrapper safe
    // once the shell zeroes its locals.
}

/// CLAUSE 7.
#[test]
fn close_unblocks_next_event_with_a_terminal_answer() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("made");
    let config = format!(
        r#"{{"path":{:?},"role":"gateway","create":true}}"#,
        dir.join("vault.db").display().to_string()
    );
    let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
    // SAFETY: live config and live out-pointer.
    assert_eq!(
        unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) },
        CENTRAID_OK
    );

    // An event already accepted, so the "not a discard" half is checkable.
    // SAFETY: the handle is live.
    unsafe { &*handle }.events().push(wire::Event {
        kind: Some(wire::event::Kind::Change(wire::ChangeEvent {
            table: "note".to_owned(),
            pk_set: Vec::new(),
            commit_seq: 1,
        })),
    });

    let pointer = handle as usize;
    let waiter = std::thread::spawn(move || {
        let handle = pointer as *mut centraid_core::Handle;
        let mut codes = Vec::new();
        for _ in 0..3 {
            let mut buf: *mut u8 = std::ptr::null_mut();
            let mut len: usize = 0;
            // SAFETY: the handle is live until the close below, and the main
            // thread joins this one before dropping it.
            let code = unsafe { centraid_next_event(handle, 30_000, &raw mut buf, &raw mut len) };
            if !buf.is_null() {
                // SAFETY: what the call reported.
                unsafe { centraid_free(buf, len) };
            }
            codes.push(code);
            if code == CENTRAID_CLOSED {
                break;
            }
        }
        codes
    });
    std::thread::sleep(Duration::from_millis(100));
    // SAFETY: the handle came from `centraid_open` and is closed once; the
    // waiter is joined below, before anything else touches the pointer.
    assert_eq!(unsafe { centraid_close(handle) }, CENTRAID_OK);
    let codes = waiter.join().expect("the waiter returns");
    assert_eq!(
        codes.first(),
        Some(&CENTRAID_OK),
        "a close is NOT a discard: the accepted event came out first"
    );
    assert_eq!(
        codes.last(),
        Some(&CENTRAID_CLOSED),
        "the waiter was released with the terminal answer"
    );

    // CLOSE ON NULL is a bad argument, not a crash.
    // SAFETY: a null pointer is explicitly refused before any dereference.
    assert_eq!(
        unsafe { centraid_close(std::ptr::null_mut()) },
        CENTRAID_BAD_ARGUMENT
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// CLAUSE 8.
#[test]
fn calls_after_close_return_a_typed_error() {
    let opened = Opened::gateway();
    // Closed through the core's own surface, so the handle POINTER stays valid
    // and clause 8 can be tested without the use-after-free clause 7 names.
    // SAFETY: the handle is live.
    unsafe { &*opened.handle }.close();

    let (code, bytes) = call(opened.handle, &hello());
    assert_eq!(code, CENTRAID_CLOSED);
    let refusal = wire::Envelope::decode(&bytes[..]).expect("a refusal decodes");
    let Some(wire::envelope::Body::Error(error)) = refusal.body else {
        panic!("a closed handle answers with an Error body, not a partial answer");
    };
    assert_eq!(error.code, wire::ErrorCode::Internal as i32);

    let mut buf: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    // SAFETY: live handle (closed, not dropped) and live out-pointers.
    let code = unsafe { centraid_next_event(opened.handle, 1, &raw mut buf, &raw mut len) };
    assert_eq!(code, CENTRAID_CLOSED, "never a hang");
    if !buf.is_null() {
        // SAFETY: what the call reported.
        unsafe { centraid_free(buf, len) };
    }
}

/// CLAUSE 9.
#[test]
fn a_rust_panic_never_crosses_the_boundary() {
    let opened = Opened::gateway();
    // The POISON half — the half a shell depends on — is driven directly here.
    // The `catch_unwind` half over a REAL panic is
    // `a_real_panic_inside_call_poisons_the_handle_through_the_abi` below,
    // which needs `--features debug-fault` (#1020 wave 3, lane E finding 4).
    // SAFETY: the handle is live.
    let core = unsafe { &*opened.handle };
    let filed = core.poison("call");
    assert!(!filed.is_empty(), "a panic is filed under a diagnostic id");

    // THE FIRST PANIC IS THE ONE FILED.
    assert_eq!(
        core.poison("next_event"),
        filed,
        "a later panic is a symptom of running on poisoned state"
    );

    // EVERY entry point now refuses, with the SAME diagnostic id, so a crash
    // report and a log line name the same event.
    let (code, bytes) = call(opened.handle, &hello());
    assert_eq!(code, CENTRAID_PANICKED);
    let refusal = wire::Envelope::decode(&bytes[..]).expect("a refusal decodes");
    let Some(wire::envelope::Body::Error(error)) = refusal.body else {
        panic!("a poisoned handle answers with an Error body");
    };
    assert_eq!(error.code, wire::ErrorCode::Internal as i32);
    assert_eq!(error.diagnostic_id, filed);

    // And the process is still here, which is the whole clause: an unwind into
    // C would have aborted before this line.
    let (again, _) = call(opened.handle, &hello());
    assert_eq!(again, CENTRAID_PANICKED, "the poison is sticky");
}

/// CLAUSE 9, over a REAL panic inside `call` (#1020 wave 3, lane E finding 4).
///
/// Every other clause-9 assertion drives `Handle::poison` directly, which is a
/// Rust-side call no shell can make — so nothing proved that the real library
/// produces what `mobile/core`'s fake ABI produces. The `debug-fault` feature
/// makes a `Command` named `debug.panic` panic inside `Handle::call`; it rides
/// an existing request rather than a sixth symbol, and it is never on in a
/// release. Run it with:
///
/// ```text
/// cargo test -p centraid-core-ffi --features debug-fault \
///   a_real_panic_inside_call_poisons_the_handle_through_the_abi
/// ```
#[cfg(feature = "debug-fault")]
#[test]
fn a_real_panic_inside_call_poisons_the_handle_through_the_abi() {
    let opened = Opened::gateway();
    let fault = envelope(
        1,
        wire::request::Kind::Command(wire::Command {
            name: centraid_core::handle::DEBUG_FAULT_COMMAND.to_owned(),
            ..Default::default()
        }),
    );

    // The panic crosses `catch_unwind` and comes back as a CODE, not as an
    // unwind into C — which would have aborted the process before this line.
    let (code, bytes) = call(opened.handle, &fault);
    assert_eq!(code, CENTRAID_PANICKED);
    let refusal = wire::Envelope::decode(&bytes[..]).expect("a refusal decodes");
    let Some(wire::envelope::Body::Error(error)) = refusal.body else {
        panic!("a caught panic answers with an Error body, not a partial answer");
    };
    assert_eq!(error.code, wire::ErrorCode::Internal as i32);
    let filed = error.diagnostic_id.clone();
    assert!(!filed.is_empty(), "a panic is filed under a diagnostic id");

    // THE HANDLE STAYS POISONED, and the FIRST diagnostic id is the one kept:
    // a later panic is a symptom of running on state nobody can vouch for.
    let (again, bytes) = call(opened.handle, &hello());
    assert_eq!(again, CENTRAID_PANICKED, "the poison is sticky");
    let refusal = wire::Envelope::decode(&bytes[..]).expect("a refusal decodes");
    let Some(wire::envelope::Body::Error(error)) = refusal.body else {
        panic!("a poisoned handle answers with an Error body");
    };
    assert_eq!(error.diagnostic_id, filed);

    // And `next_event` refuses too rather than hanging.
    let mut buf: *mut u8 = std::ptr::null_mut();
    let mut len: usize = 0;
    // SAFETY: live handle and live out-pointers.
    let code = unsafe { centraid_next_event(opened.handle, 1, &raw mut buf, &raw mut len) };
    assert_eq!(code, CENTRAID_PANICKED, "never a hang");
    if !buf.is_null() {
        // SAFETY: what the call reported.
        unsafe { centraid_free(buf, len) };
    }
}

/// WITHOUT the feature, the fault command is just an unknown command.
///
/// The door has to be absent from a default build, and "absent" has to be
/// checked rather than asserted in a comment: a build that answered
/// `debug.panic` with a panic because someone left the feature on a default
/// list would be a release that can be crashed by a request.
#[cfg(not(feature = "debug-fault"))]
#[test]
fn the_fault_door_is_absent_from_a_default_build() {
    let opened = Opened::gateway();
    let fault = envelope(
        1,
        wire::request::Kind::Command(wire::Command {
            name: centraid_core::handle::DEBUG_FAULT_COMMAND.to_owned(),
            ..Default::default()
        }),
    );
    let (code, bytes) = call(opened.handle, &fault);
    assert_ne!(code, CENTRAID_PANICKED, "no panic door in a default build");
    let answer = wire::Envelope::decode(&bytes[..]).expect("it decodes");
    if let Some(wire::envelope::Body::Error(error)) = answer.body {
        assert_ne!(
            error.code,
            wire::ErrorCode::Internal as i32,
            "an unregistered command is a request error, not a crash"
        );
    }
}

/// CLAUSE 9, the `open` corner: there is no handle to poison.
#[test]
fn a_panic_in_open_hands_back_no_handle() {
    // A configuration `open` refuses, which is the reachable neighbour of the
    // panic case: the claim under test is that `out` is written ONLY on the
    // success path, so a failed open leaves the caller's pointer alone.
    let sentinel = 0x1234_usize as *mut centraid_core::Handle;
    let mut handle = sentinel;
    let config = br#"{"role":"gateway"}"#;
    // SAFETY: live config bytes and a live out-pointer.
    let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
    assert_ne!(code, CENTRAID_OK);
    assert!(
        std::ptr::eq(handle, sentinel),
        "a failed open wrote a handle the caller would then close"
    );

    // A null out-pointer is refused before anything is allocated.
    // SAFETY: a null out-pointer is explicitly refused.
    assert_eq!(
        unsafe { centraid_open(config.as_ptr(), config.len(), std::ptr::null_mut()) },
        CENTRAID_BAD_ARGUMENT
    );
}
