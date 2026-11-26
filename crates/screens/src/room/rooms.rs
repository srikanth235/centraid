//! THE ROOM RUNTIME (app-plane §1, §6): one stack of room instances per tab. Rust keeps each
//! instance's kept state, builds its room, routes each `RoomEvent` through the handler map,
//! saves a room's place when another is pushed over it and restores it on pop, and reloads the
//! rooms whose read context a commit reaches.

use std::collections::BTreeMap;
use std::sync::Arc;

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
    screen: Box<dyn RoomScreen>,
    ui: Ui,
    handlers: HandlerMap,
    reads: ReadContext,
    covered: Option<Place>,
    restore: Option<Place>,
    status: Option<Status>,
    last: Option<wire::Room>,
}

pub struct Rooms {
    door: Arc<dyn Door>,
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
    pub fn new(registry: Registry, door: Arc<dyn Door>) -> Self {
        Self {
            door,
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
    pub fn open(&mut self, key: &str, tab: &str, root: bool) -> Result<Shown, Refusal> {
        let screen = self
            .registry
            .make(key)
            .ok_or_else(|| Refusal::NoRoom(key.to_owned()))?;
        let stack = self.stacks.entry(tab.to_owned()).or_default();
        let movement = if root || stack.is_empty() {
            stack.clear();
            Move::Replace
        } else {
            if let Some(top) = stack.last_mut() {
                top.covered = Some(top.ui.place());
            }
            Move::Push
        };
        let id = self.next;
        self.next += 1;
        let mut entry = Entry {
            id,
            screen,
            ui: Ui::default(),
            handlers: HandlerMap::default(),
            reads: ReadContext::new(),
            covered: None,
            restore: None,
            status: None,
            last: None,
        };
        let door = self.door.clone();
        rebuild(&mut entry, &door)?;
        let stack = self.stacks.entry(tab.to_owned()).or_default();
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
        instance: u64,
        event: &wire::RoomEvent,
    ) -> Result<Option<Shown>, Refusal> {
        let (tab, at) = self.locate(instance)?;
        let top = self.stacks[&tab].len() - 1;
        if at != top {
            return Ok(None);
        }
        let door = self.door.clone();
        let then = {
            let entry = &mut self.stacks.get_mut(&tab).expect("located")[at];
            handle(entry, event, &door)
        };
        match then {
            Then::Nothing => Ok(None),
            Then::Rebuild => {
                let entry = &mut self.stacks.get_mut(&tab).expect("located")[at];
                rebuild(entry, &door)?;
                Ok(Some(self.shown(&tab, Move::Reload)))
            }
            Then::Go(Nav::Stay) => Ok(None),
            Then::Go(Nav::Push(key)) => self.open(&key, &tab, false).map(Some),
            Then::Go(Nav::Replace(key)) => self.open(&key, &tab, true).map(Some),
            Then::Go(Nav::Pop) => self.pop(&tab).map(Some),
        }
    }

    fn pop(&mut self, tab: &str) -> Result<Shown, Refusal> {
        let door = self.door.clone();
        let stack = self.stacks.get_mut(tab).expect("popped tab exists");
        if stack.len() > 1 {
            stack.pop();
            if let Some(entry) = stack.last_mut() {
                entry.restore = entry.covered.take();
                if let Some(place) = entry.restore.clone() {
                    entry.ui.restore(&place);
                }
                rebuild(entry, &door)?;
            }
            return Ok(self.shown(tab, Move::Pop));
        }
        Ok(self.shown(tab, Move::Reload))
    }

    /// A commit wrote `tables`: every top room whose reads reach them is built again and shown;
    /// a covered room is built again when it is uncovered, as every popped room is.
    pub fn changed<'a>(&mut self, tables: impl IntoIterator<Item = &'a str>) -> Vec<Shown> {
        let written: Vec<&str> = tables.into_iter().collect();
        let door = self.door.clone();
        let mut shown = Vec::new();
        let tabs: Vec<String> = self.stacks.keys().cloned().collect();
        for tab in tabs {
            let stack = self.stacks.get_mut(&tab).expect("listed");
            let Some(entry) = stack.last_mut() else {
                continue;
            };
            if entry.reads.intersects(written.iter().copied()) && rebuild(entry, &door).is_ok() {
                shown.push(self.shown(&tab, Move::Reload));
            }
        }
        shown
    }
}

fn handle(entry: &mut Entry, event: &wire::RoomEvent, door: &Arc<dyn Door>) -> Then {
    match &event.kind {
        Some(E::Scrolled(scrolled)) => {
            entry.ui.scrolled(Scroll {
                anchor: scrolled.anchor_selector_id.clone(),
                fraction_milli: scrolled.anchor_fraction_milli.min(999),
            });
            Then::Nothing
        }
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

fn dispatch(entry: &mut Entry, selector: &str, input: &Input, door: &Arc<dyn Door>) -> Then {
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

fn own(entry: &mut Entry, tag: &str, input: &Input, door: &Arc<dyn Door>) -> Then {
    let outcome: Outcome = {
        let mut event = Event {
            ui: &mut entry.ui,
            door,
        };
        entry.screen.on(&mut event, tag, input)
    };
    if let Some(status) = outcome.status {
        entry.status = Some(status);
    }
    match outcome.nav {
        Nav::Stay => Then::Rebuild,
        other => Then::Go(other),
    }
}

fn rebuild(entry: &mut Entry, door: &Arc<dyn Door>) -> Result<(), Refusal> {
    let mut build = Build::new(&mut entry.ui, door);
    let mut room = entry.screen.build(&mut build);
    let (mut sel, reads) = build.into_parts();
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
    entry.last = Some(room);
    Ok(())
}
