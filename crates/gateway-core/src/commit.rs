//! The commit, and the compare-and-set that is the rollback fence (F7).
//!
//! A commit confirms each object's size and checksum, records it, moves the
//! manifest head, and acks.
//!
//! # THE MANIFEST HEAD MOVES ONLY BY COMPARE-AND-SET
//!
//! The manifest chain is sealed and hash-linked, so a gateway **cannot forge a
//! manifest**. But "newest" is whatever its index says, and **a fresh phone has
//! no memory of the last head** — so a gateway that rolled its head back to an
//! older generation would hand a restoring phone an older vault, and the phone
//! would have nothing to compare it against. That is stated in the threat model
//! rather than solved; the head hash in the vault's pkarr record is a partial
//! mitigation, and it does not cover an expired record.
//!
//! What `prev_head` buys is the other half, and it is the half that is
//! enforceable: **the head moves only from the value the writer last saw.** A
//! gateway cannot move it behind the phone's back, and two phones that both
//! hold the seed cannot both win — the loser is told the current head.
//!
//! On Cloudflare this is one line on a Durable Object, which runs one request
//! at a time. **The standalone adapter has no such property, and this is what
//! gives it the same guarantee.**

use crate::error::Refusal;
use crate::ids::ObjectName;

/// What the compare-and-set did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadMove {
    /// The head moved to the new value.
    Set(ObjectName),
    /// The head already held the new value. **An idempotent retry**, not a
    /// conflict: a phone whose acknowledgement was lost on a flaky link
    /// re-sends the same commit, and answering that with a conflict would send
    /// it into a re-read loop over a commit that already landed.
    AlreadyThere(ObjectName),
}

/// Move the head, or refuse.
///
/// `current` is what the gateway holds; `expected` is the commit's `prev_head`,
/// where `None` means "this vault has no head yet". Those are different facts
/// and the wire keeps them apart with `optional` — a writer that had never read
/// the vault must not be able to present the same request as one that had.
///
/// # Errors
///
/// [`Refusal::HeadConflict`], carrying the current head so the loser re-reads
/// rather than clobbering.
pub fn compare_and_set(
    current: Option<ObjectName>,
    expected: Option<ObjectName>,
    next: ObjectName,
) -> Result<HeadMove, Refusal> {
    if current == Some(next) {
        return Ok(HeadMove::AlreadyThere(next));
    }
    if current == expected {
        return Ok(HeadMove::Set(next));
    }
    Err(Refusal::HeadConflict { current })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Key32;

    fn head(tag: u8) -> ObjectName {
        Key32::from_bytes([tag; 32])
    }

    #[test]
    fn a_first_commit_names_no_previous_head() {
        assert_eq!(
            compare_and_set(None, None, head(1)),
            Ok(HeadMove::Set(head(1)))
        );
    }

    /// A FRESH WRITER CANNOT PRESENT ITSELF AS ONE THAT HAD READ THE VAULT.
    /// This is the fence: `None` and "some head" are different claims.
    #[test]
    fn a_writer_that_never_read_the_head_cannot_move_one_that_exists() {
        assert_eq!(
            compare_and_set(Some(head(1)), None, head(2)),
            Err(Refusal::HeadConflict {
                current: Some(head(1))
            })
        );
    }

    /// THE TWO-DEVICE RACE. Both phones hold the seed, both sign validly (F1),
    /// and exactly one wins — the other is told what the head is now.
    #[test]
    fn two_devices_racing_from_the_same_head_leave_exactly_one_winner() {
        let seen = head(1);
        let first = compare_and_set(Some(seen), Some(seen), head(2)).expect("the winner");
        assert_eq!(first, HeadMove::Set(head(2)));

        let second = compare_and_set(Some(head(2)), Some(seen), head(3));
        assert_eq!(
            second,
            Err(Refusal::HeadConflict {
                current: Some(head(2))
            }),
            "the loser is TOLD, and told what to re-read from"
        );
    }

    /// A lost ack is not a conflict. The phone re-sends and the answer is the
    /// same as the first time.
    #[test]
    fn a_replayed_commit_is_idempotent_and_not_a_conflict() {
        assert_eq!(
            compare_and_set(Some(head(2)), Some(head(1)), head(2)),
            Ok(HeadMove::AlreadyThere(head(2)))
        );
    }

    /// A gateway cannot move the head backwards under a writer, because the
    /// writer's next commit names what it last saw and no longer matches.
    #[test]
    fn a_head_rolled_back_under_a_writer_makes_its_next_commit_fail_loudly() {
        // The phone committed head 3. The gateway quietly rolled to head 1.
        let rolled_back = Some(head(1));
        assert_eq!(
            compare_and_set(rolled_back, Some(head(3)), head(4)),
            Err(Refusal::HeadConflict {
                current: Some(head(1))
            }),
            "the phone sees a head it never wrote, which is the signal it has"
        );
    }
}
