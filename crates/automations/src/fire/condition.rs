//! Condition and data sources: *"time lives in the data"* (#1020, D-1020-AU1).
//!
//! ## Condition: the matching-hash SET is the cursor
//!
//! `fire/condition.ts:1`–`:7`. Dedup is by row **content** hash, so:
//!
//! | The row | What happens |
//! |---|---|
//! | stays matched, unchanged | fires **once** |
//! | changes while still matching | fires **again** |
//! | leaves the window and re-enters unchanged | fires **again** |
//!
//! The last one is why the element's `position` is `<hash>:<occurredAt>` and
//! not the hash: the run's idempotency key is derived from the position, so a
//! re-entry that reused the hash would be answered from the ledger as a replay
//! of the first fire.
//!
//! **The committed position advances over DELIVERED rows only.** A match
//! beyond the batch cap stays unseen and arrives on the next gate tick; rows
//! that left the window drop out of the set, which is what makes a re-entry
//! fire at all.
//!
//! ## Data: a fresh watcher reacts to what happens NEXT
//!
//! A bootstrap pull — no stored position — **fires nothing**. A watcher
//! installed today must not react to the whole provenance journal. And only a
//! feed-native id is a legal watermark: a synthesised position identifies the
//! delivery but is never committed as one, because the next pull would not
//! understand it.
//!
//! ## No SQL, and no vault handle
//!
//! Both readers are pure functions over ROWS the caller already read
//! (`sql-confinement`: this crate holds no SQL, and the read rides the
//! consent gateway with the automation's own credential). That is also what
//! makes the re-entry and cap properties testable without a database.

use std::collections::BTreeSet;

use sha2::{Digest, Sha256};

use super::cursor::{CursorElement, CursorRead, StoredCursor};

/// Cap on remembered hashes. Beyond it the oldest matches re-fire, which is
/// the honest degradation: a set that grew without bound would be a cursor
/// row that grew without bound.
pub const MAX_SEEN_HASHES: usize = 2_000;

/// A row, as the gateway handed it back: column name to JSON value.
pub type Row = serde_json::Map<String, serde_json::Value>;

/// The content hash one row dedupes on.
///
/// Canonical by SORTED KEY, because a gateway that returned columns in another
/// order must not look like a changed row. 32 hex characters of SHA-256, as
/// v0 takes.
#[must_use]
pub fn row_hash(row: &Row) -> String {
    let mut keys: Vec<&String> = row.keys().collect();
    keys.sort();
    let canonical = serde_json::Value::Array(
        keys.into_iter()
            .map(|key| {
                serde_json::Value::Array(vec![
                    serde_json::Value::String(key.clone()),
                    row.get(key).cloned().unwrap_or(serde_json::Value::Null),
                ])
            })
            .collect(),
    );
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string().as_bytes());
    hex::encode(hasher.finalize())[..32].to_owned()
}

fn hash_set_position(position_json: Option<&str>) -> Vec<String> {
    position_json
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .unwrap_or_default()
}

/// Read a condition source over the rows its `where` clauses matched.
#[must_use]
pub fn read_condition(
    rows: &[Row],
    cursor: Option<&StoredCursor>,
    limit: usize,
    now: i64,
) -> CursorRead {
    let seen: BTreeSet<String> =
        hash_set_position(cursor.and_then(|row| row.position_json.as_deref()))
            .into_iter()
            .collect();
    let current: Vec<String> = rows.iter().map(row_hash).collect();
    let fresh: Vec<(usize, &String)> = current
        .iter()
        .enumerate()
        .filter(|(_, hash)| !seen.contains(*hash))
        .collect();
    let delivered: Vec<(usize, &String)> = fresh.into_iter().take(limit).collect();
    let delivered_hashes: BTreeSet<&String> = delivered.iter().map(|(_, hash)| *hash).collect();
    // The committed position is the rows still matching that were either
    // already seen or delivered NOW. A row beyond the cap is absent from it,
    // so the next tick offers it again.
    let mut position: Vec<String> = current
        .iter()
        .filter(|hash| seen.contains(*hash) || delivered_hashes.contains(hash))
        .cloned()
        .collect();
    position.truncate(MAX_SEEN_HASHES);
    CursorRead {
        elements: delivered
            .into_iter()
            .map(|(index, hash)| CursorElement {
                // ONE POSITION PER DELIVERY OCCURRENCE, not per row content.
                position: format!("{hash}:{now}"),
                occurred_at: now,
                payload: Some(serde_json::Value::Object(rows[index].clone())),
                position_json: None,
            })
            .collect(),
        position_json: Some(serde_json::to_string(&position).unwrap_or_else(|_| "[]".to_owned())),
        skipped: 0,
        window_from: None,
        window_to: None,
        gap_reason: None,
    }
}

/// One entry of the vault's consented provenance feed.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    /// The feed's own id, when it carries one. `None` means the entry has no
    /// legal watermark — it is delivered, and the cursor rides the feed's own
    /// returned position instead.
    pub id: Option<String>,
    pub row: Row,
}

impl Change {
    fn position(&self, index: usize) -> String {
        self.id
            .clone()
            .unwrap_or_else(|| format!("{}:{index}", row_hash(&self.row)))
    }
}

/// Read a data source over a provenance-feed pull.
///
/// `feed_cursor` is the watermark the feed itself returned, which is the LAST
/// ROW IT RETURNED — so delivering the whole pull is the only way the committed
/// position stays at a delivered element. Over-pulling and slicing would
/// advance past entries no fire ever saw.
#[must_use]
pub fn read_data(
    changes: &[Change],
    feed_cursor: Option<&str>,
    cursor: Option<&StoredCursor>,
    now: i64,
) -> CursorRead {
    let stored = cursor
        .and_then(|row| row.position_json.as_deref())
        .and_then(|json| serde_json::from_str::<String>(json).ok());
    // A BOOTSTRAP PULL NEVER FIRES.
    let visible: &[Change] = if stored.is_none() { &[] } else { changes };
    CursorRead {
        elements: visible
            .iter()
            .enumerate()
            .map(|(index, change)| CursorElement {
                position: change.position(index),
                occurred_at: now,
                payload: Some(serde_json::Value::Object(change.row.clone())),
                // Only a feed-native id is a legal watermark.
                position_json: change
                    .id
                    .as_ref()
                    .map(|id| serde_json::Value::String(id.clone()).to_string()),
            })
            .collect(),
        position_json: feed_cursor
            .map(|value| serde_json::Value::String(value.to_owned()).to_string()),
        skipped: 0,
        window_from: None,
        window_to: None,
        gap_reason: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, amount: i64) -> Row {
        let mut row = Row::new();
        row.insert("id".to_owned(), serde_json::json!(id));
        row.insert("amount".to_owned(), serde_json::json!(amount));
        row
    }

    fn stored(position_json: &str) -> StoredCursor {
        StoredCursor {
            source_kind: "condition".to_owned(),
            position_json: Some(position_json.to_owned()),
            ..StoredCursor::default()
        }
    }

    #[test]
    fn a_row_that_stays_matched_fires_once() {
        let rows = [row("a", 100)];
        let first = read_condition(&rows, None, 10, 1_000);
        assert_eq!(first.elements.len(), 1);
        let cursor = stored(&first.position_json.clone().expect("a set"));
        let second = read_condition(&rows, Some(&cursor), 10, 2_000);
        assert!(
            second.elements.is_empty(),
            "a standing match is not a new fire"
        );
    }

    #[test]
    fn a_row_that_changes_fires_again() {
        let first = read_condition(&[row("a", 100)], None, 10, 1_000);
        let cursor = stored(&first.position_json.clone().expect("a set"));
        let second = read_condition(&[row("a", 250)], Some(&cursor), 10, 2_000);
        assert_eq!(second.elements.len(), 1, "a changed row is a new fact");
    }

    /// THE RE-ENTRY, and the reason the position carries the instant.
    #[test]
    fn a_row_that_leaves_and_re_enters_unchanged_fires_again_with_a_new_position() {
        let rows = [row("a", 100)];
        let first = read_condition(&rows, None, 10, 1_000);
        let after_first = stored(&first.position_json.clone().expect("a set"));
        // It leaves: the set drops it.
        let empty = read_condition(&[], Some(&after_first), 10, 2_000);
        assert_eq!(empty.position_json.as_deref(), Some("[]"));
        let after_leaving = stored(&empty.position_json.clone().expect("a set"));
        // It comes back, byte-identical.
        let again = read_condition(&rows, Some(&after_leaving), 10, 3_000);
        assert_eq!(again.elements.len(), 1);
        assert_ne!(
            again.elements[0].position, first.elements[0].position,
            "one position per DELIVERY, or the second fire is answered as a replay of the first"
        );
        assert!(again.elements[0].position.ends_with(":3000"));
    }

    #[test]
    fn a_match_beyond_the_cap_arrives_on_the_next_tick() {
        let rows: Vec<Row> = (0..5).map(|index| row(&format!("r{index}"), 1)).collect();
        let first = read_condition(&rows, None, 2, 1_000);
        assert_eq!(first.elements.len(), 2);
        let position: Vec<String> =
            serde_json::from_str(&first.position_json.clone().expect("a set")).expect("json");
        assert_eq!(position.len(), 2, "only DELIVERED rows are committed");
        let cursor = stored(&first.position_json.clone().expect("a set"));
        let second = read_condition(&rows, Some(&cursor), 2, 2_000);
        assert_eq!(second.elements.len(), 2, "the next two");
    }

    #[test]
    fn a_row_hash_is_canonical_by_key_order() {
        let mut forward = Row::new();
        forward.insert("a".to_owned(), serde_json::json!(1));
        forward.insert("b".to_owned(), serde_json::json!(2));
        let mut backward = Row::new();
        backward.insert("b".to_owned(), serde_json::json!(2));
        backward.insert("a".to_owned(), serde_json::json!(1));
        assert_eq!(row_hash(&forward), row_hash(&backward));
        assert_eq!(row_hash(&forward).len(), 32);
        assert_ne!(row_hash(&forward), row_hash(&row("a", 1)));
    }

    #[test]
    fn a_corrupt_hash_set_reads_as_empty_rather_than_refusing() {
        let cursor = stored("{not an array");
        let read = read_condition(&[row("a", 1)], Some(&cursor), 10, 1_000);
        assert_eq!(
            read.elements.len(),
            1,
            "an unreadable set re-fires, which is a duplicate rather than a stall"
        );
    }

    /// A BOOTSTRAP PULL NEVER FIRES.
    #[test]
    fn a_fresh_data_watcher_reacts_to_what_happens_next() {
        let changes = [
            Change {
                id: Some("prov-1".to_owned()),
                row: row("a", 1),
            },
            Change {
                id: Some("prov-2".to_owned()),
                row: row("b", 2),
            },
        ];
        let bootstrap = read_data(&changes, Some("prov-2"), None, 1_000);
        assert!(
            bootstrap.elements.is_empty(),
            "a watcher installed today must not react to the whole journal"
        );
        assert_eq!(bootstrap.position_json.as_deref(), Some("\"prov-2\""));
        let cursor = StoredCursor {
            source_kind: "data".to_owned(),
            position_json: Some("\"prov-2\"".to_owned()),
            ..StoredCursor::default()
        };
        let next = read_data(&changes, Some("prov-4"), Some(&cursor), 2_000);
        assert_eq!(next.elements.len(), 2);
        assert_eq!(next.elements[0].position, "prov-1");
        assert_eq!(
            next.elements[0].position_json.as_deref(),
            Some("\"prov-1\"")
        );
    }

    /// A synthesised position identifies the delivery and is NEVER a watermark.
    #[test]
    fn a_change_with_no_feed_id_is_delivered_but_commits_nothing() {
        let changes = [Change {
            id: None,
            row: row("a", 1),
        }];
        let cursor = StoredCursor {
            source_kind: "data".to_owned(),
            position_json: Some("\"prov-0\"".to_owned()),
            ..StoredCursor::default()
        };
        let read = read_data(&changes, None, Some(&cursor), 1_000);
        assert_eq!(read.elements.len(), 1);
        assert!(read.elements[0].position.ends_with(":0"));
        assert!(
            read.elements[0].position_json.is_none(),
            "a synthesised position must never be committed as a watermark"
        );
        assert!(read.position_json.is_none(), "and the feed offered none");
    }
}
