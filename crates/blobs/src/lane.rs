//! The byte lane: the gateway's serving half and the seat's fetching half
//! (#1020, D-1020-B1).
//!
//! ## The law this lane exists to keep
//!
//! **Every window of any length makes durable, verified progress, and nothing
//! is ever redone.**
//!
//! It is one sentence and it is the whole mobile design. A phone gets windows
//! it does not choose and cannot extend: iOS hands `BGAppRefreshTask` about
//! thirty seconds at a time of its own choosing, Android defers a periodic
//! worker into whatever Doze decides. A byte plane that needs an unbroken
//! window never moves a video at all, and no amount of scheduling cleverness
//! fixes that — the fix has to be in the transfer.
//!
//! [`fetch`] keeps the law in three steps, and each one is a line you can point
//! at:
//!
//! 1. ask the local store what it already holds ([`Remote::local`]),
//! 2. subtract that from what was wanted ([`LocalInfo::missing`]),
//! 3. ask the peer for the difference and nothing else.
//!
//! Step 2 is set subtraction over chunk ranges, not a byte offset, so it is
//! correct even when the held chunks are not a prefix — which is the normal
//! outcome of a transfer that was cut and retried against a peer serving ranges
//! in its own order. And because every arriving chunk group is verified against
//! the root hash through its bao outboard, step 1's answer is *proven* bytes
//! rather than bytes some earlier peer asserted. Resumption therefore involves
//! no trust in the interrupted transfer at all.
//!
//! ## Why the gateway holds a provider and the seat holds a fetcher
//!
//! Both halves are here, but they are not symmetric and the asymmetry is
//! deliberate. The gateway is always on, has the disk and the power, and holds
//! every blob; the seat is asleep, metered, and holds what it needs. So the
//! seat DIALS — it is the side that knows when it is awake, and it is the side
//! behind the worse NAT — and the gateway serves what it is asked for.
//!
//! ## ONE STREAM PER BLOB REQUEST, ON THE ONE ALPN (#1025 S2)
//!
//! There is no byte lane any more, and no `centraid/v1/byte` to dial. A blob
//! moves on a bidirectional stream of the vault's single connection whose FIRST
//! FRAME is a `Request{blob}` envelope; everything after that frame is
//! iroh-blobs' own get/provide protocol, verbatim. [`serve_stream`] hands the
//! remainder to `iroh_blobs::provider::handle_stream` and [`fetch`] drives
//! `execute_get` over a `get::StreamPair` built from the stream it opened and
//! tagged — so neither side reimplements bao, and neither side needs a second
//! dial, a second admission rule, or a second accept arm.
//!
//! The connection-level `serve` this replaces drove `ProtocolHandler::accept`,
//! which owns the whole connection and loops on `accept_bi` itself. That is
//! correct for an endpoint whose only business is blobs and wrong for ours:
//! it would swallow the log and intent streams riding the same connection.
//!
//! ## Admission happened before this module was reached
//!
//! Both functions take streams of a connection that
//! `centraid_net::Endpoint::accept` has already matched against the allowlist
//! on `centraid/v1/seat`. There is no second check here and there must not be
//! one: two admission rules is how two admission rules disagree. What this
//! module adds on top is the provider's own refusal of anything that is not a
//! plain blob request, which is a FRAMING rule rather than an authority one.

use iroh_blobs::provider::events::{
    AbortReason, EventMask, EventSender, ProviderMessage, RequestMode,
};

use crate::hash::ContentHash;
use crate::store::ByteStore;

#[derive(Debug, thiserror::Error)]
pub enum LaneError {
    #[error("the byte lane could not read what this device holds of {hash}: {detail}")]
    Local { hash: ContentHash, detail: String },
    #[error("the byte lane could not fetch {hash}: {detail}")]
    Transfer { hash: ContentHash, detail: String },
}

pub type Result<T> = std::result::Result<T, LaneError>;

/// What one window of fetching achieved.
///
/// `held_before` and `moved` are separate numbers rather than one total because
/// the interesting claim is about their relationship: a resumed fetch has
/// `held_before > 0` and `moved` no larger than what was outstanding. A single
/// "bytes transferred" figure cannot distinguish a resumption from a restart,
/// which is the one thing anyone reading this report wants to know.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FetchReport {
    pub hash: ContentHash,
    /// Verified bytes this device already held when the window opened.
    pub held_before: u64,
    /// Payload bytes that crossed the wire in this window. **Zero when the blob
    /// was already complete** — an already-held blob costs no transfer, and a
    /// caller can rely on that rather than guarding every call.
    pub moved: u64,
    /// Whether the blob is now whole. `false` is an ordinary outcome: the
    /// window closed, the chunks that arrived are kept, and the next window
    /// continues from here.
    pub complete: bool,
}

/// Serve ONE `blob` stream, whose first frame has already been read.
///
/// `connection_id` is the connection's stable id; it only ever reaches a log
/// line and iroh-blobs' own progress events, and passing it keeps two streams
/// of one connection attributable to that connection.
///
/// Returns when the transfer ends, one way or the other. A failure here is a
/// STREAM-level fault and never an authority one — admission was decided
/// before this function was called — so it is logged and the connection lives
/// on, which is the point of serving per stream rather than per connection.
pub async fn serve_stream(
    store: &ByteStore,
    connection_id: u64,
    send: iroh::endpoint::SendStream,
    recv: iroh::endpoint::RecvStream,
) {
    // THE READER GOES FIRST in `StreamPair::new`'s argument list, and the one
    // that follows the one-frame handover is the reader. Swapping them compiles
    // and deadlocks.
    let pair =
        iroh_blobs::provider::StreamPair::new(connection_id, recv, send, single_blobs_only());
    if let Err(error) =
        iroh_blobs::provider::handle_stream(pair, store.inner().clone().into()).await
    {
        // WARN, NOT DEBUG (#1025 S5). This was `debug!`, and it is the ONLY
        // place the serving side says why it refused a blob — so a gateway that
        // reset every photograph's stream with `ERR_INTERNAL` (iroh-blobs'
        // code 3: a `HandleGetError`, usually the store failing to export a
        // blob's bao) said nothing at all, and the seat's own report could only
        // repeat the QUIC error it saw. A device spent a scenario run on that.
        //
        // A serving failure is a STREAM-level fault and the connection lives;
        // what it is not is unremarkable, because every one of these is a blob
        // a member asked for and did not get.
        tracing::warn!(connection = connection_id, %error, "a blob stream ended early");
    }
}

/// Refuse everything except a request for one whole-or-partial blob.
fn single_blobs_only() -> EventSender {
    let mask = EventMask {
        get: RequestMode::Intercept,
        ..EventMask::DEFAULT
    };
    let (sender, mut receiver) = EventSender::channel(32, mask);
    tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            if let ProviderMessage::GetRequestReceived(message) = message {
                let verdict = if message.request.ranges.is_blob() {
                    Ok(())
                } else {
                    // A HashSeq. Not an attack necessarily — it is what a
                    // collection download looks like — but this lane has no
                    // collections, so serving one would serve something no
                    // caller here can have meant.
                    tracing::warn!("the byte lane refused a non-blob request");
                    Err(AbortReason::Permission)
                };
                message.tx.send(verdict).await.ok();
            }
        }
    });
    sender
}

/// Fetch as much of `hash` as this window allows, over a stream of the vault's
/// one connection.
///
/// Never re-fetches a byte this device already holds, and never fails because
/// an earlier attempt was interrupted. A window that ends mid-blob returns
/// `Ok` with `complete: false`; the chunks it landed are durable and verified,
/// and the next call continues from them.
///
/// **The stream is opened here, tagged here, and handed to iroh-blobs here**
/// (#1025 S2). One `blob` stream per call, so a fetch cut mid-transfer costs
/// that stream and nothing else on the connection — the log page in flight
/// beside it is untouched.
pub async fn fetch(
    store: &ByteStore,
    connection: &iroh::endpoint::Connection,
    hash: ContentHash,
) -> Result<FetchReport> {
    let remote = store.inner().remote();

    // STEP 1 — what is already proven to be here.
    let local = remote.local(hash).await.map_err(|error| LaneError::Local {
        hash,
        detail: error.to_string(),
    })?;
    let held_before = local.local_bytes();

    // An already-complete blob costs nothing. Checked before the request is
    // built because `missing()` on a complete blob is an empty request, and an
    // empty request is a round trip that asks for no bytes — cheap, but not
    // free, and a seat with a thousand held blobs would pay it a thousand times
    // per pass.
    if local.is_complete() {
        return Ok(FetchReport {
            hash,
            held_before,
            moved: 0,
            complete: true,
        });
    }

    // STEP 2 — subtract. Chunk ranges, not an offset: held chunks need not be a
    // prefix, and an offset would silently re-fetch everything before the first
    // gap.
    let missing = local.missing();

    // STEP 3 — ask for the difference and nothing else, on a stream that says
    // what it is before it says anything else.
    let pair = open_blob_stream(connection)
        .await
        .map_err(|detail| LaneError::Transfer { hash, detail })?;
    let stats = remote
        .execute_get(pair, missing)
        .complete()
        .await
        .map_err(|error| LaneError::Transfer {
            hash,
            detail: error.to_string(),
        })?;

    let complete = store
        .is_complete(hash)
        .await
        .map_err(|error| LaneError::Local {
            hash,
            detail: error.to_string(),
        })?;
    Ok(FetchReport {
        hash,
        held_before,
        moved: stats.payload_bytes_read,
        complete,
    })
}

/// Open a stream and tag it `blob`, leaving it positioned for iroh-blobs.
///
/// The envelope is FLUSHED before the pair is handed over. iroh-blobs writes
/// its own request next and reads the answer; a tag still sitting in a buffer
/// behind that request would reach the provider after it — which is to say,
/// never, because the provider is blocked reading the tag.
async fn open_blob_stream(
    connection: &iroh::endpoint::Connection,
) -> std::result::Result<iroh_blobs::get::StreamPair, String> {
    use tokio::io::AsyncWriteExt as _;

    let (mut send, recv) = connection
        .open_bi()
        .await
        .map_err(|error| format!("a blob stream would not open: {error}"))?;
    let envelope = centraid_protocol::wire::request(
        BLOB_REQUEST_ID,
        centraid_api_proto::core_v1::Request {
            kind: Some(centraid_api_proto::core_v1::request::Kind::Blob(
                centraid_api_proto::core_v1::BlobRequest {},
            )),
        },
    );
    centraid_protocol::wire::write_envelope(&mut send, &envelope)
        .await
        .map_err(|error| format!("a blob stream would not be tagged: {error}"))?;
    send.flush()
        .await
        .map_err(|error| format!("a blob stream's tag would not flush: {error}"))?;
    Ok(iroh_blobs::get::StreamPair::new(
        connection.stable_id() as u64,
        recv,
        send,
    ))
}

/// The request id a `blob` stream's one envelope carries.
///
/// ONE, NOT ZERO. Zero is the handshake's reserved id and an envelope reader
/// refuses it anywhere else; any other value would do, and a constant is what
/// stops it being a counter nobody reads — the tag is answered by the transfer
/// itself, so there is no response to correlate.
const BLOB_REQUEST_ID: u64 = 1;
