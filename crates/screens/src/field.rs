//! The hand-written half of the generated catalogue (`catalog.rs`): how an
//! input becomes a core `Value`, and how an `ActRequest` gets its key.
//!
//! Nothing here names an app, an action or a query; those are the manifests',
//! and only the generated file spells them.

use std::collections::HashMap;

use centraid_api_proto::core_v1 as wire;

/// A property the schema lets be `null`: [`Field::Keep`] sends nothing,
/// [`Field::Clear`] sends `null`, [`Field::Is`] sends the value.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Field<T> {
    #[default]
    Keep,
    Clear,
    Is(T),
}

/// The JSON null: a required value that is deliberately nothing.
pub(crate) fn null() -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Null(wire::NullValue {})),
    }
}

pub(crate) fn text(value: impl Into<String>) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Text(value.into())),
    }
}

pub(crate) fn whole(value: i64) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Integer(value)),
    }
}

pub(crate) fn real(value: f64) -> wire::Value {
    wire::Value {
        kind: Some(wire::value::Kind::Real(value)),
    }
}

/// A boolean travels as 0 or 1; the core types it by the manifest's schema.
pub(crate) fn flag(value: bool) -> wire::Value {
    whole(i64::from(value))
}

pub(crate) fn put_field<T>(
    map: &mut HashMap<String, wire::Value>,
    name: &str,
    field: Field<T>,
    encode: impl FnOnce(T) -> wire::Value,
) {
    match field {
        Field::Keep => {}
        Field::Clear => {
            map.insert(
                name.to_owned(),
                wire::Value {
                    kind: Some(wire::value::Kind::Null(wire::NullValue {})),
                },
            );
        }
        Field::Is(value) => {
            map.insert(name.to_owned(), encode(value));
        }
    }
}

/// An `ActRequest` under the key that tells this gesture from another. The
/// core runs one key once, so a screen mints a fresh key per tap.
pub trait Keyed {
    #[must_use]
    fn keyed(self, key: impl Into<String>) -> Self;
}

impl Keyed for wire::ActRequest {
    fn keyed(mut self, key: impl Into<String>) -> Self {
        self.invoke_key = key.into();
        self
    }
}
