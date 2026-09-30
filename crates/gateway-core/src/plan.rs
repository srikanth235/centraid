//! THE QUOTA A VAULT'S ACCOUNT IS HELD TO (#1029 §3).
//!
//! `quota_bytes` is a rule the gateway enforces, not a number a screen
//! displays, and zero is a legitimate bound rather than "no limit" — which is
//! why the type is a plain `u64` with no `None` arm meaning unbounded. A
//! standalone owner sets a quota per household member when they mint the
//! invite (`crate::store` holds it on the account a vault hangs off).
//!
//! # WHAT USED TO BE HERE
//!
//! This module was "quota AND lapse": a purchase receipt entitled an account
//! until a date, and the gateway's own clock judged that into `Active`,
//! `Lapsed` (read-only, retained for a stated period) or `Expired` (F13). The
//! scope amendment of 2026-09-21 strikes the account, purchase records and
//! plan lapse from v0 — there is nothing to buy and nothing to lapse — so
//! `State`, `Entitlement`, `RETAIN_AFTER_LAPSE` and `judge` are deleted with
//! their subject, along with `Refusal::PlanLapsed`, `Refusal::PlanExpired` and
//! the `plan_state` / `lapse_at_ms` / `retain_until_ms` columns. The type is
//! still called `Plan` for now; renaming it to `Quota` collides with
//! `error::Quota`, the refusal companion, and is filed as a question rather
//! than guessed at.

use crate::error::Refusal;

/// A vault's plan as the gateway holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// The bound. Zero is a real bound, not "unlimited".
    pub quota_bytes: u64,
    pub used_bytes: u64,
}

impl Plan {
    /// What the owner hands a household member, and what the suite runs
    /// against: a bound, nothing used yet.
    #[must_use]
    pub const fn active(quota_bytes: u64) -> Self {
        Self {
            quota_bytes,
            used_bytes: 0,
        }
    }

    /// May this vault accept `wanted_bytes` of new objects?
    ///
    /// # Errors
    ///
    /// [`Refusal::QuotaExceeded`] when the write would cross the bound.
    ///   Checked **before** the upload target is issued, not at commit: a
    ///   presigned URL for bytes the gateway will refuse is a phone spending a
    ///   member's cellular data to earn a rejection.
    pub const fn authorize_write(&self, wanted_bytes: u64) -> Result<(), Refusal> {
        // Saturating, so a declared size near `u64::MAX` is refused rather than
        // wrapping into a small number that fits.
        if self.used_bytes.saturating_add(wanted_bytes) > self.quota_bytes {
            return Err(Refusal::QuotaExceeded {
                quota_bytes: self.quota_bytes,
                used_bytes: self.used_bytes,
                wanted_bytes,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A FREE TIER WITHOUT A BOUND IS SYBIL STORAGE (F13). Zero is a bound.
    #[test]
    fn a_zero_quota_refuses_the_first_byte() {
        let plan = Plan::active(0);
        assert_eq!(
            plan.authorize_write(1),
            Err(Refusal::QuotaExceeded {
                quota_bytes: 0,
                used_bytes: 0,
                wanted_bytes: 1,
            })
        );
        assert_eq!(plan.authorize_write(0), Ok(()));
    }

    #[test]
    fn a_quota_is_judged_on_what_is_already_used() {
        let plan = Plan {
            used_bytes: 900,
            ..Plan::active(1_000)
        };
        assert_eq!(plan.authorize_write(100), Ok(()));
        assert!(plan.authorize_write(101).is_err());
    }

    /// A declared size near `u64::MAX` must not wrap into one that fits.
    #[test]
    fn an_absurd_declared_size_saturates_rather_than_wrapping_under_the_quota() {
        let plan = Plan {
            used_bytes: 10,
            ..Plan::active(1_000)
        };
        assert!(plan.authorize_write(u64::MAX).is_err());
    }
}
