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
use crate::time::{Duration, ServerTime};

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

/// WHAT A STORE SAID, WHICH IS NOT YET A PLAN.
///
/// A receipt asserts two things: how much storage it entitles the account to,
/// and until when. Neither is a state — the state is what the *gateway's own
/// clock* makes of them, which is the point of [`judge`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entitlement {
    pub quota_bytes: u64,
    pub used_bytes: u64,
    /// When the store says the subscription runs out. `None` is a free tier:
    /// nothing was bought, and `quota_bytes` is whatever the operator set free
    /// accounts to — zero being a legitimate answer (see the module docs).
    pub entitled_until: Option<ServerTime>,
}

/// HOW LONG A LAPSED PLAN IS KEPT BEFORE IT EXPIRES (F13).
///
/// A rule, not a setting: "read-only and retained for a **stated** period" is
/// only a promise if the period is one number in one place. Thirty days is long
/// enough to cover a lapsed card and a holiday, which is what actually happens,
/// and it is short enough that storage nobody is paying for is not kept for a
/// year.
///
/// **A lapse never deletes anything by itself.** Expiry means the gateway stops
/// serving; what removes bytes is still `retention`'s purge, run by an operator
/// decision, and that separation is deliberate — a billing state machine that
/// could delete a member's only backup is a billing state machine one bug away
/// from doing it.
pub const RETAIN_AFTER_LAPSE: Duration = Duration::from_days(30);

/// THE PLAN A RECEIPT AND A CLOCK MAKE, DECIDED ONCE.
///
/// This is a rule and it lives here for the reason every other rule does: the
/// hosted adapter is the only deployment that verifies purchases, but it must
/// not be the place that decides what a verified purchase *means*. An adapter
/// that computed "lapsed" its own way would be an adapter whose read-only
/// window differs from what F13 promises, and nothing would catch it — the
/// standalone adapter never reaches these arms, so there is no second
/// implementation to disagree with.
///
/// **The gateway's own clock judges**, never the client's and never the
/// store's assertion about "now": a phone cannot buy itself a month by moving
/// its clock, for the same reason it cannot backdate a base (F10).
#[must_use]
pub fn judge(entitlement: Entitlement, now: ServerTime) -> Plan {
    let Some(entitled_until) = entitlement.entitled_until else {
        // Nothing was bought. A free tier is ACTIVE within its bound, which may
        // well be zero — "free" and "unlimited" are different words and this
        // one means the first.
        return Plan {
            state: State::Active,
            quota_bytes: entitlement.quota_bytes,
            used_bytes: entitlement.used_bytes,
            retain_until: None,
        };
    };
    if now <= entitled_until {
        return Plan {
            state: State::Active,
            quota_bytes: entitlement.quota_bytes,
            used_bytes: entitlement.used_bytes,
            retain_until: None,
        };
    }
    let retain_until = entitled_until + RETAIN_AFTER_LAPSE;
    Plan {
        // Past the entitlement but inside the stated period: READ-ONLY, and
        // restore works. Past that too: expired, and nothing is served — but
        // still nothing is deleted.
        state: if now <= retain_until {
            State::Lapsed
        } else {
            State::Expired
        },
        quota_bytes: entitlement.quota_bytes,
        used_bytes: entitlement.used_bytes,
        retain_until: Some(retain_until),
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

    /// THE THREE STATES A RECEIPT PASSES THROUGH, AND THE CLOCK THAT MOVES IT.
    #[test]
    fn a_receipt_lapses_then_expires_by_the_gateways_own_clock() {
        let day = 86_400_000_i64;
        let until = ServerTime::from_millis(100 * day);
        let entitlement = Entitlement {
            quota_bytes: 1_024,
            used_bytes: 10,
            entitled_until: Some(until),
        };

        // Inside the entitlement.
        assert_eq!(judge(entitlement, until).state, State::Active);
        // One millisecond past it: READ-ONLY, and restore still works.
        let lapsed = judge(entitlement, until + Duration::from_millis(1));
        assert_eq!(lapsed.state, State::Lapsed);
        assert_eq!(lapsed.authorize_read(), Ok(()));
        assert_eq!(
            lapsed.retain_until,
            Some(until + RETAIN_AFTER_LAPSE),
            "the stated period is stated, so a member can be told when it ends"
        );
        // The last instant of the stated period is still read-only.
        assert_eq!(
            judge(entitlement, until + RETAIN_AFTER_LAPSE).state,
            State::Lapsed
        );
        // And past it, expired.
        assert_eq!(
            judge(
                entitlement,
                until + RETAIN_AFTER_LAPSE + Duration::from_millis(1)
            )
            .state,
            State::Expired
        );
    }

    /// A FREE TIER IS ACTIVE WITHIN ITS BOUND, AND THE BOUND MAY BE ZERO.
    /// "Free" and "unlimited" are different words and this one means the first.
    #[test]
    fn an_account_that_bought_nothing_is_active_inside_whatever_bound_it_has() {
        let free = judge(
            Entitlement {
                quota_bytes: 0,
                used_bytes: 0,
                entitled_until: None,
            },
            ServerTime::from_millis(0),
        );
        assert_eq!(free.state, State::Active);
        assert_eq!(free.retain_until, None);
        assert!(
            free.authorize_write(1).is_err(),
            "a zero bound is a bound; keys are free to mint (F13)"
        );
    }

    /// THE QUOTA CARRIES THROUGH A LAPSE UNCHANGED.
    ///
    /// A lapse must not look like a shrink: the bytes are still there, still
    /// counted, and still restorable. Zeroing the quota on lapse would make
    /// `authorize_read` fine and every size readout wrong.
    #[test]
    fn a_lapse_changes_the_state_and_not_the_numbers() {
        let day = 86_400_000_i64;
        let entitlement = Entitlement {
            quota_bytes: 4_096,
            used_bytes: 4_000,
            entitled_until: Some(ServerTime::from_millis(day)),
        };
        let lapsed = judge(entitlement, ServerTime::from_millis(10 * day));
        assert_eq!(lapsed.state, State::Lapsed);
        assert_eq!(lapsed.quota_bytes, 4_096);
        assert_eq!(lapsed.used_bytes, 4_000);
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
