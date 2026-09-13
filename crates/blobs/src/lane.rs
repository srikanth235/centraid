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
//! ## Admission happened before this module was reached
//!
//! [`serve`] takes a connection that `centraid_net::Endpoint::accept` has
//! already matched against the allowlist on the `centraid/v1/byte` ALPN. There
//! is no second check here and there must not be one: two admission rules is
//! how two admission rules disagree. What this module adds on top is the
//! provider's own refusal of anything that is not a plain blob request, which
//! is a FRAMING rule rather than an authority one.

use iroh_blobs::BlobsProtocol;
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

/// Serve the byte lane to one admitted seat, for the length of the connection.
///
/// Returns when the peer closes or the connection fails. The caller spawns one
/// of these per accepted connection.
///
/// The `events` gate refuses anything that is not a request for a single blob.
/// A hash sequence would let one request pull a whole collection the seat never
/// named, and this lane's contract is that the seat asks for a blob at a time
/// so the GATEWAY never decides how much of a member's vault crosses a metered
/// link in one go.
pub async fn serve(store: &ByteStore, connection: iroh::endpoint::Connection) {
    let protocol = BlobsProtocol::new(store.inner(), Some(single_blobs_only()));
    // `ProtocolHandler::accept` drives the whole connection. Its `Err` is a
    // connection-level fault and never an authority one — admission was decided
    // before this function was called — so it is logged and not returned.
    if let Err(error) = iroh::protocol::ProtocolHandler::accept(&protocol, connection).await {
        tracing::debug!("the byte lane ended: {error}");
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

/// Fetch as much of `hash` as this window allows, from a peer already dialled
/// on the byte lane.
///
/// Never re-fetches a byte this device already holds, and never fails because
/// an earlier attempt was interrupted. A window that ends mid-blob returns
/// `Ok` with `complete: false`; the chunks it landed are durable and verified,
/// and the next call continues from them.
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

    // STEP 3 — ask for the difference and nothing else.
    let stats = remote
        .execute_get(connection.clone(), missing)
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
