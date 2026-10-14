//! The dedupe key (R-1099-3).
//!
//! `core_transaction.external_id` is `ofx:<FITID>` for a bank's own id and
//! `csv:<64 hex>` for a row that has none. The hash is BLAKE3: the repo's one
//! hash (#1025 S4) and `sha2` is confined to two other crates by the workspace
//! manifest; the key is only ever compared for equality, so the algorithm is
//! internal. The hash input is the printed day, the signed minor amount, the
//! raw description and the **ordinal within that triple in the file**: the same
//! weekly $9.99 on different days is distinct, and an identical pair on one day
//! stays two rows.

use std::collections::HashMap;

/// The 64-hex key for the `ordinal`th row with this day, signed amount and raw
/// description.
#[must_use]
pub fn csv_hash(posted_on: &str, signed_minor: i64, description: &str, ordinal: usize) -> String {
    let input = format!("{posted_on}|{signed_minor}|{description}|{ordinal}");
    hex::encode(blake3::hash(input.as_bytes()).as_bytes())
}

/// Hands out ordinals within a (day, amount, description) triple, in file
/// order.
#[derive(Debug, Default)]
pub struct Ordinals {
    seen: HashMap<(String, i64, String), usize>,
}

impl Ordinals {
    /// The next ordinal for this triple, counting from 0.
    pub fn next(&mut self, posted_on: &str, signed_minor: i64, description: &str) -> usize {
        let slot = self
            .seen
            .entry((posted_on.to_owned(), signed_minor, description.to_owned()))
            .or_insert(0);
        let ordinal = *slot;
        *slot += 1;
        ordinal
    }
}

/// `csv:<hex>` for a row, advancing the triple's ordinal.
#[must_use]
pub fn csv_key(
    ordinals: &mut Ordinals,
    posted_on: &str,
    signed_minor: i64,
    description: &str,
) -> String {
    let ordinal = ordinals.next(posted_on, signed_minor, description);
    format!(
        "csv:{}",
        csv_hash(posted_on, signed_minor, description, ordinal)
    )
}

/// `ofx-nofitid:<hex>` for an OFX transaction the bank gave no FITID.
#[must_use]
pub fn nofitid_key(
    ordinals: &mut Ordinals,
    posted_on: &str,
    signed_minor: i64,
    description: &str,
) -> String {
    let ordinal = ordinals.next(posted_on, signed_minor, description);
    format!(
        "ofx-nofitid:{}",
        csv_hash(posted_on, signed_minor, description, ordinal)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinals_separate_an_identical_pair_but_not_different_days() {
        let mut ordinals = Ordinals::default();
        let a = csv_key(&mut ordinals, "2024-01-01", -999, "NETFLIX");
        let b = csv_key(&mut ordinals, "2024-01-01", -999, "NETFLIX");
        let c = csv_key(&mut ordinals, "2024-01-08", -999, "NETFLIX");
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_eq!(a.len(), "csv:".len() + 64);
        let mut again = Ordinals::default();
        assert_eq!(csv_key(&mut again, "2024-01-01", -999, "NETFLIX"), a);
    }
}
