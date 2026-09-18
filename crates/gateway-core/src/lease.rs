//! The lease: one writer per vault, by monotonic epoch (#1029 §0, §3).
//!
//! Appends are accepted only from the device that holds the vault's current
//! lease, `(epoch, device key)`. Taking a lease requires a statement signed by
//! the **vault identity key**: "device D takes vault V at epoch E", and a claim
//! carries `epoch + 1`.
//!
//! # THE LEASE CANNOT ENFORCE ONE WRITER, AND IS NOT TRYING TO (F1)
//!
//! The seed is in the synced keychain and the identity key derives from it, so
//! a misplaced old phone can sign a claim **as validly as the new one**. "One
//! device per vault" is a policy the phones cooperate with, not something a
//! gateway enforces against a holder of the seed.
//!
//! What this module actually buys, then, is two things and it is worth being
//! precise about them:
//!
//! 1. **A superseded device is told it was superseded**, rather than being
//!    refused as a stranger. That is the whole reason `moved_at` is a tombstone
//!    and not a deletion: the old phone freezes the vault read-only, shows its
//!    unacked spool as "N changes since <date>", and keeps it. The old phone's
//!    unacked commits are the one place single-writer loses data, so they are
//!    shown rather than hidden.
//! 2. **Monotonicity**, so two devices cannot both believe they hold the lease
//!    at the same epoch. The race between two phones that both hold the seed is
//!    made first-writer-wins by the manifest compare-and-set
//!    ([`crate::commit`]) — not by this.

use crate::error::Refusal;
use crate::ids::DeviceId;
use crate::time::ServerTime;

/// The lease as a gateway holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lease {
    pub device: DeviceId,
    /// Monotonic, and the lease's own counter. `0` is "never claimed", which is
    /// why the first claim is `1`.
    pub epoch: u64,
    pub taken_at: ServerTime,
}

/// What a vault's lease state is, from the gateway's side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LeaseState {
    pub current: Option<Lease>,
    /// Set when a higher epoch took the vault from a device that had it. The
    /// tombstone that makes `VAULT_MOVED` distinguishable from
    /// `UNAUTHORIZED`.
    pub moved_at: Option<ServerTime>,
}

impl LeaseState {
    /// A vault nobody has claimed yet.
    #[must_use]
    pub const fn unclaimed() -> Self {
        Self {
            current: None,
            moved_at: None,
        }
    }

    /// The epoch the gateway holds. `0` before the first claim.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        match self.current {
            Some(lease) => lease.epoch,
            None => 0,
        }
    }
}

/// Accept a lease claim, or refuse it.
///
/// The claim's certificate has already been verified by the adapter and its
/// binding to *this* vault checked by the caller; what is judged here is the
/// epoch.
///
/// # Errors
///
/// [`Refusal::LeaseStale`] for an epoch at or below the one held. **Equal is
/// refused, not accepted**: an equal epoch from a different device is two
/// devices claiming the same lease, and accepting the second would make the
/// counter meaningless. This is `DeviceTrust::accept`'s rule, on the wire.
pub fn claim(
    state: LeaseState,
    claimed_epoch: u64,
    claimant: DeviceId,
    now: ServerTime,
) -> Result<LeaseState, Refusal> {
    let held = state.epoch();
    if claimed_epoch <= held {
        return Err(Refusal::LeaseStale {
            held,
            claimed: claimed_epoch,
        });
    }
    // A re-claim by the same device is a restore onto the same phone, or a
    // reissue after a certificate rotation; it is not a move and leaves no
    // tombstone for the phone to trip over.
    let same_device = state.current.is_some_and(|lease| lease.device == claimant);
    Ok(LeaseState {
        current: Some(Lease {
            device: claimant,
            epoch: claimed_epoch,
            taken_at: now,
        }),
        moved_at: if state.current.is_none() || same_device {
            state.moved_at
        } else {
            Some(now)
        },
    })
}

/// May this device write to this vault?
///
/// # Errors
///
/// - [`Refusal::VaultMoved`] when the device once held the lease and a higher
///   epoch took it. **This is the refusal with a behaviour attached**: freeze
///   read-only, keep the spool.
/// - [`Refusal::NotLeaseHolder`] for a device that never held it, and for a
///   vault nobody holds.
pub fn authorize_write(state: LeaseState, device: DeviceId, epoch: u64) -> Result<(), Refusal> {
    match state.current {
        Some(lease) if lease.device == device && lease.epoch == epoch => Ok(()),
        Some(lease) if epoch < lease.epoch => {
            // It presented a certificate for an older epoch of THIS vault, so
            // it is a phone that used to hold it — not a stranger.
            Err(Refusal::VaultMoved {
                current_epoch: lease.epoch,
                moved_at: state.moved_at.unwrap_or(lease.taken_at),
            })
        }
        _ => Err(Refusal::NotLeaseHolder),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::Key32;

    fn device(tag: u8) -> DeviceId {
        Key32::from_bytes([tag; 32])
    }

    fn at(millis: i64) -> ServerTime {
        ServerTime::from_millis(millis)
    }

    #[test]
    fn a_claim_carries_epoch_plus_one_and_an_equal_epoch_is_refused() {
        let held = claim(LeaseState::unclaimed(), 1, device(1), at(10)).expect("first claim");
        assert_eq!(held.epoch(), 1);
        assert_eq!(
            claim(held, 1, device(2), at(20)),
            Err(Refusal::LeaseStale {
                held: 1,
                claimed: 1
            }),
            "two devices cannot hold the same epoch"
        );
        assert_eq!(
            claim(held, 0, device(2), at(20)),
            Err(Refusal::LeaseStale {
                held: 1,
                claimed: 0
            })
        );
        assert_eq!(
            claim(held, 2, device(2), at(20)).expect("higher").epoch(),
            2
        );
    }

    /// THE OLD PHONE AFTER A RESTORE. It is told the vault moved, and the
    /// refusal is not the one a stranger gets.
    #[test]
    fn a_superseded_device_is_told_the_vault_moved_and_a_stranger_is_not() {
        let first = claim(LeaseState::unclaimed(), 1, device(1), at(10)).expect("claim");
        let after_restore = claim(first, 2, device(2), at(20)).expect("claim");

        let refusal = authorize_write(after_restore, device(1), 1).expect_err("superseded");
        assert_eq!(
            refusal,
            Refusal::VaultMoved {
                current_epoch: 2,
                moved_at: at(20),
            }
        );

        assert_eq!(
            authorize_write(after_restore, device(9), 1),
            Err(Refusal::VaultMoved {
                current_epoch: 2,
                moved_at: at(20)
            }),
            "a certificate for an older epoch of this vault is a superseded holder, \
             whichever device key it names — the seed is on both phones (F1)"
        );
        assert_eq!(
            authorize_write(after_restore, device(9), 5),
            Err(Refusal::NotLeaseHolder),
            "a device presenting an epoch nobody has reached is not a former holder"
        );
    }

    /// A restore onto the SAME phone is not a move, so it leaves no tombstone.
    #[test]
    fn a_reclaim_by_the_same_device_leaves_no_moved_tombstone() {
        let first = claim(LeaseState::unclaimed(), 1, device(1), at(10)).expect("claim");
        let again = claim(first, 2, device(1), at(20)).expect("claim");
        assert_eq!(again.moved_at, None);
        assert_eq!(authorize_write(again, device(1), 2), Ok(()));
    }

    #[test]
    fn nobody_writes_to_a_vault_nobody_holds() {
        assert_eq!(
            authorize_write(LeaseState::unclaimed(), device(1), 1),
            Err(Refusal::NotLeaseHolder)
        );
    }
}
