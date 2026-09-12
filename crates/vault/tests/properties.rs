//! Properties, where a property is cheaper than the cases it covers.
//!
//! Three, and no more. A proptest that restates a unit test is a slower unit
//! test; these are the places where the SPACE is the point — every integer, not
//! the three a table remembered.

use centraid_vault::intents::{BaseVersion, IntentPayload, canonical_json, compare_utf16};
use centraid_vault::value::{RowImage, Value, row_image_from_json, row_image_to_json};
use proptest::prelude::*;

/// Any SQLite value, with the boundaries weighted in.
fn any_value() -> impl Strategy<Value = Value> {
    prop_oneof![
        Just(Value::Null),
        // The whole i64 range, so the 2^53 boundary is crossed in both
        // directions rather than sampled near zero.
        any::<i64>().prop_map(Value::Integer),
        prop_oneof![
            Just(centraid_vault::value::MAX_SAFE_INTEGER),
            Just(centraid_vault::value::MAX_SAFE_INTEGER + 1),
            Just(-centraid_vault::value::MAX_SAFE_INTEGER),
            Just(i64::MIN),
            Just(i64::MAX),
        ]
        .prop_map(Value::Integer),
        // Finite reals only: NaN and the infinities have no JSON spelling and
        // the encoder says so rather than guessing.
        any::<f64>()
            .prop_filter("finite", |real| real.is_finite())
            .prop_map(Value::Real),
        ".*".prop_map(Value::Text),
        prop::collection::vec(any::<u8>(), 0..64).prop_map(Value::Blob),
    ]
}

proptest! {
    /// A row image survives the log's own JSON, whatever it holds.
    ///
    /// The property the applier depends on: an image written into `row_json`
    /// and read back binds the same values. A REAL comes back as an Integer
    /// when it is integral, which is not a loss — `node:sqlite` handed the
    /// producer a JS number for both and v0's applier binds whichever SQLite's
    /// affinity wants, so the two are genuinely indistinguishable in this
    /// format.
    #[test]
    fn a_row_image_round_trips_through_the_logs_json(
        pairs in prop::collection::vec((r"[a-z_]{1,12}", any_value()), 0..12)
    ) {
        let mut image = RowImage::new();
        for (column, value) in pairs {
            image.insert(column, value);
        }
        let text = row_image_to_json(&image);
        let back = row_image_from_json(&text).expect("our own encoding parses");
        prop_assert_eq!(back.len(), image.len());
        for (column, value) in &image {
            let round = back.get(column).expect("the key survives");
            match (value, round) {
                // An integral REAL and the INTEGER of the same value are one
                // value in this format, deliberately.
                (Value::Real(real), Value::Integer(int)) => {
                    prop_assert_eq!(*real, *int as f64);
                }
                (Value::Real(left), Value::Real(right)) => {
                    prop_assert_eq!(left, right);
                }
                (left, right) => prop_assert_eq!(left, right),
            }
        }
        // And the text is one JSON object, so nothing escaped its quoting.
        prop_assert!(serde_json::from_str::<serde_json::Value>(&text).is_ok());
    }

    /// The canonical form is a function of the VALUE, never of the key order it
    /// arrived in — which is the whole claim the payload hash rests on.
    #[test]
    fn the_canonical_form_does_not_depend_on_insertion_order(
        raw in prop::collection::vec(r"[a-zA-Z\x{00e9}\x{10000}]{1,6}", 1..8)
    ) {
        // DISTINCT keys: a JSON object with a repeated key is not a value at
        // all, and asserting anything about one would be asserting about the
        // map's own last-write-wins.
        let mut keys = raw;
        keys.sort_by(|a, b| compare_utf16(a, b));
        keys.dedup();
        let mut forward = serde_json::Map::new();
        let mut backward = serde_json::Map::new();
        for (index, key) in keys.iter().enumerate() {
            forward.insert(key.clone(), serde_json::json!(index));
        }
        for (index, key) in keys.iter().enumerate().rev() {
            backward.insert(key.clone(), serde_json::json!(index));
        }
        let left = canonical_json(&serde_json::Value::Object(forward))
            .expect("it canonicalises");
        let right = canonical_json(&serde_json::Value::Object(backward))
            .expect("it canonicalises");
        prop_assert_eq!(&left, &right);
        // And the order is UTF-16's, including for astral characters, which is
        // where Rust's own `str` ordering disagrees.
        let mut sorted = keys.clone();
        sorted.sort_by(|a, b| compare_utf16(a, b));
        sorted.dedup();
        let mut at = 0;
        for key in &sorted {
            let quoted = serde_json::to_string(key).expect("a key serialises");
            let found = left[at..].find(&quoted).map(|offset| at + offset);
            prop_assert!(found.is_some(), "`{}` is out of order in {}", key, left);
            at = found.expect("just checked");
        }
    }

    /// The payload hash does not depend on the order base versions arrived in.
    ///
    /// The seat sorts them and the gateway sorts them; if the two disagreed,
    /// every well-formed intent would be refused as a hash mismatch.
    #[test]
    fn the_payload_hash_ignores_base_version_order(
        ids in prop::collection::vec(r"[a-z0-9\x{10000}]{1,8}", 1..6)
    ) {
        let make = |order: Vec<String>| IntentPayload {
            app_id: "tally".to_owned(),
            action: "tally.add_expense".to_owned(),
            input: serde_json::json!({"amount_minor": 1}),
            base_versions: order
                .into_iter()
                .map(|row_id| BaseVersion {
                    entity: "tally.expense".to_owned(),
                    row_id,
                    shape_id: None,
                    version: 1,
                })
                .collect(),
            depends_on: Vec::new(),
        };
        let forward = make(ids.clone()).hash().expect("it hashes");
        let reversed = make(ids.iter().rev().cloned().collect()).hash().expect("it hashes");
        prop_assert_eq!(forward, reversed);
    }
}
