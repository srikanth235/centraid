//! The digits two people read to each other (#1029 §5).
//!
//! A pair ticket that travels over a channel neither person controls — a
//! message, an email — proves nothing on its own. Both sides derive a safety
//! number from the two identity keys and compare it out of band; the People app
//! shows it. An attacker who substituted either key cannot make the two numbers
//! agree without finding a BLAKE3 collision.
//!
//! ## ORDER INDEPENDENCE IS THE WHOLE POINT
//!
//! Both people must read the same digits, and neither knows which of them is
//! "first". The two keys are therefore sorted by their bytes before hashing, so
//! `safety_number(a, b) == safety_number(b, a)` by construction rather than by
//! a convention each caller has to get right.
//!
//! ## THIS HASH IS BLAKE3, AND THAT IS NOT AN OVERSIGHT
//!
//! The safety number is a format this repository defines, not a standard it
//! implements, so it falls under ONE HASH (D-1025-S4-2/-3) and not under the
//! standards carve-out this crate holds (W0.5-R1). The SHA-2 in
//! [`crate::phrase`], [`crate::derive`] and [`crate::sealed_box`] is there only
//! because BIP39, SLIP-0010 and RFC 9180 put it there.

use ed25519_dalek::VerifyingKey;

/// Domain separation, and the version. Changing either string changes every
/// safety number in the product, which is a re-verification event for every
/// contact — it is a format decision, pinned by
/// `contracts/crypto/identity-vectors.json`.
const SAFETY_NUMBER_CONTEXT: &[u8] = b"centraid-safety-number-v1";

/// 60 digits, shown as 12 groups of 5.
///
/// 60 decimal digits is ~199 bits: far past what two people will read aloud
/// carefully, and chosen because the failure mode of a *short* safety number is
/// silent. A number a person gets bored of is compared badly; a number an
/// attacker can collide is not compared at all.
pub const SAFETY_NUMBER_DIGITS: usize = 60;

/// Digits per group.
pub const SAFETY_NUMBER_GROUP: usize = 5;

/// Each group of [`SAFETY_NUMBER_GROUP`] digits is `u40 mod 100_000` over 5
/// bytes of BLAKE3 output.
const BYTES_PER_GROUP: usize = 5;

/// The digits, rendered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SafetyNumber([u8; SAFETY_NUMBER_DIGITS]);

impl SafetyNumber {
    /// The 60 digits with no grouping, for comparison and for tests.
    pub fn digits(&self) -> String {
        self.0.iter().map(|d| char::from(b'0' + d)).collect()
    }

    /// The digits as a person reads them: 12 groups of 5, space separated.
    pub fn grouped(&self) -> String {
        self.0
            .chunks(SAFETY_NUMBER_GROUP)
            .map(|group| {
                group
                    .iter()
                    .map(|d| char::from(b'0' + d))
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

impl core::fmt::Display for SafetyNumber {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(&self.grouped())
    }
}

/// The safety number for two identity keys, in either order.
pub fn safety_number(one: &VerifyingKey, other: &VerifyingKey) -> SafetyNumber {
    let (low, high) = if one.as_bytes() <= other.as_bytes() {
        (one, other)
    } else {
        (other, one)
    };

    let mut hasher = blake3::Hasher::new();
    hasher.update(SAFETY_NUMBER_CONTEXT);
    hasher.update(&[0]);
    hasher.update(low.as_bytes());
    hasher.update(high.as_bytes());

    let groups = SAFETY_NUMBER_DIGITS / SAFETY_NUMBER_GROUP;
    let mut material = vec![0u8; groups * BYTES_PER_GROUP];
    hasher.finalize_xof().fill(&mut material);

    let mut digits = [0u8; SAFETY_NUMBER_DIGITS];
    for (group, chunk) in material.chunks_exact(BYTES_PER_GROUP).enumerate() {
        // Five bytes big-endian into a u64, then the low five decimal digits.
        // The modular bias is one part in ~10^5 of 2^40 and is not what an
        // attacker attacks; the digit count is.
        let mut wide = 0u64;
        for byte in chunk {
            wide = (wide << 8) | u64::from(*byte);
        }
        let mut value = wide % 100_000;
        for offset in (0..SAFETY_NUMBER_GROUP).rev() {
            digits[group * SAFETY_NUMBER_GROUP + offset] =
                u8::try_from(value % 10).expect("a decimal digit");
            value /= 10;
        }
    }
    SafetyNumber(digits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::derive::VaultMint;
    use crate::phrase::RecoveryPhrase;

    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon \
         abandon abandon abandon abandon abandon art";

    fn keys() -> (VerifyingKey, VerifyingKey) {
        let seed = RecoveryPhrase::parse(PHRASE).expect("parses").seed();
        let mut mint = VaultMint::fresh();
        let a = mint.mint(&seed, 0).expect("vault 0").identity.public();
        let b = mint.mint(&seed, 1).expect("vault 1").identity.public();
        (a, b)
    }

    #[test]
    fn both_people_read_the_same_digits() {
        let (a, b) = keys();
        assert_eq!(safety_number(&a, &b), safety_number(&b, &a));
    }

    #[test]
    fn one_bit_in_either_key_changes_the_number() {
        let (a, b) = keys();
        let baseline = safety_number(&a, &b);

        for key in [&a, &b] {
            for bit in 0..8 {
                let mut raw = key.to_bytes();
                raw[0] ^= 1 << bit;
                let Ok(flipped) = VerifyingKey::from_bytes(&raw) else {
                    // Not every 32-byte string is a curve point; a flip that
                    // lands off the curve is not a key an attacker can present.
                    continue;
                };
                let moved = if core::ptr::eq(key, &a) {
                    safety_number(&flipped, &b)
                } else {
                    safety_number(&a, &flipped)
                };
                assert_ne!(moved, baseline, "bit {bit} did not move the safety number");
            }
        }
    }

    #[test]
    fn the_rendering_is_sixty_digits_in_twelve_groups() {
        let (a, b) = keys();
        let number = safety_number(&a, &b);
        let digits = number.digits();
        assert_eq!(digits.len(), SAFETY_NUMBER_DIGITS);
        assert!(digits.bytes().all(|b| b.is_ascii_digit()));

        let grouped = number.grouped();
        assert_eq!(grouped, number.to_string());
        let parts: Vec<&str> = grouped.split(' ').collect();
        assert_eq!(parts.len(), SAFETY_NUMBER_DIGITS / SAFETY_NUMBER_GROUP);
        assert!(parts.iter().all(|p| p.len() == SAFETY_NUMBER_GROUP));
        assert_eq!(parts.concat(), digits);
    }

    #[test]
    fn a_key_with_itself_is_not_a_constant() {
        let (a, b) = keys();
        assert_ne!(safety_number(&a, &a), safety_number(&b, &b));
    }
}
