//! Properties, not examples — v0's `*-properties.test.ts` carried over.
//!
//! Four claims that must hold for every input, not for the ones somebody
//! thought of:
//!
//! 1. The payload hash is a function of the payload's VALUE and not of the
//!    order or the shape a caller happened to build it in.
//! 2. The UTF-16 comparison is a total order, and it is the one JavaScript
//!    uses even where Rust's own disagrees.
//! 3. Idempotency: the same intent hashed twice is the same hash, and two
//!    intents differing anywhere hash differently.
//! 4. The chain's backoff is monotonic, bounded, and deterministic.

use centraid_seat::chain::{backoff_ms, stable_pending_row_id};
use centraid_seat::payload::{PayloadHash, cmp_utf16, sort_base_versions};
use centraid_vault::intents::BaseVersion;
use proptest::prelude::*;

/// Strings drawn from the ranges the seam is about: ASCII, BMP, and astral.
fn interesting_string() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z]{1,8}",
        "[\\u{0080}-\\u{07ff}]{1,4}",
        // The private-use area, whose UTF-8 bytes sit ABOVE a surrogate pair's.
        "[\\u{e000}-\\u{f8ff}]{1,3}",
        // Astral. The whole reason cmp_utf16 exists.
        "[\\u{10000}-\\u{1f9ff}]{1,3}",
    ]
}

fn base_version() -> impl Strategy<Value = BaseVersion> {
    (
        interesting_string(),
        interesting_string(),
        proptest::option::of(interesting_string()),
        1_i64..1_000,
    )
        .prop_map(|(entity, row_id, shape_id, version)| BaseVersion {
            entity,
            row_id,
            shape_id,
            version,
        })
}

proptest! {
    /// CLAIM 2, first half: a total order.
    #[test]
    fn the_utf16_comparison_is_a_total_order(
        left in interesting_string(),
        right in interesting_string(),
        middle in interesting_string(),
    ) {
        use std::cmp::Ordering;
        prop_assert_eq!(cmp_utf16(&left, &left), Ordering::Equal);
        prop_assert_eq!(cmp_utf16(&left, &right), cmp_utf16(&right, &left).reverse());
        if cmp_utf16(&left, &middle) == Ordering::Less
            && cmp_utf16(&middle, &right) == Ordering::Less
        {
            prop_assert_eq!(cmp_utf16(&left, &right), Ordering::Less);
        }
    }

    /// CLAIM 2, second half: it agrees with UTF-8 byte order for BMP text and
    /// is allowed to disagree only where a surrogate pair is involved.
    #[test]
    fn utf16_and_utf8_order_agree_unless_an_astral_character_is_involved(
        left in "[\\u{0001}-\\u{d7ff}]{1,6}",
        right in "[\\u{0001}-\\u{d7ff}]{1,6}",
    ) {
        prop_assert_eq!(cmp_utf16(&left, &right), left.cmp(&right));
    }

    /// CLAIM 1: the hash does not depend on the order base versions arrived in.
    #[test]
    fn the_payload_hash_is_invariant_to_base_version_order(
        mut versions in proptest::collection::vec(base_version(), 0..6),
        title in interesting_string(),
    ) {
        // Distinct sort keys only: two versions with the SAME key are the same
        // row referenced twice, which is a caller bug and not a property.
        versions.sort_by(|a, b| cmp_utf16(&a.sort_key(), &b.sort_key()));
        versions.dedup_by(|a, b| a.sort_key() == b.sort_key());
        let input = serde_json::json!({ "title": title });
        let forward = PayloadHash::of("notes", "edit", &input, &versions, &[])
            .expect("it hashes");
        let mut shuffled = versions.clone();
        shuffled.reverse();
        let backward = PayloadHash::of("notes", "edit", &input, &shuffled, &[])
            .expect("it hashes");
        prop_assert_eq!(forward, backward);
    }

    /// CLAIM 1, the other half: the hash does not depend on the order the
    /// INPUT's own keys were inserted in. That is what canonicalising the JSON
    /// is for.
    #[test]
    fn the_payload_hash_is_invariant_to_input_key_insertion_order(
        keys in proptest::collection::hash_set(interesting_string(), 1..5),
    ) {
        let keys: Vec<String> = keys.into_iter().collect();
        let mut forward = serde_json::Map::new();
        for (index, key) in keys.iter().enumerate() {
            forward.insert(key.clone(), serde_json::json!(index));
        }
        let mut backward = serde_json::Map::new();
        for (index, key) in keys.iter().enumerate().rev() {
            backward.insert(key.clone(), serde_json::json!(index));
        }
        prop_assert_eq!(
            PayloadHash::of("a", "b", &serde_json::Value::Object(forward), &[], &[])
                .expect("hashes"),
            PayloadHash::of("a", "b", &serde_json::Value::Object(backward), &[], &[])
                .expect("hashes")
        );
    }

    /// CLAIM 3: two intents that differ anywhere hash differently. The gateway
    /// compares hashes to detect a reused intent id with a changed payload, so
    /// a collision here is a payload a gateway would accept under the wrong id.
    #[test]
    fn any_difference_in_the_payload_changes_the_hash(
        app_id in "[a-z]{1,6}",
        action in "[a-z]{1,6}",
        title in interesting_string(),
        other in interesting_string(),
    ) {
        prop_assume!(title != other);
        let one = PayloadHash::of(&app_id, &action, &serde_json::json!({ "t": title }), &[], &[])
            .expect("hashes");
        let two = PayloadHash::of(&app_id, &action, &serde_json::json!({ "t": other }), &[], &[])
            .expect("hashes");
        prop_assert_ne!(&one, &two);
        // And a changed action, with the same input.
        let three = PayloadHash::of(
            &app_id,
            &format!("{action}x"),
            &serde_json::json!({ "t": title }),
            &[],
            &[],
        )
        .expect("hashes");
        prop_assert_ne!(&one, &three);
        // And the same intent hashed twice is the same hash.
        prop_assert_eq!(
            &one,
            &PayloadHash::of(&app_id, &action, &serde_json::json!({ "t": title }), &[], &[])
                .expect("hashes")
        );
    }

    /// The sort is stable in the sense the preimage needs: sorting a sorted
    /// list changes nothing, so a seat that sorts twice hashes the same.
    #[test]
    fn sorting_base_versions_is_idempotent(
        versions in proptest::collection::vec(base_version(), 0..8),
    ) {
        let mut once = versions.clone();
        sort_base_versions(&mut once);
        let mut twice = once.clone();
        sort_base_versions(&mut twice);
        prop_assert_eq!(once, twice);
    }

    /// CLAIM 4.
    #[test]
    fn the_backoff_is_monotonic_bounded_and_deterministic(attempts in 0_i64..64) {
        let delay = backoff_ms(attempts);
        prop_assert_eq!(delay, backoff_ms(attempts));
        prop_assert!(delay >= 1_000);
        prop_assert!(delay <= 5 * 60 * 1_000);
        prop_assert!(backoff_ms(attempts + 1) >= delay);
    }

    /// A pending row id is a function of the pair and nothing else, so the same
    /// intent re-minted after a reload refers to the same pending row.
    #[test]
    fn a_stable_pending_row_id_is_a_function_of_the_intent_and_the_table(
        intent_id in "[a-z0-9-]{1,12}",
        table in "[a-z_]{1,10}",
        other_table in "[a-z_]{1,10}",
    ) {
        let one = stable_pending_row_id(&intent_id, &table);
        prop_assert_eq!(&one, &stable_pending_row_id(&intent_id, &table));
        if table != other_table {
            prop_assert_ne!(&one, &stable_pending_row_id(&intent_id, &other_table));
        }
    }
}
