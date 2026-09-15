//! The replica log plane: the commit pair, the log rows, the doors.
//!
//! One table, one number, one truth. `replica_log` holds a full row image per
//! change and `replica_meta` holds the singleton position; there is **no
//! compaction**, because a log row is already a full image and folding buys
//! nothing a truncation does not.
//!
//! Two numbers that look alike and are not (plane census seam 5):
//!
//! - **`seq`** is a row's position in the log, and a seat's cursor is one of
//!   these. `AUTOINCREMENT`, so it never reuses a number a prune freed.
//! - **`commit_seq`** is the transaction that row belongs to. Every row of one
//!   commit shares it, an intent's outcome names it, and a seat applies one
//!   commit per transaction with its cursor in the same transaction.
//!
//! Comparing one against the other is named in v0's own source as "the R6
//! mistake in miniature — 432 against 2". The two translations live in
//! [`door::lowest_seat_commit_seq`] and nowhere else.
//!
//! And two more: **`schema_epoch`** is compatibility (a mismatch is a
//! re-bootstrap) and **`ddl_version`** is additive progress inside one epoch.
//! Conflating them makes every additive column a full re-bootstrap.

pub mod apply;
pub mod capture;
pub mod door;
pub mod guard;
pub mod store;

pub use apply::{ApplyOutcome, apply_log_page};
pub use capture::{DecodedRow, LogOp, primary_key_of, quoted, table_columns};
pub use door::{
    Cursor, LogPage, LogState, bump_epoch, format_cursor, log_state, lowest_seat_cursor,
    parse_cursor, prune, read_log_page, record_seat_cursor,
};
pub use guard::{CommitResult, CommitTx, ProducedRow};
pub use store::{LogRow, seed_replica_meta};

use crate::value::{RowImage, Value};

/// Strip the JSON keys a replicated image must not carry.
///
/// `REPLICATED_JSON_KEY_EXCLUSIONS` is `{access_receipt: {detail_json:
/// ["output"]}}`: a command's output has a gateway-only reader and every seat
/// was otherwise carrying a copy of every command result.
///
/// Returns whether anything changed, so the common path costs no allocation.
/// The value is re-serialised ONLY when a key was actually present: a receipt
/// with no `output` must come out byte-identical, or every row's hash would
/// move for a redaction that removed nothing.
pub fn redact_row_image(table: &str, image: &mut RowImage) -> bool {
    let exclusions = &centraid_ontology::registries::v0_registries()
        .replica_constants
        .json_key_exclusions;
    let mut changed = false;
    for exclusion in exclusions.iter().filter(|entry| entry.table == table) {
        let Some(Value::Text(text)) = image.get(&exclusion.column) else {
            continue;
        };
        let Ok(mut parsed) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        let Some(object) = parsed.as_object_mut() else {
            continue;
        };
        let mut removed = false;
        for key in &exclusion.json_keys {
            removed |= object.remove(key).is_some();
        }
        if removed {
            image.insert(
                exclusion.column.clone(),
                Value::Text(serde_json::to_string(&parsed).unwrap_or_else(|_| text.clone())),
            );
            changed = true;
        }
    }
    changed
}

/// The replica plane's constants, from the transcribed registry.
///
/// Read through a function rather than copied into Rust constants: a number
/// here that disagreed with v0's would be a silent protocol change, and the
/// registry fixture is the one place either side can be held to.
#[must_use]
pub fn constants() -> &'static centraid_ontology::registries::ReplicaConstants {
    &centraid_ontology::registries::v0_registries().replica_constants
}

/// The tables logged with `local = 1`: captured for the doorbell, never served.
#[must_use]
pub fn local_tables() -> &'static [String] {
    &constants().local_tables
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redaction_removes_the_declared_key_and_nothing_else() {
        let mut image = RowImage::new();
        image.insert(
            "detail_json".to_owned(),
            Value::Text("{\"output\":\"secret\",\"risk\":\"low\"}".to_owned()),
        );
        assert!(redact_row_image("access_receipt", &mut image));
        let Some(Value::Text(after)) = image.get("detail_json") else {
            panic!("the column survives redaction");
        };
        assert!(!after.contains("secret"));
        assert!(after.contains("risk"));
    }

    #[test]
    fn a_row_with_nothing_to_redact_is_left_byte_identical() {
        // The property the whole "only re-serialise when a key was removed"
        // rule exists for: an unaffected receipt must not move.
        let original = "{\"risk\":\"low\"}";
        let mut image = RowImage::new();
        image.insert("detail_json".to_owned(), Value::Text(original.to_owned()));
        assert!(!redact_row_image("access_receipt", &mut image));
        assert_eq!(
            image.get("detail_json"),
            Some(&Value::Text(original.to_owned()))
        );
    }

    #[test]
    fn redaction_is_scoped_to_the_declared_table_and_column() {
        let mut image = RowImage::new();
        image.insert(
            "detail_json".to_owned(),
            Value::Text("{\"output\":\"kept\"}".to_owned()),
        );
        assert!(!redact_row_image("agent_command_invocation", &mut image));
        assert!(
            matches!(image.get("detail_json"), Some(Value::Text(text)) if text.contains("kept"))
        );
    }
}
