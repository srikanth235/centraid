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
//! `centraid_identity::pairing_safety_number` over the vault's identity key
//! (its id) and the certificate's pin, the one function both screens render
//! with. **The pin is what the phone checks; the number is a display.** That
//! function takes both inputs as Ed25519 keys and declines bytes that do not
//! decode as one — and a pin is a BLAKE3 output, about half of which do not —
//! so a gateway whose pin it declines shows its pin to compare instead.

use crate::rules::engine::Pairing;
use crate::rules::ids::{Pin, VaultId};
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

/// The safety number's digits for this vault on this gateway, or `None` when
/// `pairing_safety_number` declines the pin. See the module header.
#[must_use]
pub fn safety_digits(vault: &VaultId, pin: &Pin) -> Option<String> {
    centraid_identity::pairing_safety_number(vault.as_bytes(), pin.as_bytes())
        .map(|number| number.grouped())
}

/// The `safety` line.
#[must_use]
pub fn safety_line(vault: &VaultId, pin: &Pin) -> String {
    safety_digits(vault, pin).map_or_else(
        || format!("safety    none for this certificate; compare its pin instead: {pin}"),
        |digits| format!("safety    {digits}"),
    )
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
            "  token   epoch {}  {}  {:?}  {}  ({standing})",
            token.epoch,
            token.kind.as_str(),
            token.label,
            utc(token.created_at_ms)
        ));
    }
    lines
}

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

    /// THE PRINTED DIGITS ARE THE FUNCTION'S (the root's ruling A7): for a
    /// known vault and a pin the function accepts, the `safety` line carries
    /// exactly `pairing_safety_number`'s grouped digits, and both orders of
    /// the pair give the same number.
    #[test]
    fn the_printed_safety_number_is_pairing_safety_number() {
        let vault = VaultId::from_bytes(key(3));
        let pin = Pin::from_bytes(key(4));
        let expected = centraid_identity::pairing_safety_number(&key(3), &key(4))
            .expect("both are keys")
            .grouped();
        assert_eq!(safety_line(&vault, &pin), format!("safety    {expected}"));
        assert_eq!(
            centraid_identity::pairing_safety_number(&key(4), &key(3))
                .expect("both are keys")
                .grouped(),
            expected,
            "the number does not depend on which side is first"
        );
        assert_eq!(expected.len(), 12 * 5 + 11, "twelve groups of five");
    }

    /// A pin the function declines prints the pin to compare, never a number
    /// nobody else could reproduce.
    #[test]
    fn a_pin_the_function_declines_prints_the_pin_instead() {
        let vault = VaultId::from_bytes(key(3));
        let declined = (0_u8..=255)
            .map(|first| {
                let mut bytes = [0_u8; 32];
                bytes[0] = first;
                Pin::from_bytes(bytes)
            })
            .find(|pin| safety_digits(&vault, pin).is_none())
            .expect("some 32 bytes are not a key");
        let line = safety_line(&vault, &declined);
        assert!(line.contains(&declined.hex()), "{line}");
    }

    #[test]
    fn a_moment_prints_in_utc_words() {
        assert_eq!(utc(1_790_674_539_189), "2026-09-29 09:35 UTC");
    }
}
