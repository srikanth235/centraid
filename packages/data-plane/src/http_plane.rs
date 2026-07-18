use std::{
    collections::{BTreeMap, HashMap},
    io::Cursor,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use image::{ImageDecoder, ImageFormat, ImageReader, Limits, codecs::jpeg::JpegEncoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
    net::TcpListener,
    sync::Mutex,
};
use tokio_util::io::ReaderStream;

use crate::{MAX_OPEN_RANGE_BYTES, ticket};

const MAX_TRANSFORM_BODY: usize = 32 * 1024 * 1024;
const MAX_PREVIEW_EDGE: u32 = 12_000;
const MAX_PREVIEW_PIXELS: u64 = 40_000_000;
const MAX_PREVIEW_ALLOC_BYTES: u64 = 192 * 1024 * 1024;

#[derive(Clone)]
struct PlaneState {
    root: Arc<PathBuf>,
    ticket_secret: Arc<Vec<u8>>,
    used_nonces: Arc<Mutex<HashMap<String, u64>>>,
}

#[derive(Debug, Clone)]
pub struct HttpPlaneConfig {
    pub listen: String,
    pub root: PathBuf,
    pub ticket_secret: Vec<u8>,
}

#[derive(Deserialize)]
struct BlobQuery {
    ticket: String,
}

#[derive(Deserialize)]
struct PreviewQuery {
    #[serde(default = "default_preview_edge")]
    edge: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PumpRequest {
    relative_path: String,
    destination_url: String,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    offset: u64,
    length: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PumpResponse {
    byte_size: u64,
    provider_status: u16,
    etag: Option<String>,
}

fn default_preview_edge() -> u32 {
    256
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HashResponse {
    sha256: String,
    byte_size: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn error(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        format!(r#"{{"error":{}}}"#, serde_json::to_string(message).unwrap()),
    )
        .into_response()
}

fn has_control_secret(headers: &HeaderMap, state: &PlaneState) -> bool {
    let supplied = headers
        .get("x-centraid-data-plane-secret")
        .map(HeaderValue::as_bytes)
        .unwrap_or_default();
    supplied.len() == state.ticket_secret.len()
        && supplied.ct_eq(state.ticket_secret.as_slice()).unwrap_u8() == 1
}

fn safe_relative(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = Path::new(relative);
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return None;
    }
    Some(root.join(relative))
}

fn parse_range(value: Option<&HeaderValue>, size: u64) -> Option<(u64, u64)> {
    let raw = value?.to_str().ok()?.strip_prefix("bytes=")?;
    if raw.contains(',') {
        return None;
    }
    let (start, end) = raw.split_once('-')?;
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?.min(size);
        if suffix == 0 {
            return None;
        }
        return Some((size.saturating_sub(suffix), size.saturating_sub(1)));
    }
    let start = start.parse::<u64>().ok()?;
    if start >= size {
        return None;
    }
    let end = if end.is_empty() {
        start.saturating_add(MAX_OPEN_RANGE_BYTES - 1).min(size - 1)
    } else {
        end.parse::<u64>().ok()?.min(size - 1)
    };
    (start <= end).then_some((start, end))
}

async fn serve_blob(
    State(state): State<PlaneState>,
    method: Method,
    Query(query): Query<BlobQuery>,
    headers: HeaderMap,
) -> Response {
    let ticket = match ticket::verify(&state.ticket_secret, &query.ticket, now_ms()) {
        Ok(ticket) => ticket,
        Err(_) => return error(StatusCode::UNAUTHORIZED, "invalid_ticket"),
    };
    {
        let mut used = state.used_nonces.lock().await;
        if used.contains_key(&ticket.nonce) {
            return error(StatusCode::UNAUTHORIZED, "ticket_replayed");
        }
        // Tickets live for seconds. Bound the set during long-running service
        // without dropping still-valid replay proofs wholesale.
        if used.len() >= 65_536 {
            let now = now_ms();
            used.retain(|_, expires_at_ms| *expires_at_ms >= now);
            if used.len() >= 65_536 {
                return error(StatusCode::SERVICE_UNAVAILABLE, "ticket_replay_cache_full");
            }
        }
        used.insert(ticket.nonce.clone(), ticket.expires_at_ms);
    }
    let Some(candidate) = safe_relative(&state.root, &ticket.relative_path) else {
        return error(StatusCode::FORBIDDEN, "invalid_path");
    };
    let path = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) if path.starts_with(state.root.as_ref()) => path,
        _ => return error(StatusCode::NOT_FOUND, "blob_not_found"),
    };
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return error(StatusCode::NOT_FOUND, "blob_not_found"),
    };
    let size = metadata.len();
    if size == 0 {
        return error(StatusCode::NOT_FOUND, "blob_empty");
    }
    let requested_range = headers.get(header::RANGE);
    let range = parse_range(requested_range, size);
    if requested_range.is_some() && range.is_none() {
        let mut response = error(StatusCode::RANGE_NOT_SATISFIABLE, "invalid_range");
        response.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes */{size}")).unwrap(),
        );
        return response;
    }
    let (start, end, status) = range
        .map(|(start, end)| (start, end, StatusCode::PARTIAL_CONTENT))
        .unwrap_or((0, size - 1, StatusCode::OK));
    let length = end - start + 1;

    let mut response = if method == Method::HEAD {
        Response::new(Body::empty())
    } else {
        let mut file = match File::open(path).await {
            Ok(file) => file,
            Err(_) => return error(StatusCode::NOT_FOUND, "blob_not_found"),
        };
        if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return error(StatusCode::INTERNAL_SERVER_ERROR, "blob_seek_failed");
        }
        Response::new(Body::from_stream(ReaderStream::new(file.take(length))))
    };
    *response.status_mut() = status;
    let output_headers = response.headers_mut();
    output_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    output_headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    output_headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&length.to_string()).unwrap(),
    );
    if let Ok(value) = HeaderValue::from_str(&ticket.media_type) {
        output_headers.insert(header::CONTENT_TYPE, value);
    }
    if let Ok(value) = HeaderValue::from_str(&ticket.disposition) {
        output_headers.insert(header::CONTENT_DISPOSITION, value);
    }
    if let Ok(value) = HeaderValue::from_str(&ticket.etag) {
        output_headers.insert(header::ETAG, value);
    }
    if range.is_some() {
        output_headers.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")).unwrap(),
        );
    }
    response
}

async fn hash_body(State(state): State<PlaneState>, headers: HeaderMap, body: Body) -> Response {
    if !has_control_secret(&headers, &state) {
        return error(StatusCode::FORBIDDEN, "invalid_data_plane_secret");
    }
    let mut digest = Sha256::new();
    let mut size = 0_u64;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else {
            return error(StatusCode::BAD_REQUEST, "body_read_failed");
        };
        size += chunk.len() as u64;
        digest.update(&chunk);
    }
    axum::Json(HashResponse {
        sha256: hex::encode(digest.finalize()),
        byte_size: size,
    })
    .into_response()
}

async fn compress_body(
    State(state): State<PlaneState>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !has_control_secret(&headers, &state) {
        return error(StatusCode::FORBIDDEN, "invalid_data_plane_secret");
    }
    let bytes = match to_bytes(body, MAX_TRANSFORM_BODY).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
    };
    match tokio::task::spawn_blocking(move || zstd::stream::encode_all(Cursor::new(bytes), 3)).await
    {
        Ok(Ok(output)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/zstd")],
            output,
        )
            .into_response(),
        _ => error(StatusCode::INTERNAL_SERVER_ERROR, "compression_failed"),
    }
}

fn render_preview(bytes: &[u8], edge: u32) -> Result<Vec<u8>> {
    let format = image::guess_format(bytes)?;
    if !matches!(format, ImageFormat::Jpeg | ImageFormat::Png) {
        anyhow::bail!("unsupported image format");
    }

    // Read only the container dimensions first. The advertised caps must be
    // checked before allocating the decoded raster, or a compressed image
    // bomb can consume the low-end host before the post-decode guard runs.
    let dimensions = ImageReader::with_format(Cursor::new(bytes), format).into_dimensions()?;
    if dimensions.0 > MAX_PREVIEW_EDGE
        || dimensions.1 > MAX_PREVIEW_EDGE
        || u64::from(dimensions.0) * u64::from(dimensions.1) > MAX_PREVIEW_PIXELS
    {
        anyhow::bail!("image dimensions exceed cap");
    }

    let mut orientation_reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut orientation_limits = Limits::default();
    orientation_limits.max_image_width = Some(MAX_PREVIEW_EDGE);
    orientation_limits.max_image_height = Some(MAX_PREVIEW_EDGE);
    orientation_limits.max_alloc = Some(MAX_PREVIEW_ALLOC_BYTES);
    orientation_reader.limits(orientation_limits);
    let orientation = orientation_reader.into_decoder()?.orientation()?;

    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_PREVIEW_EDGE);
    limits.max_image_height = Some(MAX_PREVIEW_EDGE);
    limits.max_alloc = Some(MAX_PREVIEW_ALLOC_BYTES);
    reader.limits(limits);
    let mut image = reader.decode()?;
    image.apply_orientation(orientation);
    let resized = if image.width() > edge || image.height() > edge {
        image.thumbnail(edge, edge)
    } else {
        image
    }
    .to_rgb8();
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, 80).encode_image(&resized)?;
    Ok(output)
}

async fn preview_body(
    State(state): State<PlaneState>,
    Query(query): Query<PreviewQuery>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !has_control_secret(&headers, &state) {
        return error(StatusCode::FORBIDDEN, "invalid_data_plane_secret");
    }
    if !(32..=4096).contains(&query.edge) {
        return error(StatusCode::BAD_REQUEST, "invalid_edge");
    }
    let bytes = match to_bytes(body, MAX_TRANSFORM_BODY).await {
        Ok(bytes) => bytes,
        Err(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large"),
    };
    let edge = query.edge;
    match tokio::task::spawn_blocking(move || render_preview(&bytes, edge)).await {
        Ok(Ok(output)) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "image/jpeg")],
            output,
        )
            .into_response(),
        _ => error(StatusCode::UNSUPPORTED_MEDIA_TYPE, "preview_failed"),
    }
}

/// Move one authorized file window to a pre-authorized provider URL. TS keeps
/// multipart/SigV4 policy; Rust owns the file read, upload body, and backpressure.
async fn pump_put(
    State(state): State<PlaneState>,
    headers: HeaderMap,
    axum::Json(input): axum::Json<PumpRequest>,
) -> Response {
    if !has_control_secret(&headers, &state) {
        return error(StatusCode::FORBIDDEN, "invalid_data_plane_secret");
    }
    let destination = match reqwest::Url::parse(&input.destination_url) {
        Ok(url)
            if url.scheme() == "https"
                || (url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))) =>
        {
            url
        }
        _ => return error(StatusCode::BAD_REQUEST, "invalid_destination"),
    };
    let Some(candidate) = safe_relative(&state.root, &input.relative_path) else {
        return error(StatusCode::FORBIDDEN, "invalid_path");
    };
    let path = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) if path.starts_with(state.root.as_ref()) => path,
        _ => return error(StatusCode::NOT_FOUND, "source_not_found"),
    };
    let metadata = match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => metadata,
        _ => return error(StatusCode::NOT_FOUND, "source_not_found"),
    };
    if input.offset > metadata.len() {
        return error(StatusCode::RANGE_NOT_SATISFIABLE, "invalid_source_window");
    }
    let length = input
        .length
        .unwrap_or_else(|| metadata.len().saturating_sub(input.offset));
    if input.offset.saturating_add(length) > metadata.len() {
        return error(StatusCode::RANGE_NOT_SATISFIABLE, "invalid_source_window");
    }
    let mut file = match File::open(path).await {
        Ok(file) => file,
        Err(_) => return error(StatusCode::NOT_FOUND, "source_not_found"),
    };
    if file
        .seek(std::io::SeekFrom::Start(input.offset))
        .await
        .is_err()
    {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "source_seek_failed");
    }
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(120))
        .build()
    {
        Ok(client) => client,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "http_client_failed"),
    };
    let mut request = client
        .put(destination)
        .header(reqwest::header::CONTENT_LENGTH, length)
        .body(reqwest::Body::wrap_stream(ReaderStream::new(
            file.take(length),
        )));
    if input.headers.len() > 64 {
        return error(StatusCode::BAD_REQUEST, "too_many_headers");
    }
    for (name, value) in input.headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "host" | "content-length" | "transfer-encoding"
        ) {
            return error(StatusCode::BAD_REQUEST, "forbidden_header");
        }
        let Ok(name) = reqwest::header::HeaderName::from_bytes(name.as_bytes()) else {
            return error(StatusCode::BAD_REQUEST, "invalid_header");
        };
        let Ok(value) = reqwest::header::HeaderValue::from_str(&value) else {
            return error(StatusCode::BAD_REQUEST, "invalid_header");
        };
        request = request.header(name, value);
    }
    let provider = match request.send().await {
        Ok(response) => response,
        Err(_) => return error(StatusCode::BAD_GATEWAY, "provider_request_failed"),
    };
    let provider_status = provider.status().as_u16();
    let etag = provider
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let body = axum::Json(PumpResponse {
        byte_size: length,
        provider_status,
        etag,
    });
    if provider.status().is_success() {
        body.into_response()
    } else {
        (StatusCode::BAD_GATEWAY, body).into_response()
    }
}

pub async fn serve(config: HttpPlaneConfig) -> Result<()> {
    let root = tokio::fs::canonicalize(&config.root)
        .await
        .with_context(|| format!("canonicalize data root {}", config.root.display()))?;
    let state = PlaneState {
        root: Arc::new(root),
        ticket_secret: Arc::new(config.ticket_secret),
        used_nonces: Arc::new(Mutex::new(HashMap::new())),
    };
    let app = Router::new()
        .route("/v1/health", get(|| async { "ok" }))
        .route("/v1/blob", get(serve_blob).head(serve_blob))
        .route("/v1/hash", post(hash_body))
        .route("/v1/compress", post(compress_body))
        .route("/v1/preview", post(preview_body))
        .route("/v1/pump", post(pump_put))
        .with_state(state);
    let listener = TcpListener::bind(&config.listen)
        .await
        .with_context(|| format!("bind byte plane at {}", config.listen))?;
    tracing::info!(listen = %config.listen, "Centraid byte plane listening");
    axum::serve(listener, app).await.context("serve byte plane")
}
#[cfg(test)]
#[path = "http_plane_tests.rs"]
mod tests;
