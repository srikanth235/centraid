//! THE KEYSET CURSOR (app-plane §2): `c1.` and the base64url, without padding, of the JSON
//! `[read_name, k1, …, id]`, the last returned row's `ORDER BY` tuple. Opaque to shells.
//!
//! A cursor names its read and its arity. One that names another read, or counts its keys
//! differently, is refused with [`STALE_LIST`](super::STALE_LIST): the list changed under the
//! screen that held it.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;

use super::error::{ReadError, Result};
use super::{ReadDecl, Shape};

const PREFIX: &str = "c1.";

/// One term of a key tuple: an id, an instant, a slug, or a row number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Term {
    Text(String),
    Int(i64),
}

impl Term {
    fn to_json(&self) -> Value {
        match self {
            Self::Text(text) => Value::String(text.clone()),
            Self::Int(number) => Value::from(*number),
        }
    }

    fn from_json(value: &Value) -> Option<Self> {
        match value {
            Value::String(text) => Some(Self::Text(text.clone())),
            Value::Number(number) => number.as_i64().map(Self::Int),
            _ => None,
        }
    }
}

/// The cursor after the row whose key tuple is `keys`.
///
/// # Errors
/// [`ReadError::Shape`] for a read that is not a `PagedList`, and [`ReadError::Declared`] when
/// the tuple is not as long as the read's order.
pub fn encode(read: &ReadDecl, keys: &[Term]) -> Result<String> {
    expect_paged(read)?;
    if keys.len() != read.cursor.len() {
        return Err(ReadError::Declared {
            read: read.name,
            why: format!(
                "its cursor has {} keys and a row gave {}",
                read.cursor.len(),
                keys.len()
            ),
        });
    }
    let mut parts = vec![Value::String(read.name.to_owned())];
    parts.extend(keys.iter().map(Term::to_json));
    let json = serde_json::to_vec(&Value::Array(parts)).map_err(|error| ReadError::Declared {
        read: read.name,
        why: error.to_string(),
    })?;
    Ok(format!("{PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
}

/// The key tuple a cursor of `read` carries.
///
/// # Errors
/// [`ReadError::StaleCursor`] for anything that is not this read's own cursor.
pub fn decode(read: &ReadDecl, cursor: &str) -> Result<Vec<Term>> {
    expect_paged(read)?;
    let body = cursor.strip_prefix(PREFIX).ok_or(ReadError::StaleCursor)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(body)
        .map_err(|_| ReadError::StaleCursor)?;
    let Value::Array(parts) = serde_json::from_slice(&bytes).map_err(|_| ReadError::StaleCursor)?
    else {
        return Err(ReadError::StaleCursor);
    };
    let Some((named, keys)) = parts.split_first() else {
        return Err(ReadError::StaleCursor);
    };
    if named.as_str() != Some(read.name) || keys.len() != read.cursor.len() {
        return Err(ReadError::StaleCursor);
    }
    keys.iter()
        .map(|key| Term::from_json(key).ok_or(ReadError::StaleCursor))
        .collect()
}

/// The terms a first page binds: a value past every key, so the keyset predicate keeps its index
/// seek. The highest string, `char(1114111)`, sorts after any id, instant or slug, and after every
/// number (SQLite orders a number before any text); a key that runs upward binds `i64::MIN`,
/// which sorts before any text and any number.
#[must_use]
pub fn first_page(read: &ReadDecl) -> Vec<Term> {
    read.cursor
        .iter()
        .map(|key| {
            if key.ascending {
                Term::Int(i64::MIN)
            } else {
                Term::Text(char::MAX.to_string())
            }
        })
        .collect()
}

fn expect_paged(read: &ReadDecl) -> Result<()> {
    if read.shape == Shape::PagedList {
        Ok(())
    } else {
        Err(ReadError::Shape {
            read: read.name,
            shape: read.shape,
        })
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::super::{Key, Param, ReadDecl, Shape, desc};
    use super::*;

    const TWO: ReadDecl = ReadDecl {
        name: "t.two",
        shape: Shape::PagedList,
        sql: "",
        params: &[] as &[Param],
        reads: &[],
        across: &[],
        bound: 50,
        cursor: &[desc("at", "a"), desc("id", "b")],
    };
    const ONE: ReadDecl = ReadDecl {
        name: "t.one",
        cursor: &[desc("id", "a")] as &[Key],
        ..TWO
    };
    const OTHER: ReadDecl = ReadDecl {
        name: "t.other",
        ..TWO
    };

    fn term() -> impl Strategy<Value = Term> {
        prop_oneof![
            any::<String>().prop_map(Term::Text),
            any::<i64>().prop_map(Term::Int)
        ]
    }

    proptest! {
        #[test]
        fn a_cursor_round_trips(first in term(), last in term()) {
            let keys = vec![first, last];
            let cursor = encode(&TWO, &keys).unwrap();
            prop_assert!(cursor.starts_with("c1."));
            prop_assert!(!cursor.contains('='));
            prop_assert_eq!(decode(&TWO, &cursor).unwrap(), keys);
        }

        #[test]
        fn a_foreign_cursor_is_refused(first in term(), last in term()) {
            let cursor = encode(&TWO, &[first, last]).unwrap();
            prop_assert!(matches!(decode(&OTHER, &cursor), Err(ReadError::StaleCursor)));
        }

        #[test]
        fn a_cursor_of_the_wrong_arity_is_refused(only in term(), first in term(), last in term()) {
            let short = encode(&ONE, &[only]).unwrap();
            let long = encode(&TWO, &[first, last]).unwrap();
            let renamed = |cursor: &str, from: &ReadDecl| {
                let body = URL_SAFE_NO_PAD.decode(cursor.trim_start_matches("c1.")).unwrap();
                let mut parts: Vec<Value> = serde_json::from_slice(&body).unwrap();
                parts[0] = Value::String(from.name.to_owned());
                format!("c1.{}", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&parts).unwrap()))
            };
            prop_assert!(matches!(decode(&TWO, &renamed(&short, &TWO)), Err(ReadError::StaleCursor)));
            prop_assert!(matches!(decode(&ONE, &renamed(&long, &ONE)), Err(ReadError::StaleCursor)));
        }

        #[test]
        fn nothing_else_is_a_cursor(junk in any::<String>()) {
            prop_assert!(matches!(decode(&TWO, &junk), Err(ReadError::StaleCursor)));
        }
    }

    #[test]
    fn the_first_page_binds_a_value_past_every_key() {
        let keys = first_page(&TWO);
        assert_eq!(keys[1], Term::Text("\u{10FFFF}".to_owned()));
        let up = ReadDecl {
            cursor: &[Key {
                column: "at",
                param: "a",
                ascending: true,
            }],
            ..TWO
        };
        assert_eq!(first_page(&up), vec![Term::Int(i64::MIN)]);
    }

    #[test]
    fn only_a_paged_list_has_a_cursor() {
        let by_key = ReadDecl {
            shape: Shape::ByKey,
            ..TWO
        };
        assert!(matches!(encode(&by_key, &[]), Err(ReadError::Shape { .. })));
    }
}
