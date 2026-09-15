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
    /// THE BLOBS BEHIND [`Self::completed`], each with the file the store gave
    /// it (#1025 S5, widened by D-1025-S7-20).
    ///
    /// Kept because a completed blob has to WAKE A SCREEN, and the only way
    /// back from a hash to the row a grid draws is a lookup in the replica
    /// (`centraid_seat::bytes::asset_rows_for`). A count cannot do it: 19
    /// photographs landed on a device, no row changed, no event fired, and the
    /// member read "not on this device yet" over a device that had them.
    ///
    /// **And the PATH travels with the hash**, because the row the seat writes
    /// for a landed blob carries it: the store is the one thing that knows
    /// where its own bytes are, and a pass that reported hashes alone would
    /// make the seat ask an actor, per blob, for something this loop already
    /// had in hand.
    pub landed: Vec<centraid_seat::HeldBlob>,
    /// Payload bytes that crossed in this window.
    pub moved: u64,
    /// Blobs left for a later window, after the budget.
    pub deferred: usize,
    /// The link went away partway through. The blobs already landed are kept;
    /// this is why the rest did not.
    ///
    /// **A SENTENCE THE CORE CHOSE, NEVER THE TRANSPORT'S WORDS** (#1025 S5).
    /// This used to be `LaneError`'s `Display`, which travels into
    /// `SyncOutcome::bytes_stalled` and onto a screen — so a member read
    /// "the byte lane could not fetch 053bafba2198bb…: io: stream reset by
    /// peer: error 3". That is a content hash and a QUIC error code on a
    /// member's phone, and it is the same rule D-1020-B7 closes with: no
    /// database text, no path and no peer's words reach a member. The hash and
    /// the transport's own message go to a log line, which is where a
    /// developer wanted them anyway.
    pub stalled: Option<String>,
    /// BLOBS THIS GATEWAY WOULD NOT SERVE, on a connection that stayed up
    /// (#1025 S7).
    ///
    /// Its own number rather than a spelling of [`Self::stalled`], because the
    /// two have different remedies and only one of them is about the network. A
    /// non-zero count here is a row whose bytes the gateway committed without
    /// holding — this product's law in the other direction — and it is the
    /// number that tells a STUCK plane apart from a slow one. Without it the
    /// symptom was `blobsCompleted: 0` for ever with nothing to look at.
    pub refused: usize,
    /// THE DEADLINE ENDED THIS PASS (#1025 S2). A normal end: every verified
    /// chunk group is durable and the next window resumes from it. Separate
    /// from [`Self::stalled`], which is the link going away.
    pub cut_by_the_deadline: bool,
    /// Rows whose `content_uri` is not `blob:blake3-<hex>` — the one form this
    /// plane addresses (#1025 S3, D-1025-S3-3). Counted rather than logged per
    /// row, because a vault that has one such row usually has nothing but.
    pub unaddressable: usize,
    /// ORIGINALS THIS WINDOW REFUSED TO ASK FOR because the link is metered
    /// (#1025 S5).
    ///
    /// The one reason a pass can plan NOTHING over a replica full of
    /// photographs, and therefore the one number that tells an empty byte pass
    /// apart from a caught-up device. Without it a metered flag set from a
    /// wrong input looks exactly like a working, idle byte plane.
    pub withheld: usize,
    /// What the eviction sweep did at the end of this pass (#1025 S3, R25).
    ///
    /// `None` means it did not run or could not read the store — which is NOT
    /// "nothing needed evicting". A surface that showed the two the same way
    /// would tell a member their storage is fine on the one occasion nobody
    /// could measure it.
    pub swept: Option<centraid_blobs::Sweep>,
}

/// WHAT A MEMBER READS WHEN THE BYTE PLANE STOPS.
///
/// One sentence for every transport failure, because they are one thing to a
/// member: the photographs have not arrived yet and the device will try again.
/// Which blob, and what the transport said about it, are a developer's
/// questions and are answered in the log beside this.
pub const BYTES_STALLED_SENTENCE: &str =
    "Some photos have not finished downloading yet. Centraid will keep trying.";

/// Turn the replica's rows into wants, ask the store what is held, plan, fetch.
/// `deadline` is the CALLER'S, and `None` means "as long as it takes". It is
/// checked BEFORE each blob is asked for and never against one in flight: a
/// transfer cut mid-blob is the ordinary case and costs nothing, but deciding
/// to start one is a decision this loop can make honestly.
pub async fn byte_pass(
    store: &ByteStore,
    connection: &centraid_net::endpoint::RawConnection,
    needs: &[BlobNeed],
    budget: Budget,
    deadline: Option<std::time::Instant>,
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
    // FROM THE FIRST PLAN, which saw the whole vault. The second only ever saw
    // the first's candidates, so its own count would be however many originals
    // happened to survive the budget rather than how many this window refused.
    report.withheld = rough.withheld;
    // Deferred is the FIRST plan's, plus anything the second dropped: the first
    // saw the whole vault and the second only saw its own candidates.
    report.deferred = rough.deferred + (report.planned.saturating_sub(planned.items.len()));

    for want in &planned.items {
        if deadline.is_some_and(|at| std::time::Instant::now() >= at) {
            report.cut_by_the_deadline = true;
            // WHAT IS LEFT IS DEFERRED, not lost. The number a progress line
            // shows as "and 812 more" must count them, or a member watching it
            // would see the queue shrink without anything arriving.
            report.deferred += planned
                .items
                .len()
                .saturating_sub(report.completed + report.deferred);
            break;
        }
        match centraid_blobs::fetch(store, connection, want.hash).await {
            Ok(fetched) => {
                report.moved += fetched.moved;
                if fetched.complete {
                    report.completed += 1;
                    // THE PATH, ASKED FOR ONCE, HERE. `data_path` answers
                    // `None` for a partial blob, and this branch is the one
                    // place that already knows the blob is whole. A blob whose
                    // file the store cannot name is counted as completed and
                    // is NOT reported as landed: a row is a promise a surface
                    // can open the path.
                    if let Ok(Some(path)) = store.data_path(want.hash).await {
                        // THE FILE'S OWN LENGTH AND NOT `fetched.moved`, which
                        // is what crossed in THIS window — a resumed blob
                        // moved only its remainder, and a size taken from it
                        // would be a number a storage screen could quote back.
                        let byte_size = std::fs::metadata(&path)
                            .map(|metadata| i64::try_from(metadata.len()).unwrap_or(i64::MAX))
                            .unwrap_or_default();
                        report.landed.push(centraid_seat::HeldBlob {
                            hash: want.hash.to_hex(),
                            path: path.to_string_lossy().into_owned(),
                            byte_size,
                        });
                    }
                }
            }
            Err(error) => {
                // ONE BLOB THE PEER WOULD NOT SERVE IS NOT THE END OF THE
                // WINDOW (#1025 S7).
                //
                // The loop used to break on every error, and the reason given
                // was "one dead connection means the rest would each pay a
                // timeout" — true of a dead connection and false of everything
                // else. A gateway that resets ONE stream (a blob its store
                // cannot serve, a row committed over bytes it never held) then
                // ended the window; the plan is ordered deterministically, so
                // the same blob came first in the next window, and the next.
                // **The byte plane stopped for ever and every photograph after
                // that one stayed a placeholder**, with `blobsCompleted: 0` and
                // a member-facing sentence promising it would keep trying.
                //
                // So the connection is the test, and it is the honest one: a
                // connection with a close reason is a window that is over, and
                // a live one is one blob that did not work. The refused blob is
                // counted, the window carries on, and the plane makes durable
                // progress over everything else — which is the law
                // ("every window makes durable, verified progress").
                //
                // THE DETAIL GOES HERE AND ONLY HERE. It names the blob and
                // repeats the transport's own words, which is exactly what a
                // developer needs and exactly what a member must never read
                // (`Error.detail` is logs-only).
                if connection.close_reason().is_some() {
                    tracing::warn!(
                        hash = %want.hash,
                        detail = %error,
                        "the byte plane's connection went away"
                    );
                    report.stalled = Some(BYTES_STALLED_SENTENCE.to_owned());
                    break;
                }
                tracing::warn!(
                    hash = %want.hash,
                    detail = %error,
                    "the gateway would not serve this blob; the window carries on"
                );
                report.refused += 1;
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
        // difference is deliberate: only the original's column names the hash
        // FUNCTION, so only the original's form can be checked. A derivative's
        // hash is this vault's scheme because the row that owns it was.
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
            // THE ONE FACT THE PLANNER CANNOT SEE FOR ITSELF (#1025 S4). The
            // replica's own `media_type` says it and `needed_blobs` carries
            // it; a `video/*` original is the one thing a cellular rule still
            // withholds from a member who asked for photographs on cellular.
            moving: need.moving,
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
            moving: false,
        }
    }

    /// A `content_uri` that is not `blob:blake3-<hex>` names nothing this plane
    /// can ask a peer for. Those rows are COUNTED and skipped — asking for a
    /// hash under another function's name would be asking for different bytes.
    #[test]
    fn a_uri_this_plane_cannot_address_is_counted_and_never_fetched() {
        // A URI under ANOTHER FUNCTION'S NAME. v0 wrote `blob:sha256-` and
        // #1025 S3 made `blob:blake3-` the only form this plane addresses; the
        // string is constructed here rather than cited from anywhere, because
        // nothing produces it (#1025 S4).
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

#[cfg(test)]
mod sentences {
    use super::*;

    /// WHAT A MEMBER READS WHEN THE BYTE PLANE STOPS CARRIES NO HASH, NO
    /// TRANSPORT WORDS AND NO CODE (#1025 S5, D-1020-B7).
    ///
    /// The device produced this, on screen:
    ///
    /// > "Synced: 0 changes, 0 files. the byte lane could not fetch
    /// > 053bafba2198bb412e6fb2ec38dfd78d6fde071784582d29fb5fc0a037db03c9:
    /// > io: stream reset by peer: error 3"
    ///
    /// A content hash and a QUIC application error code, on a phone. The rule
    /// is the one D-1020-B7 closes with — no database text, no path and no
    /// peer's words reach a member — and this is the assertion that keeps it
    /// true of the field `SyncOutcome::bytes_stalled` renders.
    #[test]
    fn the_stalled_sentence_is_the_cores_own_words() {
        let sentence = BYTES_STALLED_SENTENCE;
        assert!(
            !sentence.contains(':'),
            "a colon is where a detail gets appended: {sentence}"
        );
        // No hex run long enough to be a hash, and no digits at all: the two
        // things the device's sentence leaked were a hash and an error number.
        assert!(
            !sentence.chars().any(|c| c.is_ascii_digit()),
            "the sentence carries a number a member cannot act on: {sentence}"
        );
        assert!(
            !sentence.contains("error") && !sentence.contains("io"),
            "the sentence reads as a transport failure: {sentence}"
        );
        // It is a SENTENCE: it says what happened and what happens next.
        assert!(sentence.ends_with('.'));
        assert!(sentence.starts_with(char::is_uppercase));
    }

    /// AND `LaneError` STILL CARRIES THE DETAIL, because a developer needs it.
    /// The fix is about where it goes, not about losing it: the hash and the
    /// transport's own words go to the log line beside the sentence.
    #[test]
    fn the_lane_error_still_names_the_blob_and_the_cause() {
        let error = centraid_blobs::LaneError::Transfer {
            hash: centraid_blobs::ContentHash::of(b"a photograph"),
            detail: "io: stream reset by peer: error 3".to_owned(),
        };
        let text = error.to_string();
        assert!(text.contains("stream reset by peer"));
        assert_ne!(
            text, BYTES_STALLED_SENTENCE,
            "the detail and the sentence became the same string again"
        );
    }
}
