//! What a screen is, and what it may touch.
//!
//! A screen is a state machine: [`Screen::update`] takes one event and returns
//! the platform work it wants done; [`Screen::view`] returns the finished state
//! to draw. It reads and writes the vault only through [`Ctx::load`] and
//! [`Ctx::act`], so chat, the training harness and a screen share one door and
//! one catalogue (`manifest.json`).

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::Result;
use centraid_core::screens::ScreenCtx;

use crate::strings::Locale;

/// One screen. `Send` because the runtime lives behind a mutex shared by the
/// shell's call thread and its event thread.
pub trait Screen: Send {
    /// Apply one event. Reads and writes go through `ctx`; a failed read is
    /// state in the view (the read law), never a panic and never an empty list.
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect>;

    /// The finished state. `instance` and `revision` are stamped by the runtime.
    fn view(&self, ctx: &Ctx) -> wire::ViewState;
}

/// The device's locale and zone, as the shell last reported them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Environment {
    pub locale: Locale,
    pub zone: String,
    /// The region of the locale tag (`US` of `en-US` or `en_US`), upper-cased;
    /// empty when the tag names none. Units follow it.
    pub region: String,
    /// The OS the shell runs on (`ios`, `android`); empty before it says.
    pub platform: String,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            locale: Locale::En,
            zone: "UTC".to_owned(),
            region: String::new(),
            platform: String::new(),
        }
    }
}

/// A timer a screen asked to start or stop during one update.
pub(crate) enum TimerOp {
    Start(String, Duration),
    Cancel(String),
}

/// What an update did through its [`Ctx`], taken by the runtime afterwards.
#[derive(Default)]
pub(crate) struct Done {
    pub tables: BTreeSet<String>,
    pub timers: Vec<TimerOp>,
}

/// A screen's door to the core, the catalog and the clock.
pub struct Ctx<'a> {
    core: &'a dyn ScreenCtx,
    env: &'a Environment,
    done: RefCell<Done>,
}

impl<'a> Ctx<'a> {
    pub(crate) fn new(core: &'a dyn ScreenCtx, env: &'a Environment) -> Self {
        Self {
            core,
            env,
            done: RefCell::new(Done::default()),
        }
    }

    /// The one read. The tables it read are remembered: when one changes, the
    /// runtime sends the screen [`wire::DataChanged`].
    ///
    /// # Errors
    /// Whatever the core refuses with.
    pub fn load(&self, mut request: wire::LoadRequest) -> Result<wire::LoadResponse> {
        if request.zone.is_empty() {
            request.zone.clone_from(&self.env.zone);
        }
        let response = self.core.load(&request)?;
        self.done
            .borrow_mut()
            .tables
            .extend(response.tables.iter().cloned());
        Ok(response)
    }

    /// The one write.
    ///
    /// # Errors
    /// Whatever the core refuses with. A refusal the vault itself makes is an
    /// `Ok` response with `status: refused`, to be shown as the screen decides.
    pub fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse> {
        self.core.act(request)
    }

    /// One step of the Locker session. The tables are untouched: the session is
    /// not a read.
    ///
    /// # Errors
    /// Whatever the session refuses with.
    pub fn locker(
        &self,
        request: &wire::LockerSessionRequest,
    ) -> Result<wire::LockerSessionResponse> {
        self.core.locker(request)
    }

    /// The locale every string is made in.
    #[must_use]
    pub fn locale(&self) -> Locale {
        self.env.locale
    }

    /// The device's IANA zone, as the shell last reported it. A screen that
    /// SENDS a wall clock (an event's start) names this zone beside it; every
    /// reading the core answers is already placed in it.
    #[must_use]
    pub fn zone(&self) -> &str {
        &self.env.zone
    }

    /// The region of the device's locale (`US`), or empty.
    #[must_use]
    pub fn region(&self) -> &str {
        &self.env.region
    }

    /// The OS the shell runs on (`ios`, `android`), or empty.
    #[must_use]
    pub fn platform(&self) -> &str {
        &self.env.platform
    }

    /// Start (or restart) the named timer. When it elapses the screen gets
    /// [`wire::TimerFired`]. Timers die with their screen.
    pub fn start_timer(&self, name: &str, after: Duration) {
        self.done
            .borrow_mut()
            .timers
            .push(TimerOp::Start(name.to_owned(), after));
    }

    /// Stop the named timer; stopping one that is not running is fine.
    pub fn cancel_timer(&self, name: &str) {
        self.done
            .borrow_mut()
            .timers
            .push(TimerOp::Cancel(name.to_owned()));
    }

    pub(crate) fn finish(self) -> Done {
        self.done.into_inner()
    }
}
