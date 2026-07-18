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
    GW_PAIR_ALPN, MAX_REQUEST_BODY_BYTES, PAIR_ALPN, TUNNEL_ALPN,
    iroh_wire::{
        Authorization, TunnelRequestHeader, TunnelResponseHeader, WireHeaderValue, read_header,
        request_headers, response_headers, write_header,
    },
};

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

type LiveConnections = Arc<Mutex<HashMap<String, HashMap<u64, Connection>>>>;

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
        let connections = self
            .live_connections
            .lock()
            .await
            .remove(endpoint_id)
            .unwrap_or_default();
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
) -> Result<Authorization> {
    let url = format!(
        "{}/centraid/_gateway/tunnel/authorize",
        config.control_url.trim_end_matches('/')
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

async fn serve_stream(
    client: Client,
    config: Arc<IrohRelayConfig>,
    endpoint_id: String,
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
) -> Result<()> {
    let header = read_header::<TunnelRequestHeader>(&mut recv).await?;
    if !header.target.starts_with('/') || header.target.starts_with("//") {
        bail!("bad tunnel target");
    }
    let auth = authorize(&client, &config, &endpoint_id).await?;
    if !auth.allowed {
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
    let headers = request_headers(&header.headers, &auth, upstream_token)?;
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
    connection: Connection,
) {
    let endpoint_id = connection.remote_id().to_string();
    match authorize(&client, &config, &endpoint_id).await {
        Ok(Authorization { allowed: true, .. }) => {}
        _ => {
            connection.close(401_u32.into(), b"unauthorized");
            return;
        }
    }
    live_connections
        .lock()
        .await
        .entry(endpoint_id.clone())
        .or_default()
        .insert(connection_id, connection.clone());
    while let Ok((send, recv)) = connection.accept_bi().await {
        let client = client.clone();
        let config = Arc::clone(&config);
        let endpoint_id = endpoint_id.clone();
        tokio::spawn(async move {
            if let Err(error) = serve_stream(client, config, endpoint_id, send, recv).await {
                tracing::warn!(%error, "native tunnel stream failed");
            }
        });
    }
    let mut live = live_connections.lock().await;
    if let Some(connections) = live.get_mut(&endpoint_id) {
        connections.remove(&connection_id);
        if connections.is_empty() {
            live.remove(&endpoint_id);
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
    while let Some(incoming) = endpoint.accept().await {
        let mut accepting = match incoming.accept() {
            Ok(accepting) => accepting,
            Err(error) => {
                tracing::warn!(%error, "iroh accept failed");
                continue;
            }
        };
        let alpn = match accepting.alpn().await {
            Ok(alpn) if alpn == TUNNEL_ALPN || alpn == pair_alpn => alpn,
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
            tokio::spawn(serve_connection(
                client.clone(),
                Arc::clone(&config),
                Arc::clone(&live_connections),
                next_connection_id.fetch_add(1, Ordering::Relaxed),
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
        .alpns(vec![TUNNEL_ALPN.to_vec(), pair_alpn.to_vec()])
        .relay_mode(relay_mode)
        .bind()
        .await
        .context("bind native iroh relay")?;
    tracing::info!(endpoint_id = %endpoint.id(), "native iroh byte relay listening");
    let client = Client::builder().build()?;
    let live_connections = Arc::new(Mutex::new(HashMap::new()));
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
