//! The pairing QR, for a terminal (#1080).
//!
//! The renderer is `centraid_identity::ticket::qr`'s, carried over by copy:
//! half-block Unicode, so one text row carries two module rows and the code
//! is square on screen at a normal font size. A headless gateway on a VPS has
//! a terminal and nothing else, so this IS the pairing surface.

use qrcode::QrCode;
use qrcode::render::unicode::Dense1x2;

/// `text` as a QR for a terminal.
///
/// # Errors
///
/// If `text` does not fit in a QR code.
pub fn render(text: &str) -> Result<String, qrcode::types::QrError> {
    let code = QrCode::new(text.as_bytes())?;
    Ok(code
        .render::<Dense1x2>()
        .dark_color(Dense1x2::Light)
        .light_color(Dense1x2::Dark)
        .quiet_zone(true)
        .build())
}

/// How many modules wide `text`'s QR is.
///
/// # Errors
///
/// If `text` does not fit in a QR code.
pub fn width(text: &str) -> Result<usize, qrcode::types::QrError> {
    Ok(QrCode::new(text.as_bytes())?.width())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::ids::{GatewayId, Pin, Secret};
    use crate::rules::payload::{PAYLOAD_VERSION, PairPayload};

    /// A realistic payload — four addresses, a host name — fits a QR a phone
    /// reads across a desk: version 14 (73 modules) or smaller.
    #[test]
    fn a_full_payload_fits_a_scannable_qr() {
        let payload = PairPayload {
            v: PAYLOAD_VERSION,
            gw: GatewayId::from_bytes([0xa1; 16]),
            addrs: vec![
                "192.168.100.200:8443".to_owned(),
                "10.200.100.250:8443".to_owned(),
                "[fd00:1234:5678::abcd]:8443".to_owned(),
                "adas-macbook-pro.local:8443".to_owned(),
            ],
            pin: Pin::from_bytes([0xb2; 32]),
            secret: Secret::from_bytes([0xc3; 16]),
            exp_ms: 1_790_000_000_000,
        }
        .to_json();
        let modules = width(&payload).expect("fits");
        assert!(
            modules <= 73,
            "{modules} modules for {} bytes",
            payload.len()
        );
        let rendered = render(&payload).expect("renders");
        assert!(rendered.lines().count() > 20);
    }
}
