//! THE FOLLOW COORDINATOR (#1183): when the phone's own stores are followed into the vault.
//!
//! The apps follow the phone's stores ONE WAY into the vault: contacts into People, calendars
//! into Calendar, reminders into Reminders, a picked folder into Docs, the health store into Health (the camera roll has
//! its own importer, `imports.camera_roll`). Whether a store changed is a question the whole
//! session asks, not a home screen, so one service answers it for all five.
//!
//! | Piece | What it is |
//! |---|---|
//! | [`gate`] | the one coalescing machine: a settle, one pass running per store, one queued behind it |
//! | [`coordinator`] | the service that hears every trigger, runs a pass for the stores the member connected, and says when a background window's follows are done |
//! | [`Follows`] | the board the screens and services share with it: what asked, what the last pass said |
//!
//! ## What triggers a pass (a trigger carries no data)
//!
//! - **The app came to the foreground**: every store.
//! - **The OS said a store changed** while the app runs (`PhoneChanged`, from the watches the
//!   coordinator asks for): contacts and calendar. Files and Health have no cheap change
//!   notice on both platforms, so for them the foreground is the trigger.
//! - **A background window the pass service was granted** (the one that walks the camera roll
//!   and backs up), once that work has ended: every store once, before the window is reported
//!   done. The short grace after leaving the screen is not one: it belongs to the upload.
//! - **A screen asked** ([`Follows::changed`]): a home appearing, a pull to refresh, an import
//!   or a resume that turned a store on.
//!
//! A missed trigger costs a pass later and a doubled one costs nothing, because a pass is a
//! merge the vault already answers for: a pass over what it holds writes nothing.
//!
//! ## What a pass never does
//!
//! It never asks the OS for a permission (the member's own import or connect does, and keeps
//! the keychain habit that says this device did), never runs for a store the member has not
//! connected, deletes nothing on a read that was incomplete (the vault's rule), is bounded by
//! how many stores there are and not by a clock, and writes nothing back to the phone.

pub mod coordinator;
pub mod gate;
pub mod reconnect;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use centraid_api_proto::core_v1 as wire;

use crate::Registry;
use crate::catalog::load;
use crate::kit::read::{self, Reading};
use crate::screen::Ctx;
use crate::strings::Locale;
use crate::strings::follow as words;

/// The route name of the coordinator.
pub const NAME: &str = coordinator::NAME;

/// The registry of the coordinator.
#[must_use]
pub fn registry() -> Registry {
    coordinator::registry().merge(reconnect::registry())
}

/// The services a runtime opens for it: see [`crate::Runtime::with_services`].
#[must_use]
pub fn services() -> Vec<wire::Route> {
    vec![coordinator::route()]
}

/// A store the phone keeps that the vault follows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Store {
    Contacts,
    Calendar,
    Files,
    Health,
    Reminders,
}

impl Store {
    /// Every store, in the order a window follows them.
    pub const ALL: [Store; 5] = [
        Store::Contacts,
        Store::Calendar,
        Store::Files,
        Store::Health,
        Store::Reminders,
    ];

    /// The home screen that draws what a pass over this store found (contacts' row, health's
    /// refused types, the status line a doubted or incomplete pass leaves), told to draw again when a pass ends.
    #[must_use]
    pub(crate) fn shown_by(self) -> Option<&'static str> {
        match self {
            Store::Contacts => Some(crate::people::HOME),
            Store::Health => Some(crate::health::HOME),
            Store::Calendar => Some(crate::calendar::HOME),
            Store::Files => Some(crate::docs::DRIVE),
            Store::Reminders => None,
        }
    }

    /// What a sentence about a pass calls the store it read: "only part of your phone’s
    /// contacts could be read".
    #[must_use]
    pub(crate) fn source(self, locale: Locale) -> String {
        match self {
            Store::Contacts => words::source_contacts(locale),
            Store::Calendar => words::source_calendar(locale),
            Store::Files => words::source_files(locale),
            Store::Health => words::source_health(locale),
            Store::Reminders => words::source_reminders(locale),
        }
    }

    /// The name a timer carries.
    #[must_use]
    pub fn key(self) -> &'static str {
        match self {
            Store::Contacts => "contacts",
            Store::Calendar => "calendar",
            Store::Files => "files",
            Store::Health => "health",
            Store::Reminders => "reminders",
        }
    }

    /// The store a timer's name says.
    #[must_use]
    pub fn of_key(key: &str) -> Option<Store> {
        Store::ALL.into_iter().find(|store| store.key() == key)
    }
}

/// What the last pass over a store said, for the screens that draw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// How many records the last read held, and when (contacts' "N people, updated 3 minutes ago").
    pub read: Option<(u32, Instant)>,
    /// The phone refused the store the last time a read was tried.
    pub denied: bool,
    /// The types the OS refused, as the last health read said.
    pub refused: Vec<String>,
    /// Health Connect would not let the app read in the background (D16): following works
    /// while the app is open.
    pub background_refused: bool,
    /// How many followed rows the last pass doubted: a complete read that lost most of what the
    /// vault follows changes nothing and says how many it doubts.
    pub doubted: u32,
    /// The last read did not cover the whole store (limited access, a file that would not
    /// read): what it did read was merged, and nothing was removed for what it missed.
    pub incomplete: bool,
}

impl Report {
    /// The plain status line a store's screen draws when the last pass was doubted or
    /// incomplete (D12: a partial result shows what was read under a banner; it is not a
    /// failure). The same words in every store.
    #[must_use]
    pub fn status(&self, ctx: &Ctx, store: Store) -> Option<wire::StatusLine> {
        self.sentence(ctx.locale(), store)
            .map(|sentence| wire::StatusLine {
                sentence,
                action_label: String::new(),
                refused: false,
            })
    }

    /// The sentence for a doubted or incomplete pass (doubted wins), produced once: the status
    /// line above and the page note ([`crate::kit::read::Note::partial`]) both say it.
    #[must_use]
    pub fn sentence(&self, locale: Locale, store: Store) -> Option<String> {
        let source = store.source(locale);
        if self.doubted > 0 {
            Some(crate::strings::fill(
                &words::doubted_status(locale),
                &[("source", &source)],
            ))
        } else if self.incomplete {
            Some(crate::strings::fill(
                &words::incomplete_status(locale),
                &[("source", &source)],
            ))
        } else {
            None
        }
    }
}

#[derive(Default)]
struct Inner {
    /// Stores a screen or a service says may have changed.
    changed: BTreeSet<Store>,
    /// Background windows the pass service wants follows run in, by name.
    windows: Vec<String>,
    /// Windows whose follows ended: the pass service may tell the OS.
    released: Vec<String>,
    /// The coordinator asked the folder follower to run a pass; and it said it ended.
    run_files: bool,
    files_ended: bool,
    reports: BTreeMap<Store, Report>,
    /// A coordinator is running in this runtime.
    listening: bool,
}

/// THE BOARD the coordinator, the home screens, the folder follower and the pass service share
/// (`Ctx::follows`). Plain facts and asks under one lock; a screen that adds one wakes the
/// service it is for by name (`Signalled`), exactly as the pass conductor's asks do.
#[derive(Clone, Default)]
pub struct Follows(Arc<Mutex<Inner>>);

impl std::fmt::Debug for Follows {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Follows")
    }
}

fn signal(ctx: &Ctx, screen: &str) {
    ctx.post(
        screen,
        wire::ScreenEvent {
            kind: Some(wire::screen_event::Kind::Signalled(wire::Signalled {})),
        },
    );
}

impl Follows {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `store` may have changed: a screen appeared or was pulled, an import or a resume turned
    /// it on. The coordinator coalesces it with every other trigger. A runtime with no
    /// coordinator (a screen's own test) ignores it.
    pub fn changed(&self, ctx: &Ctx, store: Store) {
        self.lock().changed.insert(store);
        signal(ctx, NAME);
    }

    /// What the last pass over `store` said.
    #[must_use]
    pub fn report(&self, store: Store) -> Report {
        self.lock().reports.get(&store).cloned().unwrap_or_default()
    }

    /// A read of `store` held `count` records and was allowed.
    pub fn read(&self, store: Store, count: u32) {
        let mut inner = self.lock();
        let report = inner.reports.entry(store).or_default();
        report.read = Some((count, Instant::now()));
        report.denied = false;
    }

    /// The phone refused (or allowed again) a read of `store`.
    pub fn denied(&self, store: Store, denied: bool) {
        self.lock().reports.entry(store).or_default().denied = denied;
    }

    /// What the last pass over `store` found of its own reading: how many rows the vault doubted
    /// and whether the read missed part of the store.
    pub fn judged(&self, store: Store, doubted: u32, incomplete: bool) {
        let mut inner = self.lock();
        let report = inner.reports.entry(store).or_default();
        report.doubted = doubted;
        report.incomplete = incomplete;
    }

    /// The types the OS refused in the last read of `store`.
    pub fn refused(&self, store: Store, refused: &[String]) {
        refused.clone_into(&mut self.lock().reports.entry(store).or_default().refused);
    }

    /// Whether the OS refused the background read of `store` at its Connect.
    pub fn background_refused(&self, store: Store, refused: bool) {
        self.lock()
            .reports
            .entry(store)
            .or_default()
            .background_refused = refused;
    }

    // ---- the coordinator's side ------------------------------------------------------------

    pub(crate) fn take_changed(&self) -> BTreeSet<Store> {
        std::mem::take(&mut self.lock().changed)
    }

    pub(crate) fn listen(&self) {
        self.lock().listening = true;
    }

    pub(crate) fn take_windows(&self) -> Vec<String> {
        std::mem::take(&mut self.lock().windows)
    }

    /// The follows of a window ended: wake the pass service, which holds the OS's answer.
    pub(crate) fn release(&self, ctx: &Ctx, window: &str) {
        self.lock().released.push(window.to_owned());
        signal(ctx, crate::passes::service::NAME);
    }

    /// Ask the folder follower for one pass.
    pub(crate) fn run_files(&self, ctx: &Ctx) {
        self.lock().run_files = true;
        signal(ctx, crate::imports::FILES);
    }

    pub(crate) fn take_files_ended(&self) -> bool {
        std::mem::take(&mut self.lock().files_ended)
    }

    // ---- the folder follower's side --------------------------------------------------------

    pub(crate) fn take_run_files(&self) -> bool {
        std::mem::take(&mut self.lock().run_files)
    }

    /// The folder follower's pass ended, however it ended.
    pub(crate) fn files_ended(&self, ctx: &Ctx) {
        self.lock().files_ended = true;
        signal(ctx, NAME);
    }

    // ---- the pass service's side -----------------------------------------------------------

    /// Whether a coordinator runs here: a window's end is held for its follows only if so.
    #[must_use]
    pub(crate) fn listening(&self) -> bool {
        self.lock().listening
    }

    /// A background window finished its backup: follow every store before the OS is told.
    pub(crate) fn window(&self, ctx: &Ctx, window: &str) {
        self.lock().windows.push(window.to_owned());
        signal(ctx, NAME);
    }

    pub(crate) fn take_released(&self) -> Vec<String> {
        std::mem::take(&mut self.lock().released)
    }
}

/// THE ORIGINS THE VAULT FOLLOWS for `system` (`contacts`, `calendar`, `phone_reminders`), by
/// their refs, as it STORES them (`shell.followed-stores`): what a More sheet's stop or turn-on
/// row says, and what a stop retires. It never comes from what a pass has done since launch, so
/// a cold start says the right thing. A stopped follow deletes its origin, so none stored is none
/// followed. `None` when the read did not land: the caller says nothing, never a wrong thing.
#[must_use]
pub(crate) fn stored_origins(ctx: &Ctx, system: &str) -> Option<Vec<String>> {
    stored_stores(ctx, system)
        .map(|stores| stores.into_iter().map(|store| store.origin_ref).collect())
}

/// What the vault's followed origins of `system` FILL (a followed calendar's own id), as it stores
/// them: the things a member cannot delete while they are read from the phone. `None` when the
/// read did not land.
#[must_use]
pub(crate) fn stored_fills(ctx: &Ctx, system: &str) -> Option<Vec<String>> {
    stored_stores(ctx, system).map(|stores| {
        stores
            .into_iter()
            .map(|store| store.fills)
            .filter(|fills| !fills.is_empty())
            .collect()
    })
}

fn stored_stores(ctx: &Ctx, system: &str) -> Option<Vec<wire::FollowedStore>> {
    use wire::app_query_response::Answer;
    match read::read(
        ctx,
        load::shell::FollowedStores::default(),
        |answer| match answer {
            Answer::FollowedStores(held) => Some(held.stores),
            _ => None,
        },
    ) {
        Reading::Data(stores) => Some(
            stores
                .into_iter()
                .filter(|store| store.system == system)
                .collect(),
        ),
        _ => None,
    }
}
