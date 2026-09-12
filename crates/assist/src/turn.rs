//! The turn plane: the only host-agnostic door into a concrete harness turn
//! (#1020, D-1020-AS4).
//!
//! ## Consent is a property of the posture
//!
//! `turn-plane.ts:11`–`:14` says why, and it is the load-bearing sentence in
//! this file: *keeping the check on the posture makes consent a property of the
//! one door rather than a convention that a caller can accidentally skip.*
//!
//! The Rust shape makes that stronger than a convention. [`TurnPosture`] cannot
//! be constructed without an [`EgressConsent`], and [`TurnPlane::run_turn`]
//! asks it **before** it touches the dispatcher — so there is no ordering a
//! caller can get wrong, and no code path where a process is spawned and then
//! the consent question is asked. The refusal is typed
//! ([`TurnError::ProviderEgressConsentRequired`]) and carries the kind and the
//! egress class, because the shell's next action differs for the two.
//!
//! An absent answer is a refusal, not a default. v0 checks
//! `typeof egressConsent !== "function"` for the same reason: a posture that
//! forgot to wire consent must fail closed.
//!
//! ## Six fields, all of them decisions
//!
//! | Field | What it decides |
//! |---|---|
//! | `surface` | whether a member is looking at this turn |
//! | `egress` | whether somebody is there to see what leaves the vault |
//! | `egress_consent` | the host-owned proof that *this* dispatch may leave |
//! | `failover` | whether a failed turn retries, and at which boundary |
//! | `permission_policy` | how a harness's permission request is answered |
//! | `artifacts` | whether this turn may capture files into the ledger |
//!
//! `permission_policy` is `auto-allow` or `deny` and **never a prompt**: a
//! gateway turn has no approval UI. `artifacts: delegate-only` is how a
//! sub-run's files stay the parent's to capture.
//!
//! ## Hydration budget
//!
//! [`HYDRATION_TOKEN_BUDGET`] and [`HYDRATION_MIN_TURNS`] are v0's 8,000 and 2
//! (`turn-plane.ts:5`–`:6`). They are here rather than in the store because
//! they are a property of the door: how much canonical ledger a new harness
//! session is handed before it is cheaper to let it ask.

use std::fmt;

/// Estimated canonical-ledger prompt tokens a turn may be handed on a handoff.
/// Recorded per turn in `turns.hydration_tokens`, separate from ACP-reported
/// usage — an explicit handoff-cost marker rather than a share of the bill.
pub const HYDRATION_TOKEN_BUDGET: u32 = 8_000;

/// Below this many prior turns there is nothing worth hydrating.
pub const HYDRATION_MIN_TURNS: u32 = 2;

/// Whether a member is looking at this turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Surface {
    Interactive,
    Automation,
}

/// Whether somebody is present to see what leaves the vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Egress {
    Attended,
    Unattended,
}

impl Egress {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Attended => "attended",
            Self::Unattended => "unattended",
        }
    }
}

/// Whether a failed turn is retried, and at which boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failover {
    /// A chat turn: retry on another kind at the turn boundary.
    TurnBoundary,
    /// An automation: the whole fire is the unit, so a retry re-fires rather
    /// than re-prompting mid-run.
    FireBoundary,
    None,
}

/// How a harness's permission request is answered. Never a prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionPolicy {
    AutoAllow,
    Deny,
}

/// Whether this turn may capture harness-created files into the ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Artifacts {
    Capture,
    DelegateOnly,
}

/// The host's proof that this exact dispatch may leave the vault.
///
/// A closure rather than a boolean, because the answer is a *question asked at
/// dispatch time* — the member may have revoked the consent since the
/// conversation was opened, and a boolean captured earlier would be a stale
/// permission with a long life.
pub struct EgressConsent(Box<dyn Fn() -> bool + Send + Sync>);

impl EgressConsent {
    /// Wrap a host-owned answer.
    #[must_use]
    pub fn new(answer: impl Fn() -> bool + Send + Sync + 'static) -> Self {
        Self(Box::new(answer))
    }

    /// A standing refusal. Named, so a posture that means "never" says so
    /// rather than passing a closure that returns `false` for reasons a reader
    /// has to reconstruct.
    #[must_use]
    pub fn never() -> Self {
        Self::new(|| false)
    }

    #[must_use]
    pub fn granted(&self) -> bool {
        (self.0)()
    }
}

impl fmt::Debug for EgressConsent {
    fn fmt(&self, out: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The ANSWER is never printed: asking it has a cost, and a debug format
        // that consults a consent oracle is a log line that changes behaviour.
        out.write_str("EgressConsent(..)")
    }
}

/// The posture a turn runs under.
#[derive(Debug)]
pub struct TurnPosture {
    pub surface: Surface,
    pub egress: Egress,
    pub egress_consent: EgressConsent,
    pub failover: Failover,
    pub permission_policy: PermissionPolicy,
    pub artifacts: Artifacts,
}

impl TurnPosture {
    /// An interactive chat turn: a member is watching, so the harness's
    /// permission requests are auto-allowed and a failure may fail over to
    /// another kind at the turn boundary.
    #[must_use]
    pub fn interactive(consent: EgressConsent) -> Self {
        Self {
            surface: Surface::Interactive,
            egress: Egress::Attended,
            egress_consent: consent,
            failover: Failover::TurnBoundary,
            permission_policy: PermissionPolicy::AutoAllow,
            artifacts: Artifacts::Capture,
        }
    }

    /// An automation fire: nobody is watching, so failover is the fire's and
    /// artifacts belong to the delegate that produced them.
    #[must_use]
    pub fn unattended(consent: EgressConsent) -> Self {
        Self {
            surface: Surface::Automation,
            egress: Egress::Unattended,
            egress_consent: consent,
            failover: Failover::FireBoundary,
            permission_policy: PermissionPolicy::AutoAllow,
            artifacts: Artifacts::DelegateOnly,
        }
    }
}

/// What a turn asks for.
#[derive(Debug, Clone, Default)]
pub struct TurnInput {
    pub cwd: std::path::PathBuf,
    pub conversation_id: Option<String>,
    pub message: String,
    /// An opaque id from a previous session with this kind. **Opaque**: it is
    /// handed back as `prevSessionId` and never parsed (`runtime.ts:28`).
    pub prev_session_id: Option<String>,
    /// Canonical-ledger context injected on a handoff, and the token estimate
    /// recorded for it.
    pub hydration: Option<Hydration>,
    /// Directories beyond `cwd` the harness may read.
    pub additional_directories: Vec<std::path::PathBuf>,
    /// Prepended to the child's `PATH`, so the harness finds `centraid`.
    pub extra_path: Option<String>,
    pub model: Option<String>,
}

/// Canonical ledger handed to a fresh harness session.
#[derive(Debug, Clone)]
pub struct Hydration {
    pub context: String,
    pub tokens: u32,
}

/// What a turn produced.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnResult {
    pub harness_kind: String,
    pub session_id: Option<String>,
    pub hydrated: bool,
    pub stop_reason: Option<String>,
}

/// Why a turn did not run, or did not finish.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TurnError {
    /// THE REFUSAL THIS DOOR EXISTS FOR. Raised before dispatch — no process is
    /// spawned, no session is opened, nothing leaves.
    #[error("{egress} provider egress to {kind} is not consented")]
    ProviderEgressConsentRequired { kind: String, egress: &'static str },
    /// The breaker for this kind is open (see [`crate::health`]).
    #[error("{kind} is in a {failure_class} breaker until {until_ms}")]
    BreakerOpen {
        kind: String,
        failure_class: String,
        until_ms: i64,
    },
    /// A harness-side failure, already classified.
    #[error("{kind}: {detail}")]
    Harness { kind: String, detail: String },
    #[error("{0}")]
    Registry(#[from] crate::registry::RegistryError),
}

/// The concrete dispatch a [`TurnPlane`] drives.
///
/// This is the seam the automations lane injects through `openDispatch`
/// (`fire.ts:1`–`:3`, §Cross-lane): the automations crate owns the caller and
/// never reaches a harness itself, and the assist crate owns the posture, the
/// plane and the ledger. Two crates, one named boundary, and the boundary is
/// this trait.
pub trait Dispatch {
    /// Run one turn against a concrete harness.
    ///
    /// `policy` is the posture's, already resolved: an implementation must
    /// never re-derive a permission answer, and must never ask a human.
    fn dispatch(
        &self,
        input: &TurnInput,
        kind: &str,
        policy: PermissionPolicy,
    ) -> Result<TurnResult, TurnError>;
}

/// The one door.
pub struct TurnPlane<D: Dispatch> {
    dispatch: D,
}

impl<D: Dispatch> TurnPlane<D> {
    #[must_use]
    pub const fn new(dispatch: D) -> Self {
        Self { dispatch }
    }

    /// Run a turn, or refuse it.
    ///
    /// The consent question is asked FIRST and the dispatcher is not touched
    /// until it has been answered `true`.
    pub fn run_turn(
        &self,
        input: &TurnInput,
        kind: &str,
        posture: &TurnPosture,
    ) -> Result<TurnResult, TurnError> {
        if !posture.egress_consent.granted() {
            return Err(TurnError::ProviderEgressConsentRequired {
                kind: kind.to_owned(),
                egress: posture.egress.as_str(),
            });
        }
        self.dispatch
            .dispatch(input, kind, posture.permission_policy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    /// Records whether it was ever reached. The whole point of the consent
    /// tests is that it is not.
    struct Recording {
        reached: Cell<usize>,
        policy: Cell<Option<PermissionPolicy>>,
    }

    impl Recording {
        fn new() -> Self {
            Self {
                reached: Cell::new(0),
                policy: Cell::new(None),
            }
        }
    }

    impl Dispatch for Recording {
        fn dispatch(
            &self,
            _input: &TurnInput,
            kind: &str,
            policy: PermissionPolicy,
        ) -> Result<TurnResult, TurnError> {
            self.reached.set(self.reached.get() + 1);
            self.policy.set(Some(policy));
            Ok(TurnResult {
                harness_kind: kind.to_owned(),
                ..TurnResult::default()
            })
        }
    }

    #[test]
    fn a_posture_with_no_consent_refuses_before_any_spawn() {
        let plane = TurnPlane::new(Recording::new());
        let posture = TurnPosture::unattended(EgressConsent::never());
        let error = plane
            .run_turn(&TurnInput::default(), "codex", &posture)
            .expect_err("an unconsented dispatch must not run");
        assert_eq!(
            error,
            TurnError::ProviderEgressConsentRequired {
                kind: "codex".to_owned(),
                egress: "unattended",
            }
        );
        // THE CLAIM THAT MATTERS: the dispatcher was never entered, so no
        // process was spawned and nothing left the vault.
        assert_eq!(
            plane.dispatch.reached.get(),
            0,
            "the refusal must be before dispatch, not after it"
        );
    }

    #[test]
    fn the_refusal_names_the_attended_class_too() {
        let plane = TurnPlane::new(Recording::new());
        let posture = TurnPosture::interactive(EgressConsent::never());
        assert_eq!(
            plane.run_turn(&TurnInput::default(), "grok", &posture),
            Err(TurnError::ProviderEgressConsentRequired {
                kind: "grok".to_owned(),
                egress: "attended",
            })
        );
    }

    #[test]
    fn consent_is_asked_at_dispatch_time_not_captured() {
        let live = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let watched = std::sync::Arc::clone(&live);
        let posture = TurnPosture::interactive(EgressConsent::new(move || {
            watched.load(std::sync::atomic::Ordering::SeqCst)
        }));
        let plane = TurnPlane::new(Recording::new());
        assert!(
            plane
                .run_turn(&TurnInput::default(), "pi", &posture)
                .is_err()
        );
        live.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(
            plane
                .run_turn(&TurnInput::default(), "pi", &posture)
                .is_ok(),
            "a revoked-then-granted consent must be re-read, not remembered"
        );
        assert_eq!(plane.dispatch.reached.get(), 1);
    }

    #[test]
    fn the_postures_policy_is_what_reaches_the_dispatcher() {
        let plane = TurnPlane::new(Recording::new());
        let mut posture = TurnPosture::unattended(EgressConsent::new(|| true));
        posture.permission_policy = PermissionPolicy::Deny;
        plane
            .run_turn(&TurnInput::default(), "opencode", &posture)
            .expect("consented");
        assert_eq!(plane.dispatch.policy.get(), Some(PermissionPolicy::Deny));
    }

    #[test]
    fn the_hydration_budget_is_v0s() {
        assert_eq!(HYDRATION_TOKEN_BUDGET, 8_000);
        assert_eq!(HYDRATION_MIN_TURNS, 2);
    }
}
