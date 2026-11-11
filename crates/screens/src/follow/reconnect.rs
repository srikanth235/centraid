//! THE RECONNECT PAGE (#1185): after a restore onto another phone the vault still holds the
//! stores it was following (its `origin` rows survive in the backup), but which stores THIS phone
//! follows is a habit this phone keeps, so nothing is followed and nothing said so. This page
//! lists what the vault followed and this phone does not, and offers Connect for each. It never
//! connects anything by itself: a tap is the member's word, and the connect that follows is the
//! one the store's own page runs (the OS asks its permission then).
//!
//! | Row | What Connect does |
//! |---|---|
//! | Phone contacts | the People import ([`ContactsFollow::import`]) |
//! | Phone calendars | the Calendar import ([`CalendarFollow::import`]) |
//! | Health | opens Health's connect page, where the types are chosen |
//! | A folder | the folder picker (`FollowFolder`); the new origin fills the Docs folder the old one filled, and the old origin is retired |
//!
//! The page is the kit's transfer view, so both shells draw it as they draw every import page.
//! Whether this phone follows a store is asked of the same keychain habit the coordinator reads
//! (and of the shell, for a folder: a listing that leaves the folder out says it is not reachable
//! here), and a failed question offers the row, since a Connect is never silent and never wrong.

use std::collections::{BTreeSet, VecDeque};

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::effect_result::Outcome as O;
use wire::screen_event::Kind as E;

use crate::calendar::follow::{self as calendar, CalendarFollow};
use crate::catalog::load;
use crate::health;
use crate::kit::read::{self, Reading};
use crate::kit::transfer;
use crate::people::contacts::{self, ContactsFollow};
use crate::screen::{Ctx, Screen};
use crate::strings::{fill, follow as words, shared};

/// The route name of the page.
pub const NAME: &str = "follow.reconnect";

const CONTACTS: &str = "contacts";
const CALENDAR: &str = "calendar";
const HEALTH: &str = "health";
const FOLDER: &str = "folder:";

/// The page, as a route.
#[must_use]
pub fn route() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: NAME.to_owned(),
        args: Some(wire::route::Args::Reconnect(wire::ReconnectRoute {})),
    }
}

/// Whether the vault in front holds any store a phone followed: what a restore asks before it
/// offers the page, so a vault that followed nothing is not shown an empty one.
#[must_use]
pub fn vault_followed_stores(ctx: &Ctx) -> bool {
    matches!(stores(ctx), Reading::Data(stores) if !stores.is_empty())
}

fn stores(ctx: &Ctx) -> Reading<Vec<wire::FollowedStore>> {
    read::read(
        ctx,
        load::shell::FollowedStores::default(),
        |answer| match answer {
            // The Reconnect page asks the phone about its own stores; Reminders' lists are
            // Reminders' (its More sheet reads them).
            Answer::FollowedStores(held) => Some(
                held.stores
                    .into_iter()
                    .filter(|store| store.system != crate::imports::reminders::SYSTEM)
                    .collect(),
            ),
            _ => None,
        },
    )
}

/// The page's registry entry.
#[must_use]
pub fn registry() -> crate::Registry {
    crate::Registry::default().with(NAME, |_| Some(Box::new(Reconnect::new())))
}

/// A question asked of this phone, one at a time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Check {
    Contacts,
    Calendar,
    Health,
    Folders,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    /// The vault has not been read.
    Loading,
    /// The vault was read and the phone is being asked.
    Checking,
    Ready,
    /// The vault could not be read.
    Failed,
}

struct Reconnect {
    stage: Stage,
    stores: Vec<wire::FollowedStore>,
    queue: VecDeque<Check>,
    waiting: Option<Check>,
    /// Where, in the effects the last update asked for, the check's stands.
    asking: Option<usize>,
    /// The number the runtime gave the check's effect: every other answer is a flow's.
    check_effect: Option<u64>,
    /// The rows this phone does not follow, by key.
    open: BTreeSet<String>,
    contacts: ContactsFollow,
    calendar: CalendarFollow,
    /// The origin whose folder the picker is out for, and the effect that asked.
    picking: Option<(String, Option<u64>)>,
    /// Health's connect page was opened: the phone is asked again when its write lands.
    health_opened: bool,
}

impl Reconnect {
    fn new() -> Self {
        Self {
            stage: Stage::Loading,
            stores: Vec::new(),
            queue: VecDeque::new(),
            waiting: None,
            asking: None,
            check_effect: None,
            open: BTreeSet::new(),
            contacts: ContactsFollow::new(),
            calendar: CalendarFollow::new(),
            picking: None,
            health_opened: false,
        }
    }

    fn has(&self, system: &str) -> bool {
        self.stores.iter().any(|store| store.system == system)
    }

    /// Read the vault, then ask this phone about each system it holds.
    fn reload(&mut self, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        match stores(ctx) {
            Reading::Data(stores) => {
                self.stores = stores;
                self.stage = Stage::Checking;
            }
            _ => {
                self.stage = Stage::Failed;
                return;
            }
        }
        self.open.clear();
        self.queue.clear();
        self.waiting = None;
        for (system, check) in [
            (CONTACTS, Check::Contacts),
            (CALENDAR, Check::Calendar),
            (HEALTH, Check::Health),
            ("files", Check::Folders),
        ] {
            if self.has(system) {
                self.queue.push_back(check);
            }
        }
        self.ask_next(out);
    }

    fn ask_next(&mut self, out: &mut Vec<wire::Effect>) {
        let Some(check) = self.queue.pop_front() else {
            self.stage = Stage::Ready;
            return;
        };
        self.waiting = Some(check);
        let effect = match check {
            Check::Contacts => contacts::habit_read(),
            Check::Calendar => calendar::habit_read(),
            Check::Health => health::follow::habit_read(),
            Check::Folders => wire::Effect {
                kind: Some(wire::effect::Kind::FoldersRead(wire::FoldersRead {
                    origins: self
                        .stores
                        .iter()
                        .filter(|store| store.system == "files")
                        .map(|store| store.origin_ref.clone())
                        .collect(),
                })),
            },
        };
        self.asking = Some(out.len());
        self.check_effect = None;
        out.push(effect);
    }

    /// The phone answered the question asked.
    fn answered(&mut self, check: Check, outcome: &O, out: &mut Vec<wire::Effect>) {
        match (check, outcome) {
            // A habit of any kind is this phone's own word (followed, or paused on purpose).
            (Check::Contacts, O::Keychain(value)) if value.found => {}
            (Check::Calendar, O::Keychain(value)) if value.found => {}
            (Check::Health, O::Keychain(value)) if health::follow::device_of(value).connected => {}
            (Check::Folders, O::FoldersListing(listing)) => {
                for store in self.stores.iter().filter(|store| store.system == "files") {
                    if !listing
                        .folders
                        .iter()
                        .any(|folder| folder.origin == store.origin_ref)
                    {
                        self.open.insert(format!("{FOLDER}{}", store.origin_id));
                    }
                }
            }
            (Check::Folders, _) => {
                for store in self.stores.iter().filter(|store| store.system == "files") {
                    self.open.insert(format!("{FOLDER}{}", store.origin_id));
                }
            }
            (Check::Contacts, _) => {
                self.open.insert(CONTACTS.to_owned());
            }
            (Check::Calendar, _) => {
                self.open.insert(CALENDAR.to_owned());
            }
            (Check::Health, _) => {
                self.open.insert(HEALTH.to_owned());
            }
        }
        self.waiting = None;
        self.ask_next(out);
    }

    /// The rows still to offer, in the order the page lists them.
    fn rows(&self, ctx: &Ctx) -> Vec<wire::TransferRow> {
        let locale = ctx.locale();
        let connect = words::reconnect_connect(locale);
        let mut rows = Vec::new();
        let mut push = |key: &str, label: String| {
            rows.push(transfer::row(key, &label, &connect, true, ""));
        };
        if self.open.contains(CONTACTS) && !self.contacts.followed() {
            push(CONTACTS, words::reconnect_contacts(locale));
        }
        if self.open.contains(CALENDAR) && !self.calendar.followed() {
            push(CALENDAR, words::reconnect_calendars(locale));
        }
        if self.open.contains(HEALTH) {
            push(HEALTH, health::Store::of(ctx).name(locale));
        }
        for store in self.stores.iter().filter(|store| store.system == "files") {
            let key = format!("{FOLDER}{}", store.origin_id);
            if self.open.contains(&key) {
                push(
                    &key,
                    fill(&words::reconnect_folder(locale), &[("label", &store.label)]),
                );
            }
        }
        rows
    }

    fn tapped(&mut self, key: &str, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.stage != Stage::Ready || !self.open.contains(key) {
            return Vec::new();
        }
        match key {
            CONTACTS => self.contacts.import(ctx),
            CALENDAR => self.calendar.import(ctx),
            HEALTH => {
                self.health_opened = true;
                vec![wire::Effect {
                    kind: Some(wire::effect::Kind::OpenRoute(wire::OpenRoute {
                        route: Some(health::routes::connect(&words::reconnect_title(
                            ctx.locale(),
                        ))),
                    })),
                }]
            }
            folder => {
                let Some(origin) = folder.strip_prefix(FOLDER) else {
                    return Vec::new();
                };
                if self.picking.is_some() {
                    return Vec::new();
                }
                self.picking = Some((origin.to_owned(), None));
                self.asking = Some(0);
                vec![wire::Effect {
                    kind: Some(wire::effect::Kind::FollowFolder(wire::FollowFolder {})),
                }]
            }
        }
    }

    /// The shell followed a folder: `imports.files` follows it from now on, in the Docs folder the
    /// vault's old origin of the folder filled, and retires that origin (every document stays,
    /// and the new origin re-finds them by name).
    fn folder_followed(&mut self, ctx: &Ctx, followed: &wire::FolderFollowed) {
        let Some((origin_id, _)) = self.picking.take() else {
            return;
        };
        let replaces = self
            .stores
            .iter()
            .find(|store| store.origin_id == origin_id)
            .map(|old| old.origin_ref.clone());
        ctx.post(
            crate::imports::FILES,
            wire::ScreenEvent {
                kind: Some(E::ImportsFiles(wire::ImportsFilesEvent {
                    kind: Some(wire::imports_files_event::Kind::FolderFollowed(
                        wire::imports_files_event::FolderFollowed {
                            origin: followed.origin.clone(),
                            name: followed.name.clone(),
                            replaces,
                        },
                    )),
                })),
            },
        );
        self.open.remove(&format!("{FOLDER}{origin_id}"));
    }

    fn result(&mut self, result: &wire::EffectResult, ctx: &Ctx, out: &mut Vec<wire::Effect>) {
        let Some(outcome) = result.outcome.as_ref() else {
            return;
        };
        if let Some(check) = self.waiting
            && self.check_effect == Some(result.effect_id)
        {
            self.answered(check, outcome, out);
            return;
        }
        if let Some((_, effect)) = &self.picking
            && *effect == Some(result.effect_id)
        {
            match outcome {
                O::FolderFollowed(followed) => self.folder_followed(ctx, followed),
                // A closed picker (done) or a refusal: nothing was connected.
                _ => self.picking = None,
            }
            return;
        }
        let event = E::EffectResult(result.clone());
        if let Some(effects) = self.contacts.on_event(&event, ctx) {
            out.extend(effects);
        } else if let Some(effects) = self.calendar.on_event(&event, ctx) {
            out.extend(effects);
        }
    }
}

impl Screen for Reconnect {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        let mut out = Vec::new();
        match event.kind {
            Some(E::Appeared(_) | E::EnvironmentChanged(_)) => self.reload(ctx, &mut out),
            // A write landed (health's connect, a folder's follow): ask the phone again, unless
            // a question is out.
            Some(E::DataChanged(_)) if self.waiting.is_none() && self.picking.is_none() => {
                if self.health_opened {
                    self.health_opened = false;
                    self.reload(ctx, &mut out);
                }
            }
            Some(E::Transfer(tapped)) => out = self.tapped(&tapped.key, ctx),
            Some(E::EffectResult(result)) => self.result(&result, ctx, &mut out),
            _ => {}
        }
        out
    }

    fn effects_numbered(&mut self, ids: &[Option<u64>]) {
        let Some(index) = self.asking.take() else {
            return;
        };
        let id = ids.get(index).copied().flatten();
        if let Some((_, effect)) = self.picking.as_mut()
            && self.waiting.is_none()
        {
            *effect = id;
        } else {
            self.check_effect = id;
        }
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let rows = if self.stage == Stage::Ready {
            self.rows(ctx)
        } else {
            Vec::new()
        };
        let status = match self.stage {
            Stage::Failed => Some(wire::StatusLine {
                sentence: words::reconnect_failed(locale),
                action_label: String::new(),
                refused: false,
            }),
            _ => self
                .contacts
                .status()
                .or_else(|| self.calendar.status())
                .cloned(),
        };
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Transfer(wire::TransferView {
                app_id: String::new(),
                title: words::reconnect_title(locale),
                back_label: shared::back(locale),
                headline: if self.stage == Stage::Ready && rows.is_empty() {
                    words::reconnect_none(locale)
                } else {
                    String::new()
                },
                lede: words::reconnect_lede(locale),
                rows,
                actions: Vec::new(),
                busy: matches!(self.stage, Stage::Loading | Stage::Checking),
                status,
            })),
            ..wire::ViewState::default()
        }
    }
}
