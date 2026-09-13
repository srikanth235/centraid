//! THE APP PLANE'S CANONICAL JSON (#1020, close pass, D-1020-CL8).
//!
//! **The bug this exists to make impossible.** `serde_json::Value::to_string`
//! prints an object's keys in *insertion* order under the `preserve_order`
//! feature and in *name* order without it — and the feature is not a crate's
//! own to choose. `agent-client-protocol`, four crates away through
//! `centraid-assist`, turns it on, and cargo unifies features across a build,
//! so the same code sorted a set one way under `cargo test -p
//! centraid-apps-people` and another under `cargo test --workspace`
//! (lane People's PE-F8, a parity suite that passed in one command and failed
//! in the other). **A JSON value's printed text is not a normal form, and which
//! crates are in the build decides what it is.**
//!
//! So every place in the app plane that orders, dedupes, hashes or compares by
//! a value's TEXT goes through here instead, and the answer is a fact about the
//! value.
//!
//! **The normal form, stated.** Object keys sorted by UTF-16 code unit (what
//! JavaScript's `<` compares, so the order agrees with the generators'
//! `stableJson`), arrays in their own order, no whitespace, strings escaped as
//! `JSON.stringify` escapes them, numbers spelled as ECMAScript spells them
//! (`centraid_ontology::jsvalue::js_number_to_string`, the one lowering of
//! v0's number formatting).
//!
//! **The other two canonicalisers in this tree, and why they stay.**
//! `crates/vault::intents::canonical_json` is the INTENT DIGEST's, and it
//! refuses a non-finite number rather than writing `null` because a payload
//! whose hash depends on that coercion is a payload two implementations
//! disagree about; it is fallible for that reason alone and `crates/vault` is
//! not on the app plane's import path. `crates/media::format::canonical_json`
//! is the BACKUP WIRE FORMAT's, hashed on both sides of a file by two
//! languages. The three agree on every value an app can produce — the test
//! below pins this one against the shapes that matter — and each says in its
//! own doc comment which job it is for, because the failure mode of one
//! canonicaliser used for three jobs is that it acquires a rule for one of them.

use serde_json::Value;

/// Compare two strings by UTF-16 code unit, as JavaScript's `<` does.
#[must_use]
pub fn compare_utf16(left: &str, right: &str) -> std::cmp::Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

/// One value's canonical text: object keys sorted recursively, no whitespace.
///
/// Total by construction — `serde_json::Number` cannot hold a non-finite value,
/// so there is no arm that can fail and no caller that has to decide what to do
/// when it does.
#[must_use]
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                out.push_str(&int.to_string());
            } else if let Some(real) = number.as_f64() {
                out.push_str(&centraid_ontology::jsvalue::js_number_to_string(real));
            } else {
                // A u64 past i64::MAX. `as_f64` covers it above on every
                // platform serde builds for; this arm is the honest fallback
                // rather than an `expect` in a total function.
                out.push_str(&number.to_string());
            }
        }
        Value::String(text) => out.push_str(&Value::String(text.clone()).to_string()),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_canonical(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|left, right| compare_utf16(left, right));
            out.push('{');
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write_canonical(&map[key], out);
            }
            out.push('}');
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};

    use super::canonical_json;

    /// An object built key by key in two different orders.
    ///
    /// This is the `preserve_order` toggle a test can actually run: the feature
    /// changes `Map` from a `BTreeMap` to an `IndexMap`, so under it these two
    /// values print differently and without it identically. The canonical form
    /// is the same either way, which is the whole claim — and the test is not
    /// vacuous in a build WITHOUT the feature, because it also pins the text.
    fn built(pairs: &[(&str, Value)]) -> Value {
        let mut map = Map::new();
        for (key, value) in pairs {
            map.insert((*key).to_owned(), value.clone());
        }
        Value::Object(map)
    }

    #[test]
    fn the_text_does_not_depend_on_the_order_the_keys_arrived_in() {
        let forwards = built(&[
            ("zebra", json!(1)),
            ("apple", built(&[("y", json!(true)), ("b", Value::Null)])),
        ]);
        let backwards = built(&[
            ("apple", built(&[("b", Value::Null), ("y", json!(true))])),
            ("zebra", json!(1)),
        ]);
        assert_eq!(canonical_json(&forwards), canonical_json(&backwards));
        assert_eq!(
            canonical_json(&forwards),
            r#"{"apple":{"b":null,"y":true},"zebra":1}"#
        );
    }

    /// THE NESTING IS THE POINT. A top-level key sort that stops at depth one
    /// is what `automations::row_hash` had, and a column carrying a JSON object
    /// is exactly where it fails.
    #[test]
    fn the_sort_reaches_every_depth() {
        let deep = json!([{ "outer": built(&[("z", json!([built(&[("q", json!(0)), ("a", json!(1))])])), ("a", json!(2))]) }]);
        assert_eq!(
            canonical_json(&deep),
            r#"[{"outer":{"a":2,"z":[{"a":1,"q":0}]}}]"#
        );
    }

    /// Numbers are ECMAScript's, so the text agrees with the generators'
    /// `stableJson` on the other side of every parity fixture.
    #[test]
    fn numbers_are_spelled_the_way_the_generator_spells_them() {
        assert_eq!(canonical_json(&json!(1.5)), "1.5");
        assert_eq!(canonical_json(&json!(1.0)), "1");
        assert_eq!(canonical_json(&json!(-0.0)), "0");
        assert_eq!(
            canonical_json(&json!(1_000_000_000_000_i64)),
            "1000000000000"
        );
    }

    /// The key order is JavaScript's, not Rust's: UTF-16 code unit, which
    /// disagrees with `str`'s byte order above U+FFFF.
    #[test]
    fn keys_sort_by_utf16_code_unit() {
        let mixed = built(&[("\u{10000}", json!(1)), ("\u{ffff}", json!(2))]);
        // UTF-8 byte order puts U+FFFF first (`EF BF BF` < `F0 90 80 80`);
        // UTF-16 puts U+10000 first, because a surrogate pair begins at 0xD800.
        // The two disagree, and JavaScript's is the one the fixtures are in.
        assert_eq!(canonical_json(&mixed), "{\"\u{10000}\":1,\"\u{ffff}\":2}");
    }
}
