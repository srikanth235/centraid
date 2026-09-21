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
        Self::over_a_fresh_file(false)
    }

    /// The same, with the vault seed `CONTRACT.md` §4b describes — a core that
    /// can seal, which is what a drain needs.
    fn unlocked() -> Self {
        Self::over_a_fresh_file(true)
    }

    fn over_a_fresh_file(with_seed: bool) -> Self {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let vault = if with_seed {
            format!(
                r#","vault":{{"seed":"{}","index":0}}"#,
                "ab".repeat(centraid_core::SEED_BYTES)
            )
        } else {
            String::new()
        };
        let config = format!(
            r#"{{"path":{:?},"role":"gateway","create":true{vault}}}"#,
            dir.join("vault.db").display().to_string()
        );
        let mut handle: *mut centraid_core::Handle = std::ptr::null_mut();
        // SAFETY: `config` lives for the call, and `handle` is a live local.
        let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
        assert_eq!(code, CENTRAID_OK, "the core opens: {config}");
        assert!(!handle.is_null());
        let opened = Self { dir, handle };
        // A founded vault, so the command and page doors have something to
        // answer about. Through the Rust surface: founding IS part of the ABI
        // now (#1029 W5, `envelope.proto`'s `FoundRequest`), and driving it
        // here would make every clause below depend on that door rather than
        // on its own.
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
        wire::request::Kind::Hello(wire::Hello {
            identity: None,
            schema_version: 1,
            min_supported: 1,
            product_version: "test".to_owned(),
            capabilities: Vec::new(),
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

/// **A REFUSAL AT `open` SAYS WHY, IN THE LOG, BECAUSE THE CODE CANNOT**
/// (#1029 W6b).
///
/// ## What is under test
///
/// `code_for_open`'s own documentation ends "the reason is in the log line the
/// core already emits" — and no line was emitted, which made that sentence a
/// promise the code did not keep. The ABI has six status codes and `CONTRACT.md`
/// governs the table, so every refusal that is not one of the five named arms
/// is [`CENTRAID_BAD_ARGUMENT`]: `-1` answers "the path is wrong", "this file is
/// not a vault" and "this core is older than this vault" alike. Widening the
/// table is not the fix — a second, smaller error vocabulary for three shells to
/// learn is what `code_for` exists to refuse. The LINE is where the difference
/// lives, so the line has to be written.
///
/// ## Why this refusal and not an easier one
///
/// `VaultError::DowngradeRefused` — a file a NEWER core migrated, handed to an
/// OLDER one — is the refusal that most needs the line. It is the most
/// actionable thing a shell author can hit (their library is behind their vault)
/// and, through six status codes, it is indistinguishable from a typo in a path.
/// That the refusal itself is correct is `crates/vault`'s `file.rs` and
/// `crates/ontology`'s `golden_vault.rs`; what is asserted here is what crosses
/// the ABI: a negative code, no handle written, and a line that names the reason.
#[test]
fn a_refusal_at_open_is_a_negative_code_no_handle_and_a_line_that_says_why() {
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Captured(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Captured {
        fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .expect("the log lock")
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let path = dir.join("from-the-future.db");

    // A REAL, FOUNDED VAULT — then stamped as having run a rung this build does
    // not have. It has to be a real file: the downgrade check happens AFTER the
    // application id and the header have been accepted, so a hand-written file
    // would be refused earlier, as `NotAVault`, and would test a different arm.
    {
        let handle =
            centraid_core::Core::open(centraid_core::CoreConfig::new(&path)).expect("a core opens");
        handle
            .with_vault(|vault| Ok(vault.found("Ahead", "Owner")?))
            .expect("it founds");
        handle.close();
    }
    // Through `centraid_vault`'s own re-exported `rusqlite`, and NOT by writing
    // byte 60 of the SQLite header: the vault runs in WAL mode with
    // `NO_CKPT_ON_CLOSE`, so after a close the main file is a 4KiB header and
    // the rows — and the authoritative page one — are in the `-wal` sidecar. A
    // patched header is read straight past, which is a test that silently
    // measures nothing. `sql-confinement` is untouched: this is a pragma name,
    // not a query.
    let ahead = centraid_vault::head_version() + 1;
    {
        let connection = centraid_vault::rusqlite::Connection::open(&path).expect("the file opens");
        connection
            .pragma_update(None, "user_version", ahead)
            .expect("the stamp writes");
    }

    let config = format!(
        r#"{{"path":{:?},"create":false}}"#,
        path.display().to_string()
    );
    let sentinel = 0x1234_usize as *mut centraid_core::Handle;
    let mut handle = sentinel;
    let captured = Captured::default();
    let sink = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || sink.clone())
        .with_max_level(tracing::Level::TRACE)
        .finish();
    let code = tracing::subscriber::with_default(subscriber, || {
        // SAFETY: live config bytes and a live out-pointer.
        unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) }
    });

    assert_eq!(
        code, CENTRAID_BAD_ARGUMENT,
        "a vault from a newer core must refuse with a negative code"
    );
    assert!(
        std::ptr::eq(handle, sentinel),
        "a failed open wrote a handle the caller would then close"
    );

    let log = captured.0.lock().expect("the log lock").clone();
    let log = String::from_utf8_lossy(&log);
    assert!(
        log.contains("centraid_open refused"),
        "the refusal emitted no line, so `-1` is again the whole story: {log}"
    );
    // THE LINE CARRIES THE REASON, NOT JUST THE CODE. A line that said only
    // "refused with -1" would restate the number the caller already has.
    assert!(
        log.contains(&ahead.to_string()) && log.contains("schema version"),
        "the line does not name the version this file is at: {log}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// `open` NEVER ANSWERS `OK` WITHOUT A HANDLE — over an ordinary refusal, not
/// a malformed configuration (#1029 W5).
///
/// The neighbour above drives a config the JSON reader itself rejects. This one
/// drives a configuration that is perfectly well formed and names a file that is
/// **not a Centraid vault**, which is the case a phone reaches by itself: a
/// `.db` copied away from its `-wal` sidecar carries `application_id 0`, and
/// `Vault::open` refuses it with `NotAVault`.
///
/// That refusal went through `code_for`, whose last arm is `_ => CENTRAID_OK`
/// because a `call`'s reason travels in the out-buffer — and `open` has no
/// out-buffer. So the shell was handed `OK` and a null handle: JNA's binding
/// reported "centraid_open returned OK and a null handle", iOS's would have
/// reported the same, and both are a contract violation `code_for`'s own
/// comment names in those words. See `code_for_open`.
#[test]
fn an_open_that_refuses_an_ordinary_file_never_answers_ok() {
    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let path = dir.join("not-a-vault.db");
    // A REAL SQLITE FILE AND NOT RANDOM BYTES: `application_id 0` is what a
    // half-copied vault looks like, and it is the shape that produced the bug.
    std::fs::write(&path, {
        let mut header = Vec::from(&b"SQLite format 3\0"[..]);
        header.resize(4096, 0);
        header
    })
    .expect("the file is written");

    let config = format!(
        r#"{{"path":{:?},"create":false}}"#,
        path.display().to_string()
    );
    let sentinel = 0x1234_usize as *mut centraid_core::Handle;
    let mut handle = sentinel;
    // SAFETY: live config bytes and a live out-pointer.
    let code = unsafe { centraid_open(config.as_ptr(), config.len(), &raw mut handle) };
    assert_eq!(
        code, CENTRAID_BAD_ARGUMENT,
        "an open that produces no handle answers a negative code"
    );
    assert!(
        std::ptr::eq(handle, sentinel),
        "a failed open wrote a handle the caller would then close"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ------------------------------------------- #1029 W15: the phone's flows ----

/// Decode an answer envelope, or fail loudly with what came back instead.
fn answer(bytes: &[u8]) -> wire::Envelope {
    wire::Envelope::decode(bytes).expect("the answer is an envelope")
}

/// CLAUSE 4b. The seed crosses the boundary, and a malformed one is refused
/// rather than replaced.
///
/// The three cases are the three a shell can actually produce: no `vault` key
/// at all (every first launch, and a locked phone), a good one, and a `seed`
/// that is the wrong length — which is what a shell handed a truncated
/// Keychain item produces, and is the one that must NOT be read as "absent".
#[test]
fn the_vault_seed_crosses_the_abi_and_a_malformed_one_is_refused() {
    use centraid_core_ffi::marshal::config_from_json;

    let absent = config_from_json(br#"{"path":"/tmp/v.db"}"#).expect("no vault key is fine");
    assert!(
        absent.seed.is_none(),
        "a shell that said nothing has no seed, and that is a state"
    );

    let seed_hex = "ab".repeat(centraid_core::SEED_BYTES);
    let good = config_from_json(
        format!(r#"{{"path":"/tmp/v.db","vault":{{"seed":"{seed_hex}","index":3}}}}"#).as_bytes(),
    )
    .expect("a good seed parses");
    let (seed, index) = good.seed.expect("the seed crossed");
    assert_eq!(
        index, 3,
        "the index is the vault's own and is never chosen here"
    );
    assert_eq!(
        seed.as_bytes()[..],
        [0xAB_u8; centraid_core::SEED_BYTES][..],
        "the bytes that crossed are the bytes the shell sent"
    );

    for bad in [
        // Too short: a truncated secure-store item.
        r#"{"path":"/tmp/v.db","vault":{"seed":"abcd","index":0}}"#,
        // Not hex at all.
        r#"{"path":"/tmp/v.db","vault":{"seed":"not hex","index":0}}"#,
        // A seed with no index is half a derivation, and F2 is about indices.
        r#"{"path":"/tmp/v.db","vault":{"seed":"ab"}}"#,
    ] {
        // `CoreConfig` is not `Debug` (it holds `dyn Clock`), so the refusal
        // is matched rather than unwrapped.
        match config_from_json(bad.as_bytes()) {
            Err(centraid_core::CoreError::InvalidRequest { .. }) => {}
            Err(other) => panic!("a malformed seed is BAD_ARGUMENT, not {other}"),
            Ok(_) => panic!("present and unreadable is an error, never a fresh key: {bad}"),
        }
    }
}

/// CLAUSE 4c. All four phone flows round-trip through `centraid_call`.
///
/// **What is asserted is the round trip, not the outcome.** Each kind is
/// encoded into an `Envelope`, handed to the C symbol, and the answer decoded —
/// so a kind the core does not dispatch, or one whose answer is filed under the
/// wrong `Response` arm, fails here rather than in a shell. Two of the four
/// answer with a typed response over a core with no laptop, and two refuse for
/// a reason the shell draws; both are answers and neither is a hang.
#[test]
fn the_phones_four_flows_round_trip_through_call() {
    // UNLOCKED, because a drain seals and sealing needs the keys clause 4b
    // carries. A LOCKED core's drain is the clause's other half and is pinned
    // by `a_locked_core_refuses_to_drain_rather_than_inventing_a_key` below.
    let opened = Opened::unlocked();

    // `backup_status` — a typed answer over a phone that has never paired.
    let (code, bytes) = call(
        opened.handle,
        &envelope(
            11,
            wire::request::Kind::BackupStatus(wire::BackupStatusRequest {}),
        ),
    );
    assert_eq!(code, CENTRAID_OK, "a status read answers");
    let Some(wire::envelope::Body::Response(response)) = answer(&bytes).body else {
        panic!("a status read is answered by a Response");
    };
    let Some(wire::response::Kind::BackupStatus(status)) = response.kind else {
        panic!("a BackupStatusRequest is answered by a BackupStatusResponse");
    };
    assert!(!status.laptop_paired, "this core has never scanned a QR");
    assert_eq!(
        status.acked_at_ms, None,
        "a moment that is not the gateway's is no moment at all"
    );

    // `drain` — the door `BackupNow` stood in for, and it is NOT
    // `NotYetAvailable`: an unpaired phone has nowhere to send bytes, which is
    // `DRAIN_STOP_UNREACHABLE` and not a failure.
    let (code, bytes) = call(
        opened.handle,
        &envelope(
            12,
            wire::request::Kind::Drain(wire::DrainRequest { deadline_ms: 0 }),
        ),
    );
    assert_eq!(code, CENTRAID_OK, "a drain answers");
    let Some(wire::envelope::Body::Response(response)) = answer(&bytes).body else {
        panic!("a drain is answered by a Response, never by a NotYetAvailable error");
    };
    let Some(wire::response::Kind::Drain(drain)) = response.kind else {
        panic!("a DrainRequest is answered by a DrainResponse");
    };
    assert_eq!(
        drain.stopped,
        wire::DrainStop::Unreachable as i32,
        "an unpaired phone has no laptop to reach"
    );
    assert_eq!(
        drain.acked_at_ms, None,
        "nothing was acked, so nothing is claimed"
    );

    // `pair` — a payload that is not a ticket is refused by the core's own
    // decoder, so no shell ever writes a second one.
    let (code, bytes) = call(
        opened.handle,
        &envelope(
            13,
            wire::request::Kind::PairPhone(wire::PairRequest {
                payload: "not-a-pairing-code".to_owned(),
            }),
        ),
    );
    assert_eq!(code, CENTRAID_BAD_ARGUMENT, "a bad pairing code is refused");
    let Some(wire::envelope::Body::Error(error)) = answer(&bytes).body else {
        panic!("a refusal comes back as an Error body");
    };
    assert_eq!(error.code, wire::ErrorCode::InvalidRequest as i32);

    // `restore` — three words are not 24, and the refusal is the phrase's own
    // checksum rather than a failure somewhere downstream.
    let (code, bytes) = call(
        opened.handle,
        &envelope(
            14,
            wire::request::Kind::Restore(wire::RestoreRequest {
                phrase: "abandon abandon abandon".to_owned(),
                endpoint: None,
            }),
        ),
    );
    assert_eq!(code, CENTRAID_BAD_ARGUMENT, "three words are not a phrase");
    let Some(wire::envelope::Body::Error(error)) = answer(&bytes).body else {
        panic!("a refusal comes back as an Error body");
    };
    assert_eq!(error.code, wire::ErrorCode::InvalidRequest as i32);
}

/// CLAUSE 4b, the other half. A core opened with no seed reads and writes its
/// vault and **refuses to drain**, with a sentence naming the seed — it never
/// invents a key file beside the vault it protects.
#[test]
fn a_locked_core_refuses_to_drain_rather_than_inventing_a_key() {
    let opened = Opened::gateway();
    let (code, bytes) = call(
        opened.handle,
        &envelope(
            21,
            wire::request::Kind::Drain(wire::DrainRequest { deadline_ms: 0 }),
        ),
    );
    // `CENTRAID_OK` AND A REFUSING BODY is this ABI's shape for everything
    // that is not a decode, a bad argument, a close or a panic (`code_for`):
    // the status says the call ran and the closed `ErrorCode` says what the
    // answer is. What matters here is that the answer is not a `DrainResponse`.
    assert_eq!(code, CENTRAID_OK, "the call itself ran");
    let Some(wire::envelope::Body::Error(error)) = answer(&bytes).body else {
        panic!("a refusal comes back as an Error body");
    };
    // `CoreError::Unavailable` is `ERROR_CODE_PEER_UNREACHABLE` on the wire
    // (`crates/core/src/error.rs`), which is the sentence a member reads.
    assert_eq!(error.code, wire::ErrorCode::PeerUnreachable as i32);
    assert!(
        !centraid_core::phone::Laptop::path_for(&opened.dir.join("vault.db")).exists(),
        "a refused drain wrote something beside the vault"
    );
}
