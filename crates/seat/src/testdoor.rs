//! THE TEST DOOR over the SEAT'S OWN tables — the outbox, and what a replica
//! believes about itself (#1025 S5).
//!
//! The sibling of `centraid_vault::testdoor`, split by ownership rather than by
//! convenience: the replicated tables are the vault's schema and the queue is
//! this crate's, so an end-to-end test asking both questions reads through two
//! doors and neither crate holds a statement about the other's tables.
//!
//! `sql-confinement` (`cargo xtask rules`) is why they exist at all — SQL lives
//! only under `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and
//! a test is not an exemption. An end-to-end test that hand-wrote
//! `SELECT intent_id, created_order FROM seat_outbox` was a second, unversioned
//! opinion about a table this crate owns, in a crate that must not know its
//! columns.
//!
//! Ungated `pub mod`, following `crates/apps/kit/src/testdoor.rs`. A cargo
//! feature would not do what it looks like here: cargo unifies features across
//! a package's normal and dev dependencies in one build, so a flag a test crate
//! switched on would be on for the product too. What keeps this out of a phone
//! is that nothing in the product calls it.

use rusqlite::Connection;

/// The queue as it stands: `(intent_id, created_order)`, in queue order.
///
/// `created_order` IS PART OF THE ANSWER and not an implementation detail. A
/// re-bootstrap carries the outbox onto the file that replaces the replica, and
/// it must carry the order VERBATIM — renumbering the queue reorders the
/// member's work. A door that answered ids alone would let that regress
/// silently, which is precisely the assertion the test using this makes.
#[must_use]
pub fn queued_intents(connection: &Connection) -> Vec<(String, i64)> {
    let Ok(mut statement) = connection
        .prepare("SELECT intent_id, created_order FROM seat_outbox ORDER BY created_order")
    else {
        return Vec::new();
    };
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .and_then(std::iter::Iterator::collect)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::{IntentRecord, IntentState};

    fn queued(id: &str) -> IntentRecord {
        IntentRecord {
            intent_id: id.to_owned(),
            created_order: 0,
            app_id: "core".to_owned(),
            action: "add_party".to_owned(),
            input: serde_json::json!({}),
            payload_hash: "b".repeat(64),
            state: IntentState::Queued,
            attempts: 0,
            depends_on: Vec::new(),
            base_versions: Vec::new(),
            optimistic: None,
            commit_seq: None,
            waiting_on: Vec::new(),
            needs_blobs: Vec::new(),
            enqueued_at: "t".to_owned(),
            updated_at: "t".to_owned(),
            reason: None,
            conflicts: Vec::new(),
            online_only: false,
        }
    }

    /// A FILE WITH NO OUTBOX ANSWERS EMPTY rather than failing: "there is no
    /// queue" and "the queue is empty" are the same answer to this question,
    /// and a test asserting on the contents refuses both.
    #[test]
    fn a_file_with_no_outbox_answers_an_empty_queue() {
        let connection = Connection::open_in_memory().expect("opens");
        assert!(queued_intents(&connection).is_empty());
    }

    #[test]
    fn the_queue_comes_back_in_its_own_order_with_the_orders_it_was_given() {
        let connection = Connection::open_in_memory().expect("opens");
        let outbox = crate::outbox::Outbox::open(&connection).expect("the queue");
        let first = outbox.enqueue(&queued("i-1"), "t").expect("queued");
        let second = outbox.enqueue(&queued("i-2"), "t").expect("queued");
        assert_eq!(
            queued_intents(&connection),
            vec![("i-1".to_owned(), first), ("i-2".to_owned(), second)]
        );
    }
}
