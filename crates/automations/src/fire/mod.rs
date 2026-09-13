//! **The fire spine, and its ONE injection point** (#1020, D-1020-AU1,
//! D-1020-AU6).
//!
//! ## The sentence this module exists to keep true
//!
//! `fire/fire.ts:1`–`:3`: *the one thing it needs from agent-runtime is the
//! `ctx.delegate` dispatch surface, injected via `openDispatch`.* Census §C1
//! says what a port that loses it loses: *"a port that inlines the dispatch
//! loses the boundary."*
//!
//! So [`fire`] takes `&dyn Dispatch` — assist's trait, from
//! `crates/assist::turn` — and **never reaches a harness itself**. There is no
//! process spawn, no ACP connection, no adapter resolution anywhere under
//! `crates/automations`, and `Cargo.toml` records the dependency as the one
//! direction it runs in: automations depends on assist for the trait, assist
//! depends on automations for nothing.
//!
//! ## Steering rides the same rail
//!
//! `ctx.delegate` IS the steering rail. The posture is
//! [`TurnPosture::unattended`] — nobody is watching, so `failover` is
//! `fire-boundary`: **the whole fire is the unit**, and a retry re-fires rather
//! than re-prompting mid-run. [`Steering::delegate`] is the caller of the
//! trait, `run-automation-live-dispatch.ts`'s half; [`Failover`] is the rung
//! ladder, and a rung that fails hands on to the next **without carrying the
//! manifest's provider pins**, because a pin belongs to the primary harness.
//!
//! ## Sealed model turns
//!
//! Under every enrichment rung below `gateway` the gate answers
//! `seal_model_turns: true`, and a sealed spine **refuses the delegate before
//! it touches the dispatcher** — the same ordering `TurnPlane::run_turn` uses
//! for consent, and for the same reason: a refusal after the spawn is a
//! process that ran.

pub mod condition;
pub mod cron_cursor;
pub mod cursor;
pub mod enrich_gate;
pub mod scheduler_ledger;

use centraid_assist::turn::{
    Dispatch, EgressConsent, Failover, TurnError, TurnInput, TurnPlane, TurnPosture,
};

use crate::signals::{Signal, SignalSink};

pub use cursor::TRIGGER_MAX_ATTEMPTS;

/// What one fire is asked to do.
#[derive(Debug, Clone)]
pub struct FireRequest {
    pub automation_ref: String,
    pub run_id: String,
    /// The trigger that produced it, for the ledger's `trigger_origin`.
    pub trigger_origin: Option<String>,
    /// The instructions, with `@[…]` anchors still in them.
    pub instructions: String,
    /// The harness the manifest asked for, when it asked. An OPEN registry
    /// key: the executing gateway decides whether it is registered.
    pub harness_kind: Option<String>,
    /// `provider/model-id`, when the manifest pinned one.
    pub model: Option<String>,
    /// True while the enrichment gate seals model turns.
    pub seal_model_turns: bool,
}

/// Why a delegate did not run.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SteerError {
    /// The enrichment gate's sealed rung. **Raised before the dispatcher is
    /// touched.**
    #[error("{0}")]
    ModelTurnsSealed(String),
    /// Every rung of the ladder failed.
    #[error("every harness this fire may use failed: {0}")]
    AllRungsFailed(String),
    /// The turn plane refused or the harness failed.
    #[error("{0}")]
    Turn(String),
}

/// A borrowed dispatcher, so the caller keeps ownership of the one it built.
///
/// `TurnPlane` takes its dispatcher by value and `Dispatch` is assist's trait,
/// so a blanket `impl Dispatch for &D` would have to live in assist. It does
/// not, and this lane does not edit that crate — so the forwarding newtype
/// lives here, which also puts the boundary in one readable place: **every
/// dispatch this crate makes goes through `TurnPlane`, and every one of those
/// goes through this `impl`.**
struct Borrowed<'a, D: Dispatch>(&'a D);

impl<D: Dispatch> Dispatch for Borrowed<'_, D> {
    fn dispatch(
        &self,
        input: &TurnInput,
        kind: &str,
        policy: centraid_assist::turn::PermissionPolicy,
    ) -> Result<centraid_assist::turn::TurnResult, TurnError> {
        self.0.dispatch(input, kind, policy)
    }
}

/// The `ctx.delegate` rail, over assist's trait.
///
/// It holds the posture and the rung ladder and nothing else — no harness, no
/// process, no adapter. The dispatcher is the caller's.
pub struct Steering<'a, D: Dispatch, K: SignalSink> {
    plane: TurnPlane<Borrowed<'a, D>>,
    signals: &'a K,
    /// The failover ladder: the manifest's pinned harness first, then the
    /// gateway's own preference order.
    rungs: Vec<String>,
}

impl<'a, D: Dispatch, K: SignalSink> Steering<'a, D, K> {
    /// `rungs` is the harness ladder, in order. An empty ladder is a fire that
    /// cannot delegate, which is legal: most automations never do.
    pub fn new(dispatch: &'a D, signals: &'a K, rungs: Vec<String>) -> Self {
        Self {
            plane: TurnPlane::new(Borrowed(dispatch)),
            signals,
            rungs,
        }
    }

    /// The posture an automation fire runs under.
    ///
    /// `surface: automation`, `egress: unattended`, `failover: fire-boundary`,
    /// `artifacts: delegate-only`. The consent oracle is the HOST's, asked at
    /// dispatch time rather than captured — a member may have revoked it since
    /// the manifest was written.
    #[must_use]
    pub fn posture(consent: EgressConsent) -> TurnPosture {
        let posture = TurnPosture::unattended(consent);
        debug_assert_eq!(posture.failover, Failover::FireBoundary);
        posture
    }

    /// Take one delegate turn for this fire, failing over along the ladder.
    ///
    /// The **fire boundary** is the retry unit, so a rung that fails is tried
    /// once and handed on; a rung that refuses on CONSENT is not retried at
    /// all, because the next rung is another provider and the answer was about
    /// providers.
    pub fn delegate(
        &self,
        request: &FireRequest,
        input: &TurnInput,
        posture: &TurnPosture,
    ) -> Result<centraid_assist::turn::TurnResult, SteerError> {
        // SEALED BEFORE THE DISPATCHER IS TOUCHED.
        if request.seal_model_turns {
            let reason = enrich_gate::sealed_model_turn_reason(
                &request.automation_ref,
                crate::manifest::EnrichDomain::Photos,
            );
            return Err(SteerError::ModelTurnsSealed(reason));
        }
        let ladder: Vec<&str> = request
            .harness_kind
            .as_deref()
            .into_iter()
            .chain(self.rungs.iter().map(String::as_str))
            .collect();
        if ladder.is_empty() {
            return Err(SteerError::AllRungsFailed(
                "this gateway carries no harness for an automation to delegate to".to_owned(),
            ));
        }
        let mut last = String::new();
        for (index, kind) in ladder.iter().enumerate() {
            // A FAILOVER RUNG CARRIES NO MANIFEST PROVIDER PINS: the pin
            // belongs to the primary harness, and a model id from one vendor
            // means nothing to another.
            let mut attempt = input.clone();
            if index > 0 {
                attempt.model = None;
            }
            match self.plane.run_turn(&attempt, kind, posture) {
                Ok(result) => return Ok(result),
                Err(error @ TurnError::ProviderEgressConsentRequired { .. }) => {
                    // Not a rung failure: the member's answer was about
                    // providers, and every rung is a provider.
                    return Err(SteerError::Turn(error.to_string()));
                }
                Err(error) => {
                    last = error.to_string();
                    self.signals.raise(Signal::ElementDeadLettered {
                        automation_ref: request.automation_ref.clone(),
                        position: (*kind).to_owned(),
                        attempts: u32::try_from(index + 1).unwrap_or(1),
                        error: last.clone(),
                    });
                }
            }
        }
        Err(SteerError::AllRungsFailed(last))
    }
}

/// What a fire produced.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FireOutcome {
    pub automation_ref: String,
    pub run_id: String,
    pub ok: bool,
    pub delegate_calls: u32,
    pub error: Option<String>,
}

/// The handler a fire runs. The **only** thing a fire does beyond bookkeeping.
///
/// A trait rather than a closure because the recognition handlers are
/// implementations of it ([`crate::handler`]) and a member's automation is
/// another: one execution boundary, many bodies.
pub trait Handler {
    fn run(&self, request: &FireRequest, ctx: &mut dyn HandlerCtx) -> Result<(), String>;
}

/// What a handler is handed. **No harness, no socket, no model client.**
///
/// `docs/recognition-automations.md:57`–`:63`: there is no `ctx.enrich` and no
/// `ctx.infer`, and `ctx.fetch` is connector-only.
pub trait HandlerCtx {
    /// Take a model turn through the harness registry. Refused under a sealed
    /// rung.
    fn delegate(&mut self, prompt: &str) -> Result<String, SteerError>;
    /// Invoke a typed vault command. The ONE write door.
    fn invoke(
        &mut self,
        command: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value, String>;
    /// Read source material. Three-state: `Ok(Some)` has bytes, `Ok(None)` is
    /// NOT READY, and `Err` is a decline.
    fn content(&mut self, target_type: &str, target_id: &str) -> Result<Option<Vec<u8>>, String>;
    /// An outbound HTTP fetch. **Connector-only, and connectors are on the
    /// back burner** — so this is a typed `NotAvailable` this wave rather than
    /// a half-built rail (D-1020-AU4).
    fn fetch(&mut self, _url: &str) -> Result<Vec<u8>, crate::handler::CtxError> {
        Err(crate::handler::CtxError::NotAvailable {
            what: "ctx.fetch",
            because: "outbound fetch belongs to a connector's bound connection, and the connectors \
                      plane is not built in this release",
        })
    }
}

/// Run one fire.
///
/// The spine: it resolves nothing about harnesses, opens nothing, and its whole
/// dependency on the assistant plane is the `&dyn Dispatch` a [`Steering`] was
/// handed. A gate refusal is a RESULT, not an error — the fire did not run and
/// the member's own setting is why, which the enrichment screen already says.
/// It raises no signal of its own, deliberately: a gate refusal is already on
/// the member's enrichment screen, and a handler failure is the run's own row
/// in the automation journal. A signal for either would be a second telling of
/// something already told.
pub fn fire(
    request: &FireRequest,
    gate: Option<&enrich_gate::GateDecision>,
    handler: &dyn Handler,
    ctx: &mut dyn HandlerCtx,
) -> FireOutcome {
    let outcome = |ok: bool, error: Option<String>| FireOutcome {
        automation_ref: request.automation_ref.clone(),
        run_id: request.run_id.clone(),
        ok,
        delegate_calls: 0,
        error,
    };
    if let Some(enrich_gate::GateDecision::Refused(reason)) = gate {
        return outcome(false, Some(reason.clone()));
    }
    match handler.run(request, ctx) {
        Ok(()) => outcome(true, None),
        Err(error) => outcome(false, Some(error)),
    }
}

/// Register one automation's triggers, or refuse and SAY SO.
///
/// The one place [`Signal::ZoneUnset`] is raised, and the reason it is a
/// function rather than a line inside a host: v0's tier 3 made this case
/// invisible, and a refusal nobody is told about is the same bug wearing a
/// different value.
pub fn register<K: SignalSink>(
    automation_ref: &str,
    triggers: &[crate::manifest::Trigger],
    vault_zone: Option<&str>,
    signals: &K,
) -> Vec<cursor::Registration> {
    match cursor::registrations_for(automation_ref, triggers, vault_zone) {
        Ok(registrations) => registrations,
        Err((expr, _refusal)) => {
            signals.raise(Signal::ZoneUnset {
                automation_ref: automation_ref.to_owned(),
                expr,
            });
            Vec::new()
        }
    }
}

/// Make one capability's weights present, and report rather than throw.
///
/// `docs/recognition-automations.md:81`: *a capability whose upstream is
/// unreachable is reported, never thrown, and its automation stays unavailable
/// until the next boot.* So this answers a BOOLEAN — armed, or not — and
/// raises [`Signal::CapabilityUnavailable`] for each capability that failed.
/// The gateway boots either way.
///
/// The fetcher is the host's. Handed [`crate::handler::NoNetwork`] the whole
/// body runs except the socket, which is how the property is proved here.
pub fn arm_capability<K: SignalSink>(
    lock: &centraid_media::models::Lock,
    runtime_dir: &std::path::Path,
    capability: &str,
    fetcher: Option<&dyn centraid_media::models::Fetch>,
    signals: &K,
) -> bool {
    let provision = match fetcher {
        Some(fetcher) => centraid_media::models::ensure(lock, runtime_dir, &[capability], fetcher),
        // A host with no fetcher configured VERIFIES and opens nothing.
        None => centraid_media::models::verify(lock, runtime_dir, &[capability]),
    };
    for failure in &provision.failed {
        signals.raise(Signal::CapabilityUnavailable {
            capability: failure.capability.clone(),
            reason: failure.reason.clone(),
        });
    }
    provision.ready.iter().any(|ready| ready == capability)
}

/// Record one target's disposition, and signal a decline.
///
/// The walk's own arithmetic is [`crate::handler::TargetLedger`]'s; this is
/// the one place a DECLINE becomes something a member can see — which is what
/// `docs/system-signals.md`'s enrichment probe reads as *"the poison itself"*.
pub fn record_target<K: SignalSink>(
    capability: &str,
    target_type: &str,
    target_id: &str,
    disposition: &crate::handler::Disposition,
    signals: &K,
) {
    if let crate::handler::Disposition::Declined { reason, failures } = disposition {
        signals.raise(Signal::TargetDeclined {
            capability: capability.to_owned(),
            target_type: target_type.to_owned(),
            target_id: target_id.to_owned(),
            reason: reason.clone(),
            failures: *failures,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use centraid_assist::turn::PermissionPolicy;

    use super::*;
    use crate::signals::Recording;

    /// Fails its first `failures` dispatches, then succeeds. Records which
    /// kinds it was asked for, and with which model.
    struct Flaky {
        failures: Cell<u32>,
        seen: std::cell::RefCell<Vec<(String, Option<String>)>>,
    }

    impl Flaky {
        fn new(failures: u32) -> Self {
            Self {
                failures: Cell::new(failures),
                seen: std::cell::RefCell::new(Vec::new()),
            }
        }
    }

    impl Dispatch for Flaky {
        fn dispatch(
            &self,
            input: &TurnInput,
            kind: &str,
            _policy: PermissionPolicy,
        ) -> Result<centraid_assist::turn::TurnResult, TurnError> {
            self.seen
                .borrow_mut()
                .push((kind.to_owned(), input.model.clone()));
            if self.failures.get() > 0 {
                self.failures.set(self.failures.get() - 1);
                return Err(TurnError::Harness {
                    kind: kind.to_owned(),
                    detail: "the adapter exited".to_owned(),
                });
            }
            Ok(centraid_assist::turn::TurnResult {
                harness_kind: kind.to_owned(),
                ..centraid_assist::turn::TurnResult::default()
            })
        }
    }

    fn request(seal: bool) -> FireRequest {
        FireRequest {
            automation_ref: "digest/digest".to_owned(),
            run_id: "run-1".to_owned(),
            trigger_origin: Some("cron".to_owned()),
            instructions: "summarise yesterday".to_owned(),
            harness_kind: Some("codex".to_owned()),
            model: Some("anthropic/some-model".to_owned()),
            seal_model_turns: seal,
        }
    }

    /// THE LIVE FAILOVER TEST: a fake dispatch that fails N times, and a
    /// ladder that reaches the rung after them.
    #[test]
    fn a_delegate_fails_over_along_the_ladder() {
        let dispatch = Flaky::new(2);
        let signals = Recording::new();
        let steering = Steering::new(
            &dispatch,
            &signals,
            vec!["claude-code".to_owned(), "gemini".to_owned()],
        );
        let posture = Steering::<Flaky, Recording>::posture(EgressConsent::new(|| true));
        let input = TurnInput {
            model: Some("anthropic/some-model".to_owned()),
            ..TurnInput::default()
        };
        let result = steering
            .delegate(&request(false), &input, &posture)
            .expect("the third rung answers");
        assert_eq!(result.harness_kind, "gemini");
        let seen = dispatch.seen.borrow().clone();
        assert_eq!(
            seen.iter()
                .map(|(kind, _)| kind.as_str())
                .collect::<Vec<_>>(),
            ["codex", "claude-code", "gemini"],
            "the manifest's harness is the first rung"
        );
        // A FAILOVER RUNG CARRIES NO PROVIDER PIN.
        assert_eq!(seen[0].1.as_deref(), Some("anthropic/some-model"));
        assert_eq!(seen[1].1, None, "the pin belongs to the primary harness");
        assert_eq!(seen[2].1, None);
        assert_eq!(signals.codes().len(), 2, "each failed rung is reported");
    }

    #[test]
    fn a_ladder_that_runs_out_reports_the_last_failure() {
        let dispatch = Flaky::new(9);
        let signals = Recording::new();
        let steering = Steering::new(&dispatch, &signals, vec!["claude-code".to_owned()]);
        let posture = Steering::<Flaky, Recording>::posture(EgressConsent::new(|| true));
        let error = steering
            .delegate(&request(false), &TurnInput::default(), &posture)
            .expect_err("every rung failed");
        match error {
            SteerError::AllRungsFailed(detail) => {
                assert!(detail.contains("the adapter exited"), "{detail}");
            }
            other => panic!("{other:?}"),
        }
    }

    /// SEALED BEFORE THE DISPATCHER IS TOUCHED.
    #[test]
    fn a_sealed_rung_refuses_the_delegate_without_reaching_the_dispatcher() {
        let dispatch = Flaky::new(0);
        let signals = Recording::new();
        let steering = Steering::new(&dispatch, &signals, vec!["codex".to_owned()]);
        let posture = Steering::<Flaky, Recording>::posture(EgressConsent::new(|| true));
        let error = steering
            .delegate(&request(true), &TurnInput::default(), &posture)
            .expect_err("a sealed rung refuses");
        assert!(matches!(error, SteerError::ModelTurnsSealed(_)));
        assert!(
            dispatch.seen.borrow().is_empty(),
            "no process was spawned and nothing left the vault"
        );
    }

    /// A CONSENT refusal is not a rung failure: the next rung is another
    /// provider, and the answer was about providers.
    #[test]
    fn an_unconsented_egress_is_not_failed_over() {
        let dispatch = Flaky::new(0);
        let signals = Recording::new();
        let steering = Steering::new(
            &dispatch,
            &signals,
            vec!["claude-code".to_owned(), "gemini".to_owned()],
        );
        let posture = Steering::<Flaky, Recording>::posture(EgressConsent::never());
        let error = steering
            .delegate(&request(false), &TurnInput::default(), &posture)
            .expect_err("no consent");
        assert!(matches!(error, SteerError::Turn(_)));
        assert!(
            dispatch.seen.borrow().is_empty(),
            "the refusal is before dispatch, on every rung"
        );
    }

    #[test]
    fn the_posture_is_the_unattended_one_and_its_failover_is_the_fire() {
        let posture = Steering::<Flaky, Recording>::posture(EgressConsent::new(|| true));
        assert_eq!(posture.failover, Failover::FireBoundary);
        assert_eq!(posture.surface, centraid_assist::turn::Surface::Automation);
        assert_eq!(posture.egress, centraid_assist::turn::Egress::Unattended);
        assert_eq!(
            posture.artifacts,
            centraid_assist::turn::Artifacts::DelegateOnly
        );
    }

    struct Ok_;

    impl Handler for Ok_ {
        fn run(&self, _request: &FireRequest, _ctx: &mut dyn HandlerCtx) -> Result<(), String> {
            Ok(())
        }
    }

    struct Fails;

    impl Handler for Fails {
        fn run(&self, _request: &FireRequest, _ctx: &mut dyn HandlerCtx) -> Result<(), String> {
            Err("the handler threw".to_owned())
        }
    }

    struct BareCtx;

    impl HandlerCtx for BareCtx {
        fn delegate(&mut self, _prompt: &str) -> Result<String, SteerError> {
            Ok(String::new())
        }

        fn invoke(
            &mut self,
            _command: &str,
            _input: serde_json::Value,
        ) -> Result<serde_json::Value, String> {
            Ok(serde_json::Value::Null)
        }

        fn content(
            &mut self,
            _target_type: &str,
            _target_id: &str,
        ) -> Result<Option<Vec<u8>>, String> {
            Ok(None)
        }
    }

    #[test]
    fn a_fire_reports_its_handlers_answer() {
        let ok = fire(&request(false), None, &Ok_, &mut BareCtx);
        assert!(ok.ok);
        assert_eq!(ok.run_id, "run-1");
        let failed = fire(&request(false), None, &Fails, &mut BareCtx);
        assert!(!failed.ok);
        assert_eq!(failed.error.as_deref(), Some("the handler threw"));
        // A GATE REFUSAL IS A RESULT: the handler never ran, and the member's
        // own setting is the reason.
        let refused = enrich_gate::GateDecision::Refused("off in settings".to_owned());
        let gated = fire(&request(false), Some(&refused), &Fails, &mut BareCtx);
        assert!(!gated.ok);
        assert_eq!(gated.error.as_deref(), Some("off in settings"));
    }

    /// `ctx.fetch` IS A TYPED `NotAvailable`, not a stub that returns empty
    /// bytes and not a half-built rail (D-1020-AU4).
    #[test]
    fn ctx_fetch_is_a_typed_refusal_this_wave() {
        let error = BareCtx
            .fetch("https://example.test")
            .expect_err("connectors are on the back burner");
        match error {
            crate::handler::CtxError::NotAvailable { what, because } => {
                assert_eq!(what, "ctx.fetch");
                assert!(because.contains("connector"), "{because}");
            }
            other => panic!("{other:?}"),
        }
    }
}
