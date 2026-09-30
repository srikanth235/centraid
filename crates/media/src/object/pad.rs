//! Padmé, and an honest sentence about what it buys (#1029 §4).
//!
//! **What it hides:** the exact byte length of a plaintext. Two segments of
//! 1 001 and 1 020 bytes seal to objects of the same size, so an observer
//! counting bytes on the wire cannot tell one edit from another.
//!
//! **What it does NOT hide:** that compression happened at all, or roughly how
//! well it worked. `base`, `segment` and `manifest` plaintexts are zstd'd before
//! they are padded, and a compressed size is itself a fact about the content —
//! a page of repeated structure shrinks and a page of photographs does not.
//! Padmé **bounds** that size-class leak to a bucket whose width grows with the
//! size (at most ~12% overhead); it does not remove it. Anyone reasoning about
//! what an observer learns has to reason about the bucket, not about zero.
//!
//! Nikitin et al., *Reducing Metadata Leakage from Encrypted Files and
//! Communication with PURBs* (PoPETs 2019), §4.

/// Round `length` up to its Padmé bucket.
///
/// `E = floor(log2 L)`, `S = floor(log2 E) + 1`, and the low `E - S` bits are
/// cleared after rounding up — so a value keeps `S` significant bits and the
/// bucket width doubles with every power of two. Lengths below 2 are their own
/// bucket: `log2` has nothing to say about them and padding a 1-byte object to
/// 2 bytes hides nothing a 1-byte object was not already announcing.
#[must_use]
pub const fn padme(length: u64) -> u64 {
    if length < 2 {
        return length;
    }
    // floor(log2 L) for L >= 2, so E >= 1.
    let e = 63 - length.leading_zeros() as u64;
    // floor(log2 E) + 1, the count of bits E occupies.
    let s = 64 - (e.leading_zeros() as u64);
    let last_bits = e.saturating_sub(s);
    if last_bits == 0 {
        return length;
    }
    let mask = (1_u64 << last_bits) - 1;
    (length + mask) & !mask
}

#[cfg(test)]
mod tests {
    use super::padme;

    /// The paper's own worked values, plus the two degenerate lengths.
    #[test]
    fn padme_matches_the_published_buckets() {
        assert_eq!(padme(0), 0);
        assert_eq!(padme(1), 1);
        assert_eq!(padme(2), 2);
        assert_eq!(padme(9), 10);
        assert_eq!(padme(1000), 1024);
        assert_eq!(padme(1024), 1024);
        assert_eq!(padme(1_048_576), 1_048_576);
        assert_eq!(padme(1_048_577), 1_081_344);
    }

    /// The bound the module header claims: never shrink, never more than ~12%.
    #[test]
    fn padme_never_shrinks_and_stays_under_twelve_percent() {
        for length in (1_u64..=1_000_000).step_by(997) {
            let padded = padme(length);
            assert!(padded >= length, "{length} shrank to {padded}");
            assert!(
                (padded - length) * 100 <= length * 12,
                "{length} → {padded} exceeds 12%"
            );
        }
    }

    /// The point of the exercise: neighbouring lengths collapse onto one size.
    #[test]
    fn neighbouring_lengths_share_a_bucket() {
        assert_eq!(padme(1001), padme(1020));
        assert_eq!(padme(4_194_305), padme(4_200_000));
    }
}
