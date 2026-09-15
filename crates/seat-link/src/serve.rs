//! THE SEAT'S HALF OF THE SYMMETRIC LOOP (#1025 S2).
//!
//! One connection per vault, one stream per request — **and the accepting side
//! can open streams too**. The seat dials, but after that the connection is not
//! one-directional: the gateway may open a stream on it, and this module is
//! what answers.
//!
//! ## Why it exists now, before anything uses it
//!
//! S3 is "bytes both ways": a photograph taken on a phone reaches the gateway
//! because the GATEWAY pulls it, over the connection the phone opened, before
//! it commits the content row. That is the only shape that works — the phone is
//! behind the worse NAT and is the side that knows when it is awake — and it
//! requires the seat to serve `blob` streams on a connection it dialled.
//!
//! Building the loop one-directional now and symmetric later would mean
//! rewriting the half that works, and worse, it would mean the seat's accept
//! path had never been exercised until the slice that depended on it. So the
//! loop is here, it serves what a seat can honestly serve, and it refuses
//! everything else BY NAME.
//!
//! ## What a seat serves, and what it never will
//!
//! A seat serves `blob` streams from its own byte store, and nothing else. It
//! is not an authority: it holds a COPY of what the gateway committed, so a
//! `log` request would serve the gateway its own log back, and an `intent`
//! would be a write to a mirror that the applier overwrites on the next page.
//! Both are refused by name rather than by falling through, for the same reason
//! the gateway's lane refuses `Command`: a lane that quietly served something
//! because the code path happened to reach it is the shape of defect a named
//! refusal exists to make impossible.
//!
//! ## Admission is the GATEWAY'S enrolment of this seat, inverted
//!
//! The peer on this connection is the gateway this seat dialled, and iroh's TLS
//! proved its endpoint id before a byte moved. A seat that served blobs to a
//! connection it did not open would need an allowlist of its own; it never
//! accepts one, so it does not.

use centraid_api_proto::core_v1::{self as core, envelope, request};
use centraid_blobs::ByteStore;
use centraid_net::{IrohConnection, RawRecv, RawSend};
use centraid_protocol::Connection as _;
use centraid_protocol::wire::{read_envelope, write_envelope};
use tokio::io::AsyncWriteExt as _;

/// Answer streams the gateway opens, until the connection ends.
///
/// Runs as a task beside a pass and is dropped with it. Returning is the
/// ordinary end: the window closed, the connection went, and the next window
/// dials a new one.
pub async fn accept_streams(connection: &IrohConnection, blobs: ByteStore) {
    let connection_id = connection.iroh().stable_id() as u64;
    loop {
        let Ok((send, recv)): centraid_protocol::Result<(RawSend, RawRecv)> =
            connection.accept_bi().await
        else {
            return;
        };
        let blobs = blobs.clone();
        // ONE TASK PER STREAM, so a blob the gateway is pulling does not block
        // the next thing it asks for.
        tokio::spawn(async move {
            if let Err(why) = one_stream(send, recv, &blobs, connection_id).await {
                tracing::debug!(%why, "a gateway-opened stream ended");
            }
        });
    }
}

async fn one_stream(
    mut send: RawSend,
    mut recv: RawRecv,
    blobs: &ByteStore,
    connection_id: u64,
) -> Result<(), String> {
    let asked = match read_envelope(&mut recv).await {
        Ok(Some(envelope)) => envelope,
        Ok(None) => return Ok(()),
        // A MALFORMED FIRST FRAME COSTS THIS STREAM AND NOTHING ELSE. The
        // stream's position is unknown so there is nothing to answer on it; the
        // connection and every other stream on it are untouched.
        Err(error) => return Err(format!("an unreadable first frame: {error}")),
    };
    let request_id = asked.request_id;
    match asked.body {
        // THE HANDOVER. No envelope goes back: everything after this frame is
        // iroh-blobs' protocol, and one of ours on the same stream would be the
        // first thing the fetching side tried to parse as a blob response.
        Some(envelope::Body::Request(core::Request {
            kind: Some(request::Kind::Blob(_)),
        })) => {
            centraid_blobs::serve_stream(blobs, connection_id, send, recv).await;
            Ok(())
        }
        other => {
            let refusal = centraid_protocol::wire::error(
                request_id,
                core::Error {
                    code: core::ErrorCode::UnsupportedMessage as i32,
                    // LOGS ONLY, and it names the reason rather than the shape:
                    // a seat is a copy, and a copy has nothing to serve but
                    // bytes.
                    detail: format!(
                        "a seat serves blob streams only; it holds a copy and is nobody's \
                         authority. Got {}",
                        shape_of(other.as_ref())
                    ),
                    diagnostic_id: String::new(),
                    sentence: "This device can send files and nothing else.".to_owned(),
                },
            );
            write_envelope(&mut send, &refusal)
                .await
                .map_err(|error| format!("the refusal would not write: {error}"))?;
            send.flush()
                .await
                .map_err(|error| format!("the refusal would not flush: {error}"))?;
            let _ = send.finish();
            Ok(())
        }
    }
}

/// A name for the log line, never the payload. `Error.detail` is logs-only.
fn shape_of(body: Option<&envelope::Body>) -> &'static str {
    match body {
        Some(envelope::Body::Request(_)) => "another request kind",
        Some(envelope::Body::Response(_)) => "a response",
        Some(envelope::Body::Event(_)) => "an event",
        Some(envelope::Body::Error(_)) => "an error",
        _ => "an empty envelope",
    }
}
