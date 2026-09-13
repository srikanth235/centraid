//! The byte pass: what a window actually fetches (#1020, D-1020-B5).
//!
//! Three parts, each owned by the crate that can answer it:
//!
//! | Question | Answered by |
//! | --- | --- |
//! | which blobs does this replica have rows for? | `centraid_seat::needed_blobs` (SQL) |
//! | which of those are already here? | `centraid_blobs::ByteStore` |
//! | which should this window ask for, in what order? | `centraid_blobs::plan` (pure) |
//!
//! This module is the join, and it holds one decision of its own: **how to
//! learn what is held without asking the store once per row.**
//!
//! A camera roll is forty thousand rows. `ByteStore::holding` is a round trip
//! to the store's actor, so forty thousand of them is a window spent on
//! bookkeeping. So the pass plans twice:
//!
//! 1. one [`ByteStore::complete_hashes`] call gives every whole blob, which is
//!    the large majority of the answer, and a first plan orders and bounds the
//!    candidates with it;
//! 2. the first plan's items — at most `budget.items` of them — are then asked
//!    exactly, because a PARTIAL blob's remaining bytes are what makes a
//!    resumed transfer cheap, and the first pass cannot see those.
//!
//! The second plan is the one that is fetched. Both are cheap and pure; what
//! is bounded is the number of store questions, which is the thing that was
//! actually expensive.

use std::collections::HashSet;

use centraid_blobs::{Budget, ByteStore, ContentHash, Tier, Want};
use centraid_seat::BlobNeed;

/// What one byte pass did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BytePassReport {
    /// Blobs this window asked for.
    pub planned: usize,
    /// Blobs that are now whole. **Not the same as `planned`** — a window that
    /// ends mid-blob completes fewer than it started, and that is a success.
    pub completed: usize,
    /// Payload bytes that crossed in this window.
    pub moved: u64,
    /// Blobs left for a later window, after the budget.
    pub deferred: usize,
    /// The link went away partway through. The blobs already landed are kept;
    /// this is why the rest did not.
    pub stalled: Option<String>,
    /// Rows naming bytes this plane cannot address — a `blob:sha256-` URI from
    /// a vault that predates the byte plane. Counted rather than logged per
    /// row, because on such a vault it is every row.
    pub unaddressable: usize,
}

/// Turn the replica's rows into wants, ask the store what is held, plan, fetch.
pub async fn byte_pass(
    store: &ByteStore,
    connection: &centraid_net::endpoint::RawConnection,
    needs: &[BlobNeed],
    budget: Budget,
) -> BytePassReport {
    let mut report = BytePassReport::default();

    let complete = store.complete_hashes().await.unwrap_or_default();
    let (rough, unaddressable) = wants_from(needs, &complete);
    report.unaddressable = unaddressable;

    // FIRST PLAN — orders everything, bounded by the budget, using only the
    // one-call "is it whole" answer.
    let rough = centraid_blobs::plan(rough, budget);

    // SECOND PLAN — exact holdings for the candidates only, so a resumed blob
    // is budgeted by what is LEFT of it. See the module header.
    let mut exact = Vec::with_capacity(rough.items.len());
    for want in rough.items {
        let held = store
            .holding(want.hash)
            .await
            .map_or(0, centraid_blobs::Holding::held_bytes);
        exact.push(Want { held, ..want });
    }
    let planned = centraid_blobs::plan(exact, budget);
    report.planned = planned.items.len();
    // Deferred is the FIRST plan's, plus anything the second dropped: the first
    // saw the whole vault and the second only saw its own candidates.
    report.deferred = rough.deferred + (report.planned.saturating_sub(planned.items.len()));

    for want in &planned.items {
        match centraid_blobs::fetch(store, connection, want.hash).await {
            Ok(fetched) => {
                report.moved += fetched.moved;
                if fetched.complete {
                    report.completed += 1;
                }
            }
            Err(error) => {
                // THE WINDOW ENDED, which is the ordinary way a pass stops.
                // Everything already fetched is durable and verified; the rest
                // is the next window's. Breaking rather than continuing is the
                // point: one dead connection means the rest would each pay a
                // timeout.
                report.stalled = Some(error.to_string());
                break;
            }
        }
    }
    report.planned = planned.items.len();
    report
}

/// Map the replica's rows onto wants, dropping what this plane cannot address.
fn wants_from(needs: &[BlobNeed], complete: &HashSet<ContentHash>) -> (Vec<Want>, usize) {
    let mut wants = Vec::with_capacity(needs.len());
    let mut unaddressable = 0usize;
    for need in needs {
        // A DERIVATIVE CARRIES A BARE HASH, an original carries a URI, and the
        // difference is deliberate: only the original's column can say WHICH
        // hash function, so only the original can be refused as superseded. A
        // derivative's hash is trusted to be this vault's scheme because the
        // row that owns it was checked.
        let hash = match &need.variant {
            None => match ContentHash::parse_uri(&need.locator) {
                Ok(hash) => hash,
                Err(_) => {
                    unaddressable += 1;
                    continue;
                }
            },
            Some(_) => match ContentHash::parse_hex(&need.locator) {
                Ok(hash) => hash,
                Err(_) => {
                    unaddressable += 1;
                    continue;
                }
            },
        };
        let size = u64::try_from(need.byte_size).unwrap_or(0);
        wants.push(Want {
            hash,
            tier: tier_of(need.variant.as_deref()),
            size,
            held: if complete.contains(&hash) { size } else { 0 },
            recency: recency_of(&need.created_at),
        });
    }
    (wants, unaddressable)
}

fn tier_of(variant: Option<&str>) -> Tier {
    match variant {
        None => Tier::Original,
        Some(variant) if Tier::Thumbnail.variants().contains(&variant) => Tier::Thumbnail,
        Some(variant) if Tier::Preview.variants().contains(&variant) => Tier::Preview,
        // A variant this build does not know. Treated as an ORIGINAL, which is
        // the back of the queue: an unknown rendition is the one thing that
        // must not jump ahead of the grid.
        Some(_) => Tier::Original,
    }
}

/// `created_at` as a sortable integer.
///
/// The column is fixed-width ISO-8601 (`strftime('%Y-%m-%dT%H:%M:%fZ')`), so
/// the first eight bytes compare in the same order the timestamps do. NOT a
/// parse: a parse would need a date library on the phone to produce a number
/// only ever used for `cmp`, and a row with an unexpected shape would become an
/// error where it should become "sorts early".
fn recency_of(created_at: &str) -> i64 {
    let mut key = [0u8; 8];
    for (slot, byte) in key.iter_mut().zip(created_at.bytes()) {
        *slot = byte;
    }
    i64::from_be_bytes(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn need(locator: &str, variant: Option<&str>, size: i64, at: &str) -> BlobNeed {
        BlobNeed {
            locator: locator.to_owned(),
            variant: variant.map(ToOwned::to_owned),
            byte_size: size,
            created_at: at.to_owned(),
        }
    }

    /// A vault written before the byte plane names its bytes by sha256. Those
    /// rows are COUNTED and skipped, never verified against blake3 — which
    /// would be asking a peer for a hash that names different bytes.
    #[test]
    fn a_superseded_uri_is_counted_and_never_fetched() {
        let old = format!("blob:sha256-{}", "ab".repeat(32));
        let new = ContentHash::of(b"a photograph").to_uri();
        let (wants, unaddressable) = wants_from(
            &[
                need(&old, None, 10, "2026-01-01T00:00:00.000Z"),
                need(&new, None, 10, "2026-01-01T00:00:00.000Z"),
            ],
            &HashSet::new(),
        );
        assert_eq!(unaddressable, 1);
        assert_eq!(wants.len(), 1);
        assert_eq!(wants[0].hash, ContentHash::of(b"a photograph"));
    }

    /// Chronological order without parsing a date. The comparison is what the
    /// planner needs and the only thing this number is for.
    #[test]
    fn recency_orders_iso_timestamps_without_parsing_them() {
        assert!(recency_of("2026-09-13T00:00:00.000Z") > recency_of("2026-01-02T00:00:00.000Z"));
        assert!(recency_of("2026-01-02T00:00:00.000Z") > recency_of("2025-12-31T00:00:00.000Z"));
        // A short or empty value sorts early rather than failing.
        assert!(recency_of("") < recency_of("2020-01-01T00:00:00.000Z"));
    }

    /// A poster is a thumbnail; an unknown variant goes to the BACK, never
    /// ahead of the grid.
    #[test]
    fn variants_map_onto_the_three_tiers() {
        assert_eq!(tier_of(None), Tier::Original);
        assert_eq!(tier_of(Some("thumb")), Tier::Thumbnail);
        assert_eq!(tier_of(Some("poster")), Tier::Thumbnail);
        assert_eq!(tier_of(Some("preview")), Tier::Preview);
        assert_eq!(tier_of(Some("hologram")), Tier::Original);
    }

    /// A blob the store already holds whole is marked satisfied here, so the
    /// planner drops it and it never reaches `deferred`.
    #[test]
    fn a_held_blob_is_marked_satisfied_from_the_one_list_call() {
        let hash = ContentHash::of(b"held");
        let complete: HashSet<ContentHash> = [hash].into_iter().collect();
        let (wants, _) = wants_from(
            &[need(&hash.to_uri(), None, 500, "2026-01-01T00:00:00.000Z")],
            &complete,
        );
        assert!(wants[0].is_satisfied());
    }
}
