//! Upload batching, and the time a member is shown instead of a promise
//! (#1029 §3, W5B-2).
//!
//! # THE UI NEVER CLAIMS BACKUP THE GATEWAY HAS NOT ACKED
//!
//! This module is where that is easiest to break, so the type system does it:
//! [`BackupState`] has **no** "backed up" variant a caller can construct out of
//! hope. [`BackupState::acked`] takes a commit moment, and the only place that
//! moment comes from is
//! [`crate::client::CommitAck::committed_at_ms`] — the server's own clock, in
//! the server's own answer.
//!
//! A phone that spooled a change and showed "backed up" would be a phone that
//! lies on the one day it matters: the day the member's other phone is gone.
//!
//! # BATCHING, AND WHY IT IS BOUNDED BY BYTES AND BY COUNT
//!
//! One declare per object is the shape that makes a phone learn its quota is
//! spent partway through an upload it has already paid for; one declare for
//! everything is the shape that makes a background window expire holding a
//! batch it cannot finish. So a batch is bounded by both, and the bounds are
//! here rather than at a call site because a background pass and a foreground
//! pass must produce the same batches.
//!
//! # THE PRESIGNED LIFETIME IS COMPARED AGAINST THE DEFERRAL, NOT AGAINST NOW
//!
//! iOS may hold a discretionary background upload for **days** — the system
//! decides, and the app is not running to notice. A target checked against
//! "now" and handed to the OS is a target that can expire in a pocket, and the
//! failure is silent: the task completes, the server 403s, and the member sees
//! a backup that never finished. [`Batch::usable_for`] is the comparison that
//! is actually correct, and [`LONGEST_DEFERRAL_MS`] is the number it is against.

use crate::client::UploadTarget;

/// The longest a background upload may sit before the OS runs it.
///
/// **Seven days, and it is now this product's number** — re-judged, because the
/// reason it used to give is gone. It was "AWS Signature Version 4's own
/// maximum presign lifetime, somebody else's limit", and with the S3 byte store
/// and the hosted adapter struck from v0 (scope amendment 2026-09-21) nothing
/// presigns anything: every upload target is a path on the member's own laptop.
///
/// What the number is for is the half that was always true and is now the whole
/// of it: **a target must outlive the longest deferral a phone can suffer.** An
/// iOS device off charge and off Wi-Fi for a week comes back to finish a
/// transfer, and a target that expired in a pocket is a silent failure — the
/// task completes, the server refuses, and the member sees a backup that never
/// finished. Seven days is the week that case is about.
///
/// A target whose life is shorter than the deferral it may suffer is one
/// [`Batch::usable_for`] refuses to hand to a background task; the phone
/// uploads it in the foreground instead, where it can re-declare when it
/// expires.
pub const LONGEST_DEFERRAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// At most this many objects in one declare.
///
/// Enough that a camera-roll pass is a handful of round trips rather than
/// hundreds; small enough that a lost window loses a batch and not a day.
pub const MAX_BATCH_OBJECTS: usize = 64;

/// At most this many padded bytes in one declare.
///
/// Sixteen objects at the 16 MiB per-object cap (F6). The cap is the gateway's;
/// this is a batching bound and is deliberately a multiple of it rather than an
/// independent number, so a single maximum-size object is never unbatchable.
pub const MAX_BATCH_BYTES: u64 = 16 * 16 * 1024 * 1024;

/// One object waiting in the spool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    /// The object's name, hex — the BLAKE3 of its sealed bytes, and so its
    /// digest for signing.
    pub name: String,
    /// The padded size the gateway is told, which is what a quota is judged
    /// against.
    pub padded_size: u64,
}

/// One declare's worth of pending objects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Batch {
    /// The objects, in spool order.
    pub objects: Vec<Pending>,
    /// Their padded sizes, summed.
    pub padded_bytes: u64,
}

impl Batch {
    /// Cut the next batch off the front of a spool.
    ///
    /// **A single object over [`MAX_BATCH_BYTES`] is still batched, alone.**
    /// The alternative is a spool that stalls forever on one file, which is the
    /// failure mode of every byte-bounded queue that forgot to say this.
    #[must_use]
    pub fn cut(spool: &[Pending]) -> Self {
        let mut objects = Vec::new();
        let mut padded_bytes = 0_u64;
        for item in spool.iter().take(MAX_BATCH_OBJECTS) {
            let next = padded_bytes.saturating_add(item.padded_size);
            if !objects.is_empty() && next > MAX_BATCH_BYTES {
                break;
            }
            padded_bytes = next;
            objects.push(item.clone());
        }
        Self {
            objects,
            padded_bytes,
        }
    }

    /// Which of these targets a **background** task may be handed.
    ///
    /// A target that could expire during the longest deferral the OS may impose
    /// is not one, however long it has left right now. The rest go in the
    /// foreground, where a 403 can be answered by re-declaring.
    #[must_use]
    pub fn usable_for(targets: &[UploadTarget], now_ms: i64) -> Vec<UploadTarget> {
        targets
            .iter()
            .filter(|target| !target.already_committed)
            .filter(|target| target.expires_at_ms.saturating_sub(now_ms) >= LONGEST_DEFERRAL_MS)
            .cloned()
            .collect()
    }
}

/// What a member is shown about one vault's backup.
///
/// **There is no variant that means "backed up" without a moment in it**, and
/// the moment is always the gateway's. That is the UI invariant in the type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupState {
    /// Nothing has been acknowledged yet. Not a failure — a new vault.
    NeverAcked,
    /// The gateway acknowledged a commit at this moment, on **its** clock.
    Acked {
        /// The gateway's own `committed_at_ms`.
        at_ms: i64,
        /// Changes made since, still in the spool. Zero means up to date.
        unacked: usize,
    },
}

impl BackupState {
    /// The state after a commit the gateway answered.
    ///
    /// Takes the acknowledgement's moment, so there is no way to reach this
    /// constructor without one.
    #[must_use]
    pub const fn acked(committed_at_ms: i64, unacked: usize) -> Self {
        Self::Acked {
            at_ms: committed_at_ms,
            unacked,
        }
    }

    /// Whether this vault may be described to a member as backed up.
    ///
    /// True only over an acknowledgement with nothing still waiting. A vault
    /// with an ack and a spool is "last backed up at …", never "backed up".
    #[must_use]
    pub const fn is_backed_up(self) -> bool {
        matches!(self, Self::Acked { unacked: 0, .. })
    }

    /// The gateway's last acknowledgement, if there has been one.
    #[must_use]
    pub const fn last_acked_ms(self) -> Option<i64> {
        match self {
            Self::NeverAcked => None,
            Self::Acked { at_ms, .. } => Some(at_ms),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(name: &str, padded_size: u64) -> Pending {
        Pending {
            name: name.to_owned(),
            padded_size,
        }
    }

    fn target(expires_at_ms: i64, already_committed: bool) -> UploadTarget {
        UploadTarget {
            name: "aa".to_owned(),
            url: "https://gw.example/v1/objects/aa/bb".to_owned(),
            expires_at_ms,
            already_committed,
        }
    }

    #[test]
    fn a_batch_stops_at_the_object_count() {
        let spool: Vec<Pending> = (0..MAX_BATCH_OBJECTS + 10)
            .map(|index| pending(&format!("{index:02x}"), 1))
            .collect();
        assert_eq!(Batch::cut(&spool).objects.len(), MAX_BATCH_OBJECTS);
    }

    #[test]
    fn a_batch_stops_at_the_byte_bound() {
        let spool = vec![
            pending("a", MAX_BATCH_BYTES - 1),
            pending("b", 2),
            pending("c", 1),
        ];
        let batch = Batch::cut(&spool);
        assert_eq!(batch.objects.len(), 1, "the second would cross the bound");
        assert_eq!(batch.padded_bytes, MAX_BATCH_BYTES - 1);
    }

    /// A SPOOL MUST NOT STALL ON ONE FILE. The byte bound yields to a single
    /// object rather than refusing it forever.
    #[test]
    fn one_object_over_the_byte_bound_is_still_batched_alone() {
        let spool = vec![pending("big", MAX_BATCH_BYTES * 4), pending("b", 1)];
        let batch = Batch::cut(&spool);
        assert_eq!(batch.objects.len(), 1);
        assert_eq!(batch.objects[0].name, "big");
    }

    /// **A TARGET THAT COULD EXPIRE IN A POCKET IS NOT HANDED TO THE OS.**
    /// Checked against the longest deferral, never against now.
    #[test]
    fn a_target_that_expires_inside_the_longest_deferral_is_not_backgrounded() {
        let now = 1_770_000_000_000;
        let usable = Batch::usable_for(
            &[
                target(now + LONGEST_DEFERRAL_MS - 1, false),
                target(now + LONGEST_DEFERRAL_MS, false),
                target(now + LONGEST_DEFERRAL_MS * 2, true),
            ],
            now,
        );
        assert_eq!(
            usable.len(),
            1,
            "one lives long enough and is not committed"
        );
        assert_eq!(usable[0].expires_at_ms, now + LONGEST_DEFERRAL_MS);
    }

    /// THE UI NEVER CLAIMS BACKUP THE GATEWAY HAS NOT ACKED.
    #[test]
    fn nothing_is_backed_up_before_an_acknowledgement() {
        assert!(!BackupState::NeverAcked.is_backed_up());
        assert_eq!(BackupState::NeverAcked.last_acked_ms(), None);
    }

    /// An ack with a spool behind it is "last backed up at …", never "backed
    /// up": the member's newest change is not on the gateway.
    #[test]
    fn an_ack_with_unsent_changes_behind_it_is_not_backed_up() {
        let state = BackupState::acked(1_770_000_000_000, 3);
        assert!(!state.is_backed_up());
        assert_eq!(state.last_acked_ms(), Some(1_770_000_000_000));
    }

    #[test]
    fn an_ack_with_an_empty_spool_is_backed_up() {
        assert!(BackupState::acked(1_770_000_000_000, 0).is_backed_up());
    }

    /// Seven days, and the test says what the number is FOR rather than which
    /// other protocol it used to be borrowed from: the week an iOS device can
    /// be off charge and off Wi-Fi before it comes back to finish a transfer.
    #[test]
    fn the_longest_deferral_is_a_week() {
        assert_eq!(LONGEST_DEFERRAL_MS, 7 * 24 * 60 * 60 * 1000);
        assert_eq!(LONGEST_DEFERRAL_MS, 604_800_000);
    }
}
