//! A row, and the three states a column value has.
//!
//! **NULL, MISSING and a value are three different claims** (#1020, apps seam
//! 6). v0 keeps them apart with three mechanisms: `guardedRow` Proxies a row so
//! that reading a column the replica *stripped* throws rather than reading as
//! absent data (`packages/client/src/replica/inline-query-ctx-core.ts:50`),
//! `ReplicaRowEnvelope.hasUnavailableFields` separates "not disclosed" from
//! "over the ceiling", and `Page.next` is *absent* rather than null when rows
//! end (`packages/core/src/page/window.ts:59`).
//!
//! Rust's `Option<T>` collapses two of those, and the collapse is how the
//! ONT-23 class of bug comes back as "0 instead of unknown". So a row is a map
//! whose **absent key is an absent column** and whose `Cell::Null` is SQL NULL,
//! and every read of a cell says which of the two it found.

use std::collections::BTreeMap;

use centraid_ontology::jsvalue::js_number_to_string;

/// One column value, as SQLite hands it over.
#[derive(Debug, Clone, PartialEq)]
pub enum Cell {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Cell {
    /// The cell as the cursor spells it — `String(value)` in v0, so an integer
    /// sort column round-trips as its decimal text
    /// (`packages/core/src/page/statement.ts:77`, apps seam 7).
    pub fn to_cursor_text(&self) -> String {
        match self {
            // `pageCursorOf` maps a null sort key to the empty string, and a
            // Rust port needs the same collapse or cursors diverge.
            Self::Null => String::new(),
            Self::Integer(value) => value.to_string(),
            Self::Real(value) => js_number_to_string(*value),
            Self::Text(value) => value.clone(),
            // v0 never carries a BLOB sort column; naming the shape is the
            // honest answer rather than inventing an encoding for it.
            Self::Blob(bytes) => format!("[blob {} bytes]", bytes.len()),
        }
    }

    /// The type name v0's `typeof` would print, for the cursor's refusal.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Null => "object",
            Self::Integer(_) | Self::Real(_) => "number",
            Self::Text(_) => "string",
            Self::Blob(_) => "object",
        }
    }

    /// The text of a text cell, or `None` for every other kind — including
    /// NULL, which is a value and not a string.
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text(value) => Some(value),
            _ => None,
        }
    }

    /// The integer of an integer cell. A REAL is **not** coerced: a fold that
    /// rounds a float into minor units is the ONT-23 arithmetic.
    pub fn integer(&self) -> Option<i64> {
        match self {
            Self::Integer(value) => Some(*value),
            _ => None,
        }
    }
}

/// One row. An absent key is an absent column; `Cell::Null` is SQL NULL.
pub type Row = BTreeMap<String, Cell>;

/// What a lookup found, keeping the three states apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Found {
    /// The column was in the projection and held a value.
    Value,
    /// The column was in the projection and held NULL.
    Null,
    /// The column was never projected. Never the same claim as NULL.
    Missing,
}

/// Which of the three states a row's column is in.
pub fn found(row: &Row, column: &str) -> Found {
    match row.get(column) {
        None => Found::Missing,
        Some(Cell::Null) => Found::Null,
        Some(_) => Found::Value,
    }
}

/// A text column, treating NULL and missing alike **only** where the caller has
/// said it may: every call site that folds money uses `integer` and `found`.
pub fn text_of(row: &Row, column: &str) -> Option<String> {
    row.get(column).and_then(Cell::text).map(str::to_owned)
}

/// An integer column, or zero when the column is NULL or absent. Named for what
/// it does, because a silent zero is only correct where zero is the identity.
pub fn integer_or_zero(row: &Row, column: &str) -> i64 {
    row.get(column).and_then(Cell::integer).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_missing_and_value_are_three_answers() {
        let mut row = Row::new();
        row.insert("a".to_owned(), Cell::Null);
        row.insert("b".to_owned(), Cell::Integer(1));
        assert_eq!(found(&row, "a"), Found::Null);
        assert_eq!(found(&row, "b"), Found::Value);
        assert_eq!(found(&row, "c"), Found::Missing);
    }

    #[test]
    fn a_null_sort_key_collapses_to_the_empty_string() {
        assert_eq!(Cell::Null.to_cursor_text(), "");
        assert_eq!(Cell::Integer(42).to_cursor_text(), "42");
        assert_eq!(Cell::Real(42.5).to_cursor_text(), "42.5");
        // `String(1e21)` is "1e+21", not 22 digits.
        assert_eq!(Cell::Real(1e21).to_cursor_text(), "1e+21");
    }
}
