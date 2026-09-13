//! THE SEAT LANE: what a gateway says to an admitted replica (#1020, lane D2).
//!
//! `crates/net` pairs and streams, `crates/seat` applies and settles, and
//! [`centraid_core::Handle::call`] already answers a `LogRequest` with a page —
//! cursor, floor, watermark, rebootstrap and all. What did not exist was the
//! twenty lines between them: the gateway accepted a seat, logged that the
//! replica plane was elsewhere, and dropped the connection.
//!
//! It was held up by a belief that turned out to be false. `run.rs` recorded
//! that `Vault` "carries boxed `Clock` and `Ids` trait objects that are not
//! `Send`", so nothing vault-shaped could move into a `tokio::spawn`. Both
//! traits are declared `Send + Sync` (`crates/vault/src/clock.rs:19`, `:197`),
//! `Vault` is `Send`, and `Handle` is `Send + Sync`. A compile-time probe says
//! so; this module is what the truth buys.
//!
//! ## ONLY THE LOG IS SERVED, and the refusal is by name
//!
//! `Handle::call` answers `Hello`, `Page`, `ContentUrls`, `Command` and more.
//! A replica needs exactly one of them. The others are the THIN-SEAT plane,
//! where every call is made under the caller's principal — and this lane has no
//! principal to make it under: `accept` proved the device is enrolled, which is
//! a statement about the DEVICE and not about a member. Forwarding a `Command`
//! here would be a write to the authority attributed to nobody.
//!
//! So the match is an allowlist, not a filter, and anything else comes back
//! `UNSUPPORTED` with a sentence naming the plane that owns it. A lane that
//! quietly served a `Command` because the code path happened to reach is the
//! shape of defect this refusal exists to make impossible.
//!
//! ## THE CONNECTION IS HELD FOR THE LENGTH OF THE TASK
//!
//! A QUIC close discards whatever the peer has not read, so answering and
//! moving on would close the connection under the seat's own read. The loop
//! ends when the seat stops asking, and the connection lives until it does —
//! the same ordering rule `crates/net/tests/pair_and_stream.rs` states.

use std::sync::Arc;

use centraid_api_proto::core_v1::{self as core, envelope, request};
use centraid_core::Handle;
use centraid_protocol::version::local_hello;
use centraid_protocol::wire::{read_envelope, write_envelope};
use tokio::io::AsyncWriteExt as _;

/// What this gateway tells a seat it can do. `replica` is the log lane; it is
/// deliberately not `commands`, and a seat that needs one reads the absence.
const CAPABILITIES: &[&str] = &["replica"];

/// How the lane stopped, for one log line at the call site.
pub enum Ended {
    /// The seat closed, or the stream ended. The ordinary exit.
    PeerClosed { pages: usize, rows: usize },
    /// The lane itself failed. The connection is gone either way.
    Failed(String),
}

/// Serve one admitted seat until it stops asking.
///
/// `handle` is shared because a gateway may hold several seats at once and they
/// all read one vault; `Handle` serialises its own access behind a mutex, which
/// is what makes that safe to say in one line.
pub async fn serve(
    connection: &impl centraid_protocol::Connection,
    handle: Arc<Handle>,
    product_version: &str,
) -> Ended {
    let (mut send, mut recv) = match connection.accept_bi().await {
        Ok(pair) => pair,
        Err(error) => return Ended::Failed(format!("the seat opened no stream: {error}")),
    };

    // THE WINDOW, BEFORE ANY ROW. A seat whose schema this gateway cannot serve
    // must learn it from the handshake and not from a page it cannot apply.
    if let Err(error) = centraid_protocol::handshake::accept(
        &mut send,
        &mut recv,
        &local_hello(product_version, CAPABILITIES),
    )
    .await
    {
        return Ended::Failed(format!("the version window refused the seat: {error}"));
    }

    let mut pages = 0usize;
    let mut rows = 0usize;
    loop {
        let asked = match read_envelope(&mut recv).await {
            Ok(Some(envelope)) => envelope,
            // The seat went away. That is how this loop is SUPPOSED to end.
            Ok(None) => return Ended::PeerClosed { pages, rows },
            Err(error) => return Ended::Failed(format!("reading the seat's request: {error}")),
        };
        let request_id = asked.request_id;
        let answer = match asked.body {
            Some(envelope::Body::Request(core::Request {
                kind: Some(request::Kind::Log(log)),
            })) => {
                let handle = Arc::clone(&handle);
                let request = core::Request {
                    kind: Some(request::Kind::Log(log)),
                };
                // OFF THE REACTOR. `Handle::call` reads SQLite and a blocking
                // read on an async worker starves every other lane this
                // gateway is serving.
                let called = tokio::task::spawn_blocking(move || handle.call(&request)).await;
                match called {
                    Ok(Ok(response)) => {
                        if let Some(core::response::Kind::Log(page)) = &response.kind {
                            pages += 1;
                            rows += page.rows.len();
                        }
                        centraid_protocol::wire::response(request_id, response)
                    }
                    Ok(Err(failure)) => {
                        centraid_protocol::wire::error(request_id, failure.to_wire())
                    }
                    Err(joined) => {
                        return Ended::Failed(format!("the log read did not finish: {joined}"));
                    }
                }
            }
            // EVERYTHING ELSE, BY NAME. See the module header: this lane has an
            // enrolled device and no principal, so it serves the log and
            // nothing that could be attributed to a member.
            other => centraid_protocol::wire::error(
                request_id,
                core::Error {
                    code: core::ErrorCode::UnsupportedMessage as i32,
                    detail: format!(
                        "the seat lane serves LogRequest only; got {}",
                        shape_of(other.as_ref())
                    ),
                    diagnostic_id: String::new(),
                    sentence: "This gateway can send changes to this device and nothing else yet."
                        .to_owned(),
                },
            ),
        };
        if let Err(error) = write_envelope(&mut send, &answer).await {
            return Ended::Failed(format!("answering the seat: {error}"));
        }
        if let Err(error) = send.flush().await {
            return Ended::Failed(format!("flushing the seat's answer: {error}"));
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
