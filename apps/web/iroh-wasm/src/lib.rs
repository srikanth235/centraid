use std::str::FromStr;

use anyhow::{Context, Result};
use futures_util::stream;
use iroh::{Endpoint, SecretKey, endpoint::Connection};
use iroh_tickets::endpoint::EndpointTicket;
use js_sys::Uint8Array;
use serde::{Deserialize, Serialize};
use wasm_bindgen::{JsError, JsValue, prelude::wasm_bindgen};
use wasm_streams::{ReadableStream, readable::sys::ReadableStream as JsReadableStream};

const PAIR_ALPN: &[u8] = b"centraid/gw-pair/1";
const TUNNEL_ALPN: &[u8] = b"centraid/tunnel/1";
const MAX_HEADER_BYTES: usize = 256 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayPairRequest {
    ticket_id: String,
    secret: String,
    device_name: String,
    platform: String,
}

#[derive(Serialize)]
struct TunnelRequestHeader {
    method: String,
    target: String,
    headers: serde_json::Value,
}

#[derive(Deserialize)]
struct TunnelResponseHeader {
    status: u16,
    headers: serde_json::Value,
}

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub struct BrowserEndpoint {
    endpoint: Endpoint,
}

#[wasm_bindgen]
impl BrowserEndpoint {
    pub async fn spawn(secret_key: Option<Vec<u8>>) -> Result<BrowserEndpoint, JsError> {
        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0);
        if let Some(bytes) = secret_key {
            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| JsError::new("Iroh device key must be exactly 32 bytes"))?;
            builder = builder.secret_key(SecretKey::from_bytes(&bytes));
        }
        let endpoint = builder.bind().await.map_err(to_js_error)?;
        Ok(Self { endpoint })
    }

    pub fn endpoint_id(&self) -> String {
        self.endpoint.id().to_string()
    }

    pub fn secret_key(&self) -> Vec<u8> {
        self.endpoint.secret_key().to_bytes().to_vec()
    }

    pub async fn pair_gateway(
        &self,
        endpoint_ticket: String,
        request_json: String,
    ) -> Result<String, JsError> {
        let request: GatewayPairRequest =
            serde_json::from_str(&request_json).context("invalid pairing request").map_err(to_js_error)?;
        let ticket = parse_ticket(&endpoint_ticket).map_err(to_js_error)?;
        let connection = self
            .endpoint
            .connect(ticket.endpoint_addr().clone(), PAIR_ALPN)
            .await
            .context("could not connect to gateway pairing endpoint")
            .map_err(to_js_error)?;
        let result = pair_gateway(connection.clone(), request).await;
        connection.close(0u8.into(), b"pairing complete");
        result.map_err(to_js_error)
    }

    pub async fn request(
        &self,
        endpoint_ticket: String,
        method: String,
        target: String,
        headers_json: String,
        body: Vec<u8>,
    ) -> Result<BrowserResponse, JsError> {
        let headers = serde_json::from_str(&headers_json)
            .context("invalid request headers")
            .map_err(to_js_error)?;
        let ticket = parse_ticket(&endpoint_ticket).map_err(to_js_error)?;
        let connection = self
            .endpoint
            .connect(ticket.endpoint_addr().clone(), TUNNEL_ALPN)
            .await
            .context("could not connect to gateway tunnel")
            .map_err(to_js_error)?;
        open_request(connection, method, target, headers, body)
            .await
            .map_err(to_js_error)
    }

    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}

#[wasm_bindgen]
pub struct BrowserResponse {
    status: u16,
    headers_json: String,
    body: Option<JsReadableStream>,
}

#[wasm_bindgen]
impl BrowserResponse {
    #[wasm_bindgen(getter)]
    pub fn status(&self) -> u16 {
        self.status
    }

    #[wasm_bindgen(getter)]
    pub fn headers_json(&self) -> String {
        self.headers_json.clone()
    }

    pub fn take_body(&mut self) -> Result<JsReadableStream, JsError> {
        self.body
            .take()
            .ok_or_else(|| JsError::new("response body has already been consumed"))
    }
}

fn parse_ticket(raw: &str) -> Result<EndpointTicket> {
    EndpointTicket::from_str(raw).context("invalid Iroh endpoint ticket")
}

async fn pair_gateway(connection: Connection, request: GatewayPairRequest) -> Result<String> {
    let (mut send, mut recv) = connection.open_bi().await?;
    write_frame(&mut send, &request).await?;
    send.finish()?;
    let response: serde_json::Value = read_frame(&mut recv).await?;
    Ok(serde_json::to_string(&response)?)
}

async fn open_request(
    connection: Connection,
    method: String,
    target: String,
    headers: serde_json::Value,
    body: Vec<u8>,
) -> Result<BrowserResponse> {
    let (mut send, mut recv) = connection.open_bi().await?;
    write_frame(
        &mut send,
        &TunnelRequestHeader {
            method,
            target,
            headers,
        },
    )
    .await?;
    if !body.is_empty() {
        send.write_all(&body).await?;
    }
    send.finish()?;
    let response: TunnelResponseHeader = read_frame(&mut recv).await?;
    let body_stream = stream::unfold(Some((recv, connection)), |state| async move {
        let (mut recv, connection) = state?;
        let mut bytes = vec![0; 64 * 1024];
        match recv.read(&mut bytes).await {
            Ok(None) => {
                connection.close(0u8.into(), b"response complete");
                None
            }
            Ok(Some(read)) => {
                bytes.truncate(read);
                let value: JsValue = Uint8Array::from(bytes.as_slice()).into();
                Some((Ok(value), Some((recv, connection))))
            }
            Err(error) => Some((
                Err(JsValue::from_str(&error.to_string())),
                None,
            )),
        }
    });
    Ok(BrowserResponse {
        status: response.status,
        headers_json: serde_json::to_string(&response.headers)?,
        body: Some(ReadableStream::from_stream(body_stream).into_raw()),
    })
}

async fn write_frame(send: &mut iroh::endpoint::SendStream, value: &impl Serialize) -> Result<()> {
    let json = serde_json::to_vec(value)?;
    anyhow::ensure!(!json.is_empty() && json.len() <= MAX_HEADER_BYTES, "header frame too large");
    send.write_all(&(json.len() as u32).to_be_bytes()).await?;
    send.write_all(&json).await?;
    Ok(())
}

async fn read_frame<T: for<'de> Deserialize<'de>>(
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<T> {
    let mut length = [0u8; 4];
    recv.read_exact(&mut length).await?;
    let length = u32::from_be_bytes(length) as usize;
    anyhow::ensure!(length > 0 && length <= MAX_HEADER_BYTES, "invalid header frame length");
    let mut json = vec![0u8; length];
    recv.read_exact(&mut json).await?;
    Ok(serde_json::from_slice(&json)?)
}

fn to_js_error(error: impl Into<anyhow::Error>) -> JsError {
    JsError::new(&error.into().to_string())
}
