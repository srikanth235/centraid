//! `Envelope`s over frames, and the frame-level relay that keeps the
//! unknown-field promise (D-1020-C13).

use centraid_api_proto::core_v1::{Cancel, Envelope, Error, Event, Request, Response, envelope};
use prost::Message as _;
use tokio::io::{AsyncRead, AsyncWrite};

use crate::error::{ProtocolError, Result};
use crate::framing::{read_frame, write_frame};

/// Write one `Envelope` as one frame.
pub async fn write_envelope<W>(writer: &mut W, envelope: &Envelope) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_frame(writer, &envelope.encode_to_vec()).await
}

/// Read one `Envelope`. `Ok(None)` is a clean end of stream.
pub async fn read_envelope<R>(reader: &mut R) -> Result<Option<Envelope>>
where
    R: AsyncRead + Unpin,
{
    let Some(body) = read_frame(reader).await? else {
        return Ok(None);
    };
    let envelope = Envelope::decode(body.as_slice())?;
    if envelope.body.is_none() {
        return Err(ProtocolError::EmptyEnvelope);
    }
    Ok(Some(envelope))
}

/// Relay one frame from `reader` to `writer` WITHOUT DECODING IT.
///
/// This is mechanism 1 of D-1020-C13, as code. prost 0.14 drops unknown fields,
/// so any hop that decoded and re-encoded would silently shorten a newer peer's
/// message. Nothing in the v1 plane needs to: a party that answers a message
/// understands it, and a party that merely moves bytes moves BYTES. Returns the
/// number of body bytes moved, or `None` at a clean end of stream.
pub async fn relay_frame<R, W>(reader: &mut R, writer: &mut W) -> Result<Option<usize>>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let Some(body) = read_frame(reader).await? else {
        return Ok(None);
    };
    let moved = body.len();
    write_frame(writer, &body).await?;
    Ok(Some(moved))
}

/// A request envelope.
pub fn request(request_id: u64, request: Request) -> Envelope {
    Envelope {
        request_id,
        body: Some(envelope::Body::Request(request)),
    }
}

/// A response envelope, answering `request_id`.
pub fn response(request_id: u64, response: Response) -> Envelope {
    Envelope {
        request_id,
        body: Some(envelope::Body::Response(response)),
    }
}

/// An event. Events are unsolicited, so the id names the SUBSCRIPTION that
/// produced them — which is why an event is not id-less: a shell with two
/// subscriptions has to know which one woke.
pub fn event(request_id: u64, event: Event) -> Envelope {
    Envelope {
        request_id,
        body: Some(envelope::Body::Event(event)),
    }
}

pub fn cancel(request_id: u64) -> Envelope {
    Envelope {
        request_id,
        body: Some(envelope::Body::Cancel(Cancel {})),
    }
}

pub fn error(request_id: u64, error: Error) -> Envelope {
    Envelope {
        request_id,
        body: Some(envelope::Body::Error(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use centraid_api_proto::core_v1::{ErrorCode, Hello, request as request_kind};

    fn hello_request(id: u64) -> Envelope {
        request(
            id,
            Request {
                kind: Some(request_kind::Kind::Hello(Hello {
                    schema_version: 1,
                    min_supported: 1,
                    product_version: "1.0.0-alpha.0".to_owned(),
                    capabilities: vec!["replica".to_owned()],
                })),
            },
        )
    }

    #[tokio::test]
    async fn an_envelope_round_trips_over_a_frame() {
        let mut wire = Vec::new();
        let sent = hello_request(1);
        write_envelope(&mut wire, &sent).await.expect("write");
        let read = read_envelope(&mut wire.as_slice())
            .await
            .expect("read")
            .expect("an envelope");
        assert_eq!(read, sent);
    }

    /// An `Envelope` with no body is well-formed protobuf that says nothing.
    /// It decodes, so it is not a framing fault, and it is refused with its own
    /// error rather than reaching a handler as "some request".
    #[tokio::test]
    async fn an_envelope_with_no_body_is_refused_as_its_own_fault() {
        let empty = Envelope {
            request_id: 4,
            body: None,
        };
        let mut wire = Vec::new();
        // `write_envelope` cannot be used: an empty Envelope encodes to a
        // varint-tagged request id only, which is non-empty here because the id
        // is 4. That is the case under test.
        write_envelope(&mut wire, &empty).await.expect("write");
        let error = read_envelope(&mut wire.as_slice())
            .await
            .expect_err("refused");
        assert!(matches!(error, ProtocolError::EmptyEnvelope), "{error:?}");
        assert!(
            !error.is_fatal_to_the_stream(),
            "the stream's position is still known"
        );
    }

    /// D-1020-C13 mechanism 1, as a test. The frame carries a field this build
    /// has no name for; relaying it moves the bytes whole, while a
    /// decode-and-re-encode hop would lose them. The second half of the
    /// assertion is what makes the first half mean something.
    #[tokio::test]
    async fn a_relayed_frame_keeps_bytes_this_build_cannot_decode() {
        // A `Hello` request, plus field 99 (varint 7) inside the Envelope.
        let mut body = hello_request(1).encode_to_vec();
        let known = body.len();
        body.extend_from_slice(&[0x98, 0x06, 0x07]);

        let mut wire = Vec::new();
        write_frame(&mut wire, &body).await.expect("write");

        let mut relayed = Vec::new();
        let moved = relay_frame(&mut wire.as_slice(), &mut relayed)
            .await
            .expect("relay")
            .expect("a frame");
        assert_eq!(moved, body.len());
        assert_eq!(&relayed[4..], &body[..], "the relay moved the bytes whole");

        // The other path, for contrast: decode, then re-encode.
        let reencoded = Envelope::decode(body.as_slice())
            .expect("decode")
            .encode_to_vec();
        assert_eq!(
            reencoded.len(),
            known,
            "a decoding hop shortens the message — which is why nothing in the v1 plane is one"
        );
    }

    #[tokio::test]
    async fn every_constructor_produces_the_body_it_names() {
        let bodies = [
            hello_request(1),
            response(2, Response { kind: None }),
            event(3, Event { kind: None }),
            cancel(4),
            error(
                5,
                Error {
                    code: ErrorCode::Cancelled as i32,
                    detail: String::new(),
                    diagnostic_id: String::new(),
                },
            ),
        ];
        let kinds: Vec<&str> = bodies
            .iter()
            .map(|envelope| match envelope.body.as_ref().expect("a body") {
                envelope::Body::Request(_) => "request",
                envelope::Body::Response(_) => "response",
                envelope::Body::Event(_) => "event",
                envelope::Body::Cancel(_) => "cancel",
                envelope::Body::Error(_) => "error",
            })
            .collect();
        assert_eq!(kinds, ["request", "response", "event", "cancel", "error"]);
        for (index, envelope) in bodies.iter().enumerate() {
            assert_eq!(envelope.request_id, index as u64 + 1);
        }
    }
}
