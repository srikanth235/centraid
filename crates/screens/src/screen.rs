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
use centraid_core::screens::ScreenCtx;
use centraid_core::screens::VaultRequest;
use centraid_core::{Handle, Result};
use prost::Message;

use crate::follow::Follows;
use crate::kit::act::Settled;
use crate::strings::Locale;

/// One screen. `Send` because the runtime lives behind a mutex shared by the
/// shell's call thread and its event thread.
pub trait Screen: Send {
    /// Apply one event. Reads and writes go through `ctx`; a failed read is
    /// state in the view (the read law), never a panic and never an empty list.
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect>;

    /// The runtime numbered the effects the last [`Screen::update`] asked for: one entry per
    /// effect, in the order returned, `None` for one the runtime kept for itself (a tab
    /// selection, a shelf command) that no shell performs. The answer to an effect names its
    /// number, so a screen that can be asked twice about one thing (a read it gave up on and
    /// asked again) tells the late answer of the first from the answer of the second.
    fn effects_numbered(&mut self, ids: &[Option<u64>]) {
        let _ = ids;
    }

    /// The finished state. `instance` and `revision` are stamped by the runtime.
    fn view(&self, ctx: &Ctx) -> wire::ViewState;

    /// Whether the assistant's stream is for this screen (`ScreenEvent.assist`): only the chat
    /// says yes, so a token does not wake every open screen.
    fn hears_assist(&self) -> bool {
        false
    }
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
    /// The platform deletes from its photo library behind its own confirmation.
    pub library_deletes: bool,
    /// The phone keeps 12-hour time (`Environment.hour_cycle_12`); false is 24-hour.
    pub hour_cycle_12: bool,
    /// The units the member chose (`kit::quantity::stored`), or `None` to follow the region. The
    /// runtime fills it from the phone's store before every call; [`Ctx::units`] is the reader.
    pub units: Option<crate::kit::quantity::UnitsPref>,
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            locale: Locale::En,
            zone: "UTC".to_owned(),
            region: String::new(),
            platform: String::new(),
            library_deletes: false,
            hour_cycle_12: false,
            units: None,
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
    pub jobs: Vec<(String, centraid_core::screens::OffThreadWork)>,
    /// The vault the screen asked to bring to the front, see
    /// [`Ctx::switch_vault`].
    pub switch: Option<String>,
    /// Events for other open screens, by registered name (`Ctx::post`).
    pub posts: Vec<(String, wire::ScreenEvent)>,
    /// Every other open screen must draw again, see [`Ctx::redraw_all`].
    pub redraw_all: bool,
}

/// A screen's door to the core, the catalog and the clock.
pub struct Ctx<'a> {
    core: &'a dyn ScreenCtx,
    env: &'a Environment,
    done: RefCell<Done>,
    follows: Follows,
}

impl<'a> Ctx<'a> {
    pub(crate) fn new(core: &'a dyn ScreenCtx, env: &'a Environment) -> Self {
        Self {
            core,
            env,
            done: RefCell::new(Done::default()),
            follows: Follows::default(),
        }
    }

    /// This context over the runtime's one follow board, so a screen's ask reaches the
    /// coordinator that answers every screen.
    #[must_use]
    pub(crate) fn with_follows(mut self, follows: Follows) -> Self {
        self.follows = follows;
        self
    }

    /// The board the follow coordinator shares with the screens (`crate::follow`).
    #[must_use]
    pub fn follows(&self) -> &Follows {
        &self.follows
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

    /// One of the shell's own commands, which no app's manifest declares
    /// (`vault.export_all`), answered as `act` is: the verdict, the sentence of a refusal and
    /// the output.
    pub fn command(&self, name: &str, input: &serde_json::Value, invoke_key: &str) -> Settled {
        match self.core.command(name, input, invoke_key) {
            Ok(outcome) if outcome.status == centraid_vault::CommandStatus::Executed => Settled {
                committed: true,
                refusal: String::new(),
                output: serde_json::to_vec(&outcome.output).unwrap_or_default(),
                inverse: None,
                tables: outcome.tables,
            },
            Ok(outcome) => Settled {
                committed: false,
                refusal: outcome
                    .reason
                    .filter(|reason| !reason.trim().is_empty())
                    .unwrap_or_else(|| crate::strings::shared::write_refused(self.locale())),
                output: Vec::new(),
                inverse: None,
                tables: Vec::new(),
            },
            Err(_) => Settled {
                committed: false,
                refusal: crate::strings::shared::write_refused(self.locale()),
                output: Vec::new(),
                inverse: None,
                tables: Vec::new(),
            },
        }
    }

    /// The keep list and the census of originals (`originals.proto`).
    ///
    /// # Errors
    /// Whatever the core refuses with.
    pub fn originals(&self, request: &wire::OriginalsRequest) -> Result<wire::OriginalsResponse> {
        self.core.originals(request)
    }

    /// Where content items' bytes are on this phone, one answer per ref in
    /// order: the path the shell hands to the platform (share, save).
    ///
    /// # Errors
    /// Whatever the core refuses with.
    pub fn content_urls(&self, request: &wire::ContentUrlRequest) -> Result<wire::ContentUrls> {
        self.core.content_urls(request)
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

    /// A vault lifecycle door that is quick (the 24 words, founding a vault).
    /// The type limits it to `vault.proto` and `phone.proto` requests.
    ///
    /// # Errors
    /// Whatever the door refuses with.
    pub fn vault(&self, request: VaultRequest) -> Result<wire::Response> {
        self.core.vault(request)
    }

    /// Run `job` on a worker thread with its own handle to the core, off the
    /// runtime's lock, and answer this screen with
    /// [`wire::OffThreadDone`] `{ tag, bytes }` when it is done, the way a timer
    /// is delivered. A screen popped meanwhile never hears it.
    pub fn off_thread(&self, tag: &str, job: impl FnOnce(&Handle) -> Vec<u8> + Send + 'static) {
        self.done
            .borrow_mut()
            .jobs
            .push((tag.to_owned(), Box::new(job)));
    }

    /// [`Self::off_thread`] over one slow vault door (a pass, a pairing, a
    /// restore): the answer is a [`wire::VaultCalled`] — the core's encoded
    /// `Response`, or its typed refusal.
    pub fn vault_async(&self, tag: &str, request: VaultRequest) {
        // BOUND TO THE VAULT IN FRONT WHEN IT IS ASKED FOR: a pass or a pairing
        // started on one vault finishes on it, whatever is in front when its
        // door is called. The words and a restore are the front's own (a restore
        // lays vaults down beside the front's file, not inside a vault's).
        let bound = match request {
            VaultRequest::Phrase(_) | VaultRequest::Restore(_) => None,
            _ => self
                .core
                .vaults()
                .and_then(|vaults| vaults.foreground_core()),
        };
        self.off_thread(tag, move |front| {
            let handle = bound.as_ref().unwrap_or(front);
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
        });
    }

    /// The vaults this phone holds, when the core is the door to a shelf of
    /// them (`centraid_core::vaults`): which are held and drainable, and a way
    /// to reach the core of one that is not in front.
    #[must_use]
    pub fn vaults(&self) -> Option<std::sync::Arc<dyn centraid_core::vaults::Vaults>> {
        self.core.vaults()
    }

    /// BRING THE VAULT `vault_id` TO THE FRONT, when this update is done.
    ///
    /// Every screen of a tab is told it is being left, so what the member typed
    /// is written to the vault it was typed in; then the vault is brought to
    /// the front and each tab's root is closed and opened again, so no screen
    /// shows one vault's rows over another's. A vault nothing holds, or whose
    /// file will not reopen, leaves the phone where it was. The shell sees an
    /// ordinary update: instances closed, new views, a new navigation.
    pub fn switch_vault(&self, vault_id: &str) {
        self.done.borrow_mut().switch = Some(vault_id.to_owned());
    }

    /// One bounded assistant call (status, start, suggest, cancel, clear, confirm, dismiss,
    /// documents). A load or a send blocks for seconds: make those from [`Self::off_thread`].
    ///
    /// # Errors
    /// Whatever the core refuses with.
    pub fn assist(&self, request: &wire::AssistRequest) -> Result<wire::AssistResponse> {
        self.core.assist(request)
    }

    /// THE ONE WAY A SCREEN REACHES ANOTHER: hand `event` to every open screen (a service
    /// included) registered as `screen`. A picker returns its pick to the page that asked for
    /// it, a service tells Home what the shelf holds, and the Backup screen wakes the pass
    /// service. Delivered after this update, in the same re-render; an instance cannot post
    /// to itself.
    pub fn post(&self, screen: &str, event: wire::ScreenEvent) {
        self.done
            .borrow_mut()
            .posts
            .push((screen.to_owned(), event));
    }

    /// A SETTING EVERY SCREEN READS CHANGED (the units): every other open screen hears
    /// `EnvironmentChanged` after this update, in the same re-render, and draws again.
    pub fn redraw_all(&self) {
        self.done.borrow_mut().redraw_all = true;
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

    /// THE MEMBER'S UNITS, metric or imperial: what they chose in Settings, else what the region
    /// measures in. Every measured amount is worded with this (`kit::quantity`).
    #[must_use]
    pub fn units(&self) -> crate::kit::quantity::UnitsPref {
        crate::kit::quantity::effective(self.env.units, &self.env.region)
    }

    /// The OS the shell runs on (`ios`, `android`), or empty.
    #[must_use]
    pub fn platform(&self) -> &str {
        &self.env.platform
    }

    /// Whether the platform has a Reminders store to import from: iOS (EventKit) does,
    /// Android has none. The same fact the shell tells `imports.made` at a made vault
    /// (`Made.reminders`), from the one signal the core always has (`Environment.platform`),
    /// so Agenda's "Import reminders" row is offered only where the import can read.
    #[must_use]
    pub fn reminders_source(&self) -> bool {
        self.env.platform == "ios"
    }

    /// Whether the platform deletes from its photo library behind its own
    /// confirmation (`Environment.library_deletes`): "Free up space" is offered
    /// only where it does.
    #[must_use]
    pub fn library_deletes(&self) -> bool {
        self.env.library_deletes
    }

    /// How the phone words a time of day (`Environment.hour_cycle_12`): every
    /// clock a screen shows goes through [`civil::clock_for`] with this.
    #[must_use]
    pub fn hour_cycle(&self) -> crate::kit::civil::HourCycle {
        crate::kit::civil::HourCycle::of(self.env.hour_cycle_12)
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
