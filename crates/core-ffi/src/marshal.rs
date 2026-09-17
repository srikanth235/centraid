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
    // NO `gateway` KEY (#1025 S1, D-1025-S1-1). A shell used to hand one over
    // and the core used to name a replica by it; the vault is the unit on a
    // device now, and where it is reached lives in the pairing record.
    let role = match parsed.get("role").and_then(serde_json::Value::as_str) {
        Some("gateway") | None => Role::Gateway,
        Some("seat-replicated") => Role::Seat {
            kind: SeatKind::Replicated,
        },
        Some("seat-thin") => Role::Seat {
            kind: SeatKind::Thin,
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
        // THE PAIRING THE SHELL KEPT (#1025 S7, item 3). Absent on every launch
        // after the first copy lands: the replica holds the record by then and
        // is asked first.
        pairing: pairing_from(&parsed)?,
    };
    config.create = parsed
        .get("create")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(config.role == Role::Gateway);
    Ok(config)
}

/// THE ENROLMENT RECORD A SHELL PERSISTED, out of the open configuration
/// (#1025 S7-13).
///
/// `{"pairing": {"secret": "<64 hex>", "gatewayAddress": "<64 hex>", "vaultId":
/// "…", "vaultName": "…", "relayUrl": "…", "directAddrs": ["…"],
/// "enrolledPublicKey": "<64 hex>"}}` — the secret half of this device's
/// identity for this vault, plus everything a `PairOk` carried.
///
/// **One record, not three keys.** `endpointSecretKey` and
/// `endpointSecretKeyPath` used to be siblings of `pairing`, and the shell kept
/// the key under one secure-store name and the address under another. Two names
/// settle in two writes, and a settle that half-ran left a device with an
/// identity for a vault whose address it had lost. There is one name now, and
/// it moves in one rename (v0, no legacy: the old spellings are gone).
///
/// A record with NO gateway address is still a record here, and deliberately:
/// it is what a device holds while it is redeeming a ticket, when it has a
/// minted identity and does not yet know what it paired with.
/// `Handle::configured_gateway` is what refuses to dial one, and
/// `Handle::relay_hint` is what declines to read a relay decision off it.
fn pairing_from(
    parsed: &serde_json::Value,
) -> Result<Option<centraid_core::PairingRecord>, CoreError> {
    let Some(pairing) = parsed.get("pairing") else {
        return Ok(None);
    };
    let text = |key: &str| {
        pairing
            .get(key)
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_owned()
    };
    let record = centraid_core::PairingRecord {
        secret: secret_from(&text("secret"))?,
        gateway_address: text("gatewayAddress"),
        vault_id: text("vaultId"),
        vault_name: text("vaultName"),
        // ABSENT IS NOT EMPTY. The key's PRESENCE is the statement: a shell
        // that has read a `PairOk` says what the relay is, even when the answer
        // is "none"; a shell in the middle of redeeming a ticket says nothing
        // and the endpoint keeps relays on.
        relay_url: pairing
            .get("relayUrl")
            .and_then(serde_json::Value::as_str)
            .map(|url| url.trim().to_owned()),
        direct_addrs: pairing
            .get("directAddrs")
            .and_then(serde_json::Value::as_array)
            .map(|hints| {
                hints
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        enrolled_public_key: text("enrolledPublicKey").to_lowercase(),
    };
    // A RECORD THAT SAYS NOTHING IS NO RECORD. An object with neither an
    // identity nor an address is a shell that sent `pairing: {}`, and carrying
    // it would make `relay_hint` and the identity check reason about a blank.
    if record.secret.is_none() && record.gateway_address.is_empty() {
        return Ok(None);
    }
    Ok(Some(record))
}

/// THIS DEVICE'S ENDPOINT SECRET KEY FOR THIS VAULT, 32 bytes as 64 lowercase
/// hex (#1025 S5, folded into the enrolment record by S7-13).
///
/// **The core never invents a path for it.** A core that wrote a key beside the
/// vault would put the one unrecoverable secret on this device in a place no
/// shell asked for and no backup excludes. Empty is therefore not an error: it
/// is a shell whose store had nothing for this vault yet, which is every first
/// launch — and after a pairing it is caught by `enrolledPublicKey`, not here.
///
/// A key that is PRESENT AND UNREADABLE **is** an error, and deliberately so:
/// carrying on with a fresh key would silently un-enrol a device whose shell
/// believed it had persisted one.
fn secret_from(hex: &str) -> Result<Option<[u8; 32]>, CoreError> {
    if hex.is_empty() {
        return Ok(None);
    }
    if hex.len() != 64 {
        return Err(CoreError::InvalidRequest {
            detail: "the endpoint secret key is not 64 hex characters".to_owned(),
        });
    }
    let mut secret = [0u8; 32];
    for (index, byte) in secret.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| {
            CoreError::InvalidRequest {
                detail: "the endpoint secret key is not hexadecimal".to_owned(),
            }
        })?;
    }
    Ok(Some(secret))
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
// SAFETY: `unsafe` because the caller must uphold the `# Safety` contract
// above; the one unsafe operation in the body carries its own note.
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
// SAFETY: `unsafe` because the caller must uphold the `# Safety` contract
// above; the one unsafe operation in the body carries its own note.
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
// SAFETY: `unsafe` because the caller must uphold the `# Safety` contract
// above; the one unsafe operation in the body carries its own note.
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
// SAFETY: `unsafe` because the caller must uphold the `# Safety` contract
// above; the one unsafe operation in the body carries its own note.
pub unsafe fn reclaim(buf: *mut u8, len: usize) {
    // SAFETY: `hand_over` shrank the capacity to the length (or reserved
    // exactly one byte for an empty buffer), so rebuilding with
    // `capacity == len.max(1)` matches the allocation exactly.
    let _ = unsafe { Vec::from_raw_parts(buf, len, len.max(1)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE SHELL'S SECURE STORE REACHES THE CORE, INSIDE THE ONE RECORD
    /// (#1025 S5, re-shaped by S7-13). Absent is a first launch — a fresh
    /// keypair per open — and present is the identity a gateway enrolled.
    #[test]
    fn the_endpoint_secret_crosses_the_abi_inside_the_enrolment_record() {
        let none = config_from_json(br#"{"path":"/tmp/s.db","role":"seat-replicated"}"#)
            .expect("it parses");
        assert!(none.pairing.is_none());
        // An object that says nothing is not a record: neither an identity nor
        // an address is a shell that sent `pairing: {}`.
        let empty = config_from_json(
            br#"{"path":"/tmp/s.db","role":"seat-replicated","pairing":{"secret":""}}"#,
        )
        .expect("it parses");
        assert!(empty.pairing.is_none());

        let hex = "0a".repeat(32);
        let supplied = config_from_json(
            format!(r#"{{"path":"/tmp/s.db","pairing":{{"secret":"{hex}"}}}}"#).as_bytes(),
        )
        .expect("it parses");
        assert_eq!(
            supplied.pairing.as_ref().and_then(|record| record.secret),
            Some([0x0au8; 32])
        );
        // A TRANSIENT RECORD IS STILL A RECORD: an identity with no gateway is
        // exactly a device in the middle of redeeming a ticket.
        assert_eq!(
            supplied
                .pairing
                .as_ref()
                .map(|record| record.gateway_address.as_str()),
            Some("")
        );
    }

    /// EVERYTHING A `PairOk` CARRIED, AND THE KEY IT ENROLLED (#1025 S7-13).
    #[test]
    fn the_enrolment_record_carries_the_address_the_relay_and_the_enrolled_key() {
        let gateway = "ab".repeat(32);
        let enrolled = "CD".repeat(32);
        let config = config_from_json(
            format!(
                r#"{{"path":"/tmp/s.db","role":"seat-replicated","pairing":{{
                     "gatewayAddress":"{gateway}","vaultId":"v1","vaultName":"Home",
                     "relayUrl":"","directAddrs":["10.0.0.2:1234"],
                     "enrolledPublicKey":"{enrolled}"}}}}"#
            )
            .as_bytes(),
        )
        .expect("it parses");
        let record = config.pairing.expect("a record");
        assert_eq!(record.gateway_address, gateway);
        assert_eq!(record.vault_id, "v1");
        assert_eq!(record.direct_addrs, vec!["10.0.0.2:1234".to_owned()]);
        // LOWERCASED ON THE WAY IN, so the comparison at open is over one
        // spelling rather than two that differ by case.
        assert_eq!(record.enrolled_public_key, "cd".repeat(32));
        assert_eq!(
            record.relay_url.as_deref(),
            Some(""),
            "a deployment that STATED it has no relay"
        );
    }

    /// A KEY THAT IS PRESENT AND UNREADABLE IS AN ERROR. Carrying on with a
    /// fresh one would silently un-enrol a device whose shell believed it had
    /// persisted an identity.
    #[test]
    fn a_malformed_endpoint_secret_key_is_refused_rather_than_replaced() {
        assert!(
            config_from_json(br#"{"path":"/tmp/s.db","pairing":{"secret":"not hex at all"}}"#)
                .is_err()
        );
        assert!(
            config_from_json(br#"{"path":"/tmp/s.db","pairing":{"secret":"0a0a"}}"#).is_err(),
            "a short key was accepted and padded"
        );
        let long = "zz".repeat(32);
        assert!(
            config_from_json(
                format!(r#"{{"path":"/tmp/s.db","pairing":{{"secret":"{long}"}}}}"#).as_bytes()
            )
            .is_err()
        );
    }

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
