//! THE PASS SERVICE: the view-less screen that hears the app's lifecycle, the
//! link, the commits, the windows the OS grants and the member's asks, feeds
//! them to the [`Conductor`], and performs what it answers with.
//!
//! It is a service (`Runtime::with_services`) because the scheduler must hear
//! every broadcast whether or not any page is open. Every effect it asks for is
//! answered to it, and it tells its effects apart by what they answer
//! (`PassNoted`, `WindowsScheduled`, `UploadsState`, `LibraryStreamed`; a bare
//! `EffectDone` is the camera-roll walk).
//!
//! **A door that waits on a gateway is never called from `update`**: the runtime
//! lock is held across `update`, and a pass takes minutes. A pass, a probe, a
//! hand-off and a settle run off the lock (`Ctx::vault_async`, or the same on
//! another vault's core when `Holdings` has one) and come back as
//! `OffThreadDone` events tagged `drain:<vault>`, `reconcile:<vault>`,
//! `handoff:<vault>` and `settle`.

use std::collections::VecDeque;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;
use prost::Message;
use wire::screen_event::Kind as E;

use super::conditions::Reason;
use super::conductor::{Action, Conductor, Drained, Registration, TOPIC};
use super::rule::Rules;
use super::windows;
use crate::custody::secrets::VaultSecrets;
use crate::screen::{Ctx, Screen};

/// The route name of the service.
pub const NAME: &str = "passes.conductor";

/// The route that opens the service.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        screen: NAME.to_owned(),
        args: None,
    }
}

/// The registry factory.
pub fn build(
    secrets: &VaultSecrets,
) -> impl Fn(&wire::Route) -> Option<Box<dyn Screen>> + Send + Sync + 'static {
    let secrets = secrets.clone();
    move |_| Some(Box::new(Service::new(secrets.clone())))
}

/// What an outstanding effect will be answered as. Effects are attributed to
/// the oldest outstanding one of a compatible kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Walk,
    Schedule,
    Noted,
    Count,
    Stream,
    Load,
}

struct Service {
    secrets: VaultSecrets,
    conductor: Conductor,
    outstanding: VecDeque<Kind>,
    loading: Option<Vec<wire::SecretOp>>,
    /// What arrived before the device store was read: replayed in order once it
    /// is, because a pass reads the member's rule at its start.
    deferred: Vec<E>,
    started: bool,
    /// The last lifecycle the shell reported. A repeat is not a transition: a
    /// shell that re-reports the foreground (a screen re-reading its state) must
    /// not buy a camera-roll walk and a pass each time.
    foreground: Option<bool>,
}

impl Service {
    fn new(secrets: VaultSecrets) -> Self {
        let conductor = secrets.conductor().clone();
        Self {
            secrets,
            conductor,
            outstanding: VecDeque::new(),
            loading: None,
            deferred: Vec::new(),
            started: false,
            foreground: None,
        }
    }

    fn effect(&mut self, kind: Kind, effect: wire::Effect, out: &mut Vec<wire::Effect>) {
        self.outstanding.push_back(kind);
        out.push(effect);
    }

    /// The oldest outstanding effect `answered` could be the answer to.
    fn answered(&mut self, accept: &[Kind]) -> Option<Kind> {
        let at = self
            .outstanding
            .iter()
            .position(|kind| accept.contains(kind))?;
        self.outstanding.remove(at)
    }

    fn perform(&mut self, actions: Vec<Action>, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        let rule = Rules::read(&self.secrets).rule;
        for action in actions {
            match action {
                Action::Walk => self.effect(
                    Kind::Walk,
                    wire::Effect {
                        kind: Some(wire::effect::Kind::CameraRoll(wire::CameraRoll {
                            action: wire::camera_roll::Action::ImportNow as i32,
                        })),
                    },
                    out,
                ),
                Action::Drain { vault, request } => {
                    self.conductor.record_pass(&vault, &request);
                    self.call(
                        ctx,
                        format!("drain:{vault}"),
                        &vault,
                        VaultRequest::Drain(request),
                    );
                }
                Action::Stream { vault, needs } => self.effect(
                    Kind::Stream,
                    wire::Effect {
                        kind: Some(wire::effect::Kind::StreamFromLibrary(
                            wire::StreamFromLibrary {
                                vault_id: vault,
                                needs,
                            },
                        )),
                    },
                    out,
                ),
                Action::Reconcile { vault } => self.call(
                    ctx,
                    format!("reconcile:{vault}"),
                    &vault,
                    VaultRequest::Reconcile(wire::ReconcileRequest {}),
                ),
                Action::Handoff {
                    vault,
                    max_bytes,
                    max_parts,
                } => self.call(
                    ctx,
                    format!("handoff:{vault}"),
                    &vault,
                    VaultRequest::Handoff(wire::HandoffRequest {
                        max_bytes,
                        max_parts,
                    }),
                ),
                Action::Settle { vault, settled } => self.call(
                    ctx,
                    "settle".to_owned(),
                    &vault,
                    VaultRequest::Settle(wire::SettleRequest {
                        settled: vec![settled],
                    }),
                ),
                Action::UploadsPending => self.effect(
                    Kind::Count,
                    uploads(wire::uploads_op::Op::Pending(wire::UploadsPending {})),
                    out,
                ),
                Action::UploadsEnqueue(parts) => self.effect(
                    Kind::Noted,
                    uploads(wire::uploads_op::Op::Enqueue(wire::UploadsEnqueue {
                        parts,
                    })),
                    out,
                ),
                Action::UploadsCancelAll => self.effect(
                    Kind::Noted,
                    uploads(wire::uploads_op::Op::CancelAll(wire::UploadsCancelAll {})),
                    out,
                ),
                Action::Schedule => self.effect(Kind::Schedule, windows::schedule(rule), out),
                Action::Nudge => self.effect(Kind::Schedule, windows::schedule_nudge(rule), out),
                Action::LongRun(start) => self.effect(
                    Kind::Noted,
                    wire::Effect {
                        kind: Some(wire::effect::Kind::LongRun(wire::LongRun { start })),
                    },
                    out,
                ),
                Action::WindowDone { window, drained } => self.effect(
                    Kind::Noted,
                    wire::Effect {
                        kind: Some(wire::effect::Kind::PassWindowDone(wire::PassWindowDone {
                            window,
                            drained,
                        })),
                    },
                    out,
                ),
                Action::Timer { name, after } => ctx.start_timer(&name, after),
                Action::CancelTimer { name } => ctx.cancel_timer(&name),
                Action::Changed => ctx.signal(TOPIC),
            }
        }
    }

    /// Run one door off the lock and hear it as `OffThreadDone{tag}`. A vault the
    /// shelf holds a core for runs on THAT core; any other (and every vault, until
    /// the shelf is wired) runs on the core the screens run on.
    fn call(&mut self, ctx: &Ctx, tag: String, vault: &str, request: VaultRequest) {
        self.conductor.record_call(&tag, &request);
        match self.conductor.core_of(vault) {
            Some(handle) => ctx.off_thread(&tag, move |_| vault_called(&handle, request)),
            None => ctx.vault_async(&tag, request),
        }
    }

    /// Start once the device store has been read: the standing windows are
    /// asked for under the member's rule, and the session's first pass runs.
    fn start(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        if self.started {
            return;
        }
        self.started = true;
        let mut actions = vec![Action::Schedule];
        actions.extend(self.conductor.trigger(Reason::SessionOpened, 0));
        self.perform(actions, ctx, out);
    }

    fn handle(&mut self, event: E, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        self.conductor.set_rules(Rules::read(&self.secrets));
        let actions = match event {
            E::Lifecycle(wire::AppLifecycle { foreground }) => {
                if self.foreground.replace(foreground) == Some(foreground) {
                    Vec::new()
                } else if foreground {
                    self.conductor.trigger(Reason::BecameActive, 0)
                } else {
                    self.conductor.entered_background()
                }
            }
            E::DataChanged(_) => self.conductor.commit_landed(),
            E::TimerFired(fired) => self.conductor.timer(&fired.timer),
            E::Signalled(signal) if signal.topic == TOPIC => self.asked(),
            E::ShellFact(fact) => self.fact(fact),
            _ => Vec::new(),
        };
        self.perform(actions, ctx, out);
    }

    fn asked(&mut self) -> Vec<Action> {
        let mut actions = Vec::new();
        for ask in self.conductor.take_asks() {
            actions.extend(self.ask(ask));
        }
        actions
    }

    fn ask(&mut self, ask: wire::pass_asked::Ask) -> Vec<Action> {
        use wire::pass_asked::Ask;
        match ask {
            Ask::BackUpNow => self.conductor.trigger(Reason::BackUpNow, 0),
            Ask::ImportFinished => {
                let mut actions = self.conductor.trigger(Reason::AfterImport, 0);
                // A capture or an import is worth a window soon, not only a
                // pass now: the app may be suspended before the pass ends.
                actions.push(Action::Nudge);
                actions
            }
            Ask::RestoreFinished => self.conductor.trigger(Reason::Restored, 0),
            Ask::SessionOpened => self.conductor.trigger(Reason::SessionOpened, 0),
            Ask::RuleChanged => self.conductor.rule_changed(),
            Ask::Unspecified => Vec::new(),
        }
    }

    fn fact(&mut self, fact: wire::ShellFact) -> Vec<Action> {
        use wire::shell_fact::Fact;
        match fact.fact {
            Some(Fact::Link(link)) => self.conductor.link_changed(&link),
            Some(Fact::Window(granted)) => self
                .conductor
                .window_granted(&granted.window, granted.deadline_ms),
            Some(Fact::Expired(_)) | None => Vec::new(),
            Some(Fact::Held(held)) => {
                self.conductor.set_held(
                    held.vaults
                        .into_iter()
                        .map(|vault| super::conductor::Held {
                            vault_id: vault.vault_id,
                            drainable: vault.drainable,
                        })
                        .collect(),
                );
                Vec::new()
            }
            Some(Fact::Asked(asked)) => wire::pass_asked::Ask::try_from(asked.ask)
                .map_or_else(|_| Vec::new(), |ask| self.ask(ask)),
            Some(Fact::Settled(settled)) => self.conductor.upload_settled(&settled),
            Some(Fact::Drained(_)) => self.conductor.uploads_drained(),
        }
    }

    fn result(&mut self, result: wire::EffectResult, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        use wire::effect_result::Outcome;
        self.conductor.set_rules(Rules::read(&self.secrets));
        let actions = match result.outcome {
            Some(Outcome::Secrets(batched)) => {
                if let Some(ops) = self.loading.take() {
                    if !self.secrets.loaded() {
                        self.secrets.absorb(&ops, &batched.answers);
                    }
                    self.answered(&[Kind::Load]);
                    self.replay(ctx, out);
                }
                return;
            }
            Some(Outcome::WindowsScheduled(scheduled)) => {
                self.answered(&[Kind::Schedule]);
                self.conductor.set_registration(Registration {
                    short: scheduled.taken.iter().any(|name| name == windows::PERIODIC),
                    long: scheduled.taken.iter().any(|name| name == windows::NIGHT),
                })
            }
            Some(Outcome::PassNoted(_)) => {
                self.answered(&[Kind::Noted]);
                Vec::new()
            }
            Some(Outcome::UploadsState(state)) => {
                self.answered(&[Kind::Count]);
                self.conductor.pending(state.pending)
            }
            Some(Outcome::LibraryStreamed(streamed)) => {
                self.answered(&[Kind::Stream]);
                self.conductor.streamed(streamed.landed)
            }
            // THE WALK ENDED, OR THE SHELL HAS NONE TO WALK: the pass runs either way.
            Some(Outcome::Done(_)) => {
                if self.answered(&[Kind::Walk]).is_some() {
                    self.conductor.walked()
                } else {
                    Vec::new()
                }
            }
            Some(Outcome::Failed(_)) => match self.answered(&[
                Kind::Walk,
                Kind::Schedule,
                Kind::Noted,
                Kind::Count,
                Kind::Stream,
                Kind::Load,
            ]) {
                Some(Kind::Walk) => self.conductor.walked(),
                Some(Kind::Count) => self.conductor.pending(MAX_IN_FLIGHT_FULL),
                Some(Kind::Stream) => self.conductor.streamed(0),
                Some(Kind::Load) => {
                    self.loading = None;
                    self.replay(ctx, out);
                    Vec::new()
                }
                _ => Vec::new(),
            },
            _ => Vec::new(),
        };
        self.perform(actions, ctx, out);
    }

    /// A door that ran off the lock answered: read it and feed the conductor.
    fn done(&mut self, done: &wire::OffThreadDone) -> Vec<Action> {
        let answer = match wire::VaultCalled::decode(done.bytes.as_slice()) {
            Ok(called) => match called.error {
                Some(error) => Err(error),
                None => Ok(wire::Response::decode(called.response.as_slice()).unwrap_or_default()),
            },
            // A JOB THAT NEVER PRODUCED AN ANSWER is a door that refused.
            Err(_) => Err(wire::Error::default()),
        };
        let (kind, vault) = done.tag.split_once(':').unwrap_or((done.tag.as_str(), ""));
        match kind {
            "drain" => self.conductor.drained(vault, &Drained::of(answer)),
            "reconcile" => {
                let reachable = match answer {
                    Ok(wire::Response {
                        kind: Some(wire::response::Kind::Reconcile(probe)),
                    }) => Some(probe.reachable),
                    _ => None,
                };
                self.conductor.reconciled(vault, reachable)
            }
            "handoff" => {
                let parts = match answer {
                    Ok(wire::Response {
                        kind: Some(wire::response::Kind::Handoff(batch)),
                    }) => batch.parts,
                    _ => Vec::new(),
                };
                self.conductor.handed_off(vault, parts)
            }
            // A SETTLE IS RECORDED IN THE LEDGER AND ANSWERS NOTHING THE PASS NEEDS.
            _ => Vec::new(),
        }
    }

    /// Replay what waited for the device store.
    fn replay(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        self.start(ctx, out);
        for event in std::mem::take(&mut self.deferred) {
            self.handle(event, ctx, out);
        }
    }
}

/// An unanswered count is treated as the OS being full: nothing is handed off.
const MAX_IN_FLIGHT_FULL: u32 = super::conductor::MAX_IN_FLIGHT;

/// `Ctx::vault_async`'s answer, produced on another vault's core.
fn vault_called(handle: &centraid_core::Handle, request: VaultRequest) -> Vec<u8> {
    let called = match handle.call(&request.into_request()) {
        Ok(response) => wire::VaultCalled {
            response: response.encode_to_vec(),
            error: None,
        },
        Err(refusal) => wire::VaultCalled {
            response: Vec::new(),
            error: Some(refusal.to_wire()),
        },
    };
    called.encode_to_vec()
}

fn uploads(op: wire::uploads_op::Op) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Uploads(wire::UploadsOp {
            op: Some(op),
        })),
    }
}

impl Screen for Service {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut out = Vec::new();
        let Some(kind) = event.kind else {
            return out;
        };
        // THE PLATFORM DECIDES WHO CARRIES SEALED PARTS while the app is
        // suspended: iOS's session; Android moves them inside the pass.
        self.conductor.set_uploads(ctx.platform() == "ios");
        match kind {
            E::Appeared(_) => {
                if self.secrets.loaded() {
                    self.start(ctx, &mut out);
                } else {
                    self.load(&mut out);
                }
            }
            E::EffectResult(result) => self.result(result, ctx, &mut out),
            E::OffThreadDone(done) => {
                let actions = self.done(&done);
                self.perform(actions, ctx, &mut out);
            }
            other => {
                if self.secrets.loaded() {
                    self.start(ctx, &mut out);
                    self.handle(other, ctx, &mut out);
                } else if matches!(
                    other,
                    E::Lifecycle(_) | E::DataChanged(_) | E::ShellFact(_) | E::Signalled(_)
                ) {
                    // A pass reads the member's rule at its start, and the rule
                    // is in the device store the shell has not yet answered.
                    self.deferred.push(other);
                    self.load(&mut out);
                }
            }
        }
        out
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }

    fn hears(&self, topic: &str) -> bool {
        topic == TOPIC
    }
}

impl Service {
    fn load(&mut self, out: &mut Vec<wire::Effect>) {
        if self.loading.is_some() {
            return;
        }
        let ops = VaultSecrets::load_ops();
        self.loading = Some(ops.clone());
        self.effect(
            Kind::Load,
            wire::Effect {
                kind: Some(wire::effect::Kind::Secrets(wire::SecretBatch { ops })),
            },
            out,
        );
    }
}
