//! THE ONE PLANE: what a gateway says to an admitted replica (#1020 lane D2,
//! rebuilt by #1025 S2).
//!
//! ## ONE CONNECTION PER VAULT, ONE STREAM PER REQUEST
//!
//! A device dials once, on `centraid/v1` — the one ALPN — and
//! `centraid_net::Endpoint::accept` decides enrolment once for that connection.
//! Everything after that is streams: the device opens one per request, its
//! **first frame is a `Request` envelope naming the kind**, and the accepting
//! side reads that frame before it decides how to read the rest.
//!
//! | First frame | What the stream is |
//! | --- | --- |
//! | `pair` | a ticket redemption. The only kind a PROVISIONAL connection may carry |
//! | `log` | a page of the log since a cursor — or, with `tail`, every page after it too |
//! | `intent` | a write, run here, answered with its commit position |
//! | `snapshot_head` | the current bootstrap blob's address and seq |
//! | `blob` | the rest of the stream is iroh-blobs', verbatim |
//!
//! ## A `log` STREAM MAY STAY OPEN (#1025 S2, D-1025-S7-40)
//!
//! `LogRequest.tail` asks this gateway to serve the catch-up pages from the
//! seat's cursor exactly as it always has — following `has_more` — and then to
//! KEEP THE STREAM OPEN, writing a further `LogPage` every time this vault's
//! watermark moves past what it last sent. One page per COMMIT BATCH and never
//! one per row: the wake carries no payload, so the reader asks the log door
//! where the watermark is and writes whatever is there.
//!
//! No new message types, and none are needed: a tail is the same answer, more
//! than once. `RebootstrapRequired` ends it exactly as it ends a one-shot
//! request.
//!
//! A seat holds at most ONE tail per vault and a second from the same device
//! replaces the first ([`crate::tails`]). Presence falls out of the registry
//! and stops at a log line — see that module's header for why it is not on the
//! wire.
//!
//! ## TWO STATES, AND A CONNECTION IS PROMOTED IN PLACE (#1025 S3, D-1025-S3-4)
//!
//! `accept` looks the peer key up once and the answer is a STATE:
//!
//! - **Promoted** — an enrolled, unrevoked device. The loop below, every kind.
//! - **Provisional** — everybody else, which is every device the first time it
//!   knocks. **Exactly one stream**, under [`PROVISIONAL_FRAME_CAP`] and
//!   [`PROVISIONAL_DEADLINE`], and the only kind it may carry is `pair`.
//!   Anything else closes the CONNECTION by name — not just the stream, because
//!   a stranger that asked for a log page has already told us what it is.
//!
//! A successful redemption promotes that same connection **in place**: the loop
//! below simply starts, carrying the device the redemption just enrolled. So a
//! phone goes pair → snapshot_head → bootstrap → log on one dial, in one
//! window, instead of paying a second QUIC setup and a second hole-punch in the
//! middle of the one screen a member is watching.
//!
//! This replaces the second ALPN, `centraid/v1/pair` (superseding
//! D-1025-S2-1). The argument for keeping it was that folding pairing into the
//! plane would move the enrolment check to every stream. It does not: the check
//! is still one lookup, still at accept, still for the connection's whole life.
//! What moved is where the check's ANSWER is expressed — from a TLS label to a
//! state on the accepted connection.
//!
//! This replaces `accept_bi`-once-and-loop-on-that-stream, which was the shape
//! that made the intent sink impossible: a seat opening a second stream for
//! writes waited for an accept that never came — no error, no close, no end
//! (D-1020-B6, and the hour it cost). The fix was never to keep the sink shut;
//! it was to accept more than one stream. It also replaces the second ALPN: a
//! blob no longer needs its own dial, because a stream can say what it is.
//!
//! ## THE LOOP IS SYMMETRIC, AND THE GATEWAY PULLS (#1025 S3)
//!
//! Both sides loop on `accept_bi` and both sides may open streams. **A photo
//! minted on a phone reaches the gateway because the GATEWAY fetches it**, on a
//! `blob` stream of the connection the seat opened, before the intent that
//! names it executes. That is the only shape that works: the phone is behind
//! the worse NAT and is the side that knows when it is awake.
//!
//! Bytes commit after rows, and never only on a phone. So an `intent` stream
//! here is three steps and their order is the contract:
//!
//! 1. the intent's DECLARED bytes are read out of it, through the payload-hash
//!    gate (`centraid_core::intent::needed_bytes`) — a declaration nobody
//!    verified is a list of things an attacker chose for this gateway to fetch;
//! 2. every one this gateway does not already hold is pulled and staged;
//! 3. only then is the intent executed and the content row committed.
//!
//! A pull that does not finish — the phone went out of range, the window
//! closed — answers `ERROR_CODE_BYTES_NOT_YET_HELD`, which the seat reads as
//! "this attempt did not land" and leaves the write in its outbox. Not
//! executed, not failed: RETRYABLE. The alternative is a `core_content_item`
//! on the gateway naming bytes nobody has.
//!
//! ## A MALFORMED FRAME COSTS ITS STREAM AND NOTHING ELSE
//!
//! `crates/protocol`'s framing rule is that a malformed frame ends the
//! connection, because the stream's position is no longer known and there is
//! nothing to resynchronise to. That is still true — of the STREAM. With one
//! stream per request the blast radius is one request: the stream is dropped,
//! the connection lives, and the pages in flight beside it are untouched.
//!
//! ## THE REFUSAL IS BY NAME, AND `Command` IS STILL NOT SERVED
//!
//! `accept` proved the DEVICE is enrolled. That is a statement about a device,
//! and for an INTENT it is enough — an intent carries its own idempotency key
//! and is run under the device's principal, which is exactly what
//! [`centraid_core::Handle::submit_intent`] requires. A `Command` is different:
//! it is the thin-seat plane's forwarding, whose principal is the CALLER's and
//! not the device's, and it stays refused by name until S6 carries one.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use centraid_api_proto::core_v1::{self as core, envelope, request};
use centraid_core::Handle;
use centraid_net::{IrohConnection, RawRecv, RawSend};
use centraid_protocol::Connection as _;
use centraid_protocol::version::local_hello;
use centraid_protocol::wire::{read_envelope, write_envelope};
use tokio::io::AsyncWriteExt as _;

/// What this gateway tells a seat it can do.
///
/// `writes` is new in #1025 S2 and it is load-bearing rather than decorative: a
/// seat reads the absence of a capability to decide whether to bother
/// submitting, and this gateway now accepts intents. `commands` is still
/// absent, because the thin-seat plane is not here.
const CAPABILITIES: &[&str] = &["replica", "writes"];

/// The most bytes a PROVISIONAL connection's one frame may be.
///
/// A `pair` request is a ticket id, a 32-byte secret, a device name and a
/// platform string. Two kilobytes is generous for that and refuses to let a
/// stranger decide how much this process allocates — the general frame ceiling
/// is right for a log page and wrong for a peer we have never enrolled.
pub const PROVISIONAL_FRAME_CAP: usize = 2 * 1024;

/// How long a PROVISIONAL connection has to open its one stream and say what it
/// is.
///
/// A member is holding a phone at a QR code, so the whole exchange is one round
/// trip and a few hundred bytes. Five seconds is long enough for a relay path
/// on a bad network and short enough that a connection which opens and says
/// nothing cannot hold a task. A stranger that stalls costs this gateway a
/// timeout, once.
pub const PROVISIONAL_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// What a gateway needs to answer a redemption.
///
/// Carried apart from [`Lane`] because it is read exactly once, before the loop,
/// and nothing in a promoted connection's life touches it.
pub struct Pairing<S> {
    pub allowlist: Arc<S>,
    /// What this gateway tells a redeeming device about itself. Owned here and
    /// borrowed into `VaultIdentity` at the call, because the task that serves
    /// a connection outlives the accept-loop iteration that built it.
    pub vault_id: String,
    pub vault_name: String,
    pub gateway_address: String,
    /// This gateway's own endpoint, for the dialling hints a `PairOk` carries.
    ///
    /// The ENDPOINT and not the hints, because reading them is an `await` and
    /// the accept loop is one task: awaiting there stalls every other device
    /// trying to connect, which the walking skeleton caught as "the gateway did
    /// not answer the pairing request" on a gateway that was answering fine.
    pub endpoint: centraid_net::endpoint::Endpoint,
}

/// Everything one accepted seat connection is served from.
#[derive(Clone)]
pub struct Lane {
    pub handle: Arc<Handle>,
    pub snapshots: Option<crate::snapshots::Snapshots>,
    /// The vault's byte store. `None` is a gateway that can serve rows and not
    /// files, which shows up as photographs that have not arrived rather than
    /// as a gateway that will not start.
    pub blobs: Option<centraid_blobs::ByteStore>,
    /// THE ENROLLED DEVICE THIS CONNECTION WAS ADMITTED AS. Resolved at
    /// `accept` — or by the redemption that promoted this connection — and
    /// carried here; an intent is run under it and it is never read off a
    /// request, because a request field naming a device would let one seat
    /// submit as another.
    ///
    /// **Empty means PROVISIONAL**, which is the one state in which no request
    /// kind but `pair` is served.
    pub device_id: String,
    /// THE WAKE A TAILING STREAM PARKS ON (#1025 S2, D-1025-S7-40).
    pub commits: crate::tails::Commits,
    /// WHO IS HOLDING A TAIL. One per device, and the second replaces the first.
    pub tails: crate::tails::Tails,
}

/// How the lane stopped, for one log line at the call site.
pub enum Ended {
    /// The seat closed, or stopped opening streams. The ordinary exit.
    PeerClosed { streams: usize, rows: usize },
    /// The lane itself failed before it could serve anything.
    Failed(String),
    /// A PROVISIONAL connection that did not redeem a ticket (#1025 S3). Its
    /// own variant because it is not a fault of this gateway and not a seat
    /// closing a good window: it is a stranger, and the log line for a stranger
    /// is different from the log line for a device.
    Unredeemed(String),
}

/// Serve one admitted seat until it stops asking.
///
/// `handle` is shared because a gateway may hold several seats at once and they
/// all read one vault; `Handle` serialises its own access behind a mutex, which
/// is what makes that safe to say in one line.
pub async fn serve<S>(
    connection: &IrohConnection,
    mut lane: Lane,
    product_version: &str,
    pairing: &Pairing<S>,
) -> Ended
where
    S: centraid_net::allowlist::AllowlistStore,
{
    // THE PROVISIONAL HALF (#1025 S3, D-1025-S3-4). An empty `device_id` is a
    // peer `accept` could not find in the allowlist: one stream, one frame, one
    // kind. A redemption promotes this connection in place and the loop below
    // runs on it; anything else ends here.
    if lane.device_id.is_empty() {
        match redeem_in_place(connection, pairing, &lane).await {
            Ok(device_id) => lane.device_id = device_id,
            Err(why) => return Ended::Unredeemed(why),
        }
    }

    // THE VERSION WINDOW, ON THE CONNECTION'S FIRST STREAM, BEFORE ANY ROW. A
    // seat whose schema this gateway cannot serve must learn it from the
    // handshake and not from a page it cannot apply — so the first stream is
    // required to be the handshake, and nothing else is accepted until it has
    // been answered.
    let (mut send, mut recv) = match connection.accept_bi().await {
        Ok(pair) => pair,
        Err(error) => return Ended::Failed(format!("the seat opened no stream: {error}")),
    };
    if let Err(error) = centraid_protocol::handshake::accept(
        &mut send,
        &mut recv,
        &local_hello(product_version, CAPABILITIES),
    )
    .await
    {
        return Ended::Failed(format!("the version window refused the seat: {error}"));
    }
    if let Err(error) = send.flush().await {
        return Ended::Failed(format!("the version window would not flush: {error}"));
    }
    // The handshake stream is finished rather than held: it has said everything
    // it will ever say, and a stream left open is a stream the seat's own
    // accounting has to keep.
    let _ = send.finish();

    let streams = Arc::new(AtomicUsize::new(0));
    let rows = Arc::new(AtomicUsize::new(0));
    let connection_id = connection.iroh().stable_id() as u64;
    loop {
        // THE SYMMETRIC LOOP. `Ok` is a stream to serve; `Err` is the seat
        // having gone away, which is how this loop is SUPPOSED to end.
        let Ok((send, recv)): centraid_protocol::Result<(RawSend, RawRecv)> =
            connection.accept_bi().await
        else {
            return Ended::PeerClosed {
                streams: streams.load(Ordering::Relaxed),
                rows: rows.load(Ordering::Relaxed),
            };
        };
        streams.fetch_add(1, Ordering::Relaxed);
        let lane = lane.clone();
        let rows = Arc::clone(&rows);
        // A CLONE OF THE CONNECTION, not a borrow: the stream's task outlives
        // this iteration, and the gateway's own pull opens streams on it.
        let connection = connection.clone();
        // ONE TASK PER STREAM. A blob transfer that fills the whole window must
        // not stop the log page the seat asked for beside it, which is the
        // difference between "one stream per request" and "one request at a
        // time".
        tokio::spawn(async move {
            match one_stream(send, recv, &lane, &connection, connection_id).await {
                Ok(applied) => {
                    rows.fetch_add(applied, Ordering::Relaxed);
                }
                // A STREAM-LEVEL FAULT, AND THE CONNECTION LIVES. A malformed
                // first frame lands here; so does a seat that closed a stream
                // mid-request. Neither says anything about the other streams.
                Err(why) => tracing::debug!(%why, "a seat's stream ended"),
            }
        });
    }
}

/// Serve one stream, whose first frame names what it is.
///
/// Returns how many log rows this stream served, which is the only number worth
/// aggregating across a connection.
async fn one_stream(
    mut send: RawSend,
    mut recv: RawRecv,
    lane: &Lane,
    connection: &IrohConnection,
    connection_id: u64,
) -> Result<usize, String> {
    let asked = match read_envelope(&mut recv).await {
        Ok(Some(envelope)) => envelope,
        // A stream opened and closed with nothing on it. Not an error and not
        // worth a log line.
        Ok(None) => return Ok(0),
        // THE REFUSAL THAT MUST NOT COST THE CONNECTION. The frame did not
        // parse, so this stream's position is unknown and there is nothing to
        // answer on it — but the peer is still an enrolled device and its other
        // streams are still readable.
        Err(error) => return Err(format!("an unreadable first frame: {error}")),
    };
    let request_id = asked.request_id;

    // THE HANDOVER, BEFORE ANY ENVELOPE IS WRITTEN BACK. A `blob` stream has no
    // envelope answer: everything after its first frame is iroh-blobs'
    // protocol, and writing one of ours onto the same stream would be the first
    // thing the fetching side tried to parse as a blob response.
    if let Some(envelope::Body::Request(core::Request {
        kind: Some(request::Kind::Blob(_)),
    })) = &asked.body
    {
        let Some(blobs) = lane.blobs.as_ref() else {
            // NOTHING TO SERVE FROM, so the stream is reset rather than left to
            // time out. A fetcher reads that as a transfer that did not happen,
            // which is true, and its next window asks again.
            return Err("this gateway has no byte store".to_owned());
        };
        centraid_blobs::serve_stream(blobs, connection_id, send, recv).await;
        return Ok(0);
    }

    // THE OTHER STREAM WITH NO SINGLE ANSWER (#1025 S2, D-1025-S7-40). A tail
    // writes many envelopes on one stream and ends when the seat goes away, so
    // it cannot go through `answer_for`, which is written around exactly one.
    if let Some(envelope::Body::Request(core::Request {
        kind: Some(request::Kind::Log(log)),
    })) = &asked.body
        && log.tail
    {
        return serve_tail(send, log.clone(), request_id, lane, connection).await;
    }

    let (answer, rows) = answer_for(asked.body, request_id, lane, connection).await?;
    write_envelope(&mut send, &answer)
        .await
        .map_err(|error| format!("answering the seat: {error}"))?;
    send.flush()
        .await
        .map_err(|error| format!("flushing the seat's answer: {error}"))?;
    // ONE REQUEST, ONE ANSWER, ONE STREAM. Finishing says so on the wire; the
    // seat reads its answer and then reads the clean end, which is what tells
    // it there is nothing more coming without a timeout.
    let _ = send.finish();
    Ok(rows)
}

/// SERVE A TAIL: the catch-up, and then every page after it (#1025 S2,
/// D-1025-S7-40).
///
/// The catch-up half is byte-for-byte what a one-shot request gets, because it
/// IS one-shot requests: the same `log_page` read, the same `has_more` loop,
/// the same `RebootstrapRequired`. What changes is that the stream is not
/// finished at the end of it — the loop parks on this vault's commit wake and
/// writes the next page when the watermark moves.
///
/// **A ring is allowed to be spurious.** The wake carries no payload, so a
/// ring that moved nothing costs one indexed read and a page that is not
/// written. Only the FIRST page is written unconditionally: it is what tells
/// the seat its tail is open, and a seat that is already current would
/// otherwise wait for an answer that only a stranger's write could produce.
///
/// It ends on: a re-bootstrap, a refusal, a write that fails because the seat
/// went away, the connection closing, or a second tail from the same device.
/// All of them return here and the stream goes with the task; the seat's cursor
/// is durable at every page boundary, so the next window resumes from it.
async fn serve_tail(
    mut send: RawSend,
    asked: core::LogRequest,
    request_id: u64,
    lane: &Lane,
    connection: &IrohConnection,
) -> Result<usize, String> {
    // REGISTERED BEFORE THE FIRST PAGE, and the registration closes whichever
    // tail this device already had.
    let registered = lane.tails.register(&lane.device_id);
    // SUBSCRIBED BEFORE THE FIRST READ, always. A subscription taken after the
    // page has been read has not seen the commits in between, and would wait
    // for the one AFTER the row it missed.
    let mut commits = lane.commits.subscribe();
    let mut since = asked.since.clone();
    let limit = asked.limit;
    let mut served = 0usize;
    let mut first = true;
    loop {
        let handle = Arc::clone(&lane.handle);
        let request = core::Request {
            kind: Some(request::Kind::Log(core::LogRequest {
                since: since.clone(),
                limit,
                // ONE PAGE AT A TIME, from the door that has always served one.
                // The tail is this LOOP; the door knows nothing about it.
                tail: false,
            })),
        };
        // OFF THE REACTOR, for the reason the one-shot read gives: `Handle::call`
        // reads SQLite, and a blocking read on an async worker starves every
        // other stream this gateway is serving.
        let called = tokio::task::spawn_blocking(move || handle.call(&request))
            .await
            .map_err(|joined| format!("a tail's log read did not finish: {joined}"))?;
        let mut response = match called {
            Ok(response) => response,
            Err(failure) => {
                let refusal = centraid_protocol::wire::error(request_id, failure.to_wire());
                let _ = write_envelope(&mut send, &refusal).await;
                let _ = send.flush().await;
                let _ = send.finish();
                return Ok(served);
            }
        };
        // A RE-BOOTSTRAP ENDS THE STREAM, exactly as it ends a one-shot
        // request. The seat closes its vault, takes a copy and reopens; a tail
        // held across that would be a stream into a file about to be renamed
        // away.
        if let Some(core::response::Kind::RebootstrapRequired(required)) = &mut response.kind {
            if let Some(offer) = current_offer(lane).await {
                required.snapshot_hash = offer.hash.to_hex();
                required.snapshot_seq = u64::try_from(offer.head.seq).unwrap_or(0);
                required.snapshot_bytes = offer.size;
            }
            let answer = centraid_protocol::wire::response(request_id, response);
            let _ = write_envelope(&mut send, &answer).await;
            let _ = send.flush().await;
            let _ = send.finish();
            return Ok(served);
        }
        let Some(core::response::Kind::Log(page)) = response.kind.clone() else {
            return Err("the log door answered a tail with something else".to_owned());
        };
        let has_more = page.has_more;
        let rows = page.rows.len();
        // THE CURSOR THE NEXT READ RESUMES FROM: the page's own `next`, which
        // is the last served seq while `has_more` and the watermark otherwise.
        // Never a seq computed here — the door decides where it got to.
        since = Some(core::LogCursor {
            epoch: page.epoch.clone(),
            seq: page.next,
        });
        if first || rows > 0 {
            let answer = centraid_protocol::wire::response(request_id, response);
            // A WRITE THAT FAILS IS A SEAT THAT WENT AWAY. Not an error worth a
            // warning: a window ending is the normal shape of a seat's life.
            if write_envelope(&mut send, &answer).await.is_err() || send.flush().await.is_err() {
                return Ok(served);
            }
            served += rows;
            tracing::debug!(
                device = %lane.device_id,
                rows,
                next = page.next,
                catching_up = has_more,
                "a tailing seat was served a page"
            );
        }
        first = false;
        if has_more {
            // STILL CATCHING UP. Straight round again — a tail's catch-up is
            // not paced by commits.
            continue;
        }
        // CAUGHT UP, SO PARK. Three ways out, and all of them end the stream.
        tracing::debug!(device = %lane.device_id, next = page.next, "a tail is waiting for the next commit");
        tokio::select! {
            changed = commits.changed() => {
                tracing::debug!(device = %lane.device_id, ok = changed.is_ok(), "a tail woke");
                if changed.is_err() {
                    // The bell is gone, which means this process is shutting
                    // down. Nothing left to tail.
                    return Ok(served);
                }
            }
            () = registered.superseded() => {
                return Ok(served);
            }
            _ = connection.iroh().closed() => {
                return Ok(served);
            }
        }
    }
}

/// Serve a PROVISIONAL connection's one stream, and promote it if it redeems.
///
/// Returns the enrolled device id, or why this connection is not a device's.
///
/// **The refusal closes the CONNECTION, not the stream.** Everywhere else in
/// this file a bad frame costs one stream and the connection lives, because the
/// peer is an enrolled device whose other streams are still that device's. Here
/// the peer is a stranger, and a stranger that opened a `log` stream has said
/// what it is: there is nothing else on this connection worth keeping.
async fn redeem_in_place<S>(
    connection: &IrohConnection,
    pairing: &Pairing<S>,
    lane: &Lane,
) -> Result<String, String>
where
    S: centraid_net::allowlist::AllowlistStore,
{
    let accepted = tokio::time::timeout(PROVISIONAL_DEADLINE, connection.accept_bi()).await;
    let (mut send, mut recv) = match accepted {
        Ok(Ok(pair)) => pair,
        Ok(Err(error)) => return Err(format!("it opened no stream: {error}")),
        Err(_) => return Err("it opened no stream within the pairing deadline".to_owned()),
    };

    // ONE FRAME, CAPPED AND ON THE CLOCK. Both bounds are about a peer this
    // gateway has never enrolled: the cap is how much it may make this process
    // allocate, the deadline is how long it may hold a task.
    let read = tokio::time::timeout(
        PROVISIONAL_DEADLINE,
        centraid_protocol::wire::read_envelope_capped(&mut recv, PROVISIONAL_FRAME_CAP),
    )
    .await;
    let asked = match read {
        Ok(Ok(Some(envelope))) => envelope,
        Ok(Ok(None)) => return Err("it opened a stream and closed it".to_owned()),
        Ok(Err(error)) => return Err(format!("its first frame was unreadable: {error}")),
        Err(_) => return Err("it sent nothing within the pairing deadline".to_owned()),
    };
    let request_id = asked.request_id;
    let Some(envelope::Body::Request(core::Request {
        kind: Some(request::Kind::Pair(asked)),
    })) = asked.body
    else {
        // BY NAME, AND THE CONNECTION GOES. A device that is not enrolled and
        // did not ask to be has nothing else this plane can serve it.
        let refusal = centraid_protocol::wire::error(
            request_id,
            core::Error {
                code: core::ErrorCode::Unauthorized as i32,
                // LOGS ONLY. The sentence beside it is the member's.
                detail: "this device is not enrolled; a connection that has not                          redeemed a pairing code may carry a pair stream and nothing else"
                    .to_owned(),
                diagnostic_id: String::new(),
                sentence: centraid_core::error::sentence_for_code(core::ErrorCode::Unauthorized)
                    .to_owned(),
            },
        );
        let _ = write_envelope(&mut send, &refusal).await;
        let _ = send.flush().await;
        let _ = send.finish();
        return Err("it asked for something other than a pairing".to_owned());
    };

    // THE BLOB, BUILT BEFORE THE ANSWER GOES OUT (#1025 S7, item 5). It is the
    // same keeper every other seat asks, so the common case is a cache read;
    // the first pairing after a prune pays for the build, which is the request
    // that would have paid for it anyway one round trip later.
    let pairing_offer = current_offer(lane).await;
    let (relay_url, direct_addrs) = centraid_net::pairing::dialling_hints(&pairing.endpoint).await;
    let redeemed = centraid_net::pairing::answer_redemption(
        &mut send,
        request_id,
        &asked,
        connection.peer_id(),
        pairing.allowlist.as_ref(),
        &centraid_net::pairing::VaultIdentity {
            vault_id: &pairing.vault_id,
            vault_name: &pairing.vault_name,
            gateway_address: &pairing.gateway_address,
            // THE DIALLING HINTS, WITH THE PAIRING (#1025 S7, item 3). The
            // shell persists this record in its secure store BEFORE there is a
            // replica to put it in, and a record with no way to dial is a
            // durable identity presented to nobody.
            relay_url: &relay_url,
            direct_addrs,
            // THE BLOB, IN THE ANSWER THAT ENROLS THE DEVICE (#1025 S7,
            // item 5). `None` is a gateway with nothing to offer: the pairing
            // still stands and the device is paired with no file yet.
            snapshot: pairing_offer.map(|offer| centraid_net::pairing::SnapshotOffer {
                hash: offer.hash.to_hex(),
                seq: offer.head.seq,
                bytes: offer.size,
            }),
        },
        crate::run::now_ms(),
    )
    .await
    .map_err(|error| format!("the redemption failed: {error}"))?;
    // ONE REQUEST, ONE ANSWER, ONE STREAM — the same rule as every other stream
    // on this connection. The CONNECTION stays open, which is the whole point:
    // it is promoted now, and the next stream the phone opens is its handshake.
    let _ = send.finish();

    match redeemed.device {
        Some(device) => {
            tracing::info!(
                device = %device.device_id,
                label = %device.label,
                "a device paired and its connection was promoted in place"
            );
            Ok(device.device_id)
        }
        // A REFUSED TICKET IS ANSWERED AND THEN THE CONNECTION ENDS. The
        // vocabulary is three coarse codes on purpose — a member holding a
        // screenshot of an old QR must not learn whether that ticket ever
        // existed — and it has already been written above.
        None => Err("its pairing code was refused".to_owned()),
    }
}

/// Fetch every blob this intent declares and does not already live here.
///
/// Returns the wire error the seat should be answered with when the bytes did
/// not arrive. **Retryable, always**: the write stays in the seat's outbox and
/// the next window submits it again, which is what an `Error` on an `intent`
/// stream already means to `decode_outcome`. A `FAILED` here would tell a
/// member their photograph was rejected because their train went into a tunnel.
///
/// The pull runs on a `blob` stream the GATEWAY opens on the seat's own
/// connection; the seat's `centraid_seat_link::serve` answers it from its byte
/// store. Nothing here re-checks admission: `accept` decided it for this
/// connection before any stream existed.
async fn pull_declared_bytes(
    intent: &core::Intent,
    lane: &Lane,
    connection: &IrohConnection,
) -> Result<(), core::Error> {
    let retryable = |detail: String| core::Error {
        code: core::ErrorCode::BytesNotYetHeld as i32,
        // LOGS ONLY. The member's sentence is the code's.
        detail,
        diagnostic_id: String::new(),
        sentence: centraid_core::error::sentence_for_code(core::ErrorCode::BytesNotYetHeld)
            .to_owned(),
    };
    // THROUGH THE PAYLOAD-HASH GATE. A declaration read off an unverified
    // request is a list of fetches an attacker chose.
    let declared = match centraid_core::intent::needed_bytes(intent) {
        Ok(declared) => declared,
        // NOT retryable and not this function's to answer: a payload hash that
        // does not match its payload is `submit`'s own refusal, and it has the
        // better words for it. Letting it through means `submit` says so.
        Err(_) => return Ok(()),
    };
    if declared.is_empty() {
        return Ok(());
    }
    let Some(blobs) = lane.blobs.as_ref() else {
        return Err(retryable(
            "this gateway has no byte store, so it cannot take a seat's files".to_owned(),
        ));
    };

    let mut pulled = Vec::new();
    for need in declared {
        let Ok(hash) = centraid_blobs::ContentHash::parse_hex(&need.hash) else {
            // A DECLARATION THAT IS NOT A HASH. Left for `submit`: the input
            // that names it will be refused by the command's own gate, with a
            // sentence, and inventing a second refusal here would be a second
            // vocabulary for one mistake.
            continue;
        };
        // ALREADY HERE IS THE COMMON CASE — a retried intent, or a photograph
        // two devices both hold. Bytes never conflict, so holding them is the
        // whole answer and no transfer is opened.
        match blobs.is_complete(hash).await {
            Ok(true) => {
                pulled.push(need);
                continue;
            }
            Ok(false) => {}
            Err(error) => {
                return Err(retryable(format!(
                    "the byte store would not answer: {error}"
                )));
            }
        }
        match centraid_blobs::fetch(blobs, connection.iroh(), hash).await {
            // COMPLETE OR NOTHING. A partial blob is a normal end for a seat
            // FETCHING — the next window resumes it — and it is not one here:
            // the intent cannot run against half a photograph, so the write
            // waits and what landed is kept for the retry.
            Ok(report) if report.complete => pulled.push(need),
            Ok(report) => {
                return Err(retryable(format!(
                    "{hash} is still arriving: {} of its bytes are here",
                    report.held_before + report.moved
                )));
            }
            Err(error) => return Err(retryable(format!("{hash} did not arrive: {error}"))),
        }
    }

    // THE STAGING ROWS, in one commit, after every byte is here. Staging one
    // blob and then failing on the next would leave rows for bytes an intent
    // that never ran had named.
    let handle = Arc::clone(&lane.handle);
    tokio::task::spawn_blocking(move || handle.stage_bytes(&pulled))
        .await
        .map_err(|joined| retryable(format!("staging the pulled bytes did not finish: {joined}")))?
        .map_err(|error| retryable(format!("the pulled bytes would not stage: {error}")))?;
    Ok(())
}

/// The answer to one request, and how many log rows it carried.
async fn answer_for(
    body: Option<envelope::Body>,
    request_id: u64,
    lane: &Lane,
    connection: &IrohConnection,
) -> Result<(core::Envelope, usize), String> {
    match body {
        Some(envelope::Body::Request(core::Request {
            kind: Some(request::Kind::Log(log)),
        })) => {
            let handle = Arc::clone(&lane.handle);
            let request = core::Request {
                kind: Some(request::Kind::Log(log)),
            };
            // OFF THE REACTOR. `Handle::call` reads SQLite and a blocking read
            // on an async worker starves every other stream this gateway is
            // serving.
            let called = tokio::task::spawn_blocking(move || handle.call(&request))
                .await
                .map_err(|joined| format!("the log read did not finish: {joined}"))?;
            match called {
                Ok(mut response) => {
                    let rows = match &response.kind {
                        Some(core::response::Kind::Log(page)) => page.rows.len(),
                        _ => 0,
                    };
                    // A SEAT TOLD TO TAKE A COPY IS TOLD WHICH (#1025 S7,
                    // item 5). `centraid_core` answers the refusal — it is the
                    // one that knows the cursor cannot be served — and leaves
                    // these three empty, because the artifact belongs to this
                    // PROCESS and a core that invented a hash would be naming a
                    // blob nobody serves. This is the lane that holds the
                    // keeper, so this is where they are filled in.
                    if let Some(core::response::Kind::RebootstrapRequired(required)) =
                        &mut response.kind
                        && let Some(offer) = current_offer(lane).await
                    {
                        required.snapshot_hash = offer.hash.to_hex();
                        required.snapshot_seq = u64::try_from(offer.head.seq).unwrap_or(0);
                        required.snapshot_bytes = offer.size;
                    }
                    Ok((
                        centraid_protocol::wire::response(request_id, response),
                        rows,
                    ))
                }
                Err(failure) => Ok((
                    centraid_protocol::wire::error(request_id, failure.to_wire()),
                    0,
                )),
            }
        }
        // THE WRITE HALF (#1025 S2). Run HERE, on the gateway, under the
        // enrolled device this connection was admitted as — and answered with
        // the commit position the effect landed in, which is the number the
        // seat's overlay settles against.
        Some(envelope::Body::Request(core::Request {
            kind: Some(request::Kind::Intent(intent)),
        })) => {
            // THE BYTES FIRST (#1025 S3). See the module header: rows never
            // commit ahead of the bytes they name.
            if let Err(refusal) = pull_declared_bytes(&intent, lane, connection).await {
                return Ok((centraid_protocol::wire::error(request_id, refusal), 0));
            }
            let handle = Arc::clone(&lane.handle);
            let device = lane.device_id.clone();
            // OFF THE REACTOR, and for a stronger reason than a read: an intent
            // runs a handler and takes the vault's write lock.
            let ran = tokio::task::spawn_blocking(move || handle.submit_intent(&intent, &device))
                .await
                .map_err(|joined| format!("the intent did not finish: {joined}"))?;
            Ok((
                match ran {
                    Ok(outcome) => centraid_protocol::wire::response(
                        request_id,
                        core::Response {
                            kind: Some(core::response::Kind::Outcome(outcome)),
                        },
                    ),
                    Err(failure) => centraid_protocol::wire::error(request_id, failure.to_wire()),
                },
                0,
            ))
        }
        // EVERYTHING ELSE, BY NAME. See the module header: `Command` is the
        // thin-seat plane's, whose principal is a caller's and not this
        // connection's device.
        other => Ok((
            centraid_protocol::wire::error(
                request_id,
                core::Error {
                    code: core::ErrorCode::UnsupportedMessage as i32,
                    // LOGS ONLY. The sentence beside it is the member's.
                    detail: format!(
                        "this plane serves log, intent and blob streams; got {}",
                        shape_of(other.as_ref())
                    ),
                    diagnostic_id: String::new(),
                    sentence: "This gateway cannot answer that yet.".to_owned(),
                },
            ),
            0,
        )),
    }
}

/// THE BOOTSTRAP BLOB THIS GATEWAY CURRENTLY HOLDS (#1025 S7, item 5).
///
/// `None` when there is no byte store to keep one in, or the build failed. A
/// gateway that cannot offer a copy still answers every other question; the
/// device is told to take one and told there is none to take, which is a state
/// it handles by keeping what it has and asking again.
///
/// There is no request that asks for this. It is attached to the two answers
/// that tell a device to take a copy — `PairOk` and `RebootstrapRequired` — so
/// there is no window in which a device knows it must bootstrap and does not
/// know from what.
pub(crate) async fn current_offer(lane: &Lane) -> Option<crate::snapshots::Offer> {
    let snapshots = lane.snapshots.as_ref()?;
    match snapshots.current(&lane.handle).await {
        Ok(offer) => {
            tracing::info!(
                vault = %offer.head.vault_id,
                seq = offer.head.seq,
                bytes = offer.size,
                "a seat was offered the bootstrap blob"
            );
            Some(offer)
        }
        Err(why) => {
            tracing::warn!(%why, "the bootstrap blob could not be offered");
            None
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
