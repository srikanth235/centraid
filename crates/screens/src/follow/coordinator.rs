//! THE COORDINATOR: one service that knows when a phone store may have changed, for all four
//! stores (#1183), and runs the pass for the ones the member connected.
//!
//! It is a service ([`crate::Runtime::with_services`]), not a part of any home screen: a pass
//! runs whichever screen is showing, or none. Every trigger carries no data, and a missed or
//! doubled one is harmless because a pass is a merge the vault answers for.
//!
//! | Trigger | How it arrives |
//! |---|---|
//! | the app came to the foreground | `Lifecycle`, which the runtime tells every service: every store |
//! | the OS says a store changed | `PhoneChanged`, answering the `PhoneWatch` this service asks for contacts, calendar and reminders |
//! | a screen asked | [`Follows::changed`], woken by `Signalled`: a home appearing or pulled, an import that turned a store on |
//! | a background window | [`Follows::window`], from the pass service once the camera roll and the backup ended |
//!
//! ## One machine, one pass at a time
//!
//! A [`FollowGate`] over [`Store`] folds a burst (the first trigger arms a settle timer, the
//! ones that follow join it), keeps one pass per store running and one queued behind it. The
//! stores that read through this service (contacts, calendar, health) take turns, and the pass
//! that is out knows the number the runtime gave its one effect ([`Screen::effects_numbered`]): an answer
//! that names another number is the late answer of a pass given up on ([`READ_TIMEOUT`]), and is
//! ignored. The folder follower is a screen of its own and is woken by name, and tells this
//! service when its pass ended.
//!
//! ## What a pass is
//!
//! It reads the keychain habit that says this device imported or connected (files: the vault
//! holds a folder origin), and ends there when it did not. Otherwise it asks the shell for a
//! read that **never asks the OS for a permission**, and hands the answer to the store's own
//! follower ([`crate::people::contacts::run`], [`crate::calendar::follow::run`],
//! [`crate::health::follow::run`], `imports.files`), which tells the vault what it read. A read
//! that failed changes nothing; the vault deletes nothing on an incomplete one.
//!
//! ## A background window
//!
//! The pass service asks for the stores once its own work for the window has ended, and holds
//! the OS's answer until this service says every store ran once ([`Follows::release`]): the
//! work is bounded by the number of stores, and the OS's own expiry is the only clock. A read
//! that never answers is abandoned after [`READ_TIMEOUT`] so one stuck read cannot hold the
//! others for good, and a window is given up on after the same bound. Neither shell is hurt by a
//! bound longer than its window: iOS's expiration handler and Android's cancellation end the task
//! themselves, once, and report `Expired`, which makes the pass service forget the window, so the
//! release that comes after finds nobody waiting and sends no `PassWindowDone`; and a late one
//! would be a no-op in both shells (no waiter is left under the name).

use std::collections::{BTreeSet, VecDeque};
use std::time::{Duration, Instant};

use centraid_api_proto::core_v1 as wire;
use wire::effect_result::Outcome as O;
use wire::screen_event::Kind as E;

use super::Store;
use super::gate::{FollowGate, Step};
use crate::calendar::follow as calendar;
use crate::health::follow as health;
use crate::imports::reminders;
use crate::people::contacts;
use crate::screen::{Ctx, Screen};

/// The route name of the coordinator.
pub const NAME: &str = "follow.coordinator";

/// A read that has not answered in two minutes is abandoned, so one stuck read cannot hold the
/// follow for good. A safety bound, not a cadence.
pub const READ_TIMEOUT: Duration = Duration::from_secs(120);
/// The timer that abandons a read that never answered.
pub const READ_TIMER: &str = "follow-read";
/// The timer that gives up on a background window's follows.
pub const WINDOW_TIMER: &str = "follow-window";
const SETTLE_PREFIX: &str = "follow-settle:";

/// The route that opens the service.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: NAME.to_owned(),
        args: None,
    }
}

/// The coordinator's registry entry.
#[must_use]
pub fn registry() -> crate::Registry {
    crate::Registry::default().with(NAME, |_| Some(Box::new(Coordinator::new())))
}

/// What a pass that is out is waiting for.
enum Stage {
    /// The keychain's answer to "did this device import or connect?".
    Habit,
    /// The store's read.
    Read(Read),
}

enum Read {
    Contacts,
    Calendar,
    Reminders,
    Health {
        window: health::Window,
        chosen: Vec<String>,
    },
}

struct Active {
    store: Store,
    stage: Stage,
    /// The number the runtime gave the effect this pass waits on; every other answer is not its.
    effect: Option<u64>,
}

struct Coordinator {
    epoch: Instant,
    gate: FollowGate<Store>,
    started: bool,
    /// The last lifecycle the shell reported: a repeat is not a transition.
    foreground: Option<bool>,
    /// Stores the gate started, waiting for their turn.
    ready: VecDeque<Store>,
    /// The pass this service reads for, if one is out.
    active: Option<Active>,
    /// Where, in the effects the last update asked for, the one the pass waits on stands; the
    /// runtime says its number next ([`Screen::effects_numbered`]).
    asking: Option<usize>,
    /// The folder follower was asked to run and has not said it ended.
    files_running: bool,
    /// Background windows whose follows are owed, and the stores they wait on.
    windows: Vec<String>,
    pending: BTreeSet<Store>,
}

impl Coordinator {
    fn new() -> Self {
        Self {
            epoch: Instant::now(),
            gate: FollowGate::default(),
            started: false,
            foreground: None,
            ready: VecDeque::new(),
            active: None,
            asking: None,
            files_running: false,
            windows: Vec::new(),
            pending: BTreeSet::new(),
        }
    }

    fn now(&self) -> Duration {
        self.epoch.elapsed()
    }

    /// The store may have changed: follow soon.
    fn request(&mut self, ctx: &Ctx, store: Store) {
        if let Step::Arm(after) = self.gate.request(&store, self.now()) {
            ctx.start_timer(&format!("{SETTLE_PREFIX}{}", store.key()), after);
        }
    }

    /// The store is wanted now, with no burst to fold (a background window).
    fn request_now(&mut self, store: Store) {
        if self.gate.request_now(&store) == Step::Start {
            self.ready.push_back(store);
        }
    }

    /// A pass ended, however it ended: the one queued behind it, if a trigger came during it,
    /// goes next.
    fn end(&mut self, ctx: &Ctx, store: Store) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.store == store)
        {
            self.active = None;
            ctx.cancel_timer(READ_TIMER);
        }
        if self.gate.finish(&store) == Step::Start {
            self.ready.push_back(store);
        }
    }

    fn start(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        if self.started {
            return;
        }
        self.started = true;
        ctx.follows().listen();
        // The OS announces changes of these two while the app runs. Watching asks for no
        // permission; whether a change is followed is the habit's word at the pass.
        for source in [
            wire::ImportSource::Contacts,
            wire::ImportSource::Calendar,
            wire::ImportSource::Reminders,
        ] {
            out.push(wire::Effect {
                kind: Some(wire::effect::Kind::PhoneWatch(wire::PhoneWatch {
                    source: source as i32,
                    on: true,
                })),
            });
        }
    }

    fn signalled(&mut self, ctx: &Ctx) {
        let follows = ctx.follows();
        for store in follows.take_changed() {
            self.request(ctx, store);
        }
        if follows.take_files_ended() && self.files_running {
            self.files_running = false;
            self.end(ctx, Store::Files);
            if let Some(screen) = Store::Files.shown_by() {
                ctx.post(
                    screen,
                    wire::ScreenEvent {
                        kind: Some(E::Signalled(wire::Signalled {})),
                    },
                );
            }
        }
        for window in follows.take_windows() {
            ctx.start_timer(WINDOW_TIMER, READ_TIMEOUT);
            self.windows.push(window);
            for store in Store::ALL {
                self.pending.insert(store);
                self.request_now(store);
            }
        }
    }

    /// Run the passes whose turn it is, then answer the windows whose stores all ran.
    fn pump(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        loop {
            let Some(store) = self.ready.front().copied() else {
                break;
            };
            if store != Store::Files && self.active.is_some() {
                break;
            }
            self.ready.pop_front();
            self.begin(ctx, store, out);
        }
        if !self.windows.is_empty() && self.pending.iter().all(|store| self.gate.idle(store)) {
            self.release(ctx);
        }
    }

    /// Tell the pass service the windows' follows are over.
    fn release(&mut self, ctx: &Ctx) {
        ctx.cancel_timer(WINDOW_TIMER);
        for window in self.windows.drain(..) {
            ctx.follows().release(ctx, &window);
        }
        self.pending.clear();
    }

    fn begin(&mut self, ctx: &Ctx, store: Store, out: &mut Vec<wire::Effect>) {
        let habit = match store {
            Store::Contacts => contacts::habit_read(),
            Store::Calendar => calendar::habit_read(),
            Store::Health => health::habit_read(),
            Store::Reminders => reminders::habit_read(),
            Store::Files => {
                // The folder follower is a screen of its own: wake it by name. It checks the
                // vault for a followed folder, and tells the coordinator when it ended.
                self.files_running = true;
                ctx.follows().run_files(ctx);
                return;
            }
        };
        ctx.start_timer(READ_TIMER, READ_TIMEOUT);
        self.active = Some(Active {
            store,
            stage: Stage::Habit,
            effect: None,
        });
        self.asking = Some(out.len());
        out.push(habit);
    }

    /// The keychain answered whether this device imported or connected.
    fn habit(
        &mut self,
        ctx: &Ctx,
        store: Store,
        value: &wire::KeychainValue,
        out: &mut Vec<wire::Effect>,
    ) {
        let (read, effect) = match store {
            Store::Contacts if contacts::followed_in(value) => {
                (Read::Contacts, contacts::read_effect(false))
            }
            Store::Calendar if calendar::followed_in(value) => {
                (Read::Calendar, calendar::read_effect(false))
            }
            Store::Reminders if reminders::followed_in(value) => {
                (Read::Reminders, reminders::read_effect())
            }
            Store::Health => {
                let device = health::device_of(value);
                let window = device.connected.then(|| health::window(ctx)).flatten();
                let Some(window) = window else {
                    return self.end_taken(ctx, store);
                };
                // WHERE THE LAST READ GOT TO is in the vault, for the install that wrote it (#1183).
                let cursor = health::held_cursor(ctx, &device.install);
                let effect = health::read_effect(&window, &device.chosen, false, &cursor);
                (
                    Read::Health {
                        window,
                        chosen: device.chosen,
                    },
                    effect,
                )
            }
            _ => return self.end_taken(ctx, store),
        };
        self.active = Some(Active {
            store,
            stage: Stage::Read(read),
            effect: None,
        });
        self.asking = Some(out.len());
        out.push(effect);
    }

    /// A read came back (or failed): tell the follower, and the pass is over.
    fn read(&mut self, ctx: &Ctx, store: Store, read: Read, outcome: O) {
        let follows = ctx.follows();
        match (read, outcome) {
            (Read::Contacts, O::Contacts(snapshot)) => {
                let (outcome, _) = contacts::run(ctx, &snapshot);
                follows.read(Store::Contacts, outcome.read);
            }
            (Read::Calendar, O::Calendar(snapshot)) => {
                let _ = calendar::run(ctx, &snapshot);
                follows.denied(Store::Calendar, false);
            }
            (Read::Reminders, O::RemindersSnapshot(snapshot)) => {
                let outcome = reminders::run(ctx, &snapshot.reminders, true);
                follows.read(Store::Reminders, outcome.read);
            }
            (Read::Health { window, chosen }, O::Health(snapshot)) => {
                follows.refused(Store::Health, &snapshot.refused);
                let _ = health::run(ctx, &snapshot, &window, &chosen, &snapshot.device_id);
                follows.denied(Store::Health, false);
            }
            // A refusal or a shell that cannot read: nothing was read, so nothing changes.
            (_, O::Failed(failed)) => {
                follows.denied(store, crate::kit::permission::State::of(&failed).is_some())
            }
            _ => {}
        }
        // The screen that draws what the pass found draws again (a wake: its data did not move).
        if let Some(screen) = store.shown_by() {
            ctx.post(
                screen,
                wire::ScreenEvent {
                    kind: Some(E::Signalled(wire::Signalled {})),
                },
            );
        }
        self.end_taken(ctx, store);
    }

    fn result(&mut self, ctx: &Ctx, result: wire::EffectResult, out: &mut Vec<wire::Effect>) {
        let Some(outcome) = result.outcome else {
            return;
        };
        // THE STORE CHANGED, under the watch's one effect id.
        if let O::PhoneChanged(changed) = &outcome {
            match wire::ImportSource::try_from(changed.source) {
                Ok(wire::ImportSource::Contacts) => self.request(ctx, Store::Contacts),
                Ok(wire::ImportSource::Calendar) => self.request(ctx, Store::Calendar),
                Ok(wire::ImportSource::Reminders) => self.request(ctx, Store::Reminders),
                _ => {}
            }
            return;
        }
        // Only the answer to the effect the pass waits on is its answer: one that names another
        // is the late word of a pass that was given up on, and says nothing of this store.
        if self
            .active
            .as_ref()
            .is_none_or(|active| active.effect != Some(result.effect_id))
        {
            return;
        }
        let Some(Active { store, stage, .. }) = self.active.take() else {
            return;
        };
        match (stage, outcome) {
            (Stage::Habit, O::Keychain(value)) => self.habit(ctx, store, &value, out),
            (Stage::Habit, O::Failed(_)) => self.end_taken(ctx, store),
            (
                Stage::Read(read),
                outcome @ (O::Contacts(_)
                | O::Calendar(_)
                | O::Health(_)
                | O::RemindersSnapshot(_)
                | O::Failed(_)),
            ) => {
                self.read(ctx, store, read, outcome);
            }
            // Not the kind of answer the effect asked for: the pass goes on waiting.
            (stage, _) => {
                self.active = Some(Active {
                    store,
                    stage,
                    effect: Some(result.effect_id),
                });
            }
        }
    }

    /// End a pass whose `active` was already taken.
    fn end_taken(&mut self, ctx: &Ctx, store: Store) {
        ctx.cancel_timer(READ_TIMER);
        if self.gate.finish(&store) == Step::Start {
            self.ready.push_back(store);
        }
    }
}

impl Screen for Coordinator {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut out = Vec::new();
        let Some(kind) = event.kind else {
            return out;
        };
        self.start(ctx, &mut out);
        match kind {
            // THE APP CAME FORWARD: every store may have changed while it was away. A repeat of
            // the same lifecycle is not a transition.
            E::Lifecycle(wire::AppLifecycle { foreground }) => {
                if self.foreground.replace(foreground) != Some(foreground) && foreground {
                    for store in Store::ALL {
                        self.request(ctx, store);
                    }
                }
            }
            E::Signalled(_) => self.signalled(ctx),
            // A window's follows that never ended are given up on: the OS is told, and the
            // stores follow at the next trigger.
            E::TimerFired(fired) if fired.timer == WINDOW_TIMER => self.release(ctx),
            E::TimerFired(fired) if fired.timer == READ_TIMER => {
                if let Some(store) = self.active.as_ref().map(|active| active.store) {
                    self.end(ctx, store);
                }
            }
            E::TimerFired(fired) => {
                let store = fired
                    .timer
                    .strip_prefix(SETTLE_PREFIX)
                    .and_then(Store::of_key);
                if let Some(store) = store
                    && self.gate.fire(&store, self.now()) == Step::Start
                {
                    self.ready.push_back(store);
                }
            }
            E::EffectResult(result) => self.result(ctx, result, &mut out),
            _ => {}
        }
        self.pump(ctx, &mut out);
        out
    }

    fn effects_numbered(&mut self, ids: &[Option<u64>]) {
        if let Some(index) = self.asking.take()
            && let Some(active) = self.active.as_mut()
        {
            active.effect = ids.get(index).copied().flatten();
        }
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}
