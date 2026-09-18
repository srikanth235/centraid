//! When a phone republishes its records, and why it is a schedule and not a
//! side effect (#1029 §0, W5B-3).
//!
//! `centraid_identity::discovery` is *how* a record gets onto a resolver.
//! Missing from it, and built here, is **when**: a record has a TTL, resolvers
//! believe it for exactly that long, and the window a stale `cert=` can be
//! believed in is the window an old phone keeps answering after a restore.
//!
//! # THE THREE TRIGGERS, AND THE ONE THAT IS A TIMER
//!
//! | Trigger | Why |
//! |---|---|
//! | [`Reason::Timer`] | the record expires; resolvers stop believing it |
//! | [`Reason::GatewayChanged`] | the `gateway=` or `mailbox=` entry names somewhere that is no longer where this vault is |
//! | [`Reason::DeviceChanged`] | a restore reissued the certificate at `epoch + 1`, and `cert=` names the phone that no longer holds the vault |
//!
//! The last one is the one the mechanism exists for. #1029 §0 requires a refresh
//! on every gateway or device change precisely so that the interval a contact
//! can be pointed at the lost phone is bounded by the TTL rather than by
//! whenever the new phone next happens to run.
//!
//! # WHAT IS NOT PUBLISHED, AND WHY
//!
//! **The manifest head is not in the record.** The brief asked for it and the
//! record has no entry for it; adding one is a change to
//! `centraid_identity::record`'s format, which this lane may not make (W4c is
//! live in that crate). It would also be the wrong shape: a record is a
//! *public* DNS answer under a key anyone may query, and a head that changed on
//! every commit would publish a member's write cadence — how often they use
//! their vault, and when they stopped — to anybody who resolves the key. The
//! head reaches a phone from the gateway, over a signed request, where the only
//! party that learns it is the one already holding the objects.

use centraid_identity::{
    AccountKey, AccountRecord, Discovery, DiscoveryError, GatewayUrl, IdentityRecord,
    RECORD_TTL_SECONDS, VaultIdentityKey,
};

/// Why a republish is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The record's TTL is running out.
    Timer,
    /// This vault, or this account, moved to another gateway.
    GatewayChanged,
    /// The certificate changed — a restore, or a device swap.
    DeviceChanged,
}

/// When the next timer republish is due, in milliseconds since the epoch.
///
/// **Half the TTL**, which is the ordinary DNS-refresh discipline and is here
/// for a specific reason rather than by convention: a phone republishing *at*
/// the TTL leaves a gap in which every resolver has expired the record and the
/// new one has not landed — and during that gap a contact's lookup fails, which
/// this product renders as "unreachable". Refreshing at half the TTL means one
/// missed pass is survivable.
#[must_use]
pub const fn next_timer_ms(last_published_ms: i64) -> i64 {
    last_published_ms.saturating_add((RECORD_TTL_SECONDS as i64) * 1000 / 2)
}

/// Whether a republish is due now.
#[must_use]
pub const fn timer_due(last_published_ms: i64, now_ms: i64) -> bool {
    now_ms >= next_timer_ms(last_published_ms)
}

/// Publish a vault's record and its account's, together.
///
/// **Together, because they are one fact from a member's side**: "this vault is
/// on that gateway". Publishing the identity record alone leaves an account
/// record naming a gateway that no longer holds the vault, and a restore starts
/// from the account record (F2) — so the half that gets missed would be exactly
/// the half the worst day depends on.
///
/// # Errors
///
/// [`DiscoveryError`]. A failure to publish is **not** a failure to back up:
/// the gateway holds the objects either way, and a phone that treated an
/// unreachable resolver as a backup failure would alarm a member about the one
/// thing that was fine.
pub async fn refresh(
    discovery: &Discovery,
    identity_record: &IdentityRecord,
    identity: &VaultIdentityKey,
    account_gateway: &GatewayUrl,
    account: &AccountKey,
    _reason: Reason,
) -> Result<(), DiscoveryError> {
    discovery
        .publish_identity(identity_record, identity)
        .await?;
    let account_record = AccountRecord::new(account.public(), account_gateway.clone());
    discovery.publish_account(&account_record, account).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// HALF THE TTL, so one missed pass does not make a member unreachable.
    #[test]
    fn the_timer_refreshes_at_half_the_record_ttl() {
        assert_eq!(next_timer_ms(0), 150_000);
        assert!(!timer_due(0, 149_999));
        assert!(timer_due(0, 150_000));
    }

    /// A phone that has been asleep for a month is due, and the arithmetic does
    /// not wrap on a clock at the top of the range.
    #[test]
    fn an_absurd_clock_saturates_rather_than_wrapping_into_the_past() {
        assert!(timer_due(i64::MAX, i64::MAX));
    }

    /// The three triggers are distinct values because a caller logs which one
    /// fired; a device change that looked like a timer would hide the one
    /// transition the mechanism exists for.
    #[test]
    fn the_three_reasons_are_three_values() {
        assert_ne!(Reason::Timer, Reason::GatewayChanged);
        assert_ne!(Reason::GatewayChanged, Reason::DeviceChanged);
        assert_ne!(Reason::Timer, Reason::DeviceChanged);
    }
}
