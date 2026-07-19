use centraid_data_plane::iroh_relay::{IrohRelayConfig, IrohRelayHandle};
use napi::{Error, Result, Status};
use napi_derive::napi;

#[napi(object)]
pub struct NativeGatewayRelayOptions {
    #[napi(js_name = "secretKeyHex")]
    pub secret_key_hex: String,
    #[napi(js_name = "upstreamUrl")]
    pub upstream_url: String,
    #[napi(js_name = "upstreamToken")]
    pub upstream_token: String,
    #[napi(js_name = "controlSecret")]
    pub control_secret: String,
    #[napi(js_name = "useN0Relays")]
    pub use_n0_relays: bool,
}

#[napi(object)]
pub struct NativeDesktopRelayOptions {
    #[napi(js_name = "secretKeyHex")]
    pub secret_key_hex: String,
    #[napi(js_name = "controlUrl")]
    pub control_url: String,
    #[napi(js_name = "controlSecret")]
    pub control_secret: String,
    #[napi(js_name = "useN0Relays")]
    pub use_n0_relays: bool,
}

#[napi]
pub struct NativeGatewayRelay {
    handle: IrohRelayHandle,
}

#[napi]
impl NativeGatewayRelay {
    #[napi(getter, js_name = "endpointId")]
    pub fn endpoint_id(&self) -> String {
        self.handle.endpoint_id()
    }

    #[napi]
    pub fn ticket(&self) -> String {
        self.handle.ticket()
    }

    #[napi]
    pub async fn close(&self) {
        self.handle.close().await;
    }

    #[napi(js_name = "revokeEndpoint")]
    pub async fn revoke_endpoint(&self, endpoint_id: String) {
        self.handle.revoke_endpoint(&endpoint_id).await;
    }
}

fn key32(encoded: &str) -> Result<[u8; 32]> {
    hex::decode(encoded)
        .map_err(|error| {
            Error::new(
                Status::InvalidArg,
                format!("secret key is not hex: {error}"),
            )
        })?
        .try_into()
        .map_err(|_| Error::new(Status::InvalidArg, "secret key must contain 32 bytes"))
}

#[napi(js_name = "startGatewayRelay")]
pub async fn start_gateway_relay(options: NativeGatewayRelayOptions) -> Result<NativeGatewayRelay> {
    let handle = centraid_data_plane::iroh_relay::start(IrohRelayConfig {
        secret_key: key32(&options.secret_key_hex)?,
        control_url: options.upstream_url.clone(),
        control_token: options.upstream_token.clone(),
        upstream_url: options.upstream_url,
        upstream_token: options.upstream_token,
        control_secret: options.control_secret,
        use_n0_relays: options.use_n0_relays,
        desktop_pairing: false,
    })
    .await
    .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
    Ok(NativeGatewayRelay { handle })
}

#[napi(js_name = "startDesktopRelay")]
pub async fn start_desktop_relay(options: NativeDesktopRelayOptions) -> Result<NativeGatewayRelay> {
    let handle = centraid_data_plane::iroh_relay::start(IrohRelayConfig {
        secret_key: key32(&options.secret_key_hex)?,
        upstream_url: String::new(),
        upstream_token: String::new(),
        control_url: options.control_url,
        control_token: String::new(),
        control_secret: options.control_secret,
        use_n0_relays: options.use_n0_relays,
        desktop_pairing: true,
    })
    .await
    .map_err(|error| Error::new(Status::GenericFailure, error.to_string()))?;
    Ok(NativeGatewayRelay { handle })
}
