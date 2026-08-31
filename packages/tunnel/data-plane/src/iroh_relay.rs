use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use anyhow::{Context, Result, bail};
use bytes::Bytes;
use futures_util::StreamExt;
use iroh::{
    Endpoint, RelayMode, SecretKey,
    endpoint::{Connection, presets},
};
use iroh_tickets::endpoint::EndpointTicket;
use reqwest::{Client, Method};
use serde_json::Value;
use tokio::sync::{Mutex, mpsc};
use tokio_stream::wrappers::ReceiverStream;

use crate::{
    GW_PAIR_ALPN, MAX_REQUEST_BODY_BYTES, PAIR_ALPN, PEER_LINK_ALPN, PEER_PLANE_PREFIX,
    TUNNEL_ALPN,
    iroh_wire::{
        Authorization, RELAY_PROOF_HEADER, TunnelRequestHeader, TunnelResponseHeader,
        WireHeaderValue, read_header, request_headers, response_headers, write_header,
    },
};

/// Which lane a connection arrived on. The lanes share framing and forwarding
/// and NOTHING else: separate admission decisions, separate injected identity
/// headers, and — for `Peer` — a hard path confinement (issue #726 P3).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Plane {
    Device,
    Peer,
}

impl Plane {
    /// Control-plane route that decides admission for this lane. The device
    /// route answers device-pairing enrollment; the peer route answers "is
    /// this endpoint a known, non-revoked LINK". Never interchange them.
    fn authorize_path(self) -> &'static str {
        match self {
            Plane::Device => "/centraid/_gateway/tunnel/authorize",
            Plane::Peer => "/centraid/_gateway/tunnel/peer-authorize",
        }
    }
}

/// TRAP 1 (issue #726 P3). `header.target` is peer-supplied and is pasted onto
/// `upstream_url` in `serve_stream`, so without this a link addresses the whole
/// local gateway surface — `/centraid/_gateway/*` included. Loosening this
/// function is a privilege escalation, not a relaxation.
///
/// Byte-identical to `protocol.ts::isPeerPlaneTarget`:
///   - the PATH (before `?`/`#`) must EXTEND the prefix (a bare prefix names no
///     resource). Measured on the path, not on the whole target: measuring the
///     target let a lone `?` or `#` stand in for the extension, so
///     `/centraid/_peer/?` was admitted while the path it resolves to is
///     exactly the bare prefix (#846 P6);
///   - the path carries no `%`, no `\`, and no byte <= 0x20, so no
///     normalisation step is needed to reason about it;
///   - no `.` / `..` segment.
///
/// A `&str` is well-formed UTF-8 by construction, so the lone-surrogate rule
/// the TypeScript guard states explicitly is enforced here by the type.
fn peer_target_allowed(target: &str) -> bool {
    if !target.starts_with(PEER_PLANE_PREFIX) {
        return false;
    }
    let path = target
        .split(['?', '#'])
        .next()
        .expect("split always yields a first element");
    if path.len() <= PEER_PLANE_PREFIX.len() {
        return false;
    }
    if path
        .bytes()
        .any(|byte| byte == b'%' || byte == b'\\' || byte <= 0x20)
    {
        return false;
    }
    path.split('/')
        .all(|segment| segment != "." && segment != "..")
}

#[derive(Debug, Clone)]
pub struct IrohRelayConfig {
    pub secret_key: [u8; 32],
    pub upstream_url: String,
    pub upstream_token: String,
    pub control_url: String,
    pub control_token: String,
    pub control_secret: String,
    pub use_n0_relays: bool,
    pub desktop_pairing: bool,
}

#[derive(Clone)]
pub struct IrohRelayHandle {
    endpoint: Endpoint,
    live_connections: LiveConnections,
}

#[derive(Default)]
struct RelayConnections {
    by_endpoint: HashMap<String, HashMap<u64, Connection>>,
    revoke_epochs: HashMap<String, u64>,
}

type LiveConnections = Arc<Mutex<RelayConnections>>;

impl IrohRelayHandle {
    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    pub fn ticket(&self) -> String {
        EndpointTicket::new(self.endpoint.addr()).to_string()
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }

    pub async fn revoke_endpoint(&self, endpoint_id: &str) {
        let connections = {
            let mut live = self.live_connections.lock().await;
            let epoch = live
                .revoke_epochs
                .entry(endpoint_id.to_owned())
                .or_default();
            *epoch = epoch.wrapping_add(1);
            live.by_endpoint.remove(endpoint_id).unwrap_or_default()
        };
        for connection in connections.into_values() {
            connection.close(401_u32.into(), b"revoked");
        }
    }

    pub async fn wait(&self) {
        self.endpoint.closed().await;
    }
}

async fn authorize(
    client: &Client,
    config: &IrohRelayConfig,
    endpoint_id: &str,
    plane: Plane,
) -> Result<Authorization> {
    let url = format!(
        "{}{}",
        config.control_url.trim_end_matches('/'),
        plane.authorize_path()
    );
    // Iroh endpoint IDs are lowercase hex, so they are already URL-query safe.
    let mut request = client
        .get(format!("{url}?endpointId={endpoint_id}"))
        .header("x-centraid-data-plane-secret", &config.control_secret);
    if !config.control_token.is_empty() {
        request = request.bearer_auth(&config.control_token);
    }
    let response = request
        .send()
        .await
        .context("call tunnel authorization control route")?;
    if !response.status().is_success() {
        bail!("control plane refused authorization request");
    }
    response.json().await.context("decode tunnel authorization")
}

/// One JSON body frame + status, for refusals the caller must read as a STATE
/// rather than as a transport failure. A reset stream would reach the peer's
/// protocol code as an exception; a state reaches it as an answer.
async fn write_json_state(
    send: &mut iroh::endpoint::SendStream,
    status: u16,
    body: &[u8],
) -> Result<()> {
    write_header(
        send,
        &TunnelResponseHeader {
            status,
            headers: HashMap::from([
                (
                    "content-type".to_owned(),
                    WireHeaderValue::One("application/json".to_owned()),
                ),
                (
                    "content-length".to_owned(),
                    WireHeaderValue::One(body.len().to_string()),
                ),
            ]),
        },
    )
    .await?;
    send.write_all(body).await?;
    send.finish()?;
    Ok(())
}

async fn serve_stream(
    client: Client,
    config: Arc<IrohRelayConfig>,
    endpoint_id: String,
    plane: Plane,
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
) -> Result<()> {
    let header = read_header::<TunnelRequestHeader>(&mut recv).await?;
    if !header.target.starts_with('/') || header.target.starts_with("//") {
        bail!("bad tunnel target");
    }
    // Trap 1: confinement is decided before admission and before any gateway
    // state is consulted, so an off-plane probe cannot be told apart from a
    // missing route.
    if plane == Plane::Peer && !peer_target_allowed(&header.target) {
        return write_json_state(&mut send, 404, br#"{"state":"not_found"}"#).await;
    }
    let auth = authorize(&client, &config, &endpoint_id, plane).await?;
    if !auth.allowed {
        if plane == Plane::Peer {
            // Topology hiding: an unknown or revoked link learns only that
            // there is nothing here for it.
            return write_json_state(&mut send, 404, br#"{"state":"not_found"}"#).await;
        }
        bail!("tunnel endpoint is not authorized");
    }
    let upstream_url = auth.upstream_url.as_deref().unwrap_or(&config.upstream_url);
    let upstream_token = auth
        .upstream_token
        .as_deref()
        .unwrap_or(&config.upstream_token);
    if upstream_url.is_empty() {
        let body = br#"{"error":"gateway_unavailable"}"#;
        write_header(
            &mut send,
            &TunnelResponseHeader {
                status: 503,
                headers: HashMap::from([
                    (
                        "content-type".to_owned(),
                        WireHeaderValue::One("application/json".to_owned()),
                    ),
                    (
                        "content-length".to_owned(),
                        WireHeaderValue::One(body.len().to_string()),
                    ),
                ]),
            },
        )
        .await?;
        send.write_all(body).await?;
        send.finish()?;
        return Ok(());
    }
    let method = Method::from_bytes(header.method.as_bytes())?;
    let url = format!("{}{}", upstream_url.trim_end_matches('/'), header.target);
    let mut headers = request_headers(&header.headers, &auth, upstream_token)?;
    headers.insert(
        RELAY_PROOF_HEADER,
        reqwest::header::HeaderValue::from_str(&config.control_secret)?,
    );
    let (body_tx, body_rx) = mpsc::channel::<std::io::Result<Bytes>>(4);
    tokio::spawn(async move {
        let mut total = 0_usize;
        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            match recv.read(&mut buffer).await {
                Ok(None) => break,
                Ok(Some(read)) => {
                    total += read;
                    if total > MAX_REQUEST_BODY_BYTES {
                        let _ = body_tx
                            .send(Err(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "tunnel body exceeds limit",
                            )))
                            .await;
                        break;
                    }
                    if body_tx
                        .send(Ok(Bytes::copy_from_slice(&buffer[..read])))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = body_tx
                        .send(Err(std::io::Error::other(error.to_string())))
                        .await;
                    break;
                }
            }
        }
    });
    let response = client
        .request(method, url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(ReceiverStream::new(body_rx)))
        .send()
        .await
        .context("forward tunneled request")?;
    write_header(
        &mut send,
        &TunnelResponseHeader {
            status: response.status().as_u16(),
            headers: response_headers(response.headers()),
        },
    )
    .await?;
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        send.write_all(&chunk?).await?;
    }
    send.finish()?;
    Ok(())
}

async fn serve_connection(
    client: Client,
    config: Arc<IrohRelayConfig>,
    live_connections: LiveConnections,
    connection_id: u64,
    plane: Plane,
    connection: Connection,
) {
    let endpoint_id = connection.remote_id().to_string();
    let observed_revoke_epoch = live_connections
        .lock()
        .await
        .revoke_epochs
        .get(&endpoint_id)
        .copied()
        .unwrap_or_default();
    match authorize(&client, &config, &endpoint_id, plane).await {
        Ok(Authorization { allowed: true, .. }) => {}
        _ => {
            // Both planes close identically; the peer plane's reason word is
            // deliberately the same nothing an unknown link would be told.
            connection.close(401_u32.into(), b"unauthorized");
            return;
        }
    }
    {
        let mut live = live_connections.lock().await;
        let current_epoch = live
            .revoke_epochs
            .get(&endpoint_id)
            .copied()
            .unwrap_or_default();
        if current_epoch != observed_revoke_epoch {
            connection.close(401_u32.into(), b"revoked");
            return;
        }
        live.by_endpoint
            .entry(endpoint_id.clone())
            .or_default()
            .insert(connection_id, connection.clone());
    }
    while let Ok((send, recv)) = connection.accept_bi().await {
        let client = client.clone();
        let config = Arc::clone(&config);
        let endpoint_id = endpoint_id.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_stream(client, config, endpoint_id, plane, send, recv).await {
                tracing::warn!(%error, ?plane, "native tunnel stream failed");
            }
        });
    }
    let mut live = live_connections.lock().await;
    if let Some(connections) = live.by_endpoint.get_mut(&endpoint_id) {
        connections.remove(&connection_id);
        if connections.is_empty() {
            live.by_endpoint.remove(&endpoint_id);
        }
    }
}

async fn pair(
    client: &Client,
    config: &IrohRelayConfig,
    endpoint_id: &str,
    request: &Value,
) -> Result<Value> {
    let url = format!(
        "{}/centraid/_gateway/tunnel/pair",
        config.control_url.trim_end_matches('/')
    );
    let mut outbound = client
        .post(format!("{url}?endpointId={endpoint_id}"))
        .header("x-centraid-data-plane-secret", &config.control_secret)
        .json(request);
    if !config.control_token.is_empty() {
        outbound = outbound.bearer_auth(&config.control_token);
    }
    let response = outbound
        .send()
        .await
        .context("call tunnel pairing control route")?;
    if !response.status().is_success() {
        bail!("control plane refused pairing request");
    }
    response
        .json()
        .await
        .context("decode tunnel pairing response")
}

async fn serve_pair_connection(
    client: Client,
    config: Arc<IrohRelayConfig>,
    connection: Connection,
) {
    let endpoint_id = connection.remote_id().to_string();
    let result = async {
        let (mut send, mut recv) = connection.accept_bi().await?;
        let request = read_header::<Value>(&mut recv).await?;
        let response = pair(&client, &config, &endpoint_id, &request).await?;
        write_header(&mut send, &response).await?;
        send.finish()?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        tracing::warn!(%error, "native tunnel pairing failed");
    }
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    connection.close(0_u32.into(), b"");
}

async fn accept_loop(
    endpoint: Endpoint,
    config: Arc<IrohRelayConfig>,
    client: Client,
    live_connections: LiveConnections,
) {
    let next_connection_id = AtomicU64::new(1);
    let pair_alpn = if config.desktop_pairing {
        PAIR_ALPN
    } else {
        GW_PAIR_ALPN
    };
    // Only a GATEWAY has links. The desktop phone tunnel forwards under the
    // host's own bearer and has no link store, so it never speaks the plane.
    let peer_enabled = !config.desktop_pairing;
    while let Some(incoming) = endpoint.accept().await {
        let mut accepting = match incoming.accept() {
            Ok(accepting) => accepting,
            Err(error) => {
                tracing::warn!(%error, "iroh accept failed");
                continue;
            }
        };
        let alpn = match accepting.alpn().await {
            Ok(alpn)
                if alpn == TUNNEL_ALPN
                    || alpn == pair_alpn
                    || (peer_enabled && alpn == PEER_LINK_ALPN) =>
            {
                alpn
            }
            _ => continue,
        };
        let connection = match accepting.await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::warn!(%error, "iroh handshake failed");
                continue;
            }
        };
        if alpn == pair_alpn {
            tokio::spawn(serve_pair_connection(
                client.clone(),
                Arc::clone(&config),
                connection,
            ));
        } else {
            // The ALPN, not anything the caller says, picks the lane.
            let plane = if alpn == PEER_LINK_ALPN {
                Plane::Peer
            } else {
                Plane::Device
            };
            tokio::spawn(serve_connection(
                client.clone(),
                Arc::clone(&config),
                Arc::clone(&live_connections),
                next_connection_id.fetch_add(1, Ordering::Relaxed),
                plane,
                connection,
            ));
        }
    }
}

pub async fn start(config: IrohRelayConfig) -> Result<IrohRelayHandle> {
    let secret = SecretKey::from_bytes(&config.secret_key);
    let relay_mode = if config.use_n0_relays {
        RelayMode::Default
    } else {
        RelayMode::Disabled
    };
    let pair_alpn = if config.desktop_pairing {
        PAIR_ALPN
    } else {
        GW_PAIR_ALPN
    };
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(secret)
        .alpns(if config.desktop_pairing {
            vec![TUNNEL_ALPN.to_vec(), pair_alpn.to_vec()]
        } else {
            vec![
                TUNNEL_ALPN.to_vec(),
                pair_alpn.to_vec(),
                PEER_LINK_ALPN.to_vec(),
            ]
        })
        .relay_mode(relay_mode)
        .bind()
        .await
        .context("bind native iroh relay")?;
    // Binding finishes before iroh has selected a relay. Returning the handle
    // in that gap lets a remote mobile client receive only direct candidates and
    // spend minutes waiting for discovery to repair the address. Wait until at
    // least one configured N0 relay is connected before the first ticket can be
    // minted, so it already carries a reachable relay hint.
    if config.use_n0_relays {
        endpoint.online().await;
    }
    tracing::info!(endpoint_id = %endpoint.id(), "native iroh byte relay listening");
    let client = Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        // Per-read inactivity timeout: long-lived SSE remains healthy while
        // heartbeats flow, but a hung loopback/control response cannot pin a
        // relay task forever.
        .read_timeout(std::time::Duration::from_secs(120))
        .build()?;
    let live_connections = Arc::new(Mutex::new(RelayConnections::default()));
    let handle = IrohRelayHandle {
        endpoint: endpoint.clone(),
        live_connections: Arc::clone(&live_connections),
    };
    tokio::spawn(accept_loop(
        endpoint,
        Arc::new(config),
        client,
        live_connections,
    ));
    Ok(handle)
}

pub async fn serve(config: IrohRelayConfig) -> Result<()> {
    let handle = start(config).await?;
    handle.wait().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trap 1 (issue #726 P3). Each rejected case below is a way to reach the
    /// owner surface through a peer link; each accepted case is a real peer
    /// route. `protocol.ts`'s `isPeerPlaneTarget` answers identically — a
    /// divergence would mean one language admits what the other refuses.
    #[test]
    fn peer_targets_are_confined_to_the_peer_plane() {
        for allowed in [
            "/centraid/_peer/link/redeem",
            "/centraid/_peer/blobs/a1b2c3?range=0-1023",
            "/centraid/_peer/route/assert",
            "/centraid/_peer/x#frag",
        ] {
            assert!(peer_target_allowed(allowed), "should allow {allowed}");
        }
        for refused in [
            "/centraid/_gateway/tunnel/authorize",
            "/centraid/_vault/blobs",
            "/centraid/_peer",
            "/centraid/_peer/",
            "/centraid/_peerish/x",
            "/centraid/_peer/../_gateway/devices",
            "/centraid/_peer/./../_gateway",
            "/centraid/_peer/%2e%2e/_gateway",
            "/centraid/_peer/a%2f..%2fb",
            "/centraid/_peer/a\\..\\b",
            "/centraid/_peer/a b",
            "//centraid/_peer/x",
            "",
            // #846 P6: a separator is not an extension. The path behind each
            // of these IS the bare prefix, which names no peer-plane route.
            "/centraid/_peer/?",
            "/centraid/_peer/#",
            "/centraid/_peer/?next=/centraid/_gateway/devices",
            "/centraid/_peer/#/../_gateway",
        ] {
            assert!(!peer_target_allowed(refused), "should refuse {refused:?}");
        }
    }

    /// The lanes must not share an admission decision: device enrollment and
    /// link membership are different questions with different answers.
    #[test]
    fn planes_authorize_on_separate_control_routes() {
        assert_eq!(
            Plane::Device.authorize_path(),
            "/centraid/_gateway/tunnel/authorize"
        );
        assert_eq!(
            Plane::Peer.authorize_path(),
            "/centraid/_gateway/tunnel/peer-authorize"
        );
        assert_ne!(Plane::Device.authorize_path(), Plane::Peer.authorize_path());
    }

    /// The ALPN string is a wire constant; `alpn-parity.test.ts` pins it to the
    /// TypeScript twin, and this pins it against an accidental edit here.
    #[test]
    fn peer_alpn_is_the_published_string() {
        assert_eq!(PEER_LINK_ALPN, b"centraid/gw-link/1");
        assert_eq!(PEER_PLANE_PREFIX, "/centraid/_peer/");
    }
}
