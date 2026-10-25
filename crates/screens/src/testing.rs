//! The headless driver: send events, assert on view state and effects.
//!
//! This is where screen behaviour is tested, and it goes through the same door
//! a shell does — `Handle::call` with a `Request::Screen`, and `next_event` for
//! pushes — so a test here is a test of what SwiftUI and Compose will see.
//! `Driver::founded` opens a scratch vault seeded with the example scenario.

use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig, Handle};
use prost::Message;

use crate::runtime::Runtime;
use crate::screen::{Ctx, Environment};

/// The shell's two secret stores and its synchronised-store reading, as a
/// test double: what [`Driver::serve`] answers a [`wire::SecretBatch`] from.
/// `synced_works: false` is a platform that refuses a synchronised write
/// (Block Store without Google Play services).
#[derive(Clone, Debug)]
pub struct FakeShell {
    pub device: BTreeMap<String, String>,
    pub synced: BTreeMap<String, String>,
    pub synced_works: bool,
    pub synchronizing: bool,
    pub restores_after_setup: bool,
}

impl Default for FakeShell {
    fn default() -> Self {
        Self {
            device: BTreeMap::new(),
            synced: BTreeMap::new(),
            synced_works: true,
            synchronizing: true,
            restores_after_setup: true,
        }
    }
}

impl FakeShell {
    /// Perform a batch in order, one answer per op.
    #[must_use]
    pub fn batch(&mut self, batch: &wire::SecretBatch) -> wire::SecretBatched {
        use wire::secret_op::Op;
        let answers = batch
            .ops
            .iter()
            .map(|op| {
                let synced_store = op.store == wire::SecretStore::Synced as i32;
                if synced_store && !self.synced_works {
                    return wire::SecretAnswer::default();
                }
                let store = if synced_store {
                    &mut self.synced
                } else {
                    &mut self.device
                };
                let value = String::from_utf8_lossy(&op.value).into_owned();
                match Op::try_from(op.op) {
                    Ok(Op::Get) => wire::SecretAnswer {
                        ok: true,
                        found: store.contains_key(&op.key),
                        value: store.get(&op.key).cloned().unwrap_or_default().into_bytes(),
                        entries: Vec::new(),
                    },
                    Ok(Op::Set) => {
                        if value.is_empty() {
                            store.remove(&op.key);
                        } else {
                            store.insert(op.key.clone(), value);
                        }
                        wire::SecretAnswer {
                            ok: true,
                            ..Default::default()
                        }
                    }
                    Ok(Op::Delete) => {
                        store.remove(&op.key);
                        wire::SecretAnswer {
                            ok: true,
                            ..Default::default()
                        }
                    }
                    Ok(Op::List) => wire::SecretAnswer {
                        ok: true,
                        entries: store
                            .iter()
                            .filter(|(key, _)| key.starts_with(&op.key))
                            .map(|(key, value)| wire::SecretEntry {
                                key: key.clone(),
                                value: value.clone().into_bytes(),
                            })
                            .collect(),
                        ..Default::default()
                    },
                    _ => wire::SecretAnswer::default(),
                }
            })
            .collect();
        wire::SecretBatched { answers }
    }
}

/// A core plus what a shell would have drawn from it.
pub struct Driver {
    pub handle: Handle,
    /// The latest view of every open instance.
    pub views: BTreeMap<u64, wire::ViewState>,
    pub navigation: Option<wire::Navigation>,
    /// Effects asked and not yet answered, oldest first.
    pub effects: Vec<wire::EffectRequest>,
    /// Instances closed so far, oldest first.
    pub closed: Vec<u64>,
    _dir: std::path::PathBuf,
}

impl Driver {
    /// A founded, seeded vault with `runtime` attached.
    ///
    /// # Panics
    /// When the scratch vault cannot be made; this is test support.
    #[must_use]
    pub fn with_runtime(runtime: Runtime) -> Self {
        Self::opened(runtime, false)
    }

    /// [`Self::with_runtime`] over a core that holds the vault's keys, so a
    /// Locker session can open (the all-`abandon` words' seed).
    ///
    /// # Panics
    /// When the scratch vault cannot be made.
    #[must_use]
    pub fn keyed(runtime: Runtime) -> Self {
        Self::opened(runtime, true)
    }

    /// A core that holds no vault at all: the file is not there and is not
    /// made, as on a phone that has not made one yet. A screen that needs the
    /// vault is refused `Unpaired`.
    ///
    /// # Panics
    /// When the scratch directory cannot be made.
    #[must_use]
    pub fn unfounded(runtime: Runtime) -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        let handle = Core::open(CoreConfig::new(dir.join("vault.db")).opening_existing())
            .expect("a core opens with no vault");
        handle.attach_screens(std::sync::Arc::new(runtime));
        Self {
            handle,
            views: BTreeMap::new(),
            navigation: None,
            effects: Vec::new(),
            closed: Vec::new(),
            _dir: dir,
        }
    }

    fn opened(runtime: Runtime, keyed: bool) -> Self {
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        let config = CoreConfig::new(dir.join("vault.db"));
        let config = if keyed {
            let words = ["abandon"; 23].join(" ") + " art";
            let seed = centraid_identity::RecoveryPhrase::parse(&words)
                .expect("the words parse")
                .seed();
            config.with_seed(seed, 0)
        } else {
            config
        };
        let handle = Core::open(config).expect("a core opens with create");
        handle
            .open_own_bytes(dir.join("vault.bytes"))
            .expect("the byte store opens");
        let found = handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                    display_name: "Sample".to_owned(),
                    owner_name: "Me".to_owned(),
                    content: wire::FoundContent::Unspecified as i32,
                })),
            })
            .expect("the vault founds");
        assert!(matches!(found.kind, Some(wire::response::Kind::Found(_))));
        let report = handle
            .with_vault(|vault| {
                centraid_core::example::seed(
                    vault,
                    handle.registry(),
                    &handle.owner(),
                    &|_| true,
                    centraid_core::example::now_ms(),
                )
            })
            .expect("the scenario seeds");
        assert!(report.is_whole(), "the scenario seeds whole: {report:?}");
        handle.attach_screens(std::sync::Arc::new(runtime));
        Self {
            handle,
            views: BTreeMap::new(),
            navigation: None,
            effects: Vec::new(),
            closed: Vec::new(),
            _dir: dir,
        }
    }

    /// [`Self::with_runtime`] over the standard runtime.
    #[must_use]
    pub fn founded() -> Self {
        Self::with_runtime(crate::standard())
    }

    fn absorb(&mut self, update: wire::ScreenUpdate) -> wire::ScreenUpdate {
        if let Some(navigation) = &update.navigation {
            self.navigation = Some(navigation.clone());
        }
        for view in &update.views {
            self.views.insert(view.instance, view.clone());
        }
        for id in &update.closed {
            self.views.remove(id);
            self.closed.push(*id);
        }
        self.effects.extend(update.effects.iter().cloned());
        update
    }

    /// Send a request as a shell would and apply the update that answers it.
    ///
    /// # Panics
    /// When the core refuses; use [`Self::try_call`] to see a refusal.
    pub fn call(&mut self, kind: wire::screen_request::Kind) -> wire::ScreenUpdate {
        self.try_call(kind).expect("the screen door answers")
    }

    /// # Errors
    /// The core's refusal.
    pub fn try_call(
        &mut self,
        kind: wire::screen_request::Kind,
    ) -> centraid_core::Result<wire::ScreenUpdate> {
        let answer = self.handle.call(&wire::Request {
            kind: Some(wire::request::Kind::Screen(Box::new(wire::ScreenRequest {
                kind: Some(kind),
            }))),
        })?;
        let Some(wire::response::Kind::Screen(response)) = answer.kind else {
            panic!("a screen request answered {:?}", answer.kind);
        };
        Ok(self.absorb(response.update.unwrap_or_default()))
    }

    /// Ask for everything: the first call also opens each tab's root.
    pub fn start(&mut self) -> wire::ScreenUpdate {
        self.call(wire::screen_request::Kind::Snapshot(
            wire::SnapshotRequest {},
        ))
    }

    /// Send `event` to `instance`.
    pub fn send(&mut self, instance: u64, event: wire::screen_event::Kind) -> wire::ScreenUpdate {
        self.call(wire::screen_request::Kind::Send(wire::InstanceEvent {
            instance,
            event: Some(wire::ScreenEvent { kind: Some(event) }),
        }))
    }

    /// Navigate.
    pub fn nav(&mut self, nav: wire::nav_event::Kind) -> wire::ScreenUpdate {
        self.call(wire::screen_request::Kind::Nav(wire::NavEvent {
            kind: Some(nav),
        }))
    }

    /// Push `route` onto `tab` as a tapped row would, and return the instance
    /// it opened.
    ///
    /// # Panics
    /// When the runtime refuses the route.
    pub fn push(&mut self, tab: &str, route: wire::Route) -> u64 {
        let update = self.nav(wire::nav_event::Kind::Push(wire::NavPush {
            tab: tab.to_owned(),
            route: Some(route),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == tab))
            .and_then(|stack| stack.entries.last())
            .map(|entry| entry.instance)
            .expect("a push moves the stack")
    }

    /// A shell's back-swipe: pop `instance` off `tab`.
    pub fn pop(&mut self, tab: &str, instance: u64) -> wire::ScreenUpdate {
        self.nav(wire::nav_event::Kind::Popped(wire::NavPopped {
            tab: tab.to_owned(),
            instance,
        }))
    }

    /// The latest view of `instance`.
    ///
    /// # Panics
    /// When the instance is not open.
    #[must_use]
    pub fn view(&self, instance: u64) -> &wire::ViewState {
        &self.views[&instance]
    }

    /// Write straight to the vault as another surface (chat, an import) would,
    /// so a test can arrange data a screen then reads.
    ///
    /// # Panics
    /// When the core refuses the call itself; a vault refusal is in the answer.
    pub fn act(&self, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
        let answer = self
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Act(Box::new(request.into()))),
            })
            .expect("the act door answers");
        match answer.kind {
            Some(wire::response::Kind::Act(response)) => *response,
            other => panic!("an act answered {other:?}"),
        }
    }

    /// Run `body` with a screen [`Ctx`] over this driver's core and the default
    /// environment: the door a helper (a screen's shared selection, an album
    /// sheet) is tested through when no screen carries its events yet.
    pub fn with_ctx<R>(&self, body: impl FnOnce(&Ctx) -> R) -> R {
        let environment = Environment::default();
        body(&Ctx::new(&self.handle, &environment))
    }

    /// Answer the oldest pending effect.
    ///
    /// # Panics
    /// With no effect pending.
    pub fn answer_effect(&mut self, outcome: wire::effect_result::Outcome) -> wire::ScreenUpdate {
        let request = self.effects.remove(0);
        self.send(
            request.instance,
            wire::screen_event::Kind::EffectResult(wire::EffectResult {
                effect_id: request.effect_id,
                outcome: Some(outcome),
            }),
        )
    }

    /// Answer the effects the vault plumbing speaks the way a shell does,
    /// until none of them is pending: a [`wire::SecretBatch`] against `shell`'s
    /// two stores, a [`wire::CoreCall`] by calling this driver's own core, and a
    /// [`wire::SyncedSecretsProbe`] with `shell`'s reading. Every other effect
    /// stays in [`Self::effects`] for the test to answer. Answering one can
    /// raise the next, so this loops. Returns how many it answered.
    ///
    /// # Panics
    /// When a core call's request does not decode (a screen bug).
    pub fn serve(&mut self, shell: &mut FakeShell) -> usize {
        let mut answered = 0;
        while let Some(at) = self.effects.iter().position(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(
                    wire::effect::Kind::Secrets(_)
                        | wire::effect::Kind::CoreCall(_)
                        | wire::effect::Kind::SyncedProbe(_)
                )
            )
        }) {
            let request = self.effects.remove(at);
            let outcome = match request.effect.and_then(|e| e.kind) {
                Some(wire::effect::Kind::Secrets(batch)) => {
                    wire::effect_result::Outcome::Secrets(shell.batch(&batch))
                }
                Some(wire::effect::Kind::CoreCall(call)) => {
                    wire::effect_result::Outcome::CoreCalled(self.core_call(&call))
                }
                Some(wire::effect::Kind::SyncedProbe(_)) => {
                    wire::effect_result::Outcome::SyncedStatus(wire::SyncedSecretsStatus {
                        synchronizing: shell.synchronizing,
                        restores_after_setup: shell.restores_after_setup,
                    })
                }
                _ => unreachable!("only plumbing effects are picked"),
            };
            self.send(
                request.instance,
                wire::screen_event::Kind::EffectResult(wire::EffectResult {
                    effect_id: request.effect_id,
                    outcome: Some(outcome),
                }),
            );
            answered += 1;
        }
        answered
    }

    /// What a shell's `CoreCall` performer does: decode, call, encode.
    fn core_call(&self, call: &wire::CoreCall) -> wire::CoreCalled {
        let request = wire::Request::decode(call.request.as_slice())
            .expect("a core call carries an encoded Request");
        match self.handle.call(&request) {
            Ok(response) => wire::CoreCalled {
                response: response.encode_to_vec(),
                error: None,
            },
            Err(refusal) => wire::CoreCalled {
                response: Vec::new(),
                error: Some(refusal.to_wire()),
            },
        }
    }

    /// Drain pushed events for up to `wait`, applying every screen update, and
    /// return how many updates arrived. This is the shell's event thread.
    ///
    /// # Panics
    /// When the core's event door fails.
    pub fn pump(&mut self, wait: Duration) -> usize {
        let deadline = std::time::Instant::now() + wait;
        let mut arrived = 0;
        loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            let step = left.min(Duration::from_millis(20));
            match self
                .handle
                .next_event(step)
                .expect("the event door answers")
            {
                Some(wire::Event {
                    kind: Some(wire::event::Kind::Screen(update)),
                }) => {
                    self.absorb(*update);
                    arrived += 1;
                }
                Some(_) => {}
                None if left.is_zero() => return arrived,
                None => {}
            }
        }
    }

    /// The counter view of an instance, for the proof screen's tests.
    ///
    /// # Panics
    /// When the instance is not open or is not a counter.
    #[must_use]
    pub fn counter(&self, instance: u64) -> &wire::CounterView {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::Counter(view)) => view,
            other => panic!("instance {instance} is not a counter: {other:?}"),
        }
    }
}
