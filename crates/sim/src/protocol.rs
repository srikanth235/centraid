//! The simulation's datagram framing, and the two messages it carries.
//!
//! One datagram per message, prefixed `u32BE(len) ‖ bytes` exactly as
//! [`centraid_protocol::framing`] prefixes a stream frame. The prefix is
//! redundant over a datagram, which already has a length — and it is kept
//! anyway, because a truncated datagram must be refused for the same reason a
//! truncated stream frame is, and a simulation that accepted one would be
//! simulating a transport more forgiving than the real one.
//!
//! The bodies are real `centraid.core.v1` messages: the gateway answers them
//! through the real [`centraid_core::Handle::call`], so what the seat parses is
//! what a seat parses in production.

use centraid_api_proto::core_v1 as wire;
use prost::Message as _;

/// The ceiling on one simulated datagram, matching the protocol's frame bound.
pub const MAX_DATAGRAM_BYTES: usize = centraid_protocol::MAX_FRAME_BYTES;

/// Frame a body.
pub fn frame(body: &[u8]) -> Result<Vec<u8>, String> {
    if body.is_empty() {
        return Err("a zero-length frame is refused, as it is on the wire".to_owned());
    }
    if body.len() > MAX_DATAGRAM_BYTES {
        return Err(format!(
            "a {}-byte frame is over the {MAX_DATAGRAM_BYTES}-byte ceiling",
            body.len()
        ));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&u32::try_from(body.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(body);
    Ok(out)
}

/// Read a framed body back, refusing every malformed shape.
pub fn unframe(datagram: &[u8]) -> Result<&[u8], String> {
    if datagram.len() < 4 {
        return Err("a datagram shorter than its length prefix".to_owned());
    }
    let declared = u32::from_be_bytes([datagram[0], datagram[1], datagram[2], datagram[3]]);
    let declared = usize::try_from(declared).unwrap_or(usize::MAX);
    if declared == 0 {
        return Err("a zero-length frame".to_owned());
    }
    if declared > MAX_DATAGRAM_BYTES {
        return Err(format!(
            "a declared length of {declared} is over the ceiling"
        ));
    }
    // A DATAGRAM SHORTER THAN ITS PREFIX SAYS is a truncated message, and
    // reading the bytes that are there would be reading half a page as if it
    // were a whole one.
    if datagram.len() < 4 + declared {
        return Err(format!(
            "a datagram declaring {declared} bytes and carrying {}",
            datagram.len() - 4
        ));
    }
    Ok(&datagram[4..4 + declared])
}

/// One request, framed and encoded.
pub fn encode_request(request_id: u64, request: wire::Request) -> Result<Vec<u8>, String> {
    frame(
        &wire::Envelope {
            request_id,
            body: Some(wire::envelope::Body::Request(request)),
        }
        .encode_to_vec(),
    )
}

/// One answer, framed and encoded.
pub fn encode_envelope(envelope: &wire::Envelope) -> Result<Vec<u8>, String> {
    frame(&envelope.encode_to_vec())
}

/// Read an envelope out of a datagram.
pub fn decode_envelope(datagram: &[u8]) -> Result<wire::Envelope, String> {
    let body = unframe(datagram)?;
    wire::Envelope::decode(body).map_err(|error| format!("an undecodable envelope: {error}"))
}

/// A log-page request from `since`.
#[must_use]
pub fn log_request(epoch: &str, since: i64, limit: i64) -> wire::Request {
    wire::Request {
        kind: Some(wire::request::Kind::Log(wire::LogRequest {
            since: Some(wire::LogCursor {
                epoch: epoch.to_owned(),
                seq: since.unsigned_abs(),
            }),
            limit: u32::try_from(limit).unwrap_or(u32::MAX),
        })),
    }
}

/// A command, as a seat's intent reaches the gateway in wave 2.
///
/// The simulation submits intents as **commands carrying the intent id**, which
/// is the path D1's command plane already implements: `Vault::execute` looks an
/// `intent_id` up in `replica_intent_outcome` first, so a duplicate delivery is
/// answered from the ledger and the handler runs once. The `Intent` message's
/// own admission door (read-set checking, hash comparison in constant time) is
/// wave 3's, and this simulation would otherwise have nothing to prove
/// idempotency against — which is the whole point of running it now.
#[must_use]
pub fn command_request(
    name: &str,
    input: &serde_json::Value,
    invoke_key: &str,
    device_id: &str,
) -> wire::Request {
    wire::Request {
        kind: Some(wire::request::Kind::Command(wire::Command {
            name: name.to_owned(),
            input: serde_json::to_vec(input).unwrap_or_default(),
            invoke_key: invoke_key.to_owned(),
            principal: Some(wire::Principal {
                kind: wire::PrincipalKind::OwnerDevice as i32,
                caller_id: device_id.to_owned(),
                principal_id: String::new(),
                surface: String::new(),
                on_behalf_of_owner: false,
            }),
            optional: false,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_round_trips() {
        let framed = frame(b"a page").expect("it frames");
        assert_eq!(unframe(&framed).expect("it unframes"), b"a page");
    }

    #[test]
    fn a_zero_length_frame_is_refused_on_both_sides() {
        assert!(frame(b"").is_err());
        assert!(unframe(&[0, 0, 0, 0]).is_err());
    }

    /// THE REASON THE REDUNDANT PREFIX IS KEPT. A simulation that read the
    /// bytes that arrived would be simulating a transport more forgiving than
    /// the real one.
    #[test]
    fn a_truncated_datagram_is_refused_rather_than_read_short() {
        let mut framed = frame(b"a whole page").expect("it frames");
        framed.truncate(framed.len() - 3);
        let error = unframe(&framed).expect_err("it refuses");
        assert!(error.contains("declaring"));
    }

    #[test]
    fn a_datagram_shorter_than_its_prefix_is_refused() {
        assert!(unframe(&[0, 0]).is_err());
        assert!(unframe(&[]).is_err());
    }

    #[test]
    fn a_declared_length_over_the_ceiling_is_refused_before_any_allocation() {
        let mut oversize = u32::MAX.to_be_bytes().to_vec();
        oversize.push(1);
        let error = unframe(&oversize).expect_err("it refuses");
        assert!(error.contains("over the ceiling"));
    }

    #[test]
    fn a_request_survives_the_round_trip_as_the_message_it_was() {
        let datagram = encode_request(7, log_request("e", 42, 100)).expect("it encodes");
        let envelope = decode_envelope(&datagram).expect("it decodes");
        assert_eq!(envelope.request_id, 7);
        let Some(wire::envelope::Body::Request(wire::Request {
            kind: Some(wire::request::Kind::Log(request)),
        })) = envelope.body
        else {
            panic!("a log request comes back");
        };
        assert_eq!(request.limit, 100);
        assert_eq!(request.since.expect("a cursor").seq, 42);
    }

    #[test]
    fn garbage_in_a_well_framed_datagram_is_a_decode_error_and_not_a_panic() {
        let framed = frame(&[0x08, 0xff]).expect("it frames");
        assert!(decode_envelope(&framed).is_err());
    }

    #[test]
    fn a_command_carries_its_principal_and_its_invoke_key() {
        let request = command_request("core.note.create", &serde_json::json!({}), "k1", "d1");
        let Some(wire::request::Kind::Command(command)) = request.kind else {
            panic!("a command");
        };
        assert_eq!(command.invoke_key, "k1");
        assert_eq!(command.principal.expect("a principal").caller_id, "d1");
    }
}
