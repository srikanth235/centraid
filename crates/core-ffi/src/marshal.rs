//! The marshalling layer, isolated so `cargo miri` can run over it.
//!
//! Everything in this module that touches a raw pointer is here **so miri has
//! something to check**. `cargo miri test -p centraid-core-ffi` cannot run the
//! whole crate — SQLite is a C library and miri does not execute foreign code —
//! so the unsafe surface is confined to the four functions at the bottom of
//! this file, and `tests/marshal_miri.rs` exercises exactly those with no vault
//! in sight. What miri covers is therefore: the slice reconstruction, the
//! out-pointer writes, the `Vec` → raw → `Vec` round trip that `centraid_free`
//! inverts, and the null-pointer refusals.
//!
//! The encoding half is safe Rust and is tested the ordinary way.

use centraid_api_proto::core_v1 as wire;
use centraid_core::{CoreConfig, CoreError, Handle, Role, SeatKind};
use prost::Message as _;

// ------------------------------------------------------------- encoding -----

/// Decode an envelope.
pub fn decode_envelope(bytes: &[u8]) -> Result<wire::Envelope, CoreError> {
    Ok(wire::Envelope::decode(bytes)?)
}

/// The request id and the request an envelope carries.
///
/// Returns `(Some(id), None)` for a `Cancel`, which names a request rather than
/// being one — the caller distinguishes the two and there is no third case that
/// reaches `call`.
#[allow(clippy::type_complexity)]
pub fn request_from_envelope(
    bytes: &[u8],
) -> Result<(Option<u64>, Option<wire::Request>), CoreError> {
    let envelope = decode_envelope(bytes)?;
    let id = (envelope.request_id != 0).then_some(envelope.request_id);
    match envelope.body {
        Some(wire::envelope::Body::Request(request)) => Ok((id, Some(request))),
        Some(wire::envelope::Body::Cancel(_)) => {
            // A CANCEL WITH NO ID names nothing. Refused rather than treated as
            // "cancel everything", which is a thing no caller meant.
            let Some(id) = id else {
                return Err(CoreError::InvalidRequest {
                    detail: "a Cancel carries request_id 0, which names no request".to_owned(),
                });
            };
            Ok((Some(id), None))
        }
        _ => Err(CoreError::Unsupported {
            type_url: "centraid.core.v1.Envelope".to_owned(),
        }),
    }
}

/// Encode a response into an envelope's bytes.
#[must_use]
pub fn encode_response(request_id: u64, response: wire::Response) -> Vec<u8> {
    wire::Envelope {
        request_id,
        body: Some(wire::envelope::Body::Response(response)),
    }
    .encode_to_vec()
}

/// An envelope with a response carrying no body — the answer to a `Cancel`.
#[must_use]
pub fn empty_response(request_id: u64) -> Vec<u8> {
    encode_response(request_id, wire::Response { kind: None })
}

/// Encode an error into an envelope's bytes.
#[must_use]
pub fn encode_error(request_id: u64, error: &CoreError) -> Vec<u8> {
    wire::Envelope {
        request_id,
        body: Some(wire::envelope::Body::Error(error.to_wire())),
    }
    .encode_to_vec()
}

/// Encode an event into an envelope's bytes.
///
/// Request id **zero**: an event is not an answer to anything, and stamping it
/// with an id would invite a shell to correlate it with a call it made.
#[must_use]
pub fn encode_event(event: wire::Event) -> Vec<u8> {
    wire::Envelope {
        request_id: 0,
        body: Some(wire::envelope::Body::Event(event)),
    }
    .encode_to_vec()
}

/// Read the open configuration out of JSON.
pub fn config_from_json(bytes: &[u8]) -> Result<CoreConfig, CoreError> {
    let text = std::str::from_utf8(bytes).map_err(|error| CoreError::InvalidRequest {
        detail: format!("the open configuration is not UTF-8: {error}"),
    })?;
    let parsed: serde_json::Value =
        serde_json::from_str(text).map_err(|error| CoreError::InvalidRequest {
            detail: format!("the open configuration is not JSON: {error}"),
        })?;
    let path = parsed
        .get("path")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| CoreError::InvalidRequest {
            detail: "the open configuration names no `path`".to_owned(),
        })?;
    let gateway = parsed
        .get("gateway")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .as_bytes()
        .to_vec();
    let role = match parsed.get("role").and_then(serde_json::Value::as_str) {
        Some("gateway") | None => Role::Gateway,
        Some("seat-replicated") => Role::Seat {
            kind: SeatKind::Replicated,
            gateway,
        },
        Some("seat-thin") => Role::Seat {
            kind: SeatKind::Thin,
            gateway,
        },
        Some(other) => {
            return Err(CoreError::InvalidRequest {
                detail: format!(
                    "`{other}` is not a role; it is `gateway`, `seat-replicated` or `seat-thin`"
                ),
            });
        }
    };
    let mut config = CoreConfig {
        path: std::path::PathBuf::from(path),
        role,
        ui_thread_name: parsed
            .get("uiThreadName")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        // DEFAULTS TO THE ROLE, not to `true`: a seat whose snapshot has not
        // landed must not quietly get an empty vault, which would be a product
        // that opens and shows nothing.
        create: false,
        // NEITHER IS SETTABLE ACROSS THE ABI, on purpose. A clock is a `dyn`
        // trait object and a shell has no way to hand one over the C boundary;
        // and a shipped gateway wants the system clock, which is what `None`
        // is. `CoreConfig::with_clock` is for a test, a simulation or a fixture
        // freezer — callers that are Rust.
        clock: None,
        ids: None,
        // THE ONE IDENTITY CHECK A SHELL CAN MAKE (#1020 Artifacts, D-1020-G2;
        // wave 3 lane E finding 3). A shell that linked a prebuilt core passes
        // the digest its OWN build recorded and `Core::open` refuses a
        // mismatch. Absent means the caller claimed no expectation, which is
        // not a match — it is unchecked, and `require_digest` says so.
        expected_digest: parsed
            .get("expectedIdentity")
            .and_then(serde_json::Value::as_str)
            .filter(|digest| !digest.trim().is_empty())
            .map(str::to_owned),
    };
    config.create = parsed
        .get("create")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(config.role == Role::Gateway);
    Ok(config)
}

// --------------------------------------------------------------- unsafe -----

/// Borrow `len` bytes at `data`.
///
/// `None` for a null pointer with a non-zero length. A null pointer with length
/// **zero** is the empty slice, because that is what a shell passing "no
/// configuration" naturally produces and refusing it would be a boundary
/// nobody tested.
///
/// # Safety
///
/// When `len > 0`, `data` must point to `len` initialised bytes that stay valid
/// and unmutated for the returned slice's lifetime. The slice is **borrowed**:
/// this library keeps nothing past the call that made it.
#[must_use]
pub unsafe fn slice_of<'bytes>(data: *const u8, len: usize) -> Option<&'bytes [u8]> {
    if len == 0 {
        return Some(&[]);
    }
    if data.is_null() {
        return None;
    }
    // SAFETY: `len > 0` and `data` is non-null, and the caller's contract above
    // promises `len` initialised bytes valid for the borrow.
    Some(unsafe { std::slice::from_raw_parts(data, len) })
}

/// Borrow the handle at `handle`.
///
/// # Safety
///
/// `handle` must be null, or a pointer `centraid_open` produced that has not
/// been passed to `centraid_close`.
#[must_use]
pub unsafe fn handle_of<'handle>(handle: *mut Handle) -> Option<&'handle Handle> {
    if handle.is_null() {
        return None;
    }
    // SAFETY: non-null, and the caller promised it came from `centraid_open`
    // (which boxes a `Handle`) and is not closed. `Handle` is `Sync`, so a
    // shared reference from two threads is sound — which is the reentrancy
    // clause, held here rather than by a lock.
    Some(unsafe { &*handle })
}

/// Hand a buffer to the caller, transferring ownership.
///
/// The capacity is shrunk to the length first, so `centraid_free`'s
/// reconstruction with `capacity == len` is exact. Without that the `Vec` it
/// rebuilds would claim a capacity the allocator did not give it, which is
/// undefined behaviour that happens to work until it does not.
///
/// # Safety
///
/// `out_buf` and `out_len` must be non-null and point to writable storage for a
/// pointer and a `usize`. The caller owns the buffer afterwards and must release
/// it with `centraid_free`, and with nothing else.
pub unsafe fn hand_over(mut bytes: Vec<u8>, out_buf: *mut *mut u8, out_len: *mut usize) {
    bytes.shrink_to_fit();
    let len = bytes.len();
    // An empty answer would otherwise hand back a dangling non-null pointer
    // that `free` must not touch. One byte of slack is cheaper than a clause.
    if bytes.capacity() == 0 {
        bytes.reserve_exact(1);
    }
    let mut owned = std::mem::ManuallyDrop::new(bytes);
    let pointer = owned.as_mut_ptr();
    // SAFETY: both pointers are the caller's promise above, checked non-null by
    // every entry point before it reaches here.
    unsafe {
        out_buf.write(pointer);
        out_len.write(len);
    }
}

/// Reclaim a buffer `hand_over` gave out.
///
/// The inverse of [`hand_over`], and the thing `centraid_free` is.
///
/// # Safety
///
/// `buf` must be non-null and a pointer [`hand_over`] produced, with the exact
/// `len` it reported, not yet reclaimed.
pub unsafe fn reclaim(buf: *mut u8, len: usize) {
    // SAFETY: `hand_over` shrank the capacity to the length (or reserved
    // exactly one byte for an empty buffer), so rebuilding with
    // `capacity == len.max(1)` matches the allocation exactly.
    let _ = unsafe { Vec::from_raw_parts(buf, len, len.max(1)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gateway_config_defaults_to_creating_its_file_and_a_seat_does_not() {
        let gateway = config_from_json(br#"{"path":"/tmp/v.db"}"#).expect("it parses");
        assert!(gateway.create, "a gateway founds its vault");
        let seat =
            config_from_json(br#"{"path":"/tmp/s.db","role":"seat-thin"}"#).expect("it parses");
        assert!(
            !seat.create,
            "a seat whose snapshot has not landed must not get an empty vault"
        );
        // And an explicit `create` wins over the default in both directions.
        assert!(
            !config_from_json(br#"{"path":"/tmp/v.db","create":false}"#)
                .expect("parses")
                .create
        );
    }

    #[test]
    fn an_unknown_role_is_refused_and_not_defaulted_to_gateway() {
        assert!(config_from_json(br#"{"path":"/tmp/v.db","role":"deputy"}"#).is_err());
        assert!(
            config_from_json(br#"{"role":"gateway"}"#).is_err(),
            "no path"
        );
        assert!(config_from_json(b"not json").is_err());
        assert!(config_from_json(&[0xff, 0xfe]).is_err(), "not UTF-8");
    }

    /// `expectedIdentity` CROSSES THE ABI, and an empty one is not an
    /// expectation (#1020 Artifacts, D-1020-G2; wave 3 lane E finding 3).
    ///
    /// A shell that linked a prebuilt core has no other way to say which core
    /// its own build was made against. Absent or blank is "not checked" rather
    /// than "matched": `Core::open` then skips the comparison instead of
    /// passing an empty string to `require_digest`, which refuses one.
    #[test]
    fn an_expected_identity_crosses_the_abi_and_a_blank_one_is_not_an_expectation() {
        let config =
            config_from_json(br#"{"path":"/tmp/v.db","expectedIdentity":"abc123"}"#).expect("ok");
        assert_eq!(config.expected_digest.as_deref(), Some("abc123"));
        for blank in [
            &br#"{"path":"/tmp/v.db"}"#[..],
            &br#"{"path":"/tmp/v.db","expectedIdentity":""}"#[..],
            &br#"{"path":"/tmp/v.db","expectedIdentity":"   "}"#[..],
        ] {
            assert!(
                config_from_json(blank)
                    .expect("ok")
                    .expected_digest
                    .is_none(),
                "a blank expectation is unchecked, never a match"
            );
        }
    }

    #[test]
    fn a_cancel_with_request_id_zero_names_nothing_and_is_refused() {
        let bytes = wire::Envelope {
            request_id: 0,
            body: Some(wire::envelope::Body::Cancel(wire::Cancel {})),
        }
        .encode_to_vec();
        assert!(request_from_envelope(&bytes).is_err());
    }

    #[test]
    fn a_cancel_with_an_id_carries_the_id_and_no_request() {
        let bytes = wire::Envelope {
            request_id: 7,
            body: Some(wire::envelope::Body::Cancel(wire::Cancel {})),
        }
        .encode_to_vec();
        assert_eq!(
            request_from_envelope(&bytes).expect("it reads"),
            (Some(7), None)
        );
    }

    #[test]
    fn a_response_shaped_envelope_reaching_call_is_unsupported() {
        // A shell that sent back what it received. Refused rather than
        // interpreted, because interpreting it is how a loop starts.
        let bytes = wire::Envelope {
            request_id: 1,
            body: Some(wire::envelope::Body::Response(wire::Response {
                kind: None,
            })),
        }
        .encode_to_vec();
        assert!(matches!(
            request_from_envelope(&bytes),
            Err(CoreError::Unsupported { .. })
        ));
    }

    #[test]
    fn an_event_is_stamped_with_request_id_zero() {
        let bytes = encode_event(wire::Event { kind: None });
        let envelope = decode_envelope(&bytes).expect("it decodes");
        assert_eq!(
            envelope.request_id, 0,
            "an event answers nothing, and an id would invite a shell to correlate it"
        );
    }

    #[test]
    fn garbage_bytes_are_a_decode_error_and_not_a_panic() {
        // Field 1 as a varint with a continuation bit and no continuation.
        assert!(decode_envelope(&[0x08, 0xff]).is_err());
        assert!(request_from_envelope(&[0x08, 0xff]).is_err());
    }
}
