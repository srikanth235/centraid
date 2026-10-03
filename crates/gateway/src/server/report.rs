//! What the gateway's terminal says (#1080).
//!
//! Strings only; the binary prints them. A headless gateway has a terminal
//! and nothing else, so these lines are its whole interface to the member:
//! the pairing payload and its QR, the safety number when a phone pairs, and
//! what `pairings` lists. They never print a token or a secret the gateway
//! keeps — it keeps none — and the one secret they show, a fresh pairing
//! secret inside the payload, exists nowhere else.
//!
//! # THE SAFETY NUMBER
//!
//! The digits a member may compare between the phone and the gateway are
//! `centraid_identity::safety_number_of_bytes` over the vault's identity key
//! (its id) and the certificate's pin, the one function both screens render
//! with (#1080, the root's ruling A17). **The pin is what the phone checks;
//! the number is a display.** The function reads both as 32 bytes and decodes
//! neither, so every gateway has a number, whatever its pin hashes to.

use crate::rules::engine::Pairing;
use crate::rules::ids::{Pin, TokenHash, VaultId};
use crate::rules::payload::PairPayload;
use crate::rules::wire::PairKind;
use crate::server::Event;
use crate::server::qr;

/// A moment as the terminal prints it: UTC, to the minute.
#[must_use]
pub fn utc(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms).map_or_else(
        |_| format!("{ms} ms"),
        |at| at.strftime("%Y-%m-%d %H:%M UTC").to_string(),
    )
}

/// A vault as the terminal names it: the first eight hex of its id.
#[must_use]
pub fn short(vault: &VaultId) -> String {
    format!("{}…", &vault.hex()[..8])
}

/// The safety number's digits for this vault on this gateway, twelve groups
/// of five. See the module header.
#[must_use]
pub fn safety_digits(vault: &VaultId, pin: &Pin) -> String {
    centraid_identity::safety_number_of_bytes(vault.as_bytes(), pin.as_bytes()).grouped()
}

/// The `safety` line.
#[must_use]
pub fn safety_line(vault: &VaultId, pin: &Pin) -> String {
    format!("safety    {}", safety_digits(vault, pin))
}

/// What `serve` prints when a pairing lands.
#[must_use]
pub fn event_lines(event: &Event, pin: &Pin) -> Vec<String> {
    match event {
        Event::Paired {
            vault,
            kind,
            epoch,
            label,
        } => {
            let how = match kind {
                PairKind::Secret => "paired with a pairing secret",
                PairKind::Claim => "claimed by its identity key",
                PairKind::Read => "granted reads by its identity key",
            };
            vec![
                format!(
                    "paired    vault {} {how}, epoch {epoch}, {:?}",
                    short(vault),
                    label
                ),
                safety_line(vault, pin),
            ]
        }
    }
}

/// What `pairings` prints for one vault.
#[must_use]
pub fn pairing_lines(pairing: &Pairing, pin: &Pin) -> Vec<String> {
    let vault = &pairing.vault;
    let mut lines = vec![format!(
        "vault     {}  writer epoch {}  paired {}{}",
        short(&vault.vault),
        vault.writer_epoch,
        utc(vault.paired_at_ms),
        vault
            .moved_at_ms
            .map(|at| format!("  moved {}", utc(at)))
            .unwrap_or_default()
    )];
    lines.push(format!("  {}", safety_line(&vault.vault, pin)));
    match &pairing.head {
        Some(head) => lines.push(format!(
            "  head    {}…  taken {}  set {}",
            &head.name.hex()[..8],
            utc(head.taken_at_ms),
            utc(head.set_at_ms)
        )),
        None => lines.push("  head    none yet".to_owned()),
    }
    for token in &pairing.tokens {
        let standing = if token.epoch == vault.writer_epoch {
            "writes"
        } else {
            "reads only"
        };
        lines.push(format!(
            "  token   {}  epoch {}  {}  {:?}  {}  ({standing})",
            token_id(&token.hash),
            token.epoch,
            token.kind.as_str(),
            token.label,
            utc(token.created_at_ms)
        ));
    }
    lines
}

/// The id `pairings` prints for a token and `pairings revoke` takes: the first
/// 12 hex characters of its hash. The gateway never held the token itself,
/// and a hash prefix tells nobody the token (#1080, the audit's finding 2).
#[must_use]
pub fn token_id(hash: &TokenHash) -> String {
    hash.hex()[..TOKEN_ID_HEX].to_owned()
}

/// How many hex characters of a token's hash name it to an operator.
pub const TOKEN_ID_HEX: usize = 12;

/// What `pair` prints: the payload, its QR and when it stops working.
#[must_use]
pub fn payload_lines(payload: &PairPayload) -> Vec<String> {
    let text = payload.to_json();
    let mut lines = vec![format!("pair      {text}")];
    match qr::render(&text) {
        Ok(rendered) => lines.push(rendered),
        // The text above is the same payload and can be pasted.
        Err(error) => lines.push(format!("(no QR: {error}; paste the `pair` line instead)")),
    }
    lines.push(format!(
        "Good for one phone, once, until {}. The phone checks the gateway's pin itself.",
        utc(payload.exp_ms)
    ));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(seed: u8) -> [u8; 32] {
        ed25519_dalek::SigningKey::from_bytes(&[seed; 32])
            .verifying_key()
            .to_bytes()
    }

    /// THE PRINTED DIGITS ARE THE FUNCTION'S (the root's rulings A7 and
    /// A17): for a known vault and a known certificate the `safety` line
    /// carries exactly `safety_number_of_bytes`' grouped digits over the
    /// vault id and the pin — the bytes the phone's `pair` hands the same
    /// function — and both orders of the pair give the same number.
    #[test]
    fn the_printed_safety_number_is_the_one_both_ends_compute() {
        let vault = VaultId::from_bytes(key(3));
        let pin = Pin::of(b"the DER of a known certificate");
        let expected =
            centraid_identity::safety_number_of_bytes(vault.as_bytes(), pin.as_bytes()).grouped();
        assert_eq!(safety_line(&vault, &pin), format!("safety    {expected}"));
        assert_eq!(
            centraid_identity::safety_number_of_bytes(pin.as_bytes(), vault.as_bytes()).grouped(),
            expected,
            "the number does not depend on which side is first"
        );
        assert_eq!(expected.len(), 12 * 5 + 11, "twelve groups of five");
    }

    /// **A17.** A pin that is no curve point — about half of them — still
    /// prints digits, never the pin in their place.
    #[test]
    fn every_pin_prints_a_number() {
        let vault = VaultId::from_bytes(key(3));
        let off_the_curve = (0_u8..=255)
            .map(|first| {
                let mut bytes = [0_u8; 32];
                bytes[0] = first;
                bytes
            })
            .find(|bytes| ed25519_dalek::VerifyingKey::from_bytes(bytes).is_err())
            .expect("some 32 bytes are not a key");
        let pin = Pin::from_bytes(off_the_curve);
        let line = safety_line(&vault, &pin);
        assert!(!line.contains(&pin.hex()), "{line}");
        assert_eq!(
            line,
            format!(
                "safety    {}",
                centraid_identity::safety_number_of_bytes(vault.as_bytes(), &off_the_curve)
                    .grouped()
            )
        );
    }

    #[test]
    fn a_moment_prints_in_utc_words() {
        assert_eq!(utc(1_790_674_539_189), "2026-09-29 09:35 UTC");
    }
}
