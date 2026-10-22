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

use crate::runtime::Runtime;

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
        let dir = centraid_ontology::scratch::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the scratch directory is made");
        let handle =
            Core::open(CoreConfig::new(dir.join("vault.db"))).expect("a core opens with create");
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
