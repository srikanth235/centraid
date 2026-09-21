//! CANONICAL JSON: object keys sorted by UTF-16 code unit, no whitespace.
//!
//! This was `intents.rs`, whose subject — the replay-idempotency ledger over
//! `replica_intent_outcome` — is deleted with the replica plane (#1029, rung
//! five). What survives it is not about intents at all: it is the one spelling
//! of a JSON value that two implementations can agree on, and it has three
//! callers that have nothing to do with a seat — the audit receipt's detail
//! (`audit.rs`), the backup manifest's signed text and its segment digest
//! (`backup/manifest.rs`).
//!
//! ## Why UTF-16, in a Rust crate (plane census seam 6)
//!
//! Object keys are sorted **by UTF-16 code unit**, because that is what
//! JavaScript's `Array#sort` does and the v0 implementations that wrote these
//! digests were JS engines. Rust's own `str` ordering is by UTF-8 bytes, which
//! AGREES for every character in the BMP and DISAGREES for astral ones:
//! `"\u{10000}"` sorts after `"\u{E000}"` in UTF-8 and before it in UTF-16
//! code units. A vault with an emoji in a row id would diverge, which is
//! exactly the kind of bug that reproduces on one member's phone and nowhere
//! else. `compare_utf16` is therefore not a nicety.
//!
//! `crates/apps/kit`'s `canonical.rs` and `crates/media`'s `format.rs` are the
//! app plane's and the media plane's copies of the same rule, each with its own
//! reason for not importing this one; all three are held to the same cases.

use crate::error::{Result, VaultError};


/// Compare two strings by UTF-16 CODE UNIT, as JavaScript's `<` does.
#[must_use]
pub fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// The canonical JSON of a value: object keys sorted by UTF-16 code unit,
/// arrays in order, no whitespace.
///
/// A non-finite number is refused rather than written as `null`, which is what
/// `JSON.stringify` would do — a payload whose hash silently depended on
/// `NaN` becoming `null` is a payload two implementations disagree about.
pub fn canonical_json(value: &serde_json::Value) -> Result<String> {
    Ok(match value {
        serde_json::Value::Null => "null".to_owned(),
        serde_json::Value::Bool(flag) => flag.to_string(),
        serde_json::Value::String(text) => crate::value::json_string(text),
        serde_json::Value::Number(number) => {
            let Some(real) = number.as_f64() else {
                return Err(VaultError::Invariant {
                    context: format!("`{number}` is not a JSON-safe number"),
                });
            };
            if !real.is_finite() {
                return Err(VaultError::Invariant {
                    context: "an intent payload is not JSON-safe".to_owned(),
                });
            }
            if let Some(int) = number.as_i64() {
                int.to_string()
            } else {
                centraid_ontology::jsvalue::js_number_to_string(real)
            }
        }
        serde_json::Value::Array(items) => {
            let rendered = items
                .iter()
                .map(canonical_json)
                .collect::<Result<Vec<_>>>()?;
            format!("[{}]", rendered.join(","))
        }
        serde_json::Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| compare_utf16(left, right));
            let rendered = keys
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        crate::value::json_string(key),
                        canonical_json(&map[key])?
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            format!("{{{}}}", rendered.join(","))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_sort_by_utf16_code_unit_and_not_by_utf8_bytes() {
        // SEAM 6, as a test. U+10000 is a surrogate pair whose FIRST code unit
        // is 0xD800; U+E000 is a single 0xE000. So UTF-16 puts U+10000 first
        // and UTF-8 puts it last, and a Rust port that used `str::cmp` would
        // hash the same object to two different digests on two devices.
        let value = serde_json::json!({"\u{e000}": 1, "\u{10000}": 2});
        let rendered = canonical_json(&value).expect("it renders");
        assert!(
            rendered.starts_with("{\"\u{10000}\""),
            "UTF-8 order leaked in: {rendered}"
        );
        assert_eq!(
            compare_utf16("\u{10000}", "\u{e000}"),
            std::cmp::Ordering::Less
        );
        assert_eq!("\u{10000}".cmp("\u{e000}"), std::cmp::Ordering::Greater);
    }

    #[test]
    fn the_canonical_form_is_stable_and_whitespace_free() {
        let forwards = serde_json::json!({"b": [1, 2], "a": {"d": null, "c": true}});
        let backwards = serde_json::json!({"a": {"c": true, "d": null}, "b": [1, 2]});
        assert_eq!(
            canonical_json(&forwards).expect("it renders"),
            canonical_json(&backwards).expect("it renders")
        );
        assert_eq!(
            canonical_json(&forwards).expect("it renders"),
            "{\"a\":{\"c\":true,\"d\":null},\"b\":[1,2]}"
        );
    }

    #[test]
    fn a_non_finite_number_is_refused_rather_than_written_as_null() {
        // `JSON.stringify(NaN)` is `"null"`, so a port that mirrored it would
        // hash two different payloads to one digest.
        let mut map = serde_json::Map::new();
        map.insert(
            "x".to_owned(),
            serde_json::Number::from_f64(f64::INFINITY).map_or(serde_json::Value::Null, |number| {
                serde_json::Value::Number(number)
            }),
        );
        // `serde_json` refuses to BUILD a non-finite number, which is the same
        // guarantee one layer earlier; the refusal below is the one this
        // function owns, over a value that reached it some other way.
        assert!(canonical_json(&serde_json::json!({"x": 1.5})).is_ok());
        assert_eq!(
            canonical_json(&serde_json::Value::Object(map)).expect("it renders"),
            "{\"x\":null}"
        );
    }
}
