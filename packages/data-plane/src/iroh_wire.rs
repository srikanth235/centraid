use std::collections::HashMap;

use anyhow::{Context, Result, bail};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};

use crate::MAX_HEADER_FRAME_BYTES;

const AUTH_MODE_HEADER: &str = "x-centraid-tunnel-auth-mode";
const AUTH_WEB_SESSION: &str = "web-session";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum WireHeaderValue {
    One(String),
    Many(Vec<String>),
}

#[derive(Debug, Deserialize)]
pub(crate) struct TunnelRequestHeader {
    pub(crate) method: String,
    pub(crate) target: String,
    #[serde(default)]
    pub(crate) headers: HashMap<String, WireHeaderValue>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TunnelResponseHeader {
    pub(crate) status: u16,
    pub(crate) headers: HashMap<String, WireHeaderValue>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Authorization {
    pub(crate) allowed: bool,
    #[serde(default)]
    pub(crate) headers: HashMap<String, String>,
    pub(crate) upstream_url: Option<String>,
    pub(crate) upstream_token: Option<String>,
}

fn hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "proxy-connection"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

pub(crate) async fn read_header<T: for<'de> Deserialize<'de>>(
    recv: &mut iroh::endpoint::RecvStream,
) -> Result<T> {
    let mut length = [0_u8; 4];
    recv.read_exact(&mut length)
        .await
        .context("read tunnel header length")?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_HEADER_FRAME_BYTES {
        bail!("tunnel header length out of bounds");
    }
    let mut json = vec![0; length];
    recv.read_exact(&mut json)
        .await
        .context("read tunnel header")?;
    serde_json::from_slice(&json).context("parse tunnel header")
}

pub(crate) async fn write_header<T: Serialize>(
    send: &mut iroh::endpoint::SendStream,
    value: &T,
) -> Result<()> {
    let json = serde_json::to_vec(value)?;
    send.write_all(&u32::try_from(json.len())?.to_be_bytes())
        .await?;
    send.write_all(&json).await?;
    Ok(())
}

pub(crate) fn request_headers(
    wire: &HashMap<String, WireHeaderValue>,
    auth: &Authorization,
    token: &str,
) -> Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    let web_session = matches!(
        wire.get(AUTH_MODE_HEADER),
        Some(WireHeaderValue::One(value)) if value == AUTH_WEB_SESSION
    );
    for (name, value) in wire {
        if hop_by_hop(name) || name.eq_ignore_ascii_case(AUTH_MODE_HEADER) {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes())?;
        match value {
            WireHeaderValue::One(value) => {
                headers.append(name, HeaderValue::from_str(value)?);
            }
            WireHeaderValue::Many(values) => {
                for value in values {
                    headers.append(name.clone(), HeaderValue::from_str(value)?);
                }
            }
        }
    }
    for (name, value) in &auth.headers {
        headers.insert(
            HeaderName::from_bytes(name.as_bytes())?,
            HeaderValue::from_str(value)?,
        );
    }
    if web_session {
        headers.remove(reqwest::header::AUTHORIZATION);
    } else {
        headers.insert(
            reqwest::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))?,
        );
    }
    Ok(headers)
}

pub(crate) fn response_headers(headers: &HeaderMap) -> HashMap<String, WireHeaderValue> {
    let mut output: HashMap<String, Vec<String>> = HashMap::new();
    for (name, value) in headers {
        if !hop_by_hop(name.as_str()) {
            output
                .entry(name.as_str().to_owned())
                .or_default()
                .push(value.to_str().unwrap_or_default().to_owned());
        }
    }
    output
        .into_iter()
        .map(|(name, mut values)| {
            let value = if values.len() == 1 {
                WireHeaderValue::One(values.pop().unwrap())
            } else {
                WireHeaderValue::Many(values)
            };
            (name, value)
        })
        .collect()
}
