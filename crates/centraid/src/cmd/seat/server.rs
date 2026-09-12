//! The seat socket: bind, harden, probe, accept, dispatch, close
//! (#1020, D-1020-F1, D-1020-F2).
//!
//! ## What the socket is
//!
//! One Unix domain socket at a path the shell chooses (`<userData>/seat.sock`
//! for the desktop), mode 0600 in a 0700 directory, with a uid check on every
//! accepted connection. **No TCP listener** — `cargo xtask gate`'s
//! `no-listening-socket` rule is over this file too, and iroh's QUIC endpoint
//! is the only thing in the product that touches the network.
//!
//! ## Adoption, restated for a seat (census §F seam 4)
//!
//! v0's desktop *adopts* a gateway whose token it can prove and refuses one it
//! cannot ("leave it running and pair this desktop over iroh"). A seat is a
//! different animal — its only client is the window that started it — but the
//! trap is identical: a socket path that already exists may be **live and
//! somebody else's**. So a pre-existing path is probed with the protocol's own
//! handshake:
//!
//! | The probe says | What happens |
//! |---|---|
//! | `HelloOk` with our nonce accepted | a seat for this install is already serving: adopt it, exit 0 |
//! | `Refused` | another install's live socket: refuse, exit 1, **never unlink** |
//! | connect fails | a stale file from a process that died: unlink and bind |
//!
//! ## What quit does (D-1020-F1)
//!
//! `Terminate` on the local channel: the seat answers, closes the core — which
//! is where the vault's last write lands — and then exits 0. Electron main
//! awaits that answer, then `SIGTERM` → 5 s → `SIGKILL`, and awaits *that*
//! before it reuses the socket path. v0's "quit does not kill the gateway" was
//! a decision about a *daemon*; this is a seat process, and a seat whose window
//! is gone has no client.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_protocol::framing;
use prost::Message as _;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

use super::blob::{self, BlobPaths, Served};
use super::catalogue;
use super::core_link::CoreLink;
use super::local::{
    self, Capabilities, ClientKind, ClientMessage, RefusalCode, SeatMessage, SeatMode,
    SeatStateJson,
};
use super::state::{self, Facts};

/// How long a `BlobRange` waits for bytes that have not arrived.
///
/// Five seconds, and it is a **ceiling on a wait that normally ends in
/// milliseconds**: the writer is appending, so a seek just ahead of the write
/// head resolves in one poll. What the ceiling is for is a transfer that has
/// stalled, where holding a media element's request open forever is worse than
/// telling it to ask again.
pub const BLOB_WAIT: Duration = Duration::from_secs(5);

/// Everything one seat process holds.
pub struct Seat {
    /// The nonce the shell spawned this seat with. A renderer proves it; an
    /// adoption probe compares it.
    pub instance: String,
    pub mode: SeatMode,
    pub blobs: BlobPaths,
    pub core: CoreLink,
    capabilities: Mutex<Capabilities>,
    facts: Mutex<Facts>,
    /// Set when a client sent `Terminate`, so the accept loop stops.
    terminate: tokio::sync::Notify,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as u64)
        .unwrap_or_default()
}

impl Seat {
    #[must_use]
    pub fn new(instance: String, mode: SeatMode, blobs: BlobPaths, core: CoreLink) -> Self {
        Self {
            instance,
            mode,
            blobs,
            core,
            capabilities: Mutex::new(Capabilities::new()),
            facts: Mutex::new(Facts {
                mode,
                // A seat with a file it just opened HAS local rows to read; the
                // gateway link is a wave-4 dial, so it is honestly unconfigured
                // until something configures it.
                local_rows: matches!(mode, SeatMode::Replicated),
                ..Facts::at_rest(mode)
            }),
            terminate: tokio::sync::Notify::new(),
        }
    }

    /// The four states, as of now.
    pub async fn state(&self) -> SeatStateJson {
        state::fold(*self.facts.lock().await, now_ms())
    }

    /// Record what the core just said about itself, and return the new state.
    ///
    /// The events the core volunteers are the *only* source for durability and
    /// pending work — see `state.rs`'s header on why a second poll would be a
    /// third truth.
    pub async fn observe(&self, event: &wire::Event) -> SeatStateJson {
        {
            let mut facts = self.facts.lock().await;
            match &event.kind {
                Some(wire::event::Kind::Health(health)) => {
                    facts.stalled = health.stalled;
                    facts.behind = health.behind;
                }
                Some(wire::event::Kind::Connectivity(connectivity)) => {
                    // A CONNECTIVITY EVENT AT ALL means a gateway has been
                    // chosen: nothing emits one before there is something to
                    // connect to, which is what separates `Offline` from
                    // `Unconfigured` without a second flag.
                    facts.gateway_configured = true;
                    facts.gateway_reachable = matches!(
                        connectivity.state(),
                        wire::ConnectivityState::Direct | wire::ConnectivityState::Relay
                    );
                }
                Some(wire::event::Kind::Change(_)) | None => {}
            }
        }
        self.state().await
    }
}

/// Bind the socket, or say why not.
///
/// `Ok(None)` means a seat for this install is already serving: the caller
/// exits 0 with nothing to do, which is what makes a second launch of the shell
/// harmless.
pub async fn bind(socket: &Path, instance: &str) -> Result<Option<UnixListener>, String> {
    if let Some(parent) = socket.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("creating {}: {error}", parent.display()))?;
    }
    if socket.exists() {
        match probe(socket, instance).await {
            Probe::Ours => return Ok(None),
            Probe::Foreign(code) => {
                return Err(format!(
                    "{} is already served by another Centraid install — {}. Nothing was \
                     unlinked: that socket belongs to a running process.",
                    socket.display(),
                    code.sentence()
                ));
            }
            Probe::Stale(why) => {
                tracing::info!(path = %socket.display(), %why, "unlinking a stale seat socket");
                std::fs::remove_file(socket)
                    .map_err(|error| format!("unlinking {}: {error}", socket.display()))?;
            }
        }
    }
    let listener = UnixListener::bind(socket)
        .map_err(|error| format!("binding {}: {error}", socket.display()))?;
    let mode = super::peer::harden(socket)
        .map_err(|error| format!("hardening {}: {error}", socket.display()))?;
    tracing::info!(path = %socket.display(), mode = format!("{mode:o}"), "the seat socket is up");
    Ok(Some(listener))
}

/// What a pre-existing socket path turned out to be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    /// A live seat that accepted this install's nonce.
    Ours,
    /// A live seat that refused it.
    Foreign(RefusalCode),
    /// Nothing is listening.
    Stale(String),
}

/// Probe a pre-existing socket with the protocol's own handshake.
pub async fn probe(socket: &Path, instance: &str) -> Probe {
    let mut stream = match UnixStream::connect(socket).await {
        Ok(stream) => stream,
        Err(error) => return Probe::Stale(error.to_string()),
    };
    let hello = ClientMessage::Hello {
        client: ClientKind::Renderer,
        nonce: Some(instance.to_owned()),
        token: None,
        protocol: local::LOCAL_PROTOCOL_VERSION,
    };
    if write_client(&mut stream, &hello).await.is_err() {
        return Probe::Stale("the socket accepted a connection and then broke".to_owned());
    }
    // A LIVE SEAT ANSWERS IMMEDIATELY. The bound wait is short because a peer
    // that is listening and silent is not a peer this shell can use, and
    // treating silence as "stale" would unlink a socket somebody owns — so
    // silence is `Foreign` rather than `Stale`.
    match tokio::time::timeout(Duration::from_secs(2), read_local(&mut stream)).await {
        Ok(Ok(Some(SeatMessage::HelloOk { .. }))) => Probe::Ours,
        Ok(Ok(Some(SeatMessage::Refused { code, .. }))) => Probe::Foreign(code),
        Ok(Ok(Some(_)) | Ok(None)) => Probe::Foreign(RefusalCode::Unsupported),
        Ok(Err(_)) => Probe::Stale("the socket broke mid-handshake".to_owned()),
        Err(_) => Probe::Foreign(RefusalCode::HandshakeExpected),
    }
}

/// Serve until a client terminates the seat or the process is signalled.
pub async fn serve(listener: UnixListener, seat: Arc<Seat>) {
    let path = listener
        .local_addr()
        .ok()
        .and_then(|addr| addr.as_pathname().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let owner_uid = match super::peer::owner_uid(&path) {
        Ok(uid) => uid,
        Err(error) => {
            tracing::error!(%error, "the socket's owner could not be read; refusing to serve");
            return;
        }
    };

    loop {
        tokio::select! {
            () = seat.terminate.notified() => {
                tracing::info!("a client terminated the seat");
                break;
            }
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let seat = seat.clone();
                    tokio::spawn(async move {
                        if let Err(error) = connection(stream, seat, owner_uid).await {
                            tracing::debug!(%error, "a seat connection ended");
                        }
                    });
                }
                // One bad accept must not take the seat down: the same rule the
                // gateway's accept loop follows for a refused connection.
                Err(error) => tracing::warn!(%error, "a connection would not accept"),
            },
        }
    }
    // THE CLOSE THE QUIT PATH WAITS FOR. Awaited before this function returns,
    // so the process does not exit with a write in flight.
    seat.core.close().await;
}

/// One connection: handshake, then frames until it ends.
async fn connection(mut stream: UnixStream, seat: Arc<Seat>, owner_uid: u32) -> Result<(), String> {
    // THE PEER CHECK, before a single frame is read. R-1020-26.
    let peer = stream
        .peer_cred()
        .map_err(|error| format!("the peer's credentials could not be read: {error}"))?;
    let identity = super::peer::PeerIdentity {
        uid: peer.uid(),
        pid: peer.pid().map(|pid| pid as u32),
    };
    if let Err(code) = super::peer::judge_peer(identity, owner_uid) {
        tracing::warn!(uid = identity.uid, ?identity.pid, "a foreign peer was refused");
        let _ = write_local(
            &mut stream,
            &SeatMessage::Refused {
                code,
                message: code.sentence().to_owned(),
            },
        )
        .await;
        return Ok(());
    }

    let first = read_client(&mut stream)
        .await?
        .ok_or_else(|| "the connection closed before the handshake".to_owned())?;
    let kind = {
        let mut capabilities = seat.capabilities.lock().await;
        local::judge_hello(&first, &seat.instance, &mut capabilities, now_ms())
    };
    let kind = match kind {
        Ok(kind) => kind,
        Err(code) => {
            write_local(
                &mut stream,
                &SeatMessage::Refused {
                    code,
                    message: code.sentence().to_owned(),
                },
            )
            .await?;
            return Ok(());
        }
    };
    write_local(
        &mut stream,
        &SeatMessage::HelloOk {
            instance: seat.instance.clone(),
            mode: seat.mode,
            protocol: local::LOCAL_PROTOCOL_VERSION,
            schema_version: centraid_protocol::version::SCHEMA_VERSION,
            min_supported: centraid_protocol::version::MIN_SUPPORTED,
            product_version: env!("CARGO_PKG_VERSION").to_owned(),
        },
    )
    .await?;
    tracing::info!(?kind, pid = ?identity.pid, "a local client attached");

    let mut events = seat.core.subscribe();
    let mut subscribed = None::<u64>;
    loop {
        tokio::select! {
            frame = framing::read_frame(&mut stream) => {
                let Some(body) = frame.map_err(|error| error.to_string())? else {
                    return Ok(());
                };
                let Some((channel, payload)) = local::split_channel(&body) else {
                    return Err("a frame with no channel tag".to_owned());
                };
                match channel {
                    local::CHANNEL_CORE => core_frame(&mut stream, &seat, payload).await?,
                    local::CHANNEL_LOCAL => {
                        let message: ClientMessage = serde_json::from_slice(payload)
                            .map_err(|error| format!("a local frame would not parse: {error}"))?;
                        // Subscribing is answered HERE and not in
                        // `local_frame`, because it changes this connection's
                        // own state — the id every later `state` message is
                        // sent under — and `local_frame` is pure with respect
                        // to the connection.
                        if let ClientMessage::SubscribeState { id } = message {
                            subscribed = Some(id);
                            let state = seat.state().await;
                            write_local(&mut stream, &SeatMessage::State { id: Some(id), state })
                                .await?;
                            continue;
                        }
                        let answer = local_frame(&seat, kind, message).await;
                        for message in answer.messages {
                            write_local(&mut stream, &message).await?;
                        }
                        if answer.terminate {
                            seat.terminate.notify_waiters();
                            return Ok(());
                        }
                    }
                    other => {
                        return Err(format!("channel {other} is not a channel this build knows"));
                    }
                }
            }
            event = events.recv() => match event {
                Ok(event) => {
                    let state = seat.observe(&event).await;
                    if let Some(id) = subscribed {
                        write_local(&mut stream, &SeatMessage::State { id: Some(id), state })
                            .await?;
                    }
                }
                // LAGGED IS NOT FATAL: the fan-out buffer dropped events for
                // this connection, and the honest repair is to re-send the
                // state rather than to drop the client.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Some(id) = subscribed {
                        let state = seat.state().await;
                        write_local(&mut stream, &SeatMessage::State { id: Some(id), state })
                            .await?;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
            },
        }
    }
}

/// One `Envelope` on the core channel, answered as an `Envelope`.
async fn core_frame(stream: &mut UnixStream, seat: &Seat, payload: &[u8]) -> Result<(), String> {
    let envelope = wire::Envelope::decode(payload)
        .map_err(|error| format!("an envelope would not decode: {error}"))?;
    let request_id = envelope.request_id;
    match envelope.body {
        Some(wire::envelope::Body::Request(request)) => {
            let answer = seat.core.call_with_id(request, request_id).await;
            let reply = match answer {
                Ok(response) => centraid_protocol::wire::response(request_id, response),
                // `Error.detail` is a SUPPORT-BUNDLE field, not a member
                // sentence (`error.proto:3`–`:6`): the core's own refusal text
                // goes there and nothing renders it to a person.
                Err(detail) => centraid_protocol::wire::error(
                    request_id,
                    wire::Error {
                        code: wire::ErrorCode::Internal as i32,
                        detail,
                        diagnostic_id: String::new(),
                    },
                ),
            };
            write_core(stream, &reply).await
        }
        Some(wire::envelope::Body::Cancel(_)) => {
            seat.core.cancel(request_id).await;
            Ok(())
        }
        // A RESPONSE OR AN EVENT FROM A CLIENT is answered with `Unsupported`
        // rather than dropped (#1020 Compatibility).
        Some(_) | None => {
            let reply = centraid_protocol::wire::response(
                request_id,
                wire::Response {
                    kind: Some(wire::response::Kind::Unsupported(wire::Unsupported {
                        type_url: "centraid.core.v1.Envelope".to_owned(),
                    })),
                },
            );
            write_core(stream, &reply).await
        }
    }
}

/// What one local message produced.
struct Answer {
    messages: Vec<SeatMessage>,
    terminate: bool,
}

impl Answer {
    fn one(message: SeatMessage) -> Self {
        Self {
            messages: vec![message],
            terminate: false,
        }
    }

    fn error(id: u64, code: &str, message: impl Into<String>) -> Self {
        Self::one(SeatMessage::Error {
            id,
            code: code.to_owned(),
            message: message.into(),
        })
    }
}

async fn local_frame(seat: &Seat, kind: ClientKind, message: ClientMessage) -> Answer {
    match message {
        // A second handshake on a connection that already has one.
        ClientMessage::Hello { .. } => Answer::one(SeatMessage::Refused {
            code: RefusalCode::HandshakeExpected,
            message: "this connection is already attached".to_owned(),
        }),
        ClientMessage::SubscribeState { id } => Answer::one(SeatMessage::State {
            id: Some(id),
            state: seat.state().await,
        }),
        ClientMessage::Page {
            id,
            statement,
            limit,
            after,
        } => page(seat, id, &statement, limit, after).await,
        ClientMessage::Command { id, name, input } => command(seat, id, &name, &input).await,
        ClientMessage::DevicesList { id } => {
            match seat
                .core
                .call(wire::Request {
                    kind: Some(wire::request::Kind::DevicesList(wire::DevicesList {})),
                })
                .await
            {
                Ok(wire::Response {
                    kind: Some(wire::response::Kind::DevicesList(list)),
                }) => Answer::one(SeatMessage::Result {
                    id,
                    value: serde_json::json!({
                        "devices": list.devices.iter().map(|device| serde_json::json!({
                            "device_id": device.device_id,
                            "label": device.label,
                        })).collect::<Vec<_>>(),
                    }),
                }),
                Ok(_) => Answer::error(id, "unexpected", "the core answered with another shape"),
                Err(error) => Answer::error(id, "refused", error),
            }
        }
        ClientMessage::BlobStat { id, blob } => blob_stat(seat, id, &blob).await,
        ClientMessage::BlobRange {
            id,
            blob,
            range,
            wait_ms,
        } => blob_range(seat, id, &blob, range.as_deref(), wait_ms).await,
        ClientMessage::MintCapability {
            id,
            client,
            purpose,
            ttl_ms,
        } => {
            if !kind.may_mint() {
                return Answer::one(SeatMessage::Refused {
                    code: RefusalCode::NotPermitted,
                    message: RefusalCode::NotPermitted.sentence().to_owned(),
                });
            }
            if client.may_mint() {
                return Answer::error(
                    id,
                    "not-permitted",
                    "a capability token is for a child process, and the shell proves the instance \
                     nonce instead",
                );
            }
            let token = mint_token();
            let expires_at_ms = {
                let mut capabilities = seat.capabilities.lock().await;
                capabilities.mint(token.clone(), client, purpose, now_ms(), ttl_ms)
            };
            Answer::one(SeatMessage::Result {
                id,
                value: serde_json::json!({ "token": token, "expires_at_ms": expires_at_ms }),
            })
        }
        ClientMessage::Terminate { id } => Answer {
            messages: vec![
                SeatMessage::Result {
                    id,
                    value: serde_json::json!({ "terminating": true }),
                },
                SeatMessage::Closing {
                    reason: "the shell asked this seat to stop".to_owned(),
                },
            ],
            terminate: true,
        },
    }
}

async fn page(
    seat: &Seat,
    id: u64,
    statement: &str,
    limit: u32,
    after: Option<local::PageCursorJson>,
) -> Answer {
    let Some(query) = catalogue::statement(statement) else {
        return Answer::error(
            id,
            "unknown-statement",
            format!("`{statement}` is not a statement this seat serves"),
        );
    };
    let columns = query.select.clone();
    let request = wire::Request {
        kind: Some(wire::request::Kind::Page(wire::PageRequest {
            query: Some(query),
            limit,
            after: after.map(|cursor| wire::PageCursor {
                sort_key: cursor.sort_key,
                pk: cursor.pk,
            }),
        })),
    };
    match seat.core.call(request).await {
        Ok(wire::Response {
            kind: Some(wire::response::Kind::Page(answered)),
        }) => Answer::one(SeatMessage::Page {
            id,
            columns,
            rows: answered
                .rows
                .iter()
                .map(|row| row.values.iter().map(catalogue::value_to_json).collect())
                .collect(),
            next: answered.next.map(|cursor| local::PageCursorJson {
                sort_key: cursor.sort_key,
                pk: cursor.pk,
            }),
        }),
        Ok(_) => Answer::error(id, "unexpected", "the core answered with another shape"),
        Err(error) => Answer::error(id, "refused", error),
    }
}

async fn command(seat: &Seat, id: u64, name: &str, input: &serde_json::Value) -> Answer {
    let bytes = match serde_json::to_vec(input) {
        Ok(bytes) => bytes,
        Err(error) => return Answer::error(id, "bad-input", error.to_string()),
    };
    let request = wire::Request {
        kind: Some(wire::request::Kind::Command(wire::Command {
            name: name.to_owned(),
            input: bytes,
            ..wire::Command::default()
        })),
    };
    match seat.core.call(request).await {
        Ok(wire::Response {
            kind: Some(wire::response::Kind::Command(outcome)),
        }) => Answer::one(SeatMessage::Result {
            id,
            value: serde_json::json!({
                "status": outcome.status().as_str_name(),
                "receipt_id": outcome.receipt_id,
                "invocation_id": outcome.invocation_id,
                "reason": outcome.reason,
                // D-1020-D2's seed-0 fix: the commit sequence the write landed
                // at, so a caller can tell "committed at 0" from "not told".
                "commit_seq": outcome.commit_seq,
            }),
        }),
        Ok(_) => Answer::error(id, "unexpected", "the core answered with another shape"),
        Err(error) => Answer::error(id, "refused", error),
    }
}

/// The media type a vault row declares for a digest, when there is one.
async fn declared_media_type(seat: &Seat, digest: &str) -> Option<String> {
    let content = seat
        .core
        .call(wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(catalogue::content_by_digest(digest)),
                limit: 1,
                after: None,
            })),
        })
        .await
        .ok()?;
    let wire::Response {
        kind: Some(wire::response::Kind::Page(page)),
    } = content
    else {
        return None;
    };
    let content_id = page
        .rows
        .first()
        .and_then(|row| match &row.values.first()?.kind {
            Some(wire::value::Kind::Text(text)) => Some(text.clone()),
            _ => None,
        })?;
    let representations = seat
        .core
        .call(wire::Request {
            kind: Some(wire::request::Kind::Page(wire::PageRequest {
                query: Some(catalogue::representations_of(&content_id)),
                limit: 8,
                after: None,
            })),
        })
        .await
        .ok()?;
    let wire::Response {
        kind: Some(wire::response::Kind::Page(page)),
    } = representations
    else {
        return None;
    };
    // Column 2 is `media_type`; `representations_of` declares the projection.
    page.rows
        .first()
        .and_then(|row| match &row.values.get(2)?.kind {
            Some(wire::value::Kind::Text(text)) => Some(text.clone()),
            _ => None,
        })
}

async fn blob_stat(seat: &Seat, id: u64, digest: &str) -> Answer {
    let hint = declared_media_type(seat, digest).await;
    match seat.blobs.shape(digest, hint.as_deref()) {
        Ok(shape) => Answer::one(SeatMessage::BlobStat {
            id,
            total: shape.total,
            received: shape.received,
            complete: shape.complete,
            inline: shape.inline(),
            media_type: shape.media_type,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Answer::error(id, "not-found", format!("no blob {digest}"))
        }
        Err(error) => Answer::error(id, "unreadable", error.to_string()),
    }
}

async fn blob_range(
    seat: &Seat,
    id: u64,
    digest: &str,
    header: Option<&str>,
    wait_ms: u64,
) -> Answer {
    use base64::Engine as _;

    let hint = declared_media_type(seat, digest).await;
    let shape = match seat.blobs.shape(digest, hint.as_deref()) {
        Ok(shape) => shape,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Answer::error(id, "not-found", format!("no blob {digest}"));
        }
        Err(error) => return Answer::error(id, "unreadable", error.to_string()),
    };
    // THE ONE COPY OF THE RANGE GRAMMAR, against the DECLARED total — so a
    // probe learns the real length of an arriving video and not its length so
    // far (`blob.rs`'s `addressable`).
    let addressable = shape.addressable();
    let range = match header {
        Some(header) => match blob::parse_range(header, addressable) {
            Some(range) => range,
            // A `Range` this build cannot satisfy against a size it knows is
            // the ONLY 416 (D-1020-F3).
            None => {
                return Answer::one(SeatMessage::Error {
                    id,
                    code: "unsatisfiable".to_owned(),
                    message: addressable.to_string(),
                });
            }
        },
        // No header: the whole blob, bounded by one frame.
        None => blob::ByteRange {
            start: 0,
            end: addressable.saturating_sub(1),
        },
    };
    let resolved_end = range.end;
    let range = blob::ByteRange {
        start: range.start,
        end: range
            .end
            .min(range.start.saturating_add(blob::MAX_CHUNK_BYTES - 1)),
    };
    let wait = if wait_ms == 0 {
        BLOB_WAIT
    } else {
        Duration::from_millis(wait_ms).min(BLOB_WAIT)
    };
    // A BLOCKING READ ON THE BLOCKING POOL. The wait polls a file length and
    // sleeps; doing that on a reactor thread would stall every other
    // connection for up to five seconds.
    let paths = seat.blobs.clone();
    let digest_owned = digest.to_owned();
    let media_type = shape.media_type.clone();
    let served = tokio::task::spawn_blocking(move || {
        paths.read_range(&digest_owned, range, Some(&media_type), wait)
    })
    .await;
    let served = match served {
        Ok(Ok(served)) => served,
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Answer::error(id, "not-found", format!("no blob {digest}"));
        }
        Ok(Err(error)) => return Answer::error(id, "unreadable", error.to_string()),
        Err(error) => return Answer::error(id, "unreadable", error.to_string()),
    };
    // RE-READ THE SHAPE: the wait may have ended with the blob complete, and a
    // `complete` the shell reads from before the wait is a stale answer.
    let after = seat.blobs.shape(digest, hint.as_deref()).ok();
    match served {
        Served::Bytes { start, end, bytes } => Answer::one(SeatMessage::BlobBytes {
            id,
            start,
            end,
            req_end: resolved_end,
            total: after.as_ref().and_then(|shape| shape.total),
            complete: after.as_ref().is_some_and(|shape| shape.complete),
            partial: header.is_some(),
            bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        }),
        // NEVER A 416 FOR A KNOWN-TOTAL BLOB (D-1020-F3): "not yet" is the
        // true answer and the shell turns it into a retry.
        Served::NotYet { received, total } => Answer::one(SeatMessage::Error {
            id,
            code: "still-arriving".to_owned(),
            message: format!("{received}/{total}"),
        }),
        Served::Unsatisfiable { size } => Answer::one(SeatMessage::Error {
            id,
            code: "unsatisfiable".to_owned(),
            message: size.to_string(),
        }),
    }
}

/// A capability token: 32 bytes of the OS's randomness, hex.
///
/// From `/dev/urandom` rather than a crate, because this is the only place the
/// binary needs randomness that is not already inside iroh, and a failure to
/// read it must be a refusal and not a weaker token.
fn mint_token() -> String {
    use std::io::Read as _;

    let mut bytes = [0_u8; 32];
    match std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)) {
        Ok(()) => bytes.iter().fold(String::new(), |mut text, byte| {
            use std::fmt::Write as _;
            let _ = write!(text, "{byte:02x}");
            text
        }),
        // An empty token is refused by `Capabilities::spend` (it was never
        // minted under that key — the map stores what we return), so a machine
        // with no urandom mints nothing rather than minting something guessable.
        Err(_) => String::new(),
    }
}

async fn write_local<W>(stream: &mut W, message: &SeatMessage) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    let payload =
        serde_json::to_vec(message).map_err(|error| format!("encoding a reply: {error}"))?;
    framing::write_frame(stream, &local::tagged(local::CHANNEL_LOCAL, &payload))
        .await
        .map_err(|error| error.to_string())?;
    stream.flush().await.map_err(|error| error.to_string())
}

async fn write_core<W>(stream: &mut W, envelope: &wire::Envelope) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    let payload = envelope.encode_to_vec();
    framing::write_frame(stream, &local::tagged(local::CHANNEL_CORE, &payload))
        .await
        .map_err(|error| error.to_string())?;
    stream.flush().await.map_err(|error| error.to_string())
}

async fn read_local<R>(stream: &mut R) -> Result<Option<SeatMessage>, String>
where
    R: AsyncRead + Unpin,
{
    let Some(body) = framing::read_frame(stream)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let Some((channel, payload)) = local::split_channel(&body) else {
        return Err("a frame with no channel tag".to_owned());
    };
    if channel != local::CHANNEL_LOCAL {
        return Err(format!("expected a local frame, got channel {channel}"));
    }
    serde_json::from_slice(payload)
        .map(Some)
        .map_err(|error| format!("a local frame would not parse: {error}"))
}

/// Write one client message. Used by the probe and by `crates/centraid`'s own
/// integration tests, which is why it is not private.
pub async fn write_client<W>(stream: &mut W, message: &ClientMessage) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    let payload =
        serde_json::to_vec(message).map_err(|error| format!("encoding a message: {error}"))?;
    framing::write_frame(stream, &local::tagged(local::CHANNEL_LOCAL, &payload))
        .await
        .map_err(|error| error.to_string())?;
    stream.flush().await.map_err(|error| error.to_string())
}

/// Read one **client** message: the accepting side of the same channel.
async fn read_client<R>(stream: &mut R) -> Result<Option<ClientMessage>, String>
where
    R: AsyncRead + Unpin,
{
    let Some(payload) = read_local_payload(stream).await? else {
        return Ok(None);
    };
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|error| format!("a local frame would not parse: {error}"))
}

/// One local-channel frame's payload, with the tag checked.
async fn read_local_payload<R>(stream: &mut R) -> Result<Option<Vec<u8>>, String>
where
    R: AsyncRead + Unpin,
{
    let Some(body) = framing::read_frame(stream)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let Some((channel, payload)) = local::split_channel(&body) else {
        return Err("a frame with no channel tag".to_owned());
    };
    if channel != local::CHANNEL_LOCAL {
        return Err(format!("expected a local frame, got channel {channel}"));
    }
    Ok(Some(payload.to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_socket_path_nothing_is_listening_on_is_unlinked_and_rebound() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let socket = dir.path().join("seat.sock");
        // A LEFTOVER FILE: the shape a crashed seat leaves behind.
        std::fs::write(&socket, b"not a socket").expect("a leftover");
        assert!(matches!(probe(&socket, "instance").await, Probe::Stale(_)));
        let listener = bind(&socket, "instance")
            .await
            .expect("bound")
            .expect("a listener");
        drop(listener);
    }

    #[tokio::test]
    async fn a_live_socket_that_refuses_our_nonce_is_never_unlinked() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let socket = dir.path().join("seat.sock");
        let listener = UnixListener::bind(&socket).expect("a listener");
        // A stand-in for another install's seat: it refuses every handshake.
        // A LOOP, because `bind` probes again before it decides — and a
        // stand-in that answered once would make the second probe read as
        // stale, which is the bug this test exists to catch.
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = read_client(&mut stream).await;
                let _ = write_local(
                    &mut stream,
                    &SeatMessage::Refused {
                        code: RefusalCode::ForeignInstance,
                        message: RefusalCode::ForeignInstance.sentence().to_owned(),
                    },
                )
                .await;
            }
        });
        assert_eq!(
            probe(&socket, "ours").await,
            Probe::Foreign(RefusalCode::ForeignInstance)
        );
        let error = bind(&socket, "ours").await.expect_err("refused");
        assert!(error.contains("another Centraid install"), "{error}");
        assert!(socket.exists(), "the foreign socket was unlinked");
        server.abort();
    }

    #[tokio::test]
    async fn a_seat_that_answers_our_nonce_is_adopted_rather_than_replaced() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let socket = dir.path().join("seat.sock");
        let listener = UnixListener::bind(&socket).expect("a listener");
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let _ = read_client(&mut stream).await;
                let _ = write_local(
                    &mut stream,
                    &SeatMessage::HelloOk {
                        instance: "ours".to_owned(),
                        mode: SeatMode::Replicated,
                        protocol: local::LOCAL_PROTOCOL_VERSION,
                        schema_version: 1,
                        min_supported: 1,
                        product_version: "test".to_owned(),
                    },
                )
                .await;
            }
        });
        assert_eq!(probe(&socket, "ours").await, Probe::Ours);
        assert!(
            bind(&socket, "ours").await.expect("probed").is_none(),
            "an adopted seat binds nothing"
        );
        server.abort();
    }

    #[test]
    fn a_minted_token_is_sixty_four_hex_characters() {
        let token = mint_token();
        assert_eq!(token.len(), 64, "{token}");
        assert!(token.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(token, mint_token(), "two mints are two tokens");
    }
}
