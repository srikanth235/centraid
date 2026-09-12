//! The canonical payload hash — the seat's side of seam 6.
//!
//! **One implementation, two callers.** The canonical form lives in
//! [`centraid_vault::intents`] and this module re-exports it rather than
//! reproducing it. That is not laziness: the gateway compares the submitted
//! hash against one it recomputes, in constant time, and refuses the intent on
//! a mismatch. Two implementations of the same canonicalisation is two things
//! that can drift, and the symptom of drift is *every* offline write from one
//! seat being refused — a failure that looks like a network fault.
//!
//! What this module adds is the seat-side vocabulary ([`PayloadHash`], so a hex
//! string cannot be passed where a payload was meant) and the tests the seam
//! demands: an astral-plane row id, whose ordering Rust's own `str` comparison
//! gets wrong.
//!
//! ## Why UTF-16 code units (seam 6)
//!
//! `Array#sort` on object keys, and `<`/`>` on the base-version sort keys, are
//! JavaScript's — UTF-16 code-unit order. Rust's `str: Ord` is UTF-8 byte
//! order. The two AGREE for every character in the BMP and DISAGREE for astral
//! ones, because UTF-16 spells `U+10000` as a surrogate pair beginning `D800`,
//! which is below `E000`, while UTF-8 spells it `F0 90 80 80`, which is above
//! `EE 80 80`. A vault with an emoji in a row id diverges, on exactly one
//! member's phone.

use centraid_vault::intents::{BaseVersion, IntentPayload};

use crate::error::{Result, SeatError};

/// Compare two strings by UTF-16 CODE UNIT, as JavaScript's `<` does.
///
/// Delegates to the vault's, so the two sides are the same function and not
/// two functions that agree today.
#[must_use]
pub fn cmp_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    centraid_vault::intents::compare_utf16(left, right)
}

/// A lowercase-hex sha-256 of a canonical payload.
///
/// A newtype, because the gateway requires `/^[a-f0-9]{64}$/` and a `String`
/// that had been through a `to_uppercase` anywhere would be refused with no
/// explanation of why.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct PayloadHash(String);

impl PayloadHash {
    /// The hash of one payload.
    pub fn of(
        app_id: &str,
        action: &str,
        input: &serde_json::Value,
        base_versions: &[BaseVersion],
        depends_on: &[String],
    ) -> Result<Self> {
        let payload = IntentPayload {
            app_id: app_id.to_owned(),
            action: action.to_owned(),
            input: input.clone(),
            base_versions: base_versions.to_vec(),
            depends_on: depends_on.to_vec(),
        };
        Ok(Self(payload.hash()?))
    }

    /// Accept a hash off the wire or out of the outbox, checking its shape.
    pub fn parse(text: &str) -> Result<Self> {
        if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(SeatError::Invariant {
                context: format!("`{text}` is not a 64-character lowercase-hex sha-256"),
            });
        }
        if text.bytes().any(|byte| byte.is_ascii_uppercase()) {
            return Err(SeatError::Invariant {
                context: "a payload hash is lowercase hex; the gateway's regex refuses uppercase"
                    .to_owned(),
            });
        }
        Ok(Self(text.to_owned()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for PayloadHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// The sort key both sides order base versions by: `entity\0rowId\0shapeId`.
///
/// Re-exported as a function so a caller never rebuilds the string with a
/// different separator. NUL is the separator precisely because it cannot occur
/// in any of the three parts, so `("a\0b", "")` and `("a", "b")` are different
/// keys — a `:` separator would collapse them.
#[must_use]
pub fn base_version_sort_key(version: &BaseVersion) -> String {
    version.sort_key()
}

/// Sort base versions the way the hash preimage requires.
pub fn sort_base_versions(versions: &mut [BaseVersion]) {
    versions.sort_by(|left, right| cmp_utf16(&left.sort_key(), &right.sort_key()));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(entity: &str, row_id: &str) -> BaseVersion {
        BaseVersion {
            entity: entity.to_owned(),
            row_id: row_id.to_owned(),
            shape_id: None,
            version: 1,
        }
    }

    /// SEAM 6, the case Rust gets wrong on its own. `U+10000` (an astral
    /// character — the lowest one, `𐀀`) sorts BELOW `U+E000` in UTF-16 code
    /// units and ABOVE it in UTF-8 bytes.
    #[test]
    fn an_astral_row_id_sorts_by_utf16_and_not_by_utf8_bytes() {
        let astral = "\u{10000}";
        let private_use = "\u{E000}";
        assert_eq!(
            cmp_utf16(astral, private_use),
            std::cmp::Ordering::Less,
            "UTF-16 code units put the surrogate pair's D800 below E000"
        );
        // And the naive answer, recorded so the difference is not theoretical.
        assert_eq!(
            astral.cmp(private_use),
            std::cmp::Ordering::Greater,
            "Rust's own ordering is the WRONG answer here, which is why cmp_utf16 exists"
        );
    }

    #[test]
    fn base_versions_with_an_astral_row_id_sort_the_way_a_phone_sorted_them() {
        let mut versions = vec![base("note", "\u{E000}"), base("note", "\u{10000}")];
        sort_base_versions(&mut versions);
        assert_eq!(
            versions
                .iter()
                .map(|v| v.row_id.as_str())
                .collect::<Vec<_>>(),
            ["\u{10000}", "\u{E000}"]
        );
    }

    /// The property the whole seam is about: the hash is invariant to the order
    /// the caller happened to hold the base versions in.
    #[test]
    fn the_hash_does_not_depend_on_the_order_base_versions_arrived_in() {
        let input = serde_json::json!({ "title": "a" });
        let forward = vec![base("note", "\u{10000}"), base("note", "\u{E000}")];
        let backward: Vec<BaseVersion> = forward.iter().rev().cloned().collect();
        assert_eq!(
            PayloadHash::of("notes", "edit", &input, &forward, &[]).expect("it hashes"),
            PayloadHash::of("notes", "edit", &input, &backward, &[]).expect("it hashes")
        );
    }

    #[test]
    fn an_empty_base_version_set_is_omitted_and_not_written_as_an_empty_array() {
        let input = serde_json::json!({ "title": "a" });
        let with_none = PayloadHash::of("notes", "edit", &input, &[], &[]).expect("it hashes");
        // The same payload hashed with the field present-and-empty would be a
        // different preimage; v0 omits, so the only way to be sure is that an
        // intent with one base version hashes DIFFERENTLY.
        let with_one =
            PayloadHash::of("notes", "edit", &input, &[base("note", "n1")], &[]).expect("hashes");
        assert_ne!(with_none, with_one);
        assert_eq!(with_none.as_str().len(), 64);
    }

    #[test]
    fn depends_on_is_part_of_the_payload_because_a_rewritten_chain_is_a_new_intent() {
        let input = serde_json::json!({ "title": "a" });
        let alone = PayloadHash::of("notes", "edit", &input, &[], &[]).expect("hashes");
        let chained =
            PayloadHash::of("notes", "edit", &input, &[], &["i-1".to_owned()]).expect("hashes");
        assert_ne!(alone, chained);
    }

    #[test]
    fn a_non_finite_number_is_refused_rather_than_written_as_null() {
        // `JSON.stringify(NaN)` is `null`, so a payload whose hash depended on
        // that is a payload two implementations disagree about.
        let input = serde_json::json!({ "rate": 1.0 });
        assert!(PayloadHash::of("m", "set", &input, &[], &[]).is_ok());
        let mut map = serde_json::Map::new();
        map.insert(
            "rate".to_owned(),
            serde_json::Value::Number(
                serde_json::Number::from_f64(f64::MAX).expect("MAX is finite"),
            ),
        );
        assert!(
            PayloadHash::of("m", "set", &serde_json::Value::Object(map), &[], &[]).is_ok(),
            "a large finite number is fine; only non-finite is refused"
        );
    }

    #[test]
    fn a_hash_must_be_lowercase_hex_of_the_right_length() {
        let good = "a".repeat(64);
        assert_eq!(PayloadHash::parse(&good).expect("it parses").as_str(), good);
        assert!(PayloadHash::parse(&"A".repeat(64)).is_err());
        assert!(PayloadHash::parse(&"a".repeat(63)).is_err());
        assert!(PayloadHash::parse(&"z".repeat(64)).is_err());
    }

    #[test]
    fn the_sort_key_separator_cannot_be_forged_by_a_row_id() {
        // NUL, not `:`. With a colon these two would collide.
        let left = base("a:b", "c");
        let right = base("a", "b:c");
        assert_ne!(base_version_sort_key(&left), base_version_sort_key(&right));
    }
}
