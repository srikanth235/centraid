//! The runtime: route stacks, screen instances, timers and the re-render rule.
//!
//! One [`Runtime`] per core, attached with `Handle::attach_screens`. It holds
//! no reference to the handle between calls; the core hands it a
//! [`ScreenCtx`] each time it is driven (a `Request::Screen`, a change event or
//! a wake — see `centraid_core::screens`).
//!
//! ## The re-render rule
//!
//! Every `load` a screen does records the tables it read. A change event for
//! one of them sends that screen [`wire::DataChanged`], and the screen loads
//! again. A view is pushed only if it differs from the last one sent, so the
//! echo of a screen's own `act` is not a second redraw.
//!
//! ## Timers
//!
//! A timer is a deadline in the runtime and a wake scheduled on the core's
//! tokio runtime. A wake fires every timer that is due; a timer cancelled or
//! owned by a closed screen simply is not there when the wake comes.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::Instant;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Result};
use prost::Message;

use crate::registry::Registry;
use crate::screen::{Ctx, Environment, Screen, TimerOp};
use crate::strings::Locale;

struct Instance {
    route: wire::Route,
    /// A service has no view and no place in any tab (see
    /// [`Runtime::with_services`]).
    service: bool,
    screen: Box<dyn Screen>,
    /// Every table any of this screen's loads read.
    tables: BTreeSet<String>,
    revision: u64,
    /// The last view sent, encoded with `revision` zeroed, to tell a redraw
    /// from an echo.
    last: Vec<u8>,
    view: wire::ViewState,
}

struct Tab {
    id: String,
    stack: Vec<u64>,
}

struct State {
    next_instance: u64,
    next_effect: u64,
    instances: BTreeMap<u64, Instance>,
    tabs: Vec<Tab>,
    selected: String,
    nav_revision: u64,
    timers: BTreeMap<(u64, String), Instant>,
    /// Jobs running off the lock: the instance that asked and the tag it gave.
    jobs: BTreeMap<u64, (u64, String)>,
    next_job: u64,
    env: Environment,
    started: bool,
}

/// The screen runtime.
pub struct Runtime {
    registry: Registry,
    roots: Vec<(String, wire::Route)>,
    services: Vec<wire::Route>,
    state: Mutex<State>,
}

impl Runtime {
    /// A runtime over `registry`, with one root route per tab, in tab order.
    /// The first tab is selected.
    #[must_use]
    pub fn new(registry: Registry, roots: Vec<(String, wire::Route)>) -> Self {
        let selected = roots
            .first()
            .map(|(tab, _)| tab.clone())
            .unwrap_or_default();
        Self {
            registry,
            roots,
            services: Vec::new(),
            state: Mutex::new(State {
                next_instance: 1,
                next_effect: 1,
                instances: BTreeMap::new(),
                tabs: Vec::new(),
                selected,
                nav_revision: 0,
                timers: BTreeMap::new(),
                jobs: BTreeMap::new(),
                next_job: 1,
                env: Environment::default(),
                started: false,
            }),
        }
    }

    /// Screens that run for as long as the runtime does, with no view and no
    /// tab: the pass scheduler, which must hear the app's lifecycle, the
    /// environment and the tables it read whether or not any page is open
    /// (#1135, lane H2). Opened by the first call, before the roots; they hear
    /// every broadcast, are never popped or closed, and a view they return is
    /// ignored. Their effects reach the shell as any screen's do.
    #[must_use]
    pub fn with_services(mut self, services: Vec<wire::Route>) -> Self {
        self.services = services;
        self
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn bad(detail: impl Into<String>) -> CoreError {
        CoreError::InvalidRequest {
            detail: detail.into(),
        }
    }

    fn navigation(state: &State) -> wire::Navigation {
        wire::Navigation {
            selected_tab: state.selected.clone(),
            tabs: state
                .tabs
                .iter()
                .map(|tab| wire::TabStack {
                    tab: tab.id.clone(),
                    entries: tab
                        .stack
                        .iter()
                        .filter_map(|id| {
                            state.instances.get(id).map(|instance| wire::StackEntry {
                                instance: *id,
                                route: Some(instance.route.clone()),
                            })
                        })
                        .collect(),
                })
                .collect(),
            revision: state.nav_revision,
        }
    }

    /// Make a screen for `route`, give it its first event and record it.
    fn open(
        &self,
        state: &mut State,
        core: &dyn ScreenCtx,
        route: wire::Route,
        service: bool,
        out: &mut wire::ScreenUpdate,
    ) -> Result<u64> {
        let screen = self
            .registry
            .build(&route)
            .ok_or_else(|| Self::bad(format!("no screen is registered as `{}`", route.screen)))?;
        let id = state.next_instance;
        state.next_instance += 1;
        state.instances.insert(
            id,
            Instance {
                route,
                service,
                screen,
                tables: BTreeSet::new(),
                revision: 0,
                last: Vec::new(),
                view: wire::ViewState::default(),
            },
        );
        Self::dispatch(
            state,
            core,
            id,
            wire::ScreenEvent {
                kind: Some(wire::screen_event::Kind::Appeared(wire::Appeared {})),
            },
            out,
        );
        Ok(id)
    }

    /// Drop an instance and what it owned.
    fn close(state: &mut State, id: u64, out: &mut wire::ScreenUpdate) {
        if state.instances.remove(&id).is_some() {
            out.closed.push(id);
        }
        state.timers.retain(|(owner, _), _| *owner != id);
        state.jobs.retain(|_, (owner, _)| *owner != id);
    }

    /// Tell a screen it is being popped: its last chance to write what the
    /// member typed. Only the writes it makes survive; the view and any effect
    /// it asks for are dropped with the screen.
    fn leave(state: &mut State, core: &dyn ScreenCtx, id: u64) {
        let mut discarded = wire::ScreenUpdate::default();
        Self::dispatch(
            state,
            core,
            id,
            wire::ScreenEvent {
                kind: Some(wire::screen_event::Kind::Left(wire::Left {})),
            },
            &mut discarded,
        );
    }

    /// Run one event through one screen and collect everything that came of it.
    fn dispatch(
        state: &mut State,
        core: &dyn ScreenCtx,
        id: u64,
        event: wire::ScreenEvent,
        out: &mut wire::ScreenUpdate,
    ) {
        let env = state.env.clone();
        let Some(instance) = state.instances.get_mut(&id) else {
            return;
        };
        let ctx = Ctx::new(core, &env);
        let effects = instance.screen.update(event, &ctx);
        let done = ctx.finish();
        instance.tables.extend(done.tables);

        if !instance.service {
            let view_ctx = Ctx::new(core, &env);
            let mut view = instance.screen.view(&view_ctx);
            view.instance = id;
            view.revision = 0;
            let encoded = view.encode_to_vec();
            if encoded != instance.last {
                instance.revision += 1;
                instance.last = encoded;
            }
            view.revision = instance.revision;
            if view != instance.view {
                instance.view = view.clone();
                out.views.push(view);
            }
        }

        for op in done.timers {
            match op {
                TimerOp::Start(name, after) => {
                    state.timers.insert((id, name), Instant::now() + after);
                    core.wake_after(after);
                }
                TimerOp::Cancel(name) => {
                    state.timers.remove(&(id, name));
                }
            }
        }
        // WHAT THIS SCREEN HANDED TO OTHERS (a picker's pick): delivered now, so one re-render
        // carries both screens' views.
        for (screen, post) in done.posts {
            let targets: Vec<u64> = state
                .instances
                .iter()
                .filter(|(other, instance)| **other != id && instance.route.screen == screen)
                .map(|(other, _)| *other)
                .collect();
            for target in targets {
                Self::dispatch(state, core, target, post.clone(), out);
            }
        }
        for (tag, work) in done.jobs {
            let job = state.next_job;
            state.next_job += 1;
            state.jobs.insert(job, (id, tag));
            core.off_thread(job, work);
        }
        for effect in effects {
            let effect_id = state.next_effect;
            state.next_effect += 1;
            out.effects.push(wire::EffectRequest {
                effect_id,
                instance: id,
                effect: Some(effect),
            });
        }
    }

    /// Open every tab's root, once.
    fn start(
        &self,
        state: &mut State,
        core: &dyn ScreenCtx,
        out: &mut wire::ScreenUpdate,
    ) -> Result<()> {
        if state.started {
            return Ok(());
        }
        state.started = true;
        for route in &self.services {
            self.open(state, core, route.clone(), true, out)?;
        }
        for (tab, route) in &self.roots {
            let id = self.open(state, core, route.clone(), false, out)?;
            state.tabs.push(Tab {
                id: tab.clone(),
                stack: vec![id],
            });
        }
        state.nav_revision += 1;
        Ok(())
    }

    fn navigate(
        &self,
        state: &mut State,
        core: &dyn ScreenCtx,
        nav: &wire::NavEvent,
        out: &mut wire::ScreenUpdate,
    ) -> Result<()> {
        use wire::nav_event::Kind as N;
        let tab_index = |state: &State, tab: &str| {
            state
                .tabs
                .iter()
                .position(|candidate| candidate.id == tab)
                .ok_or_else(|| Self::bad(format!("there is no tab `{tab}`")))
        };
        match nav
            .kind
            .as_ref()
            .ok_or_else(|| Self::bad("an empty navigation event"))?
        {
            N::Push(push) => {
                let index = tab_index(state, &push.tab)?;
                let route = push
                    .route
                    .clone()
                    .ok_or_else(|| Self::bad("a push without a route"))?;
                let id = self.open(state, core, route, false, out)?;
                state.tabs[index].stack.push(id);
                state.selected.clone_from(&push.tab);
            }
            N::Popped(popped) => {
                let index = tab_index(state, &popped.tab)?;
                let stack = &mut state.tabs[index].stack;
                // Never the root: a tab's root is what a pop returns to.
                let Some(at) = stack
                    .iter()
                    .position(|id| *id == popped.instance)
                    .filter(|at| *at > 0)
                else {
                    return Ok(());
                };
                let gone = stack.split_off(at);
                for id in gone {
                    Self::leave(state, core, id);
                    Self::close(state, id, out);
                }
            }
            N::SelectTab(select) => {
                tab_index(state, &select.tab)?;
                state.selected.clone_from(&select.tab);
            }
            N::PopToRoot(pop) => {
                let index = tab_index(state, &pop.tab)?;
                let gone = state.tabs[index].stack.split_off(1);
                for id in gone {
                    Self::leave(state, core, id);
                    Self::close(state, id, out);
                }
            }
        }
        state.nav_revision += 1;
        out.navigation = Some(Self::navigation(state));
        Ok(())
    }

    /// Send `event` to every screen `wants` picks.
    fn broadcast(
        state: &mut State,
        core: &dyn ScreenCtx,
        wants: impl Fn(&Instance) -> Option<wire::ScreenEvent>,
        out: &mut wire::ScreenUpdate,
    ) {
        let work: Vec<(u64, wire::ScreenEvent)> = state
            .instances
            .iter()
            .filter_map(|(id, instance)| wants(instance).map(|event| (*id, event)))
            .collect();
        for (id, event) in work {
            Self::dispatch(state, core, id, event, out);
        }
    }

    fn empty(update: &wire::ScreenUpdate) -> bool {
        update.navigation.is_none()
            && update.views.is_empty()
            && update.effects.is_empty()
            && update.closed.is_empty()
    }
}

impl ScreenHost for Runtime {
    fn call(
        &self,
        core: &dyn ScreenCtx,
        request: &wire::ScreenRequest,
    ) -> Result<wire::ScreenResponse> {
        use wire::screen_request::Kind as K;
        let mut state = self.lock();
        let mut out = wire::ScreenUpdate::default();
        self.start(&mut state, core, &mut out)?;
        match request
            .kind
            .as_ref()
            .ok_or_else(|| Self::bad("an empty screen request"))?
        {
            K::Nav(nav) => self.navigate(&mut state, core, nav, &mut out)?,
            K::Send(send) => {
                let event = send
                    .event
                    .clone()
                    .ok_or_else(|| Self::bad("an instance event without an event"))?;
                if !state.instances.contains_key(&send.instance) {
                    return Err(Self::bad(format!(
                        "screen instance {} is not open",
                        send.instance
                    )));
                }
                Self::dispatch(&mut state, core, send.instance, event, &mut out);
            }
            K::Snapshot(_) => {
                out.navigation = Some(Self::navigation(&state));
                out.views = state
                    .instances
                    .values()
                    .filter(|i| !i.service)
                    .map(|i| i.view.clone())
                    .collect();
            }
            K::Environment(environment) => {
                state.env = Environment {
                    locale: Locale::from_tag(&environment.locale),
                    zone: if environment.zone.is_empty() {
                        "UTC".to_owned()
                    } else {
                        environment.zone.clone()
                    },
                    region: region_of(&environment.locale),
                    platform: environment.platform.clone(),
                };
                Self::broadcast(
                    &mut state,
                    core,
                    |_| {
                        Some(wire::ScreenEvent {
                            kind: Some(wire::screen_event::Kind::EnvironmentChanged(
                                wire::EnvironmentChanged {},
                            )),
                        })
                    },
                    &mut out,
                );
            }
            // THE APP LEFT OR CAME BACK: every open screen hears it (a Locker
            // relocks the instant it leaves the foreground).
            K::Lifecycle(lifecycle) => {
                let lifecycle = *lifecycle;
                Self::broadcast(
                    &mut state,
                    core,
                    |_| {
                        Some(wire::ScreenEvent {
                            kind: Some(wire::screen_event::Kind::Lifecycle(lifecycle)),
                        })
                    },
                    &mut out,
                );
            }
        }
        // The first call also carries the opened roots, so a snapshot is not a
        // second round trip: `start` filled `out` already.
        if out.navigation.is_none() && !out.views.is_empty() && state.nav_revision == 1 {
            out.navigation = Some(Self::navigation(&state));
        }
        Ok(wire::ScreenResponse { update: Some(out) })
    }

    fn changed(&self, core: &dyn ScreenCtx, tables: &[String]) {
        let mut state = self.lock();
        let mut out = wire::ScreenUpdate::default();
        Self::broadcast(
            &mut state,
            core,
            |instance| {
                let hit: Vec<String> = tables
                    .iter()
                    .filter(|table| instance.tables.contains(*table))
                    .cloned()
                    .collect();
                (!hit.is_empty()).then_some(wire::ScreenEvent {
                    kind: Some(wire::screen_event::Kind::DataChanged(wire::DataChanged {
                        tables: hit,
                    })),
                })
            },
            &mut out,
        );
        if !Self::empty(&out) {
            core.push(out);
        }
    }

    fn assist(&self, core: &dyn ScreenCtx, event: &wire::AssistEvent) {
        let mut state = self.lock();
        let mut out = wire::ScreenUpdate::default();
        let ids: Vec<u64> = state
            .instances
            .iter()
            .filter(|(_, instance)| instance.screen.hears_assist())
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            Self::dispatch(
                &mut state,
                core,
                id,
                wire::ScreenEvent {
                    kind: Some(wire::screen_event::Kind::Assist(event.clone())),
                },
                &mut out,
            );
        }
        if !Self::empty(&out) {
            core.push(out);
        }
    }

    fn job_done(&self, core: &dyn ScreenCtx, job: u64, bytes: Vec<u8>) {
        let mut state = self.lock();
        let Some((id, tag)) = state.jobs.remove(&job) else {
            return;
        };
        let mut out = wire::ScreenUpdate::default();
        Self::dispatch(
            &mut state,
            core,
            id,
            wire::ScreenEvent {
                kind: Some(wire::screen_event::Kind::OffThreadDone(
                    wire::OffThreadDone { tag, bytes },
                )),
            },
            &mut out,
        );
        if !Self::empty(&out) {
            core.push(out);
        }
    }

    fn wake(&self, core: &dyn ScreenCtx) {
        let mut state = self.lock();
        let now = Instant::now();
        let due: Vec<(u64, String)> = state
            .timers
            .iter()
            .filter(|(_, deadline)| **deadline <= now)
            .map(|(key, _)| key.clone())
            .collect();
        let mut out = wire::ScreenUpdate::default();
        for (id, name) in due {
            state.timers.remove(&(id, name.clone()));
            Self::dispatch(
                &mut state,
                core,
                id,
                wire::ScreenEvent {
                    kind: Some(wire::screen_event::Kind::TimerFired(wire::TimerFired {
                        timer: name,
                    })),
                },
                &mut out,
            );
        }
        if !Self::empty(&out) {
            core.push(out);
        }
    }
}

/// The region of a BCP 47 or POSIX locale tag (`en-US`, `en_US`, `zh-Hant-TW`):
/// its first two-letter alphabetic part after the language, upper-cased.
fn region_of(tag: &str) -> String {
    tag.split(['-', '_'])
        .skip(1)
        .find(|part| part.len() == 2 && part.chars().all(|c| c.is_ascii_alphabetic()))
        .map(str::to_ascii_uppercase)
        .unwrap_or_default()
}

#[cfg(test)]
mod region_tests {
    use super::region_of;

    #[test]
    fn a_region_is_the_two_letters_after_the_language() {
        assert_eq!(region_of("en-US"), "US");
        assert_eq!(region_of("en_us"), "US");
        assert_eq!(region_of("zh-Hant-TW"), "TW");
        assert_eq!(region_of("en"), "");
        assert_eq!(region_of(""), "");
    }
}
