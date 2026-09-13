//! The gateway connection, as the seat's sync loop sees it (#1020, D-1020-B6).
//!
//! `crates/seat`'s [`pass`](centraid_seat::sync::pass) is written over two
//! traits so that `crates/sim` can drive it over turmoil and a real phone can
//! drive it over QUIC. `crates/sim` had the only implementation; this is the
//! other one, and it is why the loop was production code rather than a test
//! driver.
//!
//! ## One stream, opened once
//!
//! `seat_lane::serve` on the gateway calls `accept_bi()` a single time and then
//! loops reading envelopes off that stream. So the seat opens one bidirectional
//! stream, handshakes on it, and reuses it for every request in the window. A
//! client that opened a stream per request would hang on the second one with no
//! error on either side — the gateway is not accepting another.
//!
//! ## The intent sink is honest about being shut
//!
//! The gateway's seat lane serves `LogRequest` and refuses everything else by
//! name, because `accept` proves the DEVICE is enrolled and says nothing about
//! a member (D-1020-D2A). So [`GatewayLink`] reports intents as `Unavailable`
//! with that reason rather than pretending to submit. A seat whose sink is
//! unavailable is *blocked*: its writes stay in the outbox, the badge says so,
//! and nothing is lost. Faking a success here would drop a member's write.

use centraid_api_proto::core_v1 as core;
use centraid_net::IrohConnection;
use centraid_protocol::Connection as _;
use centraid_protocol::version::local_hello;
use centraid_protocol::wire::{read_envelope, write_envelope};
use centraid_seat::sync::{FetchOutcome, FetchedPage, IntentSink, LogSource, SubmitOutcome};
use tokio::io::AsyncWriteExt as _;

/// What this seat tells a gateway it can do.
const CAPABILITIES: &[&str] = &["replica"];

/// A live seat-lane connection, ready to be asked for pages.
pub struct GatewayLink {
    send: <IrohConnection as centraid_protocol::Connection>::Send,
    recv: <IrohConnection as centraid_protocol::Connection>::Recv,
    request_id: u64,
}

impl GatewayLink {
    /// Open the stream and complete the version handshake.
    ///
    /// The connection must already be on `alpn::SEAT`; admission happened when
    /// the gateway accepted it.
    pub async fn open(connection: &IrohConnection, product_version: &str) -> Result<Self, String> {
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|error| format!("the seat lane's stream would not open: {error}"))?;
        centraid_protocol::handshake::dial(
            &mut send,
            &mut recv,
            &local_hello(product_version, CAPABILITIES),
        )
        .await
        .map_err(|error| format!("the version window refused this seat: {error:?}"))?;
        send.flush()
            .await
            .map_err(|error| format!("the handshake would not flush: {error}"))?;
        Ok(Self {
            send,
            recv,
            request_id: 0,
        })
    }

    async fn exchange(&mut self, request: core::Request) -> Result<core::Envelope, String> {
        self.request_id += 1;
        let asked = centraid_protocol::wire::request(self.request_id, request);
        write_envelope(&mut self.send, &asked)
            .await
            .map_err(|error| format!("the request would not write: {error}"))?;
        self.send
            .flush()
            .await
            .map_err(|error| format!("the request would not flush: {error}"))?;
        match read_envelope(&mut self.recv).await {
            Ok(Some(envelope)) => Ok(envelope),
            // THE GATEWAY CLOSED. Not an error to escalate: a window ending is
            // the normal shape of a seat's life, and the next pass opens a new
            // connection.
            Ok(None) => Err("the gateway closed the connection".to_owned()),
            Err(error) => Err(format!("an unreadable answer: {error}")),
        }
    }
}

impl LogSource for GatewayLink {
    fn fetch<'a>(
        &'a mut self,
        _epoch: &'a str,
        since: i64,
        limit: i64,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = FetchOutcome> + 'a>> {
        Box::pin(async move {
            // `since <= 0` means "from the floor" and is sent as ABSENT, not as
            // a zero cursor: `LogRequest.since` is optional and a gateway reads
            // a present cursor as a resume point. A seat with nothing applied
            // that sent `seq: 0` would be asking to resume from a seq that
            // never existed.
            let cursor = (since > 0).then(|| core::LogCursor {
                epoch: _epoch.to_owned(),
                seq: u64::try_from(since).unwrap_or(0),
            });
            let request = core::Request {
                kind: Some(core::request::Kind::Log(core::LogRequest {
                    since: cursor,
                    limit: u32::try_from(limit).unwrap_or(u32::MAX),
                })),
            };
            match self.exchange(request).await {
                Ok(envelope) => decode_page(envelope),
                Err(reason) => FetchOutcome::Unavailable(reason),
            }
        })
    }
}

impl IntentSink for GatewayLink {
    fn submit<'a>(
        &'a mut self,
        _record: &'a centraid_seat::IntentRecord,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = SubmitOutcome> + 'a>> {
        // NOT A LIE AND NOT A PANIC. The gateway's seat lane has no principal
        // to attribute an intent to yet (D-1020-D2A), so this reports the sink
        // as down. The outbox keeps the write, the attempt count rises, and the
        // member's badge says writes are queued — which is true.
        Box::pin(async move {
            SubmitOutcome::Unavailable(
                "this gateway serves changes and does not yet accept writes from a seat".to_owned(),
            )
        })
    }
}

/// Read a page, a re-bootstrap or a refusal out of one answer.
///
/// Carried from `crates/sim`'s `decode_page` because it is the same wire and
/// the same three outcomes; the simulation's copy stays where it is so a change
/// to one is visible as a divergence from the other rather than as a silent
/// shared edit.
fn decode_page(envelope: core::Envelope) -> FetchOutcome {
    match envelope.body {
        Some(core::envelope::Body::Response(core::Response {
            kind: Some(core::response::Kind::Log(page)),
        })) => {
            let header = centraid_seat::applier::PageHeader {
                epoch: page.epoch.clone(),
                schema_epoch: i64::from(page.schema_epoch),
                ddl_version: i64::from(page.ddl_version),
                watermark: i64::try_from(page.watermark).unwrap_or(i64::MAX),
            };
            let rows = page
                .rows
                .iter()
                .map(|row| centraid_core::convert::log_row_from_wire(row, &page.epoch))
                .collect::<Result<Vec<_>, _>>();
            match rows {
                Ok(rows) => FetchOutcome::Page(FetchedPage {
                    header,
                    rows,
                    has_more: page.has_more,
                    next: i64::try_from(page.next).unwrap_or(i64::MAX),
                }),
                Err(error) => FetchOutcome::Unavailable(format!("an unreadable page: {error}")),
            }
        }
        Some(core::envelope::Body::Response(core::Response {
            kind: Some(core::response::Kind::RebootstrapRequired(required)),
        })) => FetchOutcome::RebootstrapRequired {
            reason: rebootstrap_from_wire(required.reason),
            epoch: required.epoch,
            floor: i64::try_from(required.floor).unwrap_or(0),
            watermark: i64::try_from(required.watermark).unwrap_or(0),
        },
        // `Error.detail` is logs-only and must never reach a member. This value
        // travels into `PassReport::stale`, which a shell turns into its own
        // sentence; the detail is here for a log line and a `doctor` run.
        Some(core::envelope::Body::Error(error)) => {
            FetchOutcome::Unavailable(format!("the gateway refused: {}", error.detail))
        }
        _ => FetchOutcome::Unavailable("an answer that was not a page".to_owned()),
    }
}

fn rebootstrap_from_wire(reason: i32) -> centraid_vault::RebootstrapReason {
    use centraid_vault::RebootstrapReason as R;
    match core::RebootstrapReason::try_from(reason) {
        Ok(core::RebootstrapReason::EpochMismatch) => R::EpochMismatch,
        Ok(core::RebootstrapReason::Retention) => R::Retention,
        Ok(core::RebootstrapReason::CursorAhead) => R::CursorAhead,
        Ok(core::RebootstrapReason::Initial) => R::Initial,
        // EVERY REASON A READER DOES NOT KNOW NORMALISES TO `InvalidCursor`, as
        // v0's door does and as `crates/sim` does: no raw error text reaches a
        // peer, and a wire enum this build predates must still produce a
        // re-bootstrap rather than a guess at which kind.
        _ => R::InvalidCursor,
    }
}
