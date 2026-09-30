//! The proto boundary: lane C's generated types on one side, D1's and D2's
//! plain Rust on the other.
//!
//! **The conversion lives here and nowhere else.** `crates/vault` deliberately
//! does not depend on `crates/api-proto` (lane C wrote the schema concurrently
//! with lane D1's file), so this module is the single seam and a spelling that
//! drifts drifts in one file.
//!
//! What it carries is now only VALUES: the log-row and log-page conversions
//! went with the replica log plane (#1029 §1), and the wire types they targeted
//! leave `core.proto` in W2-5.
//!
//! ## The one asymmetry worth naming
//!
//! `Value` on the wire carries the whole `i64` range as `int64`, with **no
//! decimal-text escape**. The vault's own JSON encoding has one — `{"i": "…"}`
//! past `Number.MAX_SAFE_INTEGER` — because that encoding is v0's and lives
//! *inside the file*, where a JS reader must still be able to read it. Protobuf
//! has real 64-bit integers, so the wire needs no escape and must not invent
//! one: a caller that received `{"i"}` on the wire would be parsing JSON out of
//! a protobuf field.

use centraid_api_proto::core_v1 as wire;
use centraid_vault::value::{RowImage, Value};

use crate::error::{CoreError, Result};

/// A vault value as the wire spells it.
#[must_use]
pub fn value_to_wire(value: &Value) -> wire::Value {
    wire::Value {
        kind: Some(match value {
            Value::Null => wire::value::Kind::Null(wire::NullValue {}),
            Value::Text(text) => wire::value::Kind::Text(text.clone()),
            // THE WHOLE i64 RANGE. No decimal-text escape: that is the file's
            // encoding, not the wire's.
            Value::Integer(int) => wire::value::Kind::Integer(*int),
            Value::Real(real) => wire::value::Kind::Real(*real),
            Value::Blob(bytes) => wire::value::Kind::Blob(bytes.clone()),
        }),
    }
}

/// A wire value as the vault holds it.
///
/// An absent `kind` is refused rather than read as NULL: proto3 cannot say
/// "required", so the refusal is the contract. A peer that sent no kind meant
/// something this build cannot know, and NULL is a guess that writes over data.
pub fn value_from_wire(value: &wire::Value) -> Result<Value> {
    let Some(kind) = &value.kind else {
        return Err(CoreError::InvalidRequest {
            detail: "a Value carries no kind; an absent kind is not SQL NULL".to_owned(),
        });
    };
    Ok(match kind {
        wire::value::Kind::Null(_) => Value::Null,
        wire::value::Kind::Text(text) => Value::Text(text.clone()),
        wire::value::Kind::Integer(int) => Value::Integer(*int),
        wire::value::Kind::Real(real) => Value::Real(*real),
        wire::value::Kind::Blob(bytes) => Value::Blob(bytes.to_vec()),
    })
}

/// A primary key as the wire spells it.
#[must_use]
pub fn key_to_wire(key: &[Value]) -> wire::RecordKey {
    wire::RecordKey {
        values: key.iter().map(value_to_wire).collect(),
    }
}

/// A row image as the wire spells it.
#[must_use]
pub fn image_to_wire(image: &RowImage) -> wire::RowImage {
    wire::RowImage {
        columns: image
            .iter()
            .map(|(column, value)| (column.clone(), value_to_wire(value)))
            .collect(),
    }
}

/// A prior delta as the wire spells it.
///
/// Separate from [`image_to_wire`] because the two are different claims with
/// the same shape: an image is a whole row and a delta is the touched columns'
/// OLD values. `PriorDelta` being its own message is what keeps a consumer from
/// treating one as the other.
#[must_use]
pub fn prior_to_wire(prior: &RowImage) -> wire::PriorDelta {
    wire::PriorDelta {
        columns: prior
            .iter()
            .map(|(column, value)| (column.clone(), value_to_wire(value)))
            .collect(),
    }
}

/// A row image read back off the wire.
pub fn image_from_wire(image: &wire::RowImage) -> Result<RowImage> {
    let mut out = RowImage::new();
    for (column, value) in &image.columns {
        out.insert(column.clone(), value_from_wire(value)?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_value_kind_round_trips() {
        for value in [
            Value::Null,
            Value::Text("a".to_owned()),
            Value::Integer(i64::MIN),
            Value::Integer(i64::MAX),
            Value::Real(1.5),
            Value::Blob(vec![0, 1, 255]),
        ] {
            let round = value_from_wire(&value_to_wire(&value)).expect("it reads back");
            assert_eq!(round, value, "`{value:?}` did not survive");
        }
    }

    /// The asymmetry, stated as a test. Past `Number.MAX_SAFE_INTEGER` the
    /// FILE's encoding escapes to decimal text; the WIRE does not.
    #[test]
    fn a_wide_integer_crosses_the_wire_as_an_integer_and_not_as_decimal_text() {
        let wide = Value::Integer(centraid_vault::value::MAX_SAFE_INTEGER + 1);
        let on_the_wire = value_to_wire(&wide);
        assert!(matches!(
            on_the_wire.kind,
            Some(wire::value::Kind::Integer(_))
        ));
        // And the file's own encoding does escape, which is why this test
        // exists rather than being obvious.
        assert!(wide.to_wire_json().contains("\"i\""));
    }

    #[test]
    fn an_absent_value_kind_is_refused_and_not_read_as_null() {
        assert!(value_from_wire(&wire::Value { kind: None }).is_err());
    }
}
