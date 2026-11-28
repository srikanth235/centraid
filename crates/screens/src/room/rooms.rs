//! THE ROOM RUNTIME (app-plane §1, §6): one stack of room instances per tab. Rust keeps each
//! instance's kept state, builds its room, routes each `RoomEvent` through the handler map,
//! saves a room's place when another is pushed over it and restores it on pop, and reloads the
//! rooms whose read context a commit reaches.

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::read::ReadContext;
use wire::room_event::Kind as E;

use super::door::Door;
use super::screen::{Build, Event, Input, Nav, Outcome, Registry, RoomScreen, Status};
use super::selector::{Handler, HandlerMap, RoomError};
use super::ui::{Place, Scroll, Ui};

/// How the shell should move to the room it is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Move {
    Replace,
    Push,
    Pop,
    Reload,
}

/// The room on top of a tab, as the shell draws it.
#[derive(Debug, Clone)]
pub struct Shown {
    pub tab: String,
    pub instance: u64,
    pub depth: u32,
    pub movement: Move,
    pub room: wire::Room,
}

impl Shown {
    #[must_use]
    pub fn wire(&self) -> wire::RoomShown {
        wire::RoomShown {
            instance: self.instance,
            depth: self.depth,
            transition: match self.movement {
                Move::Replace => wire::RoomTransition::Replace,
                Move::Push => wire::RoomTransition::Push,
                Move::Pop => wire::RoomTransition::Pop,
                Move::Reload => wire::RoomTransition::Reload,
            } as i32,
            room: Some(self.room.clone()),
            tab: self.tab.clone(),
            secure_epoch: 0,
        }
    }
}

/// What the runtime refuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// No room is registered under this key.
    NoRoom(String),
    /// The instance is not an open room.
    NoInstance(u64),
    /// A room built a selector twice, or named an action the catalogue lacks.
    Room(RoomError),
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoRoom(key) => write!(f, "no room is registered as `{key}`"),
            Self::NoInstance(id) => write!(f, "room instance {id} is not open"),
            Self::Room(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for Refusal {}

impl From<RoomError> for Refusal {
    fn from(error: RoomError) -> Self {
        Self::Room(error)
    }
}

const SEARCH_FIELD: &str = "search";

struct Entry {
    id: u64,
    depth: usize,
    hue_key: String,
    screen: Box<dyn RoomScreen>,
    ui: Ui,
    handlers: HandlerMap,
    reads: ReadContext,
    watched: std::collections::BTreeSet<&'static str>,
    covered: Option<Place>,
    restore: Option<Place>,
    status: Option<Status>,
    last: Option<wire::Room>,
    pending: BTreeMap<u64, String>,
    outbox: Vec<wire::ShellEffect>,
    asked: u64,
}

pub struct Rooms {
    registry: Registry,
    stacks: BTreeMap<String, Vec<Entry>>,
    next: u64,
}

/// What the rest of an event leaves to do after a handler ran.
enum Then {
    Rebuild,
    Nothing,
    Go(Nav),
}

impl Rooms {
    #[must_use]
    pub fn new(registry: Registry) -> Self {
        Self {
            registry,
            stacks: BTreeMap::new(),
            next: 1,
        }
    }

    /// Open the room `key` on `tab`: it is pushed over the tab's top room, or, with `root`, it
    /// replaces the whole stack.
    ///
    /// # Errors
    /// No room under the key, or a room that cannot be built.
    pub fn open(
        &mut self,
        door: &dyn Door,
        key: &str,
        tab: &str,
        root: bool,
    ) -> Result<Shown, Refusal> {
        self.open_with_question(door, key, tab, root, None)
    }

    fn open_with_question(
        &mut self,
        door: &dyn Door,
        key: &str,
        tab: &str,
        root: bool,
        question: Option<&str>,
    ) -> Result<Shown, Refusal> {
        let key = if key.starts_with("locker/") && !door.locker_unlocked() {
            super::locker::LOCKER
        } else {
            key
        };
        let screen = self
            .registry
            .make(key)
            .ok_or_else(|| Refusal::NoRoom(key.to_owned()))?;
        let held = self.stacks.get(tab).map_or(0, Vec::len);
        let replace = root || held == 0;
        let inherited_hue = (!replace)
            .then(|| self.stacks.get(tab).and_then(|stack| stack.last()))
            .flatten()
            .map(|entry| entry.hue_key.as_str())
            .unwrap_or_default();
        let hue_key = hue_key_for_room(key, inherited_hue);
        let id = self.next;
        let mut ui = Ui::default();
        if let Some(question) = question {
            ui.set_term(question);
        }
        let mut entry = Entry {
            id,
            depth: if replace { 1 } else { held + 1 },
            hue_key,
            screen,
            ui,
            handlers: HandlerMap::default(),
            reads: ReadContext::new(),
            watched: std::collections::BTreeSet::new(),
            covered: None,
            restore: None,
            status: None,
            last: None,
            pending: BTreeMap::new(),
            outbox: Vec::new(),
            asked: 0,
        };
        rebuild(&mut entry, door)?;
        self.next += 1;
        if !replace
            && !key.starts_with("locker")
            && let Some(stack) = self.stacks.get_mut(tab)
        {
            for old in stack {
                let cancel = cancel_locker_prompt(old);
                old.outbox.extend(cancel);
            }
        }
        let stack = self.stacks.entry(tab.to_owned()).or_default();
        let movement = if replace {
            let locker_checks = stack
                .iter()
                .flat_map(|old| old.pending.values())
                .filter(|tag| tag.as_str() == "locker:unlock")
                .count();
            for entry in stack.iter() {
                for tag in entry.pending.values() {
                    super::export::cleanup_pending(door, tag);
                }
            }
            for _ in 0..locker_checks {
                entry.asked += 1;
                let effect_id = (entry.id << 32) | entry.asked;
                entry.outbox.push(wire::ShellEffect {
                    effect_id,
                    kind: Some(wire::shell_effect::Kind::OwnerCheck(
                        wire::ShellOwnerCheck {
                            cancel: true,
                            ..wire::ShellOwnerCheck::default()
                        },
                    )),
                });
            }
            stack.clear();
            Move::Replace
        } else {
            if let Some(top) = stack.last_mut() {
                top.covered = Some(top.ui.place());
            }
            Move::Push
        };
        stack.push(entry);
        Ok(self.shown(tab, movement))
    }

    fn shown(&self, tab: &str, movement: Move) -> Shown {
        let stack = &self.stacks[tab];
        let top = stack.last().expect("a shown tab has a room");
        Shown {
            tab: tab.to_owned(),
            instance: top.id,
            depth: u32::try_from(stack.len()).unwrap_or(u32::MAX),
            movement,
            room: top.last.clone().unwrap_or_default(),
        }
    }

    /// The effects the rooms asked for since the last call, in order.
    pub fn take_effects(&mut self) -> Vec<wire::ShellEffect> {
        self.stacks
            .values_mut()
            .flatten()
            .flat_map(|entry| std::mem::take(&mut entry.outbox))
            .collect()
    }

    /// Drop every room instance before another vault is allowed to render through this runtime.
    ///
    /// This intentionally does not call room close actions: entries belong to the outgoing
    /// vault, while `door` already points at the incoming one. Pending exports are only removed
    /// through the core's generated-path cleanup, which checks the owning awake vault.
    pub fn reset_for_vault(&mut self, door: &dyn Door, old_vault_id: &str) -> Vec<Shown> {
        let tabs: Vec<String> = if self.stacks.is_empty() {
            vec![super::host::DEFAULT_TAB.to_owned()]
        } else {
            self.stacks.keys().cloned().collect()
        };
        let pending_owner_checks = self
            .stacks
            .values()
            .flatten()
            .flat_map(|entry| entry.pending.iter())
            .filter(|(_, tag)| tag.as_str() == "locker:unlock")
            .count();

        for entry in self.stacks.values().flatten() {
            for tag in entry.pending.values() {
                super::export::cleanup_pending(door, tag);
            }
        }
        self.stacks.clear();

        let mut shown = Vec::with_capacity(tabs.len());
        for tab in tabs {
            shown.push(
                self.open(door, "home", &tab, true)
                    .expect("Home is registered"),
            );
        }

        let Some(tab) = shown.first().map(|room| room.tab.as_str()) else {
            return shown;
        };
        let entry = self
            .stacks
            .get_mut(tab)
            .and_then(|stack| stack.last_mut())
            .expect("reset created a Home entry");
        for _ in 0..pending_owner_checks {
            queue_boundary_effect(
                entry,
                wire::shell_effect::Kind::OwnerCheck(wire::ShellOwnerCheck {
                    cancel: true,
                    ..Default::default()
                }),
            );
        }
        if !old_vault_id.is_empty() {
            queue_boundary_effect(
                entry,
                wire::shell_effect::Kind::ClipboardCopy(wire::ShellClipboardCopy {
                    owner_vault_id: old_vault_id.to_owned(),
                    clear_owned: true,
                    ..Default::default()
                }),
            );
        }
        shown
    }

    /// The depth of a tab's stack.
    #[must_use]
    pub fn depth(&self, tab: &str) -> usize {
        self.stacks.get(tab).map_or(0, Vec::len)
    }

    /// The room now on top of `tab`.
    #[must_use]
    pub fn top(&self, tab: &str) -> Option<Shown> {
        self.stacks
            .get(tab)
            .is_some_and(|stack| !stack.is_empty())
            .then(|| self.shown(tab, Move::Reload))
    }

    fn locate(&self, instance: u64) -> Result<(String, usize), Refusal> {
        self.stacks
            .iter()
            .find_map(|(tab, stack)| {
                stack
                    .iter()
                    .position(|entry| entry.id == instance)
                    .map(|at| (tab.clone(), at))
            })
            .ok_or(Refusal::NoInstance(instance))
    }

    /// One event from the shell. `None` when nothing the shell draws changed (a scroll report, a
    /// stale selector, an edit the field already holds).
    ///
    /// # Errors
    /// An instance that is not open, or a room that cannot be built.
    pub fn event(
        &mut self,
        door: &dyn Door,
        instance: u64,
        event: &wire::RoomEvent,
    ) -> Result<Option<Shown>, Refusal> {
        let (tab, at) = match self.locate(instance) {
            Ok(located) => located,
            Err(Refusal::NoInstance(_)) if matches!(&event.kind, Some(E::EffectResult(_))) => {
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        let top = self.stacks[&tab].len() - 1;
        if at != top {
            return Ok(None);
        }
        let then = {
            let entry = &mut self.stacks.get_mut(&tab).expect("located")[at];
            handle(entry, event, door)
        };
        match then {
            Then::Nothing => Ok(None),
            Then::Rebuild => {
                let entry = &mut self.stacks.get_mut(&tab).expect("located")[at];
                rebuild(entry, door)?;
                Ok(Some(self.shown(&tab, Move::Reload)))
            }
            Then::Go(Nav::Stay) => Ok(None),
            Then::Go(nav) => self.navigate(door, &tab, at, nav).map(Some),
        }
    }

    fn navigate(
        &mut self,
        door: &dyn Door,
        tab: &str,
        from: usize,
        nav: Nav,
    ) -> Result<Shown, Refusal> {
        // A handler can ask for an effect and navigation in the same outcome (Locker Lock clears
        // its owned clipboard copy while replacing the stack with the wall). Carry those effects
        // onto the room the shell will actually show; the source entry may be dropped by Replace
        // or Pop before `take_effects` runs.
        let effects = self
            .stacks
            .get_mut(tab)
            .and_then(|stack| stack.get_mut(from))
            .map(|entry| std::mem::take(&mut entry.outbox))
            .unwrap_or_default();
        let shown = match nav {
            Nav::Push(key) => self.open(door, &key, tab, false)?,
            Nav::Ask(question) => {
                self.open_with_question(door, super::chat::CHAT, tab, false, Some(&question))?
            }
            Nav::Replace(key) => self.open(door, &key, tab, true)?,
            Nav::Pop => self.pop(door, tab)?,
            Nav::Stay => self
                .top(tab)
                .ok_or_else(|| Refusal::NoRoom("the active tab has no room".to_owned()))?,
        };
        if !effects.is_empty()
            && let Some(entry) = self
                .stacks
                .get_mut(tab)
                .and_then(|stack| stack.iter_mut().find(|entry| entry.id == shown.instance))
        {
            entry.outbox.extend(effects);
        }
        Ok(shown)
    }

    fn pop(&mut self, door: &dyn Door, tab: &str) -> Result<Shown, Refusal> {
        let stack = self.stacks.get_mut(tab).expect("popped tab exists");
        if stack.len() > 1 {
            let leaving_locker = stack.last().is_some_and(|entry| {
                entry.screen.key().starts_with("locker")
                    && !stack[stack.len() - 2].screen.key().starts_with("locker")
            });
            let cancel = if leaving_locker {
                stack
                    .last_mut()
                    .map(cancel_locker_prompt)
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            if let Some(entry) = stack.last() {
                for tag in entry.pending.values() {
                    super::export::cleanup_pending(door, tag);
                }
            }
            let popped = stack.pop();
            let popped_status = popped.as_ref().and_then(|entry| entry.status.clone());
            if let Some(entry) = stack.last_mut() {
                if popped_status.is_some() {
                    entry.status = popped_status;
                }
                entry.restore = entry.covered.take();
                if let Some(place) = entry.restore.clone() {
                    entry.ui.restore(&place);
                }
                entry.outbox.extend(cancel);
                rebuild(entry, door)?;
            }
            return Ok(self.shown(tab, Move::Pop));
        }
        Ok(self.shown(tab, Move::Reload))
    }

    /// A commit wrote `tables`: every top room whose reads reach them is built again and shown;
    /// a covered room is built again when it is uncovered, as every popped room is.
    pub fn changed<'a>(
        &mut self,
        door: &dyn Door,
        tables: impl IntoIterator<Item = &'a str>,
    ) -> Vec<Shown> {
        let written: Vec<&str> = tables.into_iter().collect();
        let mut shown = Vec::new();
        let tabs: Vec<String> = self.stacks.keys().cloned().collect();
        for tab in tabs {
            let stack = self.stacks.get_mut(&tab).expect("listed");
            let Some(last) = stack.len().checked_sub(1) else {
                continue;
            };
            let mut top_changed = false;
            for (index, entry) in stack.iter_mut().enumerate() {
                if entry.reads.intersects(written.iter().copied())
                    || entry.watched.iter().any(|table| written.contains(table))
                {
                    // A covered screen keeps its UI cache. Invalidate it too so returning
                    // to an open search cannot resurrect a row that another room changed.
                    entry.ui.refresh_search();
                    top_changed |= index == last;
                }
            }
            if top_changed {
                let entry = stack.last_mut().expect("nonempty stack");
                if rebuild(entry, door).is_ok() {
                    shown.push(self.shown(&tab, Move::Reload));
                }
            }
        }
        shown
    }

    pub fn lock_locker(&mut self, door: &dyn Door) -> Vec<Shown> {
        let tabs: Vec<String> = self.stacks.keys().cloned().collect();
        for tab in &tabs {
            let Some(stack) = self.stacks.get_mut(tab) else {
                continue;
            };
            let Some(first_locker) = stack
                .iter()
                .position(|entry| entry.screen.key().starts_with("locker"))
            else {
                continue;
            };
            let owner_checks: usize = stack[first_locker..]
                .iter()
                .flat_map(|entry| entry.pending.iter())
                .filter(|(_, tag)| tag.as_str() == "locker:unlock")
                .count();
            let mut suffix = stack.split_off(first_locker);
            let Some(mut entry) = suffix.drain(..1).next() else {
                continue;
            };
            let mut preserved = Vec::new();
            for removed in suffix.drain(..) {
                if removed.screen.key().starts_with("locker") {
                    for tag in removed.pending.values() {
                        super::export::cleanup_pending(door, tag);
                    }
                } else {
                    preserved.push(removed);
                }
            }
            entry.pending.clear();
            entry.outbox.clear();
            for _ in 0..owner_checks {
                entry.asked += 1;
                let effect_id = (entry.id << 32) | entry.asked;
                entry.outbox.push(wire::ShellEffect {
                    effect_id,
                    kind: Some(wire::shell_effect::Kind::OwnerCheck(
                        wire::ShellOwnerCheck {
                            cancel: true,
                            ..wire::ShellOwnerCheck::default()
                        },
                    )),
                });
            }
            let Some(screen) = self.registry.make(super::locker::LOCKER) else {
                stack.push(entry);
                stack.extend(preserved);
                continue;
            };
            entry.screen = screen;
            entry.ui = Ui::default();
            entry.handlers = HandlerMap::default();
            entry.reads = ReadContext::new();
            entry.watched.clear();
            entry.status = None;
            entry.last = None;
            let _ = rebuild(&mut entry, door);
            stack.push(entry);
            stack.extend(preserved);
        }
        tabs.into_iter()
            .filter_map(|tab| {
                self.stacks
                    .get(&tab)
                    .is_some_and(|stack| {
                        stack
                            .last()
                            .is_some_and(|entry| entry.screen.key().starts_with("locker"))
                    })
                    .then(|| self.shown(&tab, Move::Reload))
            })
            .collect()
    }

    /// Rebuild each tab's authoritative top room after a shell returns to the foreground.
    pub fn foreground(&mut self, door: &dyn Door) -> Vec<Shown> {
        let tabs: Vec<String> = self.stacks.keys().cloned().collect();
        for tab in &tabs {
            let Some(stack) = self.stacks.get_mut(tab) else {
                continue;
            };
            let Some(entry) = stack.last_mut() else {
                continue;
            };
            let _ = rebuild(entry, door);
        }
        tabs.into_iter()
            .filter_map(|tab| {
                self.stacks
                    .get(&tab)
                    .is_some_and(|stack| !stack.is_empty())
                    .then(|| self.shown(&tab, Move::Reload))
            })
            .collect()
    }
}

fn queue_boundary_effect(entry: &mut Entry, kind: wire::shell_effect::Kind) {
    entry.asked += 1;
    entry.outbox.push(wire::ShellEffect {
        effect_id: (entry.id << 32) | entry.asked,
        kind: Some(kind),
    });
}

fn handle(entry: &mut Entry, event: &wire::RoomEvent, door: &dyn Door) -> Then {
    match &event.kind {
        Some(E::Scrolled(scrolled)) => {
            entry.ui.scrolled(Scroll {
                anchor: scrolled.anchor_selector_id.clone(),
                fraction_milli: scrolled.anchor_fraction_milli.min(999),
            });
            Then::Nothing
        }
        Some(E::EffectResult(result)) => match entry.pending.remove(&result.effect_id) {
            Some(tag) => own(entry, &tag, &Input::Effect(result.clone()), door),
            None => Then::Nothing,
        },
        Some(E::Tap(tap)) => dispatch(entry, &tap.selector_id, &Input::Tap, door),
        Some(E::Change(change)) => {
            let input = match &change.value {
                Some(wire::room_change::Value::Text(text)) => Input::Text(text.clone()),
                Some(wire::room_change::Value::Integer(n)) => Input::Integer(*n),
                Some(wire::room_change::Value::Flag(flag)) => Input::Flag(*flag),
                Some(wire::room_change::Value::Option(option)) => Input::Option(option.clone()),
                Some(wire::room_change::Value::Moment(moment)) => Input::Moment(moment.clone()),
                None => return Then::Nothing,
            };
            let name = match entry.handlers.get(&change.selector_id) {
                Some(Handler::Field(name)) => Some(name.clone()),
                Some(Handler::SearchTerm) => Some(SEARCH_FIELD.to_owned()),
                _ => None,
            };
            if let (Input::Text(text), Some(name)) = (&input, name)
                && entry.ui.fields.change(&name, change.seq, text) == super::field::Taken::Stale
            {
                return Then::Nothing;
            }
            dispatch(entry, &change.selector_id, &input, door)
        }
        Some(E::Canvas(canvas)) => match &canvas.kind {
            Some(kind) => dispatch(
                entry,
                &canvas.selector_id,
                &Input::Canvas(kind.clone()),
                door,
            ),
            None => Then::Nothing,
        },
        None => Then::Nothing,
    }
}

fn cancel_locker_prompt(entry: &mut Entry) -> Vec<wire::ShellEffect> {
    let ids: Vec<u64> = entry
        .pending
        .iter()
        .filter_map(|(id, tag)| (tag == "locker:unlock").then_some(*id))
        .collect();
    for id in &ids {
        entry.pending.remove(id);
    }
    entry
        .outbox
        .retain(|effect| !ids.contains(&effect.effect_id));
    ids.into_iter()
        .map(|_| {
            entry.asked += 1;
            wire::ShellEffect {
                effect_id: (entry.id << 32) | entry.asked,
                kind: Some(wire::shell_effect::Kind::OwnerCheck(
                    wire::ShellOwnerCheck {
                        cancel: true,
                        ..wire::ShellOwnerCheck::default()
                    },
                )),
            }
        })
        .collect()
}

fn dispatch(entry: &mut Entry, selector: &str, input: &Input, door: &dyn Door) -> Then {
    let Some(handler) = entry.handlers.get(selector).cloned() else {
        return Then::Nothing;
    };
    entry.status = None;
    match handler {
        Handler::Act(act) => {
            entry.status = Some(match door.act(&act) {
                Ok(done) => Status {
                    sentence: done.sentence,
                    undo: done.undo,
                    refused: false,
                },
                Err(refused) => Status {
                    sentence: refused.0,
                    undo: false,
                    refused: true,
                },
            });
            Then::Rebuild
        }
        Handler::Undo => {
            entry.status = Some(match door.undo() {
                Ok(done) => Status {
                    sentence: done.sentence,
                    undo: false,
                    refused: false,
                },
                Err(refused) => Status {
                    sentence: refused.0,
                    undo: false,
                    refused: true,
                },
            });
            Then::Rebuild
        }
        Handler::Open(key) => Then::Go(Nav::Push(key)),
        Handler::Ask(question) => Then::Go(Nav::Ask(question)),
        Handler::Back => Then::Go(Nav::Pop),
        Handler::Pick(id) => {
            entry.ui.pick(&id);
            Then::Rebuild
        }
        Handler::SelectMode(on) => {
            entry.ui.select_mode(on);
            Then::Rebuild
        }
        Handler::SelectAll => {
            entry.ui.pick_all();
            Then::Rebuild
        }
        Handler::SearchOpen => {
            entry.ui.open_search();
            Then::Rebuild
        }
        Handler::SearchClose => {
            entry.ui.close_search();
            Then::Rebuild
        }
        Handler::SearchTerm => {
            if let Input::Text(term) = input {
                entry.ui.set_term(term);
            }
            Then::Rebuild
        }
        Handler::Filter(id) => {
            entry.ui.toggle_filter(&id);
            Then::Rebuild
        }
        Handler::FilterClear => {
            entry.ui.clear_filters();
            Then::Rebuild
        }
        Handler::Lens(lens) => {
            entry.ui.set_lens(&lens);
            Then::Rebuild
        }
        Handler::Field(name) => own(entry, &name, input, door),
        Handler::Tag(tag) => own(entry, &tag, input, door),
        Handler::NextPage(section) => own(entry, &format!("next:{section}"), input, door),
    }
}

fn own(entry: &mut Entry, tag: &str, input: &Input, door: &dyn Door) -> Then {
    let outcome: Outcome = {
        let mut event = Event {
            ui: &mut entry.ui,
            door,
        };
        super::follow::handle(&mut event, tag)
            .unwrap_or_else(|| entry.screen.on(&mut event, tag, input))
    };
    if let Some(status) = outcome.status {
        entry.status = Some(status);
    }
    if let Some((tag, kind)) = outcome.effect {
        entry.asked += 1;
        let effect_id = (entry.id << 32) | entry.asked;
        entry.pending.insert(effect_id, tag);
        entry.outbox.push(wire::ShellEffect {
            effect_id,
            kind: Some(kind),
        });
    }
    match outcome.nav {
        Nav::Stay => Then::Rebuild,
        other => Then::Go(other),
    }
}

fn rebuild(entry: &mut Entry, door: &dyn Door) -> Result<(), Refusal> {
    let mut build = Build::new(&mut entry.ui, door, entry.depth);
    let mut room = entry.screen.build(&mut build);
    if room.hue_key.is_empty() {
        room.hue_key.clone_from(&entry.hue_key);
    }
    let (mut sel, reads, watched) = build.into_parts();
    if let Some(status) = &entry.status {
        room.status_line = Some(wire::RoomStatusLine {
            sentence: status.sentence.clone(),
            action_label: String::new(),
            action_selector_id: String::new(),
            refused: status.refused,
        });
        if status.undo {
            let id = sel.on("status/undo", Handler::Undo);
            if let Some(line) = room.status_line.as_mut() {
                line.action_label = crate::strings::shared::undo_label(crate::strings::Locale::En);
                line.action_selector_id = id;
            }
        }
    }
    let handlers = sel.finish()?;
    let loading = matches!(room.state, Some(wire::room::State::Loading(_)));
    if loading && entry.last.is_some() {
        return Ok(());
    }
    if !loading && let Some(place) = entry.restore.take() {
        room.restore = Some(place.wire());
    }
    entry.handlers = handlers;
    entry.reads = reads;
    entry.watched = watched;
    entry.last = Some(room);
    Ok(())
}

/// The app hue is explicit Rust room authority, resolved from registered route families.
/// Generic child pages have no match and inherit the hue captured from their caller on open.
fn app_hue_for_room_key(key: &str) -> Option<&'static str> {
    let route = key.split('/').next()?;
    match route {
        "people" | "person" => Some("people"),
        "money" => Some("money"),
        "photos" | "photo" => Some("photos"),
        "locker" => Some("locker"),
        "docs" => Some("docs"),
        "calendar" => Some("calendar"),
        "reminders" => Some("reminders"),
        "notes" => Some("notes"),
        "health" => Some("health"),
        _ => None,
    }
}

fn hue_key_for_room(key: &str, inherited: &str) -> String {
    app_hue_for_room_key(key).unwrap_or(inherited).to_owned()
}

#[cfg(test)]
mod hue_tests {
    use super::hue_key_for_room;

    #[test]
    fn rust_assigns_each_app_hue_and_generic_pages_inherit_their_parent() {
        for (route, expected) in [
            ("person/00000000-0000-7000-8000-000000000001", "people"),
            ("people/list/00000000-0000-7000-8000-000000000001", "people"),
            ("money/txn/00000000-0000-7000-8000-000000000001", "money"),
            (
                "photos/photo/00000000-0000-7000-8000-000000000001",
                "photos",
            ),
            ("locker/item/00000000-0000-7000-8000-000000000001", "locker"),
            ("docs/doc/00000000-0000-7000-8000-000000000001", "docs"),
            (
                "calendar/event/00000000-0000-7000-8000-000000000001",
                "calendar",
            ),
            (
                "reminders/task/00000000-0000-7000-8000-000000000001",
                "reminders",
            ),
            ("notes/note/00000000-0000-7000-8000-000000000001", "notes"),
            (
                "health/workout/00000000-0000-7000-8000-000000000001",
                "health",
            ),
        ] {
            assert_eq!(hue_key_for_room(route, ""), expected, "{route}");
        }
        assert_eq!(hue_key_for_room("organize/picker", "people"), "people");
        assert_eq!(hue_key_for_room("home", ""), "");
    }
}
