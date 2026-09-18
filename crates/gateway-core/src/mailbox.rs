//! Mailboxes: unsigned deposits, and the three limits that make that safe
//! (#1029 §3).
//!
//! A mailbox is addressed by the **recipient's** identity key. A deposit is
//! `POST`ed by anyone holding a **deposit capability the recipient issued**, and
//! is *not* signed by the sender at the gateway — so the recipient's gateway
//! never learns who is writing. The sender's signature is inside the sealed
//! bundle, where only the recipient reads it.
//!
//! The price of that anonymity is that authorisation cannot be "who are you".
//! So **one leaked capability must not be able to fill a mailbox**, and three
//! limits together are what makes that true:
//!
//! 1. a **TTL** per entry, so nothing accumulates forever;
//! 2. a **per-deposit size cap**, so one deposit cannot be a terabyte;
//! 3. a **per-capability rate limit**, so a script cannot make a million small
//!    ones.
//!
//! Any two of the three leave a hole: without the cap, the rate limit admits
//! huge deposits; without the rate limit, the cap admits endless small ones;
//! without the TTL, both admit a slow fill that never drains because the
//! recipient's phone is off.
//!
//! Drain and ack are signed by a device key with a **current** certificate from
//! the mailbox's identity key — the same rule the lease uses, so a superseded
//! phone stops draining a mailbox at the moment it stops writing its vault.

use crate::error::{MailboxFault, Refusal};
use crate::ids::{Key32, VaultId};
use crate::time::{Duration, ServerTime};

/// A deposit capability as the gateway holds it. Its signature has already been
/// verified against the mailbox's identity key by the adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capability {
    pub mailbox: VaultId,
    /// Random, and the rate-limit key. **Revoking one sender is forgetting one
    /// id**, which is why the limit is per capability and not per mailbox: a
    /// mailbox-wide limit would let one leaked capability starve every honest
    /// sender.
    pub capability_id: Key32,
    pub expires_at: ServerTime,
    pub max_deposit_bytes: u64,
    pub deposits_per_hour: u32,
    pub revoked: bool,
}

/// The TTL applied to every entry in a mailbox.
pub const DEFAULT_TTL: Duration = Duration::from_millis(30 * 86_400_000);

/// The rate-limit window. Per hour, as the capability states it.
pub const RATE_WINDOW: Duration = Duration::from_millis(3_600_000);

/// Accept one deposit, or refuse it.
///
/// `recent_deposits` is how many deposits this **capability** has made inside
/// [`RATE_WINDOW`] — the adapter counts, because counting is storage; the
/// threshold is here, because the threshold is a rule.
///
/// # Errors
///
/// [`Refusal::MailboxRefused`] with the [`MailboxFault`] that applied.
pub fn accept_deposit(
    capability: &Capability,
    sealed_bytes: u64,
    recent_deposits: u32,
    now: ServerTime,
) -> Result<ServerTime, Refusal> {
    if capability.revoked {
        return Err(Refusal::MailboxRefused(MailboxFault::CapabilityRevoked));
    }
    if now > capability.expires_at {
        return Err(Refusal::MailboxRefused(MailboxFault::CapabilityExpired));
    }
    if sealed_bytes > capability.max_deposit_bytes {
        return Err(Refusal::MailboxRefused(MailboxFault::TooLarge));
    }
    if recent_deposits >= capability.deposits_per_hour {
        return Err(Refusal::MailboxRefused(MailboxFault::RateLimited));
    }
    Ok(now + DEFAULT_TTL)
}

/// Has this entry outlived its TTL?
///
/// The Cloudflare adapter arms a Durable Object alarm at `expires_at` and the
/// standalone adapter sweeps; both ask this.
#[must_use]
pub const fn expired(expires_at: ServerTime, now: ServerTime) -> bool {
    now.millis() > expires_at.millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capability() -> Capability {
        Capability {
            mailbox: Key32::from_bytes([1; 32]),
            capability_id: Key32::from_bytes([2; 32]),
            expires_at: ServerTime::from_millis(10_000),
            max_deposit_bytes: 1_024 * 1_024,
            deposits_per_hour: 10,
            revoked: false,
        }
    }

    fn now() -> ServerTime {
        ServerTime::from_millis(5_000)
    }

    #[test]
    fn a_deposit_inside_every_limit_is_accepted_and_gets_a_ttl() {
        assert_eq!(
            accept_deposit(&capability(), 4_096, 0, now()),
            Ok(now() + DEFAULT_TTL)
        );
    }

    /// One leaked capability, one terabyte. The size cap is what stops it.
    #[test]
    fn a_deposit_over_the_per_deposit_cap_is_refused() {
        assert_eq!(
            accept_deposit(&capability(), 1_024 * 1_024 + 1, 0, now()),
            Err(Refusal::MailboxRefused(MailboxFault::TooLarge))
        );
    }

    /// One leaked capability, a million small deposits. The rate limit is what
    /// stops that one, and it is per capability so honest senders are not
    /// starved.
    #[test]
    fn a_deposit_over_the_per_capability_rate_limit_is_refused() {
        assert_eq!(
            accept_deposit(&capability(), 1, 10, now()),
            Err(Refusal::MailboxRefused(MailboxFault::RateLimited))
        );
        assert!(accept_deposit(&capability(), 1, 9, now()).is_ok());
    }

    #[test]
    fn a_revoked_or_expired_capability_deposits_nothing() {
        let revoked = Capability {
            revoked: true,
            ..capability()
        };
        assert_eq!(
            accept_deposit(&revoked, 1, 0, now()),
            Err(Refusal::MailboxRefused(MailboxFault::CapabilityRevoked))
        );
        assert_eq!(
            accept_deposit(&capability(), 1, 0, ServerTime::from_millis(10_001)),
            Err(Refusal::MailboxRefused(MailboxFault::CapabilityExpired))
        );
    }

    /// Without the TTL, the other two limits still admit a slow fill that never
    /// drains because the recipient's phone is off.
    #[test]
    fn an_entry_past_its_ttl_is_expired() {
        let deposited = accept_deposit(&capability(), 1, 0, now()).expect("accepted");
        assert!(!expired(deposited, now()));
        assert!(!expired(deposited, deposited));
        assert!(expired(deposited, deposited + Duration::from_millis(1)));
    }
}
