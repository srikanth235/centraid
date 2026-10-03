//! The pairing payload: what `pair` prints and the phone scans (#1080).
//!
//! # FORMAT DECISION — THE QR'S TEXT
//!
//! The QR carries exactly this JSON, UTF-8, keys in this order:
//!
//! ```text
//! {"v":2,"gw":"<32 hex>","addrs":["<host>:<port>",…],"pin":"<64 hex>",
//!  "secret":"<32 hex>","exp_ms":<integer>}
//! ```
//!
//! `gw` is the gateway id the phone will sign claims to; `addrs` are where to
//! dial it, in order of preference; `pin` is BLAKE3 of the certificate the
//! phone must find there; `secret` admits one new vault; `exp_ms` is when the
//! secret stops working, on the gateway's clock.
//!
//! Parsing refuses rather than half-accepts: an unknown `v`, no address, an
//! address that is not `host:port`, or any identifier off its exact length is
//! no payload at all. A QR is read off a screen by a camera with no handshake
//! in front of it, so there is no negotiated version to interpret it under.

use serde::{Deserialize, Serialize};

use crate::rules::ids::{GatewayId, Pin, Secret};

/// The payload version this build mints and accepts.
pub const PAYLOAD_VERSION: u32 = 2;

/// The most addresses one payload carries; past this a QR stops being
/// scannable at a terminal's font size.
pub const MAX_ADDRS: usize = 8;

/// The QR's content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairPayload {
    pub v: u32,
    pub gw: GatewayId,
    pub addrs: Vec<String>,
    pub pin: Pin,
    pub secret: Secret,
    pub exp_ms: i64,
}

/// A payload that is not one.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PayloadError {
    #[error("not a pairing payload: {0}")]
    Malformed(String),
    #[error("pairing payload version {0}; this build reads {PAYLOAD_VERSION}")]
    Version(u32),
    #[error("the pairing payload names no usable address")]
    Addresses,
}

impl PairPayload {
    /// The text the QR encodes.
    #[must_use]
    pub fn to_json(&self) -> String {
        // A struct of plain fields always serialises.
        serde_json::to_string(self).unwrap_or_default()
    }

    /// Read a scanned or pasted payload. Surrounding whitespace is tolerated;
    /// nothing else is.
    ///
    /// # Errors
    ///
    /// [`PayloadError`] for anything that is not a version-2 payload with
    /// between one and [`MAX_ADDRS`] well-formed addresses.
    pub fn parse(text: &str) -> Result<Self, PayloadError> {
        let payload: Self = serde_json::from_str(text.trim())
            .map_err(|error| PayloadError::Malformed(error.to_string()))?;
        if payload.v != PAYLOAD_VERSION {
            return Err(PayloadError::Version(payload.v));
        }
        if payload.addrs.is_empty()
            || payload.addrs.len() > MAX_ADDRS
            || !payload.addrs.iter().all(|addr| is_host_port(addr))
        {
            return Err(PayloadError::Addresses);
        }
        Ok(payload)
    }

    /// Has the secret's day passed? Exclusive at the edge, matching the
    /// gateway's own check, so the two cannot disagree by a millisecond.
    #[must_use]
    pub const fn is_expired(&self, now_ms: i64) -> bool {
        now_ms >= self.exp_ms
    }
}

/// `host:port`, where host is a name, an IPv4 address or a bracketed IPv6
/// address, and the port is not zero.
#[must_use]
pub fn is_host_port(addr: &str) -> bool {
    if addr.len() > 255 || addr.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return false;
    }
    let Some((host, port)) = addr.rsplit_once(':') else {
        return false;
    };
    let port_ok = port.parse::<u16>().is_ok_and(|port| port != 0);
    let host_ok = if let Some(inner) = host.strip_prefix('[') {
        inner
            .strip_suffix(']')
            .is_some_and(|ip| ip.parse::<core::net::Ipv6Addr>().is_ok())
    } else {
        !host.is_empty() && !host.contains(':')
    };
    port_ok && host_ok
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> PairPayload {
        PairPayload {
            v: PAYLOAD_VERSION,
            gw: GatewayId::from_bytes([0xa1; 16]),
            addrs: vec![
                "192.168.1.20:8443".to_owned(),
                "[fd00::20]:8443".to_owned(),
                "ada-laptop.local:8443".to_owned(),
            ],
            pin: Pin::from_bytes([0xb2; 32]),
            secret: Secret::from_bytes([0xc3; 16]),
            exp_ms: 1_790_000_000_000,
        }
    }

    #[test]
    fn a_payload_round_trips_through_its_text() {
        let text = payload().to_json();
        assert!(text.starts_with(r#"{"v":2,"gw":""#), "{text}");
        assert_eq!(PairPayload::parse(&format!("  {text}\n")), Ok(payload()));
    }

    /// Each of these is a payload a lenient parser would half-accept.
    #[test]
    fn every_malformed_payload_is_refused() {
        let good = serde_json::to_value(payload()).expect("serialises");
        let with = |key: &str, value: serde_json::Value| {
            let mut changed = good.clone();
            changed[key] = value;
            changed.to_string()
        };
        assert_eq!(
            PairPayload::parse(&with("v", 1.into())),
            Err(PayloadError::Version(1))
        );
        assert_eq!(
            PairPayload::parse(&with("addrs", serde_json::json!([]))),
            Err(PayloadError::Addresses)
        );
        for bad in [
            "192.168.1.20",
            "host:0",
            ":8443",
            "[fd00::20:8443",
            "a b:1",
            "fd00::1:80",
        ] {
            assert_eq!(
                PairPayload::parse(&with("addrs", serde_json::json!([bad]))),
                Err(PayloadError::Addresses),
                "{bad}"
            );
        }
        for (key, value) in [
            ("pin", serde_json::json!("B2".repeat(32))),
            ("gw", serde_json::json!("a1".repeat(15))),
            ("secret", serde_json::json!(null)),
        ] {
            assert!(
                matches!(
                    PairPayload::parse(&with(key, value)),
                    Err(PayloadError::Malformed(_))
                ),
                "{key}"
            );
        }
        assert!(PairPayload::parse("not json").is_err());
    }

    #[test]
    fn expiry_is_exclusive_at_the_edge() {
        let payload = payload();
        assert!(!payload.is_expired(payload.exp_ms - 1));
        assert!(payload.is_expired(payload.exp_ms));
    }

    /// The secret is a credential, and a payload's `Debug` does not print it.
    #[test]
    fn a_payload_debug_hides_its_secret() {
        let printed = format!("{:?}", payload());
        assert!(!printed.contains(&"c3".repeat(16)), "{printed}");
    }
}
