//! A GATEWAY BELOW PROTOCOL 1 IS REFUSED, OVER THE WIRE (#1191, B1, E13).
//!
//! A stub with a real certificate and real TLS plays an older gateway: it
//! answers `/v1/info` with protocol 0. The real client must return
//! `GatewayTooOld { found: 0, required: 1 }` and must not send a second
//! request.

use std::sync::Arc;

use axum::Router;
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse as _, Response};
use axum::routing::any;
use centraid_gateway::client::{Client, ClientError};
use centraid_gateway::rules::ids::GatewayId;
use centraid_gateway::rules::limits::REQUIRED_PROTOCOL;
use centraid_gateway::server::serve::{TlsListener, bind, run_router};
use centraid_gateway::server::tls::Identity;

/// What an older gateway says: `/v1/info` reports a protocol below `REQUIRED_PROTOCOL`.
async fn older(uri: Uri, paths: Arc<std::sync::Mutex<Vec<String>>>) -> Response {
    paths.lock().expect("paths").push(uri.path().to_owned());
    if uri.path() == "/v1/info" {
        return axum::Json(serde_json::json!({
            "gateway_id": "05050505050505050505050505050505",
            "protocol": 0,
            "time_ms": 1
        }))
        .into_response();
    }
    let mut response = (
        StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({"code": "NOT_FOUND", "time_ms": 1})),
    )
        .into_response();
    response
        .headers_mut()
        .insert("centraid-code", HeaderValue::from_static("NOT_FOUND"));
    response
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_gateway_below_required_protocol_is_refused() {
    let dir = tempfile::tempdir().expect("a temp dir");
    let identity = Identity::load_or_mint(dir.path(), || GatewayId::from_bytes([5; 16]))
        .expect("a certificate");
    let listener = TlsListener::new(
        bind("127.0.0.1:0").await.expect("binds"),
        identity.server_config().expect("a TLS config"),
    )
    .expect("a TLS listener");
    let addr = listener.local();
    let paths: Arc<std::sync::Mutex<Vec<String>>> = Arc::default();
    let seen = Arc::clone(&paths);
    let router = Router::new().fallback(any(move |uri: Uri| older(uri, Arc::clone(&seen))));
    let server = tokio::spawn(run_router(listener, router, std::future::pending()));

    let phone = Client::trusting(vec![addr.to_string()], identity.cert_der().to_vec());
    match phone.info().await {
        Err(ClientError::GatewayTooOld { found, required }) => {
            assert_eq!((found, required), (0, REQUIRED_PROTOCOL));
        }
        other => panic!("an older gateway was not refused as too old: {other:?}"),
    }
    assert_eq!(
        *paths.lock().expect("paths"),
        vec!["/v1/info".to_owned()],
        "it asked /v1/info once and stopped"
    );
    server.abort();
}
