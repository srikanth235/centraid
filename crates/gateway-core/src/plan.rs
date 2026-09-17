//! Quota and lapse (#1029 §3, F13).
//!
//! # Free tier and lapse were undefined, and both are rules rather than
//! settings
//!
//! **Keys are free to mint**, so an unbounded free quota is unbounded Sybil
//! storage: anyone with a script can derive ten thousand account keys. The free
//! tier is therefore **zero or receipt-bound**, and `quota_bytes` is a rule the
//! gateway enforces, not a number a screen displays. Zero is a legitimate free
//! tier here, and it is *not* the same as "no limit" — which is why the type is
//! a plain `u64` and there is no `None` arm to mean unbounded.
//!
//! **A lapsed plan is read-only and retained for a stated period, never deleted
//! inside it.** Restore still works while lapsed, which is the whole reason
//! somebody comes back. Only after `retain_until` does the state become
//! [`State::Expired`], and that is a separate decision an operator makes rather
//! than a sweep this crate runs.
//!
//! Plans and billing apply to the hosted adapter only; a standalone owner sets
//! a quota per household member and never reaches the lapse arms. That is why
//! there is no purchase verification here: it is the one feature limited to one
//! adapter, and it ends in a `Plan` this module then judges identically.

use crate::error::Refusal;
use crate::time::ServerTime;

/// Where a plan stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Active,
    /// Read-only. Reads, lists and restores work; nothing new is accepted and
    /// nothing is deleted.
    Lapsed,
    /// The stated retention period after a lapse ended. Nothing is served.
    Expired,
}

/// A vault's plan as the gateway holds it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub state: State,
    /// The bound. Zero is a real free tier, not "unlimited".
    pub quota_bytes: u64,
    pub used_bytes: u64,
    pub retain_until: Option<ServerTime>,
}

impl Plan {
    /// What the standalone adapter's owner hands a household member, and what
    /// the suite runs against: active, with a bound.
    #[must_use]
    pub const fn active(quota_bytes: u64) -> Self {
        Self {
            state: State::Active,
            quota_bytes,
            used_bytes: 0,
            retain_until: None,
        }
    }

    /// May this vault be read at all?
    ///
    /// # Errors
    ///
    /// [`Refusal::PlanExpired`] only. A lapsed plan reads fine — that is the
    /// point of it.
    pub const fn authorize_read(&self) -> Result<(), Refusal> {
        match self.state {
            State::Active | State::Lapsed => Ok(()),
            State::Expired => Err(Refusal::PlanExpired),
        }
    }

    /// May this vault accept `wanted_bytes` of new objects?
    ///
    /// # Errors
    ///
    /// - [`Refusal::PlanLapsed`] or [`Refusal::PlanExpired`] when the plan is
    ///   not active;
    /// - [`Refusal::QuotaExceeded`] when the write would cross the bound.
    ///   Checked **before** the upload target is issued, not at commit: a
    ///   presigned URL for bytes the gateway will refuse is a phone spending a
    ///   member's cellular data to earn a rejection.
    pub const fn authorize_write(&self, wanted_bytes: u64) -> Result<(), Refusal> {
        match self.state {
            State::Lapsed => return Err(Refusal::PlanLapsed),
            State::Expired => return Err(Refusal::PlanExpired),
            State::Active => {}
        }
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

    /// Is this vault read-only for the purposes of a delete?
    #[must_use]
    pub const fn is_read_only(&self) -> bool {
        matches!(self.state, State::Lapsed | State::Expired)
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

    /// RESTORE STILL WORKS WHILE LAPSED. It is the whole reason somebody comes
    /// back, and a lapse that broke restore would be a lapse that deleted the
    /// backup slowly.
    #[test]
    fn a_lapsed_plan_reads_and_refuses_writes() {
        let plan = Plan {
            state: State::Lapsed,
            ..Plan::active(1_000)
        };
        assert_eq!(plan.authorize_read(), Ok(()));
        assert_eq!(plan.authorize_write(1), Err(Refusal::PlanLapsed));
        assert!(plan.is_read_only());
    }

    #[test]
    fn an_expired_plan_serves_nothing() {
        let plan = Plan {
            state: State::Expired,
            ..Plan::active(1_000)
        };
        assert_eq!(plan.authorize_read(), Err(Refusal::PlanExpired));
        assert_eq!(plan.authorize_write(1), Err(Refusal::PlanExpired));
    }
}
