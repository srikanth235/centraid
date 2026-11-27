//! Screen builders turn read results into rooms and handle their events without retaining rebuildable state.

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
    /// The shell's answer to an effect this room asked for.
    Effect(wire::ShellEffectResult),
}

/// Where an event sends the member.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Nav {
    #[default]
    Stay,
    Push(String),
    Ask(String),
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
    /// A job for the shell and the tag its answer comes back under (`RoomScreen::on`, `Input::Effect`).
    pub effect: Option<(String, wire::shell_effect::Kind)>,
}

impl Outcome {
    /// Ask the shell to do `effect`; its answer reaches `on` under `tag`.
    #[must_use]
    pub fn effect(tag: &str, effect: wire::shell_effect::Kind) -> Self {
        Self {
            effect: Some((tag.to_owned(), effect)),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn and_effect(mut self, tag: &str, effect: wire::shell_effect::Kind) -> Self {
        self.effect = Some((tag.to_owned(), effect));
        self
    }

    #[must_use]
    pub fn push(key: &str) -> Self {
        Self {
            nav: Nav::Push(key.to_owned()),
            status: None,
            effect: None,
        }
    }

    #[must_use]
    pub fn replace(key: &str) -> Self {
        Self {
            nav: Nav::Replace(key.to_owned()),
            status: None,
            effect: None,
        }
    }

    #[must_use]
    pub fn pop() -> Self {
        Self {
            nav: Nav::Pop,
            status: None,
            effect: None,
        }
    }

    #[must_use]
    pub fn done(sentence: &str, undo: bool) -> Self {
        Self {
            nav: Nav::Stay,
            status: Some(Status {
                sentence: sentence.to_owned(),
                undo,
                refused: false,
            }),
            effect: None,
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
            effect: None,
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
            effect: None,
        }
    }
}

/// What a build holds: the selectors it claims, the room's kept state, and the reads it ran.
pub struct Build<'a> {
    /// How deep this room sits in its tab's stack: 1 is a root, which has no back.
    pub depth: usize,
    pub sel: Sel,
    pub ui: &'a mut Ui,
    pub door: &'a dyn Door,
    reader: Option<centraid_domain::read::Reader>,
    reads: ReadContext,
    watched: std::collections::BTreeSet<&'static str>,
}

impl<'a> Build<'a> {
    pub fn new(ui: &'a mut Ui, door: &'a dyn Door, depth: usize) -> Self {
        Self {
            depth,
            sel: Sel::new(),
            ui,
            door,
            reader: None,
            reads: ReadContext::new(),
            watched: std::collections::BTreeSet::new(),
        }
    }

    /// Record that `read` ran for this room: a commit that wrote one of its tables reloads it.
    pub fn read(&mut self, read: &ReadDecl) {
        self.reads.record(read);
    }

    fn reader(&mut self) -> Result<&centraid_domain::read::Reader, super::door::Refused> {
        if self.reader.is_none() {
            self.reader = Some(self.door.reader()?);
        }
        Ok(self.reader.as_ref().expect("reader just initialized"))
    }

    /// Run a registered read through the door and record its tables for auto-reload.
    ///
    /// # Errors
    /// The door's or reader's refusal.
    pub fn run<R: 'static>(
        &mut self,
        read: &centraid_domain::read::Read<R>,
        args: &centraid_domain::read::Args,
    ) -> Result<centraid_domain::read::Answer<R>, super::door::Refused> {
        self.reads.record(&read.decl);
        self.reader()?
            .run(read, args)
            .map_err(|error| super::door::Refused(error.to_string()))
    }

    /// Reload a paged read up to `loaded` rows and record its tables for auto-reload.
    ///
    /// # Errors
    /// The door's or reader's refusal.
    pub fn reload<R: 'static>(
        &mut self,
        read: &centraid_domain::read::Read<R>,
        args: &centraid_domain::read::Args,
        loaded: usize,
    ) -> Result<centraid_domain::read::Answer<R>, super::door::Refused> {
        self.reads.record(&read.decl);
        self.reader()?
            .reload(read, args, loaded)
            .map_err(|error| super::door::Refused(error.to_string()))
    }

    /// Reload when a commit writes any of `tables`, for what the room read through the core's own
    /// doors and not through a registered read (the backup status reads the `backup` ledger and
    /// the vault's `blob` rows).
    pub fn watch(&mut self, tables: &[&'static str]) {
        self.watched.extend(tables.iter().copied());
    }

    pub(super) fn into_parts(self) -> (Sel, ReadContext, std::collections::BTreeSet<&'static str>) {
        (self.sel, self.reads, self.watched)
    }
}

/// What an event may do beside returning an [`Outcome`].
pub struct Event<'a> {
    pub ui: &'a mut Ui,
    pub door: &'a dyn Door,
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
