//! THE SWEEP (#1185): every screen that reads says so on the kit's page. Opened over a door whose
//! reads all fail, a screen is Failed, never Empty and never Ready; over a door that refuses, a
//! screen that asks the vault is Refused; and over a door that answers, it reads again and is ready.
//! Each failure also keeps a way out of the page (the page's own title and back words).
//!
//! `cargo xtask rules`' `page-state` rule is the static half (a screen that reads must carry a
//! page); this is the behaviour half, over a table of every read screen's route.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::strings::{Locale, shared};
use centraid_screens::testing::Driver;
use wire::page_state::State;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Answers,
    Fails,
    Refuses,
}

/// The core's own door, except while it is told to fail or to refuse every read.
struct Door<'a> {
    core: &'a Handle,
    mode: Cell<Mode>,
}

impl ScreenCtx for Door<'_> {
    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        match self.mode.get() {
            Mode::Answers => self.core.load(request),
            Mode::Fails => Err(CoreError::Unavailable {
                reason: "test read failure".into(),
            }),
            Mode::Refuses => Ok(wire::LoadResponse {
                answer: Some(wire::AppQueryResponse {
                    answer: Some(wire::app_query_response::Answer::Denied(
                        wire::AppQueryDenial {
                            code: Some("consent.revoked".to_owned()),
                            ..Default::default()
                        },
                    )),
                }),
                ..Default::default()
            }),
        }
    }

    fn act(&self, request: &wire::ActRequest) -> Result<wire::ActResponse> {
        self.core.act(request)
    }

    /// Locker's own session always goes to the core, so its wall opens as it does.
    fn locker(&self, request: &wire::LockerSessionRequest) -> Result<wire::LockerSessionResponse> {
        self.core.locker_session(request)
    }

    fn push(&self, _update: wire::ScreenUpdate) {}

    fn wake_after(&self, _after: Duration) {}
}

/// A shell: one app's screens over the door.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    tab: &'static str,
    views: BTreeMap<u64, wire::ViewState>,
}

impl<'a> Shell<'a> {
    fn new(core: &'a Handle, runtime: centraid_screens::Runtime, tab: &'static str) -> Self {
        let mut shell = Self {
            runtime,
            door: Door {
                core,
                mode: Cell::new(Mode::Answers),
            },
            tab,
            views: BTreeMap::new(),
        };
        shell.call(wire::screen_request::Kind::Environment(wire::Environment {
            locale: "en".to_owned(),
            zone: "UTC".to_owned(),
            platform: "ios".to_owned(),
            ..Default::default()
        }));
        shell.call(wire::screen_request::Kind::Snapshot(
            wire::SnapshotRequest {},
        ));
        shell
    }

    /// One call, then the owner check answered (as a phone does) for as long as one is asked.
    fn call(&mut self, kind: wire::screen_request::Kind) -> wire::ScreenUpdate {
        let mut update = self.raw(kind);
        let mut asked = update.clone();
        while let Some(check) = asked.effects.iter().find(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(wire::effect::Kind::OwnerCheck(check)) if check.ask
            )
        }) {
            let answer = wire::screen_request::Kind::Send(wire::InstanceEvent {
                instance: check.instance,
                event: Some(wire::ScreenEvent {
                    kind: Some(wire::screen_event::Kind::EffectResult(wire::EffectResult {
                        effect_id: check.effect_id,
                        outcome: Some(wire::effect_result::Outcome::OwnerChecked(
                            wire::OwnerChecked {
                                available: true,
                                biometry: wire::Biometry::Face as i32,
                                outcome: wire::owner_checked::Outcome::Succeeded as i32,
                            },
                        )),
                    })),
                }),
            });
            asked = self.raw(answer);
            update = asked.clone();
        }
        update
    }

    fn raw(&mut self, kind: wire::screen_request::Kind) -> wire::ScreenUpdate {
        let update = self
            .runtime
            .call(&self.door, &wire::ScreenRequest { kind: Some(kind) })
            .expect("the runtime answers")
            .update
            .unwrap_or_default();
        for view in &update.views {
            self.views.insert(view.instance, view.clone());
        }
        update
    }

    fn reads(&self, mode: Mode) {
        self.door.mode.set(mode);
    }

    fn push(&mut self, route: wire::Route) -> Option<u64> {
        let update = self.call(wire::screen_request::Kind::Nav(wire::NavEvent {
            kind: Some(wire::nav_event::Kind::Push(wire::NavPush {
                tab: self.tab.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == self.tab))
            .and_then(|stack| stack.entries.last())
            .map(|entry| entry.instance)
    }

    /// The vault said something changed: the page reads again.
    fn changed(&mut self, instance: u64) {
        self.call(wire::screen_request::Kind::Send(wire::InstanceEvent {
            instance,
            event: Some(wire::ScreenEvent {
                kind: Some(wire::screen_event::Kind::DataChanged(
                    wire::DataChanged::default(),
                )),
            }),
        }));
    }

    fn page(&self, instance: u64) -> Option<&wire::PageState> {
        use wire::view_state::Kind as K;
        match &self.views[&instance].kind {
            Some(K::Counter(state)) => state.page.as_ref(),
            Some(K::AgendaHome(state)) => state.page.as_ref(),
            Some(K::AgendaEvent(state)) => state.page.as_ref(),
            Some(K::AgendaEditor(state)) => state.page.as_ref(),
            Some(K::TodoList(state)) => state.page.as_ref(),
            Some(K::TodoProject(state)) => state.page.as_ref(),
            Some(K::TodoDetail(state)) => state.page.as_ref(),
            Some(K::TodoCatchUp(state)) => state.page.as_ref(),
            // The home draws one tab's read at a time; the tab that is open carries its page.
            Some(K::PhotosHome(state)) => state
                .library
                .as_ref()
                .and_then(|tab| tab.page.as_ref())
                .or_else(|| state.collections.as_ref().and_then(|tab| tab.page.as_ref()))
                .or_else(|| state.search.as_ref().and_then(|tab| tab.page.as_ref())),
            Some(K::PhotosShelf(state)) => state.page.as_ref(),
            Some(K::PhotosPicker(state)) => state.page.as_ref(),
            Some(K::PhotosPlaces(state)) => state.page.as_ref(),
            Some(K::PhotosLightbox(state)) => state.page.as_ref(),
            Some(K::PhotosEditor(state)) => state.page.as_ref(),
            Some(K::LockerHome(state)) => state.page.as_ref(),
            Some(K::LockerItem(state)) => state.page.as_ref(),
            Some(K::LockerEditor(state)) => state.page.as_ref(),
            Some(K::LockerExport(state)) => state.page.as_ref(),
            Some(K::LockerImport(state)) => state.page.as_ref(),
            Some(K::MoneyHome(state)) => state.page.as_ref(),
            Some(K::MoneyTransaction(state)) => state.page.as_ref(),
            Some(K::MoneyTarget(state)) => state.page.as_ref(),
            Some(K::MoneySearch(state)) => state.page.as_ref(),
            Some(K::MoneyRecurring(state)) => state.page.as_ref(),
            Some(K::MoneyAccounts(state)) => state.page.as_ref(),
            Some(K::MoneyCategories(state)) => state.page.as_ref(),
            Some(K::MoneyRules(state)) => state.page.as_ref(),
            Some(K::MoneyImport(state)) => state.page.as_ref(),
            Some(K::DocsDrive(state)) => state.page.as_ref(),
            Some(K::DocsDocument(state)) => state.page.as_ref(),
            Some(K::DocsEditor(state)) => state.page.as_ref(),
            Some(K::HealthHome(state)) => state.page.as_ref(),
            Some(K::HealthMetric(state)) => state.page.as_ref(),
            Some(K::HealthWorkout(state)) => state.page.as_ref(),
            Some(K::NotesHome(state)) => state.page.as_ref(),
            Some(K::NotesEditor(state)) => state.page.as_ref(),
            Some(K::PeopleHome(state)) => state.page.as_ref(),
            Some(K::PeoplePerson(state)) => state.page.as_ref(),
            Some(K::PeopleEditor(state)) => state.page.as_ref(),
            Some(K::PeopleLists(state)) => state.page.as_ref(),
            Some(K::Trash(state)) => state.page.as_ref(),
            Some(K::Transfer(state)) => state.page.as_ref(),
            Some(K::Earlier(state)) => state.page.as_ref(),
            Some(K::BackupHome(state)) => state.page.as_ref(),
            Some(K::Home(state)) => state.page.as_ref(),
            Some(K::HomeSearch(state)) => state.page.as_ref(),
            Some(K::Settings(state)) => state.page.as_ref(),
            _ => None,
        }
    }
}

/// One screen under the sweep: its name, and the route that opens it. `reads` is whether opening it
/// asks the vault at once (a search page at rest asks nothing until a term is typed).
struct Screen {
    name: &'static str,
    route: wire::Route,
    reads: bool,
    /// Whether the vault's gate can refuse the read: an app query can; the backup's standing is the
    /// phone's own reading of its store and has no gate, so a refusal is only a read that failed.
    gated: bool,
    /// Whether it lists what the vault holds, so an answering vault makes it ready (a screen of one
    /// named thing the vault does not hold stays gone).
    lists: bool,
}

/// A screen that lists what the vault holds.
fn list(name: &'static str, route: wire::Route) -> Screen {
    Screen {
        lists: true,
        ..screen(name, route)
    }
}

fn screen(name: &'static str, route: wire::Route) -> Screen {
    Screen {
        name,
        route,
        reads: true,
        gated: true,
        lists: false,
    }
}

/// An app's screens: its runtime, its tab and every route that reads.
struct App {
    runtime: fn() -> centraid_screens::Runtime,
    /// The core the app's screens open over: Locker's is keyed and its session open.
    vault: fn() -> Driver,
    tab: &'static str,
    screens: Vec<Screen>,
}

fn founded() -> Driver {
    Driver::founded()
}

/// A keyed core whose Locker session is open, as it is once the owner check has passed.
fn unlocked() -> Driver {
    let d = Driver::keyed(centraid_screens::locker::runtime());
    d.handle
        .locker_session(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Unlock(
                wire::LockerUnlock::default(),
            )),
        })
        .expect("the session answers");
    d
}

fn apps() -> Vec<App> {
    use centraid_screens::kit::earlier;
    vec![
        App {
            runtime: centraid_screens::money::runtime,
            vault: founded,
            tab: centraid_screens::money::TAB,
            screens: {
                use centraid_screens::money::routes as r;
                vec![
                    list("money home", r::home(wire::MoneyDestination::Activity)),
                    list("money spending", r::home(wire::MoneyDestination::Spending)),
                    list("money cash flow", r::home(wire::MoneyDestination::Cashflow)),
                    screen("money transaction", r::transaction("x", "Money")),
                    screen("money target", r::target("2026-10", "x", "USD")),
                    // A search at rest reads nothing until a term is typed.
                    Screen {
                        reads: false,
                        ..screen("money search", r::search("Money"))
                    },
                    list("money recurring", r::recurring("Money")),
                    list("money accounts", r::accounts("Money")),
                    list("money categories", r::categories("Money")),
                    list("money rules", r::rules("Money")),
                    screen("money import", r::import("Money")),
                    list("money trash", r::trash()),
                    screen(
                        "money earlier",
                        earlier::route(centraid_screens::money::EARLIER, "x", "Money"),
                    ),
                ]
            },
        },
        App {
            runtime: centraid_screens::notes::runtime,
            vault: founded,
            tab: centraid_screens::notes::TAB,
            screens: {
                use centraid_screens::notes::routes as r;
                vec![
                    list(
                        "notes home",
                        r::home(wire::NotesPlace::Unspecified, "", "", false),
                    ),
                    screen("notes editor", r::editor("x")),
                    list("notes trash", r::trash()),
                    screen(
                        "notes earlier",
                        earlier::route(centraid_screens::notes::EARLIER, "x", "Notes"),
                    ),
                ]
            },
        },
        App {
            runtime: centraid_screens::docs::runtime,
            vault: founded,
            tab: centraid_screens::docs::TAB,
            screens: {
                use centraid_screens::docs::routes as r;
                vec![
                    list(
                        "docs drive",
                        r::drive(wire::DocsDestination::Unspecified, "", "", ""),
                    ),
                    screen("docs document", r::document("x", "Doc", "Docs")),
                    screen("docs editor", r::editor("x", "Doc")),
                    list("docs trash", r::trash()),
                    screen(
                        "docs earlier",
                        earlier::route(centraid_screens::docs::EARLIER, "x", "Docs"),
                    ),
                ]
            },
        },
        App {
            runtime: centraid_screens::people::runtime,
            vault: founded,
            tab: centraid_screens::people::TAB,
            screens: {
                use centraid_screens::people::routes as r;
                vec![
                    list("people home", r::home(wire::PeopleDestination::Unspecified)),
                    screen("people person", r::person("x", "Ada", false)),
                    screen("people editor", r::editor("x")),
                    list("people lists", r::lists("People")),
                    list("people trash", r::trash()),
                    screen(
                        "people earlier",
                        earlier::route(centraid_screens::people::EARLIER, "x", "People"),
                    ),
                ]
            },
        },
        App {
            runtime: centraid_screens::health::runtime,
            vault: founded,
            tab: centraid_screens::health::TAB,
            screens: {
                use centraid_screens::health::routes as r;
                vec![
                    list("health home", r::home(wire::HealthDestination::Unspecified)),
                    screen("health metric", r::metric("steps", "Health")),
                    screen("health workout", r::workout("x", "Health")),
                    // What it shows is the phone's word on its permissions, not a read of the vault.
                    Screen {
                        reads: false,
                        ..screen("health connect", r::connect("Health"))
                    },
                    list("health trash", r::trash()),
                    screen(
                        "health earlier",
                        earlier::route(centraid_screens::health::EARLIER, "x", "Health"),
                    ),
                ]
            },
        },
        App {
            runtime: centraid_screens::photos::runtime,
            vault: founded,
            tab: centraid_screens::photos::TAB,
            screens: {
                use centraid_screens::photos::routes as r;
                vec![
                    list(
                        "photos home",
                        r::home(wire::PhotosDestination::Unspecified, None),
                    ),
                    screen("photos places", r::places()),
                    screen("photos editor", r::editor("x")),
                    screen("photos lightbox", r::lightbox("x", &[], "")),
                ]
            },
        },
        App {
            runtime: centraid_screens::locker::runtime,
            vault: unlocked,
            tab: centraid_screens::locker::TAB,
            screens: {
                use centraid_screens::locker::routes as r;
                vec![
                    list("locker home", r::home(wire::LockerDestination::Unspecified)),
                    screen("locker item", r::item("x", "Locker", "")),
                    screen("locker edit", r::edit("x")),
                    screen("locker export", r::export("Locker")),
                    screen("locker import", r::import("Locker")),
                    list("locker trash", r::trash()),
                    screen(
                        "locker earlier",
                        earlier::route(centraid_screens::locker::EARLIER, "x", "Locker"),
                    ),
                ]
            },
        },
        App {
            runtime: centraid_screens::standard,
            vault: founded,
            tab: "home",
            screens: {
                use centraid_screens::backup::routes as r;
                vec![
                    Screen {
                        gated: false,
                        ..list("backup home", r::home())
                    },
                    // These draw what the phone holds, not a read of the vault.
                    Screen {
                        reads: false,
                        ..screen("backup add destination", r::add_destination())
                    },
                    Screen {
                        reads: false,
                        ..screen("backup show key", r::show_key())
                    },
                ]
            },
        },
        App {
            runtime: centraid_screens::agenda::runtime,
            vault: founded,
            tab: centraid_screens::agenda::TAB,
            screens: {
                use centraid_screens::calendar::routes as c;
                use centraid_screens::reminders::routes as t;
                vec![
                    list(
                        "calendar schedule",
                        c::home(wire::AgendaDestination::Schedule),
                    ),
                    list("calendar month", c::home(wire::AgendaDestination::Month)),
                    screen("calendar event", c::event("x", "x", None, "2026-06-15")),
                    list("calendar trash", c::trash()),
                    list("reminders home", t::home()),
                    list("reminders todo", t::todo_list(wire::TodoView::Unspecified)),
                    screen("reminders project", t::project("x", "Project")),
                    list("reminders catch up", t::catch_up()),
                    list("reminders trash", t::trash()),
                ]
            },
        },
    ]
}

#[test]
fn a_screen_over_a_door_whose_reads_all_fail_is_failed_never_empty_or_ready() {
    for app in apps() {
        let d = (app.vault)();
        for screen in app.screens.iter().filter(|screen| screen.reads) {
            let mut shell = Shell::new(&d.handle, (app.runtime)(), app.tab);
            shell.reads(Mode::Fails);
            let Some(i) = shell.push(screen.route.clone()) else {
                panic!("{}: the route did not open", screen.name);
            };
            let page = shell
                .page(i)
                .unwrap_or_else(|| panic!("{}: the screen carries no page", screen.name));
            let Some(State::Failed(failure)) = page.state.as_ref() else {
                panic!(
                    "{}: a failed read is not a failed page: {page:?}",
                    screen.name
                );
            };
            assert!(
                !failure.permanent,
                "{}: a failed read can be tried again",
                screen.name
            );
            assert_eq!(
                failure.sentence,
                shared::read_failed(Locale::En),
                "{}",
                screen.name
            );
        }
    }
}

#[test]
fn a_screen_over_a_door_that_refuses_is_refused_with_a_way_to_say_why() {
    for app in apps() {
        let d = (app.vault)();
        for screen in app.screens.iter().filter(|screen| screen.reads) {
            let mut shell = Shell::new(&d.handle, (app.runtime)(), app.tab);
            shell.reads(Mode::Refuses);
            let Some(i) = shell.push(screen.route.clone()) else {
                panic!("{}: the route did not open", screen.name);
            };
            let page = shell
                .page(i)
                .unwrap_or_else(|| panic!("{}: the screen carries no page", screen.name));
            if !screen.gated {
                assert!(
                    matches!(page.state.as_ref(), Some(State::Failed(_))),
                    "{}: an ungated read that is refused is a read that failed: {page:?}",
                    screen.name
                );
                continue;
            }
            let Some(State::Refused(gate)) = page.state.as_ref() else {
                panic!(
                    "{}: a refused read is not a refused page: {page:?}",
                    screen.name
                );
            };
            assert!(
                !gate.title.is_empty(),
                "{}: the gate says what it is",
                screen.name
            );
        }
    }
}

#[test]
fn a_failed_page_reads_again_when_the_vault_changes_and_answers() {
    for app in apps() {
        let d = (app.vault)();
        // Screens of one thing the vault does not hold ("x") stay failed for good: only the
        // screens that list read their way back.
        for screen in app
            .screens
            .iter()
            .filter(|screen| screen.reads && screen.lists)
        {
            let mut shell = Shell::new(&d.handle, (app.runtime)(), app.tab);
            shell.reads(Mode::Fails);
            let i = shell
                .push(screen.route.clone())
                .unwrap_or_else(|| panic!("{}: the route did not open", screen.name));
            shell.reads(Mode::Answers);
            shell.changed(i);
            let page = shell.page(i);
            assert!(
                !matches!(
                    page.and_then(|page| page.state.as_ref()),
                    Some(State::Failed(_) | State::Refused(_))
                ),
                "{}: the page did not read again: {page:?}",
                screen.name
            );
        }
    }
}
