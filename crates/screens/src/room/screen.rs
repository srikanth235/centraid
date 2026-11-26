//! A ROOM'S SCREEN (app-plane §1, "room builders"): turns what a read answered into a [`Room`],
//! holds nothing a rebuild cannot recompute, and answers the events that are its own.

use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::read::{ReadContext, ReadDecl};

use super::door::Door;
use super::selector::Sel;
use super::ui::Ui;

/// What an event carried, beside the selector it named.
#[derive(Debug, Clone, PartialEq)]
pub enum Input {
    Tap,
    Text(String),
    Integer(i64),
    Flag(bool),
    Option(String),
    Moment(String),
    Canvas(wire::room_canvas_event::Kind),
}

/// Where an event sends the member.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Nav {
    #[default]
    Stay,
    Push(String),
    Pop,
    Replace(String),
}

/// What the status line says after an event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub sentence: String,
    pub undo: bool,
    pub refused: bool,
}

/// A screen's answer to an event of its own.
#[derive(Debug, Clone, Default)]
pub struct Outcome {
    pub nav: Nav,
    pub status: Option<Status>,
}

impl Outcome {
    #[must_use]
    pub fn push(key: &str) -> Self {
        Self {
            nav: Nav::Push(key.to_owned()),
            status: None,
        }
    }

    #[must_use]
    pub fn say(sentence: &str) -> Self {
        Self {
            nav: Nav::Stay,
            status: Some(Status {
                sentence: sentence.to_owned(),
                undo: false,
                refused: false,
            }),
        }
    }

    #[must_use]
    pub fn refuse(sentence: &str) -> Self {
        Self {
            nav: Nav::Stay,
            status: Some(Status {
                sentence: sentence.to_owned(),
                undo: false,
                refused: true,
            }),
        }
    }
}

/// What a build holds: the selectors it claims, the room's kept state, and the reads it ran.
pub struct Build<'a> {
    pub sel: Sel,
    pub ui: &'a mut Ui,
    pub door: &'a Arc<dyn Door>,
    reads: ReadContext,
}

impl<'a> Build<'a> {
    pub fn new(ui: &'a mut Ui, door: &'a Arc<dyn Door>) -> Self {
        Self {
            sel: Sel::new(),
            ui,
            door,
            reads: ReadContext::new(),
        }
    }

    /// Record that `read` ran for this room: a commit that wrote one of its tables reloads it.
    pub fn read(&mut self, read: &ReadDecl) {
        self.reads.record(read);
    }

    pub(super) fn into_parts(self) -> (Sel, ReadContext) {
        (self.sel, self.reads)
    }
}

/// What an event may do beside returning an [`Outcome`].
pub struct Event<'a> {
    pub ui: &'a mut Ui,
    pub door: &'a Arc<dyn Door>,
}

pub trait RoomScreen: Send {
    /// The room's stable identity (keep-my-place and snapshots; never shown, never routed on).
    fn key(&self) -> String;

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room;

    /// An event that is the screen's own: a `Handler::Tag`, a field's change, a canvas event.
    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        let _ = (e, tag, input);
        Outcome::default()
    }
}

pub type Factory = Box<dyn Fn(&str) -> Option<Box<dyn RoomScreen>> + Send + Sync>;

/// Every room the shell can ask for by key.
#[derive(Default)]
pub struct Registry {
    factories: Vec<Factory>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with(mut self, factory: Factory) -> Self {
        self.factories.push(factory);
        self
    }

    /// A room named exactly `key`.
    #[must_use]
    pub fn exact(
        self,
        key: &'static str,
        make: impl Fn() -> Box<dyn RoomScreen> + Send + Sync + 'static,
    ) -> Self {
        self.with(Box::new(move |asked| (asked == key).then(&make)))
    }

    #[must_use]
    pub fn make(&self, key: &str) -> Option<Box<dyn RoomScreen>> {
        self.factories.iter().find_map(|factory| factory(key))
    }

    #[must_use]
    pub fn merge(mut self, other: Self) -> Self {
        self.factories.extend(other.factories);
        self
    }
}
