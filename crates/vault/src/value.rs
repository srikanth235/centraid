//! A SQLite value, a row image, and the JSON the log stores them as.
//!
//! Three distinctions this module exists to keep, each of which v0 lost once
//! and paid for (plane census seam 2, `packages/core/src/protocol/row-json.ts:1-28`):
//!
//! 1. **An absent key is not a NULL.** An UPDATE's changeset record omits every
//!    column the statement did not touch. A reader that cannot tell an omitted
//!    column from a NULL one writes NULLs over live data. `RowImage` is a map,
//!    so absence is the absence of a key, and [`Value`] has no "absent"
//!    variant on purpose — a value that is there is there.
//! 2. **A BLOB is not NULL.** JSON has no byte string; the retired change-log
//!    trigger reduced blobs to NULL and the hole surfaced later, in a filter
//!    over a column nobody had looked at. A BLOB is `{"b64": "…"}`.
//! 3. **A 64-bit integer is not always a JSON number.** Past
//!    `Number.MAX_SAFE_INTEGER` a JSON number loses precision, and a vault that
//!    stores byte counts reaches that. Beyond the boundary, and ONLY beyond it,
//!    an integer is `{"i": "<decimal>"}`.
//!
//! ## Why the file's own format is still v0's JSON (D-1020-D1-4)
//!
//! v1's wire is protobuf (lane C). This encoding is not the wire — it is what
//! `replica_log.row_json` holds INSIDE the file, and it stays v0's for one
//! reason: the ORACLE fixture compares Rust's log rows against rows v0
//! produced, value for value, and a differently-spelled image would make every
//! row a finding for a difference that is not a difference. The secondary
//! benefit is that a v0 reader could still read a v1 log row.
//!
//! The number spelling is therefore JavaScript's, borrowed from
//! `centraid_ontology::jsvalue::js_number_to_string` rather than re-derived: a
//! REAL `1.0` is JSON `1`, because `node:sqlite` handed the freezer a JS number
//! and `JSON.stringify` prints `1`. Rust's own `f64` formatting prints `1.0`,
//! and every such cell would be a phantom diff.

use std::collections::BTreeMap;

use centraid_ontology::jsvalue::js_number_to_string;
use rusqlite::types::{ToSqlOutput, ValueRef};

use crate::error::{Result, VaultError};

/// Beyond this a JSON number silently loses integer precision.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// One SQLite cell. The five storage classes, and nothing else.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Value {
    /// Read a value off a statement's column.
    pub fn from_ref(value: ValueRef<'_>) -> Result<Self> {
        Ok(match value {
            ValueRef::Null => Self::Null,
            ValueRef::Integer(int) => Self::Integer(int),
            ValueRef::Real(real) => Self::Real(real),
            ValueRef::Text(bytes) => Self::Text(
                std::str::from_utf8(bytes)
                    .map_err(|_| VaultError::Invariant {
                        context: "a TEXT cell is not UTF-8".to_owned(),
                    })?
                    .to_owned(),
            ),
            ValueRef::Blob(bytes) => Self::Blob(bytes.to_vec()),
        })
    }

    /// The JSON text for one cell, in v0's spelling.
    pub fn to_wire_json(&self) -> String {
        match self {
            Self::Null => "null".to_owned(),
            Self::Integer(int) => {
                // `unsigned_abs`, not `abs`: `i64::MIN.abs()` overflows, and
                // `i64::MIN` is a value a byte count can legitimately hold on
                // the way to being rejected somewhere else.
                if int.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() {
                    int.to_string()
                } else {
                    // A one-key object, and the key is the whole signal.
                    format!("{{\"i\":{}}}", json_string(&int.to_string()))
                }
            }
            // Not `{int}` and not Rust's `{real}`: JavaScript's.
            Self::Real(real) => {
                let spelled = js_number_to_string(*real);
                // NaN and the infinities have no JSON spelling. v0 would have
                // written `null` through `JSON.stringify`, which loses the
                // cell; refusing is the honest answer, and no v0 corpus holds
                // one (`jsvalue` documents the same three cases).
                if spelled.ends_with("Infinity") || spelled == "NaN" {
                    "null".to_owned()
                } else {
                    spelled
                }
            }
            Self::Text(text) => json_string(text),
            Self::Blob(bytes) => format!("{{\"b64\":{}}}", json_string(&to_base64(bytes))),
        }
    }

    /// Read one cell back out of parsed JSON.
    ///
    /// A JSON number with no fraction and no exponent that fits an `i64` comes
    /// back as `Integer`, and anything else numeric as `Real`. That is not a
    /// guess: `node:sqlite` handed the producer a JS number for both a small
    /// INTEGER and a REAL, so the two are genuinely indistinguishable in this
    /// format and v0's own applier binds whichever SQLite's affinity wants.
    pub fn from_wire_json(value: &serde_json::Value) -> Result<Self> {
        match value {
            serde_json::Value::Null => Ok(Self::Null),
            serde_json::Value::Bool(flag) => Ok(Self::Integer(i64::from(*flag))),
            serde_json::Value::String(text) => Ok(Self::Text(text.clone())),
            serde_json::Value::Number(number) => {
                if let Some(int) = number.as_i64() {
                    Ok(Self::Integer(int))
                } else if let Some(real) = number.as_f64() {
                    Ok(Self::Real(real))
                } else {
                    Err(VaultError::Invariant {
                        context: format!("`{number}` is not a value a row image can hold"),
                    })
                }
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::String(decimal)) = map.get("i") {
                    return decimal.parse::<i64>().map(Self::Integer).map_err(|_| {
                        VaultError::Invariant {
                            context: format!("`{decimal}` is not a 64-bit integer"),
                        }
                    });
                }
                if let Some(serde_json::Value::String(base64)) = map.get("b64") {
                    return from_base64(base64).map(Self::Blob);
                }
                Err(VaultError::Invariant {
                    context: "a wire value object must carry exactly `i` or `b64`".to_owned(),
                })
            }
            serde_json::Value::Array(_) => Err(VaultError::Invariant {
                context: "an array is not a SQLite value".to_owned(),
            }),
        }
    }

    /// Bind this value into a statement.
    #[must_use]
    pub fn to_sql_output(&self) -> ToSqlOutput<'_> {
        match self {
            Self::Null => ToSqlOutput::Borrowed(ValueRef::Null),
            Self::Integer(int) => ToSqlOutput::Owned(rusqlite::types::Value::Integer(*int)),
            Self::Real(real) => ToSqlOutput::Owned(rusqlite::types::Value::Real(*real)),
            Self::Text(text) => ToSqlOutput::Borrowed(ValueRef::Text(text.as_bytes())),
            Self::Blob(bytes) => ToSqlOutput::Borrowed(ValueRef::Blob(bytes)),
        }
    }
}

impl rusqlite::ToSql for Value {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(self.to_sql_output())
    }
}

/// One row image: column name to value. **An absent key is an absent column.**
///
/// Ordered, and not as a convenience: the JSON this serialises to is compared
/// against v0's rows by value in the ORACLE fixture, and a map with a
/// non-deterministic order would make the comparison depend on a hash seed.
pub type RowImage = BTreeMap<String, Value>;

/// Serialise a row image as the log stores it.
#[must_use]
pub fn row_image_to_json(image: &RowImage) -> String {
    let mut out = String::from("{");
    for (index, (column, value)) in image.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&json_string(column));
        out.push(':');
        out.push_str(&value.to_wire_json());
    }
    out.push('}');
    out
}

/// Parse a row image back out of the log.
pub fn row_image_from_json(text: &str) -> Result<RowImage> {
    let parsed: serde_json::Value =
        serde_json::from_str(text).map_err(|source| VaultError::Json {
            context: "a stored row image is not JSON".to_owned(),
            source,
        })?;
    let serde_json::Value::Object(map) = parsed else {
        return Err(VaultError::Invariant {
            context: "a stored row image is not a JSON object".to_owned(),
        });
    };
    let mut image = RowImage::new();
    for (column, value) in map {
        image.insert(column, Value::from_wire_json(&value)?);
    }
    Ok(image)
}

/// A JSON array of the key values, in declared key order — how `pk_json` is
/// stored, and what `SeatLogRowWire.pk` carries.
#[must_use]
pub fn key_to_json(key: &[Value]) -> String {
    let mut out = String::from("[");
    for (index, value) in key.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&value.to_wire_json());
    }
    out.push(']');
    out
}

/// Parse a `pk_json` back to its values.
pub fn key_from_json(text: &str) -> Result<Vec<Value>> {
    let parsed: serde_json::Value =
        serde_json::from_str(text).map_err(|source| VaultError::Json {
            context: "a stored key is not JSON".to_owned(),
            source,
        })?;
    let serde_json::Value::Array(values) = parsed else {
        return Err(VaultError::Invariant {
            context: "a stored key is not a JSON array".to_owned(),
        });
    };
    values.iter().map(Value::from_wire_json).collect()
}

/// A JSON string literal, escaped as `JSON.stringify` escapes one.
///
/// Written here rather than borrowed from `serde_json` because the rest of the
/// encoder writes text directly (a JS-spelled number has no `serde_json::Number`),
/// and one writer with one escaping rule is easier to hold to the oracle than
/// two halves that agree by coincidence.
#[must_use]
pub fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            // JSON.stringify escapes every other control character as \uXXXX,
            // and leaves everything above them, including astral characters,
            // as literal UTF-8.
            control if control < ' ' => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding, the alphabet v0 hand-rolled.
#[must_use]
pub fn to_base64(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0];
        let b = chunk.get(1).copied();
        let c = chunk.get(2).copied();
        out.push(B64[usize::from(a >> 2)] as char);
        out.push(B64[usize::from(((a & 3) << 4) | (b.unwrap_or(0) >> 4))] as char);
        match b {
            None => out.push('='),
            Some(b) => out.push(B64[usize::from(((b & 15) << 2) | (c.unwrap_or(0) >> 6))] as char),
        }
        match c {
            None => out.push('='),
            Some(c) => out.push(B64[usize::from(c & 63)] as char),
        }
    }
    out
}

/// Decode standard base64, refusing anything outside the alphabet.
pub fn from_base64(text: &str) -> Result<Vec<u8>> {
    let clean = text.trim_end_matches('=');
    let mut bytes = Vec::with_capacity(clean.len() * 3 / 4);
    let mut bits = 0u32;
    let mut accumulator = 0u32;
    for character in clean.bytes() {
        let Some(value) = B64.iter().position(|&code| code == character) else {
            return Err(VaultError::Invariant {
                context: "replica log: malformed base64 blob".to_owned(),
            });
        };
        accumulator =
            (accumulator << 6) | u32::try_from(value).expect("a base64 digit is under 64");
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push(u8::try_from((accumulator >> bits) & 0xff).expect("masked to one byte"));
        }
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_integer_boundary_is_max_safe_integer_and_not_i64() {
        // SEAM 2. A Rust port that always emitted `{i}` for an i64 would move
        // every row's bytes; one that never did would lose precision on a byte
        // count. The boundary is JS's, and it is INCLUSIVE.
        assert_eq!(Value::Integer(0).to_wire_json(), "0");
        assert_eq!(Value::Integer(-7).to_wire_json(), "-7");
        assert_eq!(
            Value::Integer(MAX_SAFE_INTEGER).to_wire_json(),
            "9007199254740991"
        );
        assert_eq!(
            Value::Integer(-MAX_SAFE_INTEGER).to_wire_json(),
            "-9007199254740991"
        );
        assert_eq!(
            Value::Integer(MAX_SAFE_INTEGER + 1).to_wire_json(),
            "{\"i\":\"9007199254740992\"}"
        );
        assert_eq!(
            Value::Integer(i64::MIN).to_wire_json(),
            "{\"i\":\"-9223372036854775808\"}"
        );
    }

    #[test]
    fn a_real_is_spelled_the_way_javascript_spells_it() {
        assert_eq!(Value::Real(1.0).to_wire_json(), "1");
        assert_eq!(Value::Real(1.5).to_wire_json(), "1.5");
        assert_eq!(Value::Real(-0.0).to_wire_json(), "0");
        assert_eq!(Value::Real(1e21).to_wire_json(), "1e+21");
        assert_eq!(Value::Real(f64::NAN).to_wire_json(), "null");
    }

    #[test]
    fn a_blob_is_b64_and_never_null() {
        assert_eq!(
            Value::Blob(vec![1, 2, 255]).to_wire_json(),
            "{\"b64\":\"AQL/\"}"
        );
        assert_eq!(Value::Blob(Vec::new()).to_wire_json(), "{\"b64\":\"\"}");
        assert_eq!(
            Value::from_wire_json(&serde_json::json!({"b64": "AQL/"})).expect("decodes"),
            Value::Blob(vec![1, 2, 255])
        );
    }

    #[test]
    fn an_absent_key_and_a_null_are_two_different_images() {
        let mut with_null = RowImage::new();
        with_null.insert("a".to_owned(), Value::Integer(1));
        with_null.insert("b".to_owned(), Value::Null);
        let mut without = RowImage::new();
        without.insert("a".to_owned(), Value::Integer(1));

        assert_eq!(row_image_to_json(&with_null), "{\"a\":1,\"b\":null}");
        assert_eq!(row_image_to_json(&without), "{\"a\":1}");
        assert_ne!(with_null, without);
        // And the distinction survives the round trip, which is the claim the
        // applier depends on.
        assert_eq!(
            row_image_from_json(&row_image_to_json(&with_null)).expect("parses"),
            with_null
        );
        assert_eq!(
            row_image_from_json(&row_image_to_json(&without)).expect("parses"),
            without
        );
    }

    #[test]
    fn text_never_collides_with_the_two_wide_forms() {
        // A TEXT value encodes as a JSON string, never as an object, so a row
        // whose text happens to read `{"i":"1"}` stays text.
        let text = Value::Text("{\"i\":\"1\"}".to_owned());
        let json = text.to_wire_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("parses");
        assert_eq!(Value::from_wire_json(&parsed).expect("decodes"), text);
    }

    #[test]
    fn control_characters_and_astral_text_round_trip() {
        for sample in ["a\nb", "tab\there", "\u{1}", "emoji 🙂", "\u{10000}"] {
            let value = Value::Text(sample.to_owned());
            let json = value.to_wire_json();
            let parsed: serde_json::Value = serde_json::from_str(&json).expect("parses");
            assert_eq!(Value::from_wire_json(&parsed).expect("decodes"), value);
        }
    }

    #[test]
    fn base64_round_trips_every_byte() {
        for length in 0..8_usize {
            let bytes: Vec<u8> = (0..length).map(|index| (index * 37 + 11) as u8).collect();
            assert_eq!(
                from_base64(&to_base64(&bytes)).expect("decodes"),
                bytes,
                "at length {length}"
            );
        }
        assert!(from_base64("not base64!").is_err());
    }

    #[test]
    fn a_key_is_a_json_array_in_declared_order() {
        assert_eq!(
            key_to_json(&[Value::Text("a".to_owned()), Value::Integer(2)]),
            "[\"a\",2]"
        );
        assert_eq!(
            key_from_json("[\"a\",2]").expect("parses"),
            vec![Value::Text("a".to_owned()), Value::Integer(2)]
        );
    }
}
