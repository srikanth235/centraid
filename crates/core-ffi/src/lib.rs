//! The C ABI: **five symbols and a contract**.
//!
//! `centraid_open`, `centraid_call`, `centraid_next_event`, `centraid_free`,
//! `centraid_close`. That is the whole surface every shell — Swift, Kotlin,
//! Electron — links against, and the xtask rule `abi-five-symbols` counts them
//! on every gate run
//! ([#1020](https://github.com/srikanth235/centraid/issues/1020) wave 2, lane
//! D2, D-1020-D2-3).
//!
//! **The clauses are in [`CONTRACT.md`](../CONTRACT.md) and each one has a
//! test** in `tests/contract.rs`, named after the clause. Read that file before
//! changing anything here: a shell's memory safety depends on claims that are
//! not visible in these signatures.
//!
//! ## Why five and not fifty
//!
//! Every symbol is a thing three shells must wrap, three build systems must
//! see, and `buf`-shaped compatibility must hold for. A per-verb ABI would be
//! forty symbols that change whenever a verb does; one `call` taking encoded
//! bytes moves that churn into the protobuf schema, where `buf breaking`
//! already governs it.
//!
//! ## Why bytes and not structs
//!
//! Every payload across this boundary is a length-prefixed, protobuf-encoded
//! `centraid.core.v1.Envelope`. A C struct would need a stable layout per
//! message, per platform, per compiler — and a shell that got the padding wrong
//! would read garbage rather than failing to link. Bytes have one layout.
//!
//! ## A panic never crosses
//!
//! Every entry point is wrapped in [`std::panic::catch_unwind`]. A caught panic
//! becomes an error response with a diagnostic id **and poisons the handle**, so
//! the shell restarts the core deliberately rather than carrying on over state
//! nobody can vouch for. Unwinding into C is undefined behaviour, so this is not
//! tidiness.

#![deny(unsafe_op_in_unsafe_fn)]

pub mod marshal;

use std::panic::AssertUnwindSafe;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreError, Handle};

// The status codes. Zero is success and every failure is negative, so a caller
// can branch on `< 0` without knowing the table.
//
// A code is **not** an error *message*: the reason travels in the response bytes
// as a `centraid.core.v1.Error`, which carries the closed `ErrorCode` enum.
// These six say only whether the CALL itself worked.
//
// ONE NAME, PREFIXED ON BOTH SIDES. A C preprocessor has a single namespace and
// a header that `#define`d bare `OK` would collide with somebody's enum on the
// first project that included both. Rust has modules and would not need the
// prefix — but two spellings for one constant is a thing that drifts, and these
// are C ABI constants in Rust's clothing either way.

/// The call completed. The out-buffer, if there is one, holds the answer.
pub const CENTRAID_OK: i32 = 0;
/// A pointer argument was null, or a length was impossible.
pub const CENTRAID_BAD_ARGUMENT: i32 = -1;
/// The bytes were not a decodable `Envelope`.
pub const CENTRAID_MALFORMED: i32 = -2;
/// The handle is closed. Distinct from [`CENTRAID_PANICKED`]: a closed handle
/// was closed on purpose and a poisoned one was not.
pub const CENTRAID_CLOSED: i32 = -3;
/// A panic was caught. The handle is poisoned; restart the core.
pub const CENTRAID_PANICKED: i32 = -4;
/// `next_event` returned with nothing, because its timeout elapsed. **Not an
/// error** — it is negative only because every non-`OK` code is, and a caller
/// that treats it as a failure will restart the core once a second.
pub const CENTRAID_TIMEOUT: i32 = -5;

/// Open a core over a vault file.
///
/// `config` is `len` bytes of UTF-8 JSON: `{"path": "...", "role":
/// "gateway"|"seat-replicated"|"seat-thin", "create": bool?, "uiThreadName":
/// "..."?, "expectedIdentity": "<digest>"?, "pairing": {…}?}`. JSON and not
/// protobuf, because a
/// configuration is read once at startup by a human-written call site and being
/// able to log it verbatim is worth more than the encoding.
///
/// `expectedIdentity` is the artifact digest the SHELL's build recorded for the
/// core it intends to load. A mismatch is refused here, before a handle exists
/// and before one query is answered from the wrong schema (#1020 Artifacts,
/// D-1020-G2). Absent means the caller claimed no expectation, which is not a
/// match — it is unchecked, and a `dev` build on either side logs a warning
/// that says so. `mobile/core`'s `CentraidCore.open(dataDir, expectedIdentity)`
/// already takes it, and the handshake's `Hello.identity` is what a shell
/// compares after the fact.
///
/// `pairing` is THE ENROLMENT RECORD THE SHELL KEPT FOR THIS VAULT (#1025
/// S7-13): `{"secret": "<64 hex>"?, "gatewayAddress": "<64 hex>", "vaultId":
/// "…", "vaultName": "…", "relayUrl": "…", "directAddrs": ["…"],
/// "enrolledPublicKey": "<64 hex>"}`. One record and not three keys, because a
/// key filed under one name and an address under another is a pair that can
/// settle by halves — and did.
///
/// `secret` is this device's endpoint identity, 32 bytes as 64 lowercase hex,
/// out of the shell's secure store. Absent means a fresh keypair per open,
/// which is a seat its gateway has not enrolled; `enrolledPublicKey` is what
/// catches that, and an open whose endpoint does not match it is refused with
/// `ERROR_CODE_IDENTITY_MISMATCH` rather than dialled as a stranger.
///
/// `relayUrl` decides the relay mode: empty on a SETTLED record is a LAN-only
/// deployment. There is no `relays` flag — see `CoreConfig::pairing`.
///
/// On success writes an owned handle to `out` and returns [`CENTRAID_OK`]. The
/// handle is released **only** by [`centraid_close`].
///
/// # Safety
///
/// `config` must point to `len` readable bytes and `out` must point to writable
/// storage for one pointer. Both are borrowed for the duration of the call
/// only; this function keeps neither.
// SAFETY: `no_mangle` exports this under its `centraid_`-prefixed name, which
// no other symbol in the library shares; the function is `unsafe` because the
// caller must uphold the `# Safety` contract above, and every raw pointer is
// null-checked or borrowed through `marshal` before it is used.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn centraid_open(
    config: *const u8,
    len: usize,
    out: *mut *mut Handle,
) -> i32 {
    if out.is_null() {
        return CENTRAID_BAD_ARGUMENT;
    }
    // SAFETY: `config`/`len` are the caller's promise above. `slice_of` returns
    // `None` for a null pointer with a non-zero length, so the only `unsafe`
    // dereference below happens on a pointer the caller said is readable.
    let Some(bytes) = (unsafe { marshal::slice_of(config, len) }) else {
        return CENTRAID_BAD_ARGUMENT;
    };
    // The panic barrier is OUTSIDE every allocation this call makes, so a panic
    // in the middle leaks nothing the caller was told about: `out` is written
    // only on the success path.
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let config = marshal::config_from_json(bytes)?;
        let vault_path = config.path.clone();
        let handle = Core::open(config)?;
        // SEAT ROLES ONLY (#1025 S1). The previous rule — "every role, because
        // the network belongs to the device" — read correctly and attached the
        // wrong thing: a `SeatLink` is now built PER REPLICA and its whole job
        // is to replace that file with a copy from a gateway. Handing one to a
        // gateway-role core means an endpoint, a key and a byte store standing
        // by to overwrite the vault this device is the authority for, which is
        // the one operation that cannot be undone.
        //
        // A phone that holds a local vault AND pairs with a gateway is still
        // served: that is two vaults on one device, each with its own core and
        // its own endpoint, which is exactly what "the vault is the unit on a
        // device" means.
        if !handle.is_gateway() {
            attach_network(&handle, &vault_path)?;
        }
        Ok::<_, CoreError>(handle)
    }));
    match outcome {
        Ok(Ok(handle)) => {
            let boxed = Box::into_raw(Box::new(handle));
            // SAFETY: `out` is non-null (checked above) and the caller promised
            // it points to writable storage for one pointer.
            unsafe { out.write(boxed) };
            CENTRAID_OK
        }
        Ok(Err(error)) => code_for(&error),
        // THERE IS NO HANDLE TO POISON YET. A panic in `open` is reported as
        // such and the caller gets no handle at all, which is the only honest
        // answer: a poisoned handle it never received cannot be restarted.
        Err(_) => CENTRAID_PANICKED,
    }
}

/// Give a seat its network (#1020, D-1020-B7).
///
/// **Non-fatal on purpose, with ONE exception.** A core with no network is
/// exactly a local-first vault: every screen still reads, every write still
/// queues, and the shell draws "not connected to a gateway" — which is a true
/// state and the one every phone is in before it scans a code. Failing
/// `centraid_open` because a UDP socket would not bind would be refusing to
/// show a member their own vault over a network they were not using.
///
/// The exception is [`CoreError::IdentityMismatch`], which IS fatal: see below.
///
/// The link is built from the REPLICA PATH and derives its own
/// `<stem>.bytes` store beside it, matching the gateway's layout and the
/// content CAS's: a vault handed to someone else is handed over whole, and a
/// sibling directory travels with the file it belongs to. One endpoint, one
/// key, one store per open replica (#1025 S1) — and since #1025 S7-13, one
/// tokio runtime for all of them.
///
/// ## Everything comes off the ENROLMENT RECORD (#1025 S7-13)
///
/// The secret to bind with, the relay decision, and the public key to check the
/// result against are three properties of one enrolment with one gateway, and
/// the shell hands them over as one record. There used to be a `relays: bool`
/// beside the secret that no shell ever set.
///
/// ## THE IDENTITY IS CHECKED BEFORE THE FIRST DIAL
///
/// If the record names an `enrolled_public_key` and the endpoint that came up
/// has a different one, the secret half is gone — a Keychain item that was
/// never written, a record settled under one name and a key under another — and
/// **the open is refused**. The network is not attached and nothing is dialled.
///
/// This is the defect #1025 S7-9 reproduced and could not place: a seat whose
/// secret did not reach here minted a fresh keypair, dialled its own gateway,
/// and was closed as an unenrolled peer — which the seat then rendered as "this
/// app and that gateway are too far apart in version to talk". A member was
/// sent to update an app that was working correctly. A device that cannot be
/// itself says so, at the door, in its own words.
fn attach_network(handle: &Handle, vault_path: &std::path::Path) -> Result<(), CoreError> {
    let enrolment = handle.enrolment();
    let link = match centraid_seat_link::SeatLink::start_with_key(
        vault_path,
        env!("CARGO_PKG_VERSION"),
        handle.endpoint_secret(),
        handle.relay_hint(),
    ) {
        Ok(link) => link,
        Err(error) => {
            tracing::warn!(
                %error,
                "this seat has no network; it will read what it already holds"
            );
            return Ok(());
        }
    };
    // THE ENDPOINT THAT CAME UP, AGAINST THE ROW THE GATEWAY WROTE.
    let enrolled = enrolment
        .map(|record| record.enrolled_public_key.as_str())
        .filter(|key| !key.is_empty());
    if let Some(enrolled) = enrolled {
        let found = centraid_core::link::hex_lower(&link.endpoint_id());
        if !found.eq_ignore_ascii_case(enrolled) {
            // DROPPED BEFORE THE REFUSAL TRAVELS. The socket is bound by now;
            // leaving it up while the open fails would leave an endpoint on the
            // device with no handle to close it.
            drop(link);
            tracing::error!(
                %enrolled,
                %found,
                "this device's endpoint is not the one its gateway enrolled; not dialling"
            );
            return Err(CoreError::IdentityMismatch {
                enrolled: enrolled.to_owned(),
                found,
            });
        }
    }
    // THE ONE CONTENT STORE, ON THE VAULT'S BYTE DOOR (#1025 S3,
    // D-1025-S3-1). `SeatLink` opened `<replica>.bytes` beside the
    // endpoint; the same handle now backs `media.add_asset`'s spill and
    // `content_location`'s answer. Before this the core opened a flat
    // CAS of its own and a photograph this phone fetched could not be
    // displayed on it.
    handle.attach_bytes(link.content_door());
    handle.attach_network(Box::new(link));
    Ok(())
}

/// Answer one request.
///
/// `req`/`len` are a protobuf-encoded `centraid.core.v1.Envelope` carrying a
/// `Request`. On return `*out_buf`/`*out_len` hold a **callee-allocated**
/// `Envelope` carrying a `Response` or an `Error`, released only by
/// [`centraid_free`].
///
/// **Reentrant across threads.** This function takes no lock of its own; two
/// concurrent calls contend only for whatever the core's own serialisation
/// requires (see `crates/core`'s `handle.rs`, D-1020-D2-9). The FFI is never the
/// bottleneck, and `tests/contract.rs` asserts it.
///
/// # Safety
///
/// `handle` must be a live pointer from [`centraid_open`] that has not been
/// passed to [`centraid_close`]. `req` must point to `len` readable bytes.
/// `out_buf` and `out_len` must point to writable storage.
// SAFETY: `no_mangle` exports this under its `centraid_`-prefixed name, which
// no other symbol in the library shares; the function is `unsafe` because the
// caller must uphold the `# Safety` contract above, and every raw pointer is
// null-checked or borrowed through `marshal` before it is used.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn centraid_call(
    handle: *mut Handle,
    req: *const u8,
    len: usize,
    out_buf: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out_buf.is_null() || out_len.is_null() {
        return CENTRAID_BAD_ARGUMENT;
    }
    // SAFETY: the caller's promise. `handle_of` refuses a null pointer, so the
    // reference below is to storage the caller said is live.
    let Some(core) = (unsafe { marshal::handle_of(handle) }) else {
        return CENTRAID_BAD_ARGUMENT;
    };
    // SAFETY: as above, for `req`/`len`.
    let Some(bytes) = (unsafe { marshal::slice_of(req, len) }) else {
        return CENTRAID_BAD_ARGUMENT;
    };

    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let (request_id, request) = marshal::request_from_envelope(bytes)?;
        // A `Cancel` body is not a request: it names one. Answering it through
        // the same entry point is what keeps the ABI at five symbols.
        if let Some(cancel_id) = request_id.filter(|_| request.is_none()) {
            core.cancel(cancel_id)?;
            return Ok(marshal::empty_response(cancel_id));
        }
        let Some(request) = request else {
            return Err(CoreError::Unsupported {
                type_url: "centraid.core.v1.Envelope".to_owned(),
            });
        };
        let response = match request_id {
            // AN ID THE PEER MINTED. A core that minted its own would answer
            // under an id the caller never used.
            Some(id) if id != 0 => (core.call_with_id(&request, id)?, id),
            _ => (core.call(&request)?, 0),
        };
        Ok(marshal::encode_response(response.1, response.0))
    }));

    match outcome {
        Ok(Ok(encoded)) => {
            // SAFETY: both out-pointers were checked non-null above.
            unsafe { marshal::hand_over(encoded, out_buf, out_len) };
            CENTRAID_OK
        }
        Ok(Err(error)) => {
            // A TYPED REFUSAL IS STILL AN ANSWER. The bytes carry the closed
            // `ErrorCode` the shell branches on; the status code says only that
            // the call itself ran.
            let code = code_for(&error);
            let encoded = marshal::encode_error(0, &error);
            // SAFETY: as above.
            unsafe { marshal::hand_over(encoded, out_buf, out_len) };
            code
        }
        Err(_) => unsafe { poison(core, "call", out_buf, out_len) },
    }
}

/// Wait for the next event, up to `timeout_ms`.
///
/// On [`CENTRAID_OK`], `*out_buf`/`*out_len` hold an `Envelope` carrying an
/// `Event`. On [`CENTRAID_TIMEOUT`] nothing is allocated and the out-pointers are
/// left alone — a caller must not call [`centraid_free`] on them.
///
/// # Safety
///
/// As [`centraid_call`], for `handle`, `out_buf` and `out_len`.
// SAFETY: `no_mangle` exports this under its `centraid_`-prefixed name, which
// no other symbol in the library shares; the function is `unsafe` because the
// caller must uphold the `# Safety` contract above, and every raw pointer is
// null-checked or borrowed through `marshal` before it is used.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn centraid_next_event(
    handle: *mut Handle,
    timeout_ms: u32,
    out_buf: *mut *mut u8,
    out_len: *mut usize,
) -> i32 {
    if out_buf.is_null() || out_len.is_null() {
        return CENTRAID_BAD_ARGUMENT;
    }
    // SAFETY: the caller's promise; `handle_of` refuses null.
    let Some(core) = (unsafe { marshal::handle_of(handle) }) else {
        return CENTRAID_BAD_ARGUMENT;
    };
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        core.next_event(std::time::Duration::from_millis(u64::from(timeout_ms)))
    }));
    match outcome {
        Ok(Ok(Some(event))) => {
            let encoded = marshal::encode_event(event);
            // SAFETY: both out-pointers were checked non-null above.
            unsafe { marshal::hand_over(encoded, out_buf, out_len) };
            CENTRAID_OK
        }
        // NOTHING IS ALLOCATED on a timeout, so there is nothing to free. A
        // caller that called `free` on the untouched pointers would free
        // whatever was in them, which is why this is a clause and not a note.
        Ok(Ok(None)) => CENTRAID_TIMEOUT,
        Ok(Err(error)) => code_for(&error),
        // SAFETY: both out-pointers were checked non-null on entry.
        Err(_) => unsafe { poison(core, "next_event", out_buf, out_len) },
    }
}

/// Release a buffer this library allocated.
///
/// `len` must be the length the call handed back. It is required rather than
/// tracked because Rust's allocator needs the layout to deallocate, and
/// carrying a header inside the buffer would make the bytes the shell reads
/// offset from the pointer it was given — a mistake every shell would make
/// once.
///
/// A null `buf` is a **no-op**, so a caller need not branch on the timeout case.
///
/// # Safety
///
/// `buf` must be a pointer this library returned through an out-parameter, with
/// exactly the `len` it reported, and must not have been freed already.
// SAFETY: `no_mangle` exports this under its `centraid_`-prefixed name, which
// no other symbol in the library shares; the function is `unsafe` because the
// caller must uphold the `# Safety` contract above, and every raw pointer is
// null-checked or borrowed through `marshal` before it is used.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn centraid_free(buf: *mut u8, len: usize) {
    if buf.is_null() {
        return;
    }
    // SAFETY: the caller's promise that `buf`/`len` came from this library's
    // `hand_over`. `reclaim` is that function's exact inverse and lives beside
    // it, so the capacity the two agree on is stated in one place.
    unsafe { marshal::reclaim(buf, len) };
}

/// Close a core and release its handle.
///
/// Unblocks any thread parked in [`centraid_next_event`] — which returns
/// [`CENTRAID_CLOSED`] — and then drops the handle. Every later call on the same
/// pointer is undefined: the pointer is dangling, and no ABI can make a
/// use-after-free safe. A shell must null its own copy, and `CONTRACT.md` says
/// so in those words.
///
/// # Safety
///
/// `handle` must be a live pointer from [`centraid_open`] that has not already
/// been closed. It must not be used afterwards.
// SAFETY: `no_mangle` exports this under its `centraid_`-prefixed name, which
// no other symbol in the library shares; the function is `unsafe` because the
// caller must uphold the `# Safety` contract above, and every raw pointer is
// null-checked or borrowed through `marshal` before it is used.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn centraid_close(handle: *mut Handle) -> i32 {
    if handle.is_null() {
        return CENTRAID_BAD_ARGUMENT;
    }
    // SAFETY: the caller promised a live pointer from `centraid_open`, which is
    // the only thing that produces one, and that it has not been closed.
    let boxed = unsafe { Box::from_raw(handle) };
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        // CLOSE FIRST, then drop: the waiters have to be released before the
        // queue they are parked on goes away.
        boxed.close();
    }));
    drop(boxed);
    if outcome.is_err() {
        return CENTRAID_PANICKED;
    }
    CENTRAID_OK
}

/// File a panic against the handle and hand back an error response.
///
/// # Safety
///
/// `out_buf` and `out_len` must be non-null and point to writable storage.
// SAFETY: `unsafe` because the caller must uphold the `# Safety` contract
// above; the one unsafe operation in the body carries its own note.
unsafe fn poison(core: &Handle, what: &str, out_buf: *mut *mut u8, out_len: *mut usize) -> i32 {
    let diagnostic_id = core.poison(what);
    let encoded = marshal::encode_error(0, &CoreError::Poisoned { diagnostic_id });
    // SAFETY: the caller's promise, checked by every entry point before it can
    // reach here.
    unsafe { marshal::hand_over(encoded, out_buf, out_len) };
    CENTRAID_PANICKED
}

/// The status code one core error becomes.
fn code_for(error: &CoreError) -> i32 {
    match error {
        CoreError::Closed => CENTRAID_CLOSED,
        CoreError::Poisoned { .. } => CENTRAID_PANICKED,
        CoreError::Decode(_) => CENTRAID_MALFORMED,
        CoreError::InvalidRequest { .. } => CENTRAID_BAD_ARGUMENT,
        // THE CONFIGURATION NAMED AN IDENTITY THIS VAULT'S GATEWAY DOES NOT
        // KNOW (#1025 S7-13), which is the one refusal `centraid_open` can
        // produce that is neither a decode nor a stale core.
        //
        // `BAD_ARGUMENT` and not a seventh status code: the ABI has six, the
        // xtask rule counts the symbols and `CONTRACT.md` governs the table, and
        // a status code is deliberately NOT an error vocabulary — the reason
        // lives in the response bytes' closed `ErrorCode`, which is
        // `ERROR_CODE_IDENTITY_MISMATCH` wherever this surfaces through a
        // `call`. What `open` gives a shell is a negative code and a log line
        // naming both keys; what it must never give it is `OK` and no handle.
        CoreError::IdentityMismatch { .. } => CENTRAID_BAD_ARGUMENT,
        // EVERYTHING ELSE IS A SUCCESSFUL CALL WITH A REFUSING ANSWER. The
        // reason is in the response bytes' closed `ErrorCode`, which is what a
        // shell branches on; collapsing them into status codes here would be a
        // second, smaller error vocabulary for the shell to learn.
        _ => CENTRAID_OK,
    }
}
