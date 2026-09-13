//! The pair ticket, its encoding and its QR (#1020, D-1020-C8).
//!
//! `base64url(PairTicket)` — a protobuf message, not JSON. v0's ticket is
//! `base64url(JSON.stringify(payload))`
//! (`packages/server/src/serve/pairing-ticket-codec.ts:11-13`); protobuf is
//! smaller in a QR (fewer modules, so a lower error-correction level is enough
//! at a phone's scanning distance) and cannot be hand-edited into a shape a
//! lenient parser half-accepts.
//!
//! **No key rides the ticket**
//! (`packages/core/src/protocol/seat-log.ts:143-158`). The ticket is read off a
//! screen by a camera, survives in a photo roll, and is validated before any
//! device exists to be a principal. The vault's Locker key reaches a seat over
//! the authenticated post-pair channel only.
//!
//! Parsing **returns an option rather than throwing**, and refuses an unknown
//! `v`. v0 does the same (`pairing-ticket-codec.ts:15-36`), and the reason is
//! that a ticket is the one message with no handshake in front of it: there is
//! no negotiated version to interpret it under, so the version is in the
//! payload and a mismatch is a refusal.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use centraid_api_proto::core_v1::PairTicket;
use prost::Message as _;
use qrcode::QrCode;
use qrcode::render::unicode::Dense1x2;
use rand::TryRngCore as _;

/// The ticket format version this build mints and accepts.
pub const TICKET_VERSION: u32 = 1;

/// 15 minutes, v0's `DEFAULT_TICKET_TTL_MS`
/// (`packages/server/src/serve/pairing-store.ts:21`).
pub const TICKET_TTL_MS: u64 = 15 * 60 * 1000;

/// 128 bits. The secret is guessed or it is not; a longer one costs QR modules
/// and buys nothing against an attacker who has 15 minutes and one attempt per
/// round trip.
pub const SECRET_BYTES: usize = 16;

/// A fresh ticket secret, from the OS.
///
/// `try_os_rng` rather than a thread-local generator: a pairing secret is the
/// one value in this crate whose predictability would hand over a vault, so the
/// source is the operating system and a failure to read it is an error rather
/// than a fallback.
pub fn fresh_secret() -> std::io::Result<Vec<u8>> {
    let mut secret = vec![0u8; SECRET_BYTES];
    rand::rngs::OsRng
        .try_fill_bytes(&mut secret)
        .map_err(std::io::Error::other)?;
    Ok(secret)
}

/// Encode a ticket for a QR or for a copy-and-paste hand-off.
pub fn encode(ticket: &PairTicket) -> String {
    BASE64URL.encode(ticket.encode_to_vec())
}

/// Decode one. `None` for anything that is not a `v = TICKET_VERSION` ticket
/// with every load-bearing field present — never a partially-trusted ticket.
pub fn decode(encoded: &str) -> Option<PairTicket> {
    let bytes = BASE64URL.decode(encoded.trim()).ok()?;
    let ticket = PairTicket::decode(bytes.as_slice()).ok()?;
    if ticket.v != TICKET_VERSION {
        return None;
    }
    if ticket.gateway_endpoint.len() != 32
        || ticket.ticket_id.is_empty()
        || ticket.secret.is_empty()
        || ticket.expires_at_ms == 0
    {
        return None;
    }
    Some(ticket)
}

/// Has the ticket's TTL passed? Exclusive at the edge, matching the allowlist's
/// own check, so the two cannot disagree by a millisecond.
pub fn is_expired(ticket: &PairTicket, now_ms: u64) -> bool {
    ticket.expires_at_ms <= now_ms
}

/// The ticket as a QR, rendered for a terminal.
///
/// Half-block Unicode, which is what makes a QR scannable at a normal terminal
/// font size: one text row carries two module rows, so the code is roughly
/// square on screen instead of twice as tall as it is wide. A headless gateway
/// on a VPS has a terminal and nothing else, so this IS the pairing surface
/// (#1020: `centraid gateway` prints a pair QR).
pub fn qr(encoded: &str) -> Result<String, qrcode::types::QrError> {
    let code = QrCode::new(encoded.as_bytes())?;
    Ok(code
        .render::<Dense1x2>()
        .dark_color(Dense1x2::Light)
        .light_color(Dense1x2::Dark)
        .quiet_zone(true)
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ticket() -> PairTicket {
        PairTicket {
            v: TICKET_VERSION,
            gateway_endpoint: vec![0x11; 32],
            relay_url: String::new(),
            ticket_id: "tkt_1".to_owned(),
            secret: vec![0x22; SECRET_BYTES],
            vault_name: "Home".to_owned(),
            expires_at_ms: TICKET_TTL_MS,
            direct_addrs: vec!["192.168.1.20:41234".to_owned()],
        }
    }

    #[test]
    fn a_ticket_round_trips_through_base64url() {
        let encoded = encode(&ticket());
        assert_eq!(decode(&encoded).expect("decoded"), ticket());
        // base64url, no padding: safe in a URL, in a filename and in a QR's
        // alphanumeric mode.
        assert!(
            !encoded.contains('=') && !encoded.contains('+') && !encoded.contains('/'),
            "{encoded}"
        );
    }

    /// Surrounding whitespace is tolerated, because the ticket is pasted out of
    /// a terminal by hand at least as often as it is scanned.
    #[test]
    fn a_pasted_ticket_with_whitespace_still_decodes() {
        let encoded = encode(&ticket());
        assert!(decode(&format!("  {encoded}\n")).is_some());
    }

    /// The refusals, one per row. Each is a ticket a lenient parser would have
    /// half-accepted, and a half-accepted ticket is a pairing attempt against a
    /// gateway coordinate nobody checked.
    #[test]
    fn every_malformed_ticket_is_refused_rather_than_half_accepted() {
        let rows: [(&str, PairTicket); 5] = [
            ("an unknown format version", PairTicket { v: 2, ..ticket() }),
            (
                "an endpoint id that is not 32 bytes",
                PairTicket {
                    gateway_endpoint: vec![0x11; 31],
                    ..ticket()
                },
            ),
            (
                "no ticket id",
                PairTicket {
                    ticket_id: String::new(),
                    ..ticket()
                },
            ),
            (
                "no secret",
                PairTicket {
                    secret: Vec::new(),
                    ..ticket()
                },
            ),
            (
                "no expiry, which would never expire",
                PairTicket {
                    expires_at_ms: 0,
                    ..ticket()
                },
            ),
        ];
        for (description, malformed) in rows {
            assert!(
                decode(&encode(&malformed)).is_none(),
                "accepted a ticket with {description}"
            );
        }
        assert!(decode("not base64url at all !!!").is_none());
        assert!(decode("").is_none());
        // Well-formed base64url that is not a ticket.
        assert!(decode(&BASE64URL.encode([0xff, 0xff, 0xff, 0xff])).is_none());
    }

    #[test]
    fn expiry_is_exclusive_at_the_edge() {
        let ticket = ticket();
        assert!(!is_expired(&ticket, TICKET_TTL_MS - 1));
        assert!(is_expired(&ticket, TICKET_TTL_MS));
        assert!(is_expired(&ticket, TICKET_TTL_MS + 1));
        assert_eq!(TICKET_TTL_MS, 900_000, "15 minutes, as v0 mints");
    }

    /// The whole ticket fits in a QR a phone camera can read across a desk.
    /// The assertion is on the QR's VERSION (its module count), because that is
    /// what decides whether the code is scannable at a terminal font size — and
    /// it is the number that would quietly grow if a field were added to the
    /// ticket.
    #[test]
    fn the_ticket_fits_in_a_scannable_qr() {
        let encoded = encode(&ticket());
        let code = QrCode::new(encoded.as_bytes()).expect("a QR");
        let width = code.width();
        assert!(
            width <= 57,
            "the ticket needs a QR of {width} modules, past version 10 — a phone will struggle at \
             terminal font size, and a field was probably added to PairTicket"
        );
        let rendered = qr(&encoded).expect("rendered");
        assert!(rendered.lines().count() > 10);
        assert!(rendered.contains('█') || rendered.contains('▀') || rendered.contains('▄'));
    }

    #[test]
    fn a_fresh_secret_is_sixteen_bytes_and_not_the_previous_one() {
        let first = fresh_secret().expect("the OS rng");
        let second = fresh_secret().expect("the OS rng");
        assert_eq!(first.len(), SECRET_BYTES);
        assert_ne!(first, second);
        assert_ne!(first, vec![0u8; SECRET_BYTES]);
    }
}
