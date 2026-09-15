//! Perceptual-hash similarity: Hamming distance over hex digests.
//!
//! Three rules, ported from `packages/vault/src/enrich/similarity.ts:1-22`,
//! and every one of them is a decision about what "not comparable" means:
//!
//! 1. **Unequal lengths are NOT COMPARABLE**, never distance `0` and never an
//!    error. A 16-hex dHash and a 64-hex pHash are two different measurements;
//!    comparing them by their common prefix would cluster a photograph with a
//!    photograph it looks nothing like.
//! 2. **A non-hex character is not comparable either.** The column's CHECK is
//!    only `length(phash) BETWEEN 4 AND 64`, so a writer can put anything in
//!    it; a reader that coerced `Number.parseInt` failures to zero nibbles
//!    would read "different" as "identical".
//! 3. **An empty digest is not comparable.** Two absent measurements are not a
//!    match.
//!
//! `None` is the one answer for all three — the caller decides, and every
//! caller in the product decides "skip this pair".

/// Nibble popcount, so the distance is a table lookup per hex digit rather than
/// a per-bit loop. The same table v0 uses (`similarity.ts:7-9`).
const POPCOUNT_NIBBLE: [u32; 16] = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

/// The bit distance between two hex digests, or `None` for a pair that is not
/// comparable. See the module note for the three cases.
#[must_use]
pub fn hex_hamming(left: &str, right: &str) -> Option<u32> {
    if left.is_empty() || left.len() != right.len() {
        return None;
    }
    let mut distance = 0;
    for (a, b) in left.bytes().zip(right.bytes()) {
        let (a, b) = (nibble(a)?, nibble(b)?);
        distance += POPCOUNT_NIBBLE[usize::from(a ^ b) & 0xf];
    }
    Some(distance)
}

/// One hex digit, or `None`. **Case-insensitive**, like `parseInt(_, 16)`.
const fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Whether a digest is shaped the way `media_asset_phash.phash`'s CHECK
/// demands: 4…64 characters, all hex.
///
/// The CHECK itself only bounds the LENGTH (`contracts/schema/vault-ddl.sql`,
/// `media_asset_phash`), so this is the stricter reading the clustering needs
/// and a finding worth naming: a non-hex digest is storable today.
#[must_use]
pub fn is_wellformed(phash: &str) -> bool {
    (4..=64).contains(&phash.len()) && phash.bytes().all(|byte| nibble(byte).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_digests_are_zero_apart() {
        assert_eq!(hex_hamming("3727170f8b494d6e", "3727170f8b494d6e"), Some(0));
    }

    #[test]
    fn one_flipped_bit_is_one() {
        assert_eq!(hex_hamming("0000", "0001"), Some(1));
        assert_eq!(hex_hamming("0000", "000f"), Some(4));
        assert_eq!(hex_hamming("ffff", "0000"), Some(16));
    }

    /// UNEQUAL LENGTHS ARE NOT COMPARABLE. Not zero, and not an error.
    #[test]
    fn digests_of_two_different_widths_are_not_comparable() {
        assert_eq!(hex_hamming("0000", "00000000"), None);
        assert_eq!(hex_hamming("", ""), None);
        assert_eq!(hex_hamming("0000", ""), None);
    }

    /// A non-hex character is not comparable either — never "different read as
    /// identical".
    #[test]
    fn a_non_hex_digest_is_not_comparable() {
        assert_eq!(hex_hamming("00zz", "0000"), None);
        assert_eq!(hex_hamming("0000", "00 0"), None);
        assert!(!is_wellformed("00zz"));
        assert!(!is_wellformed("abc"));
        assert!(is_wellformed("3727170f8b494d6e"));
        assert!(is_wellformed("3727170F8B494D6E"));
    }

    #[test]
    fn the_comparison_is_case_insensitive_like_parse_int() {
        assert_eq!(hex_hamming("ABCD", "abcd"), Some(0));
    }

    #[test]
    fn the_distance_is_symmetric_and_triangular_on_the_seeds_own_digests() {
        // Two frames from the demo roll, seconds apart on the same ridge.
        let a = "1f0f0f0e57334f25";
        let b = "1f0f0f1337250d17";
        let left = hex_hamming(a, b).expect("comparable");
        assert_eq!(hex_hamming(b, a), Some(left));
        let c = "0f0f0f272b958f27";
        let (ac, cb) = (
            hex_hamming(a, c).expect("comparable"),
            hex_hamming(c, b).expect("comparable"),
        );
        assert!(left <= ac + cb, "{left} > {ac} + {cb}");
    }
}
