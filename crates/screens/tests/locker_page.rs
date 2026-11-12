//! Locker's reads on the shared page state (#1185): a read that came to nothing is the failure and
//! never an empty page, a refusal is the gate, an item that is gone is a final failure in its own
//! words, and a refresh that failed keeps what was shown under one sentence.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail or refuse. The Locker's own session always goes to the core, so the wall opens as it does.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

mod locker_support;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::locker::{self, routes};
use centraid_screens::strings::{Locale, shared};
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

    fn locker(&self, request: &wire::LockerSessionRequest) -> Result<wire::LockerSessionResponse> {
        self.core.locker_session(request)
    }

    fn push(&self, _update: wire::ScreenUpdate) {}

    fn wake_after(&self, _after: Duration) {}
}

/// A shell: Locker's screens over the door, answering the owner check as a phone does, with the
/// last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
    root: u64,
}

impl<'a> Shell<'a> {
    /// Locker's home is open (the owner check passed) over a door that answers `mode` from the
    /// first read.
    fn new(core: &'a Handle, mode: Mode) -> Self {
        let mut shell = Self {
            runtime: locker::runtime(),
            door: Door {
                core,
                mode: Cell::new(mode),
            },
            views: BTreeMap::new(),
            root: 0,
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
        shell.root = shell
            .views
            .keys()
            .next()
            .copied()
            .expect("Locker's home is open");
        shell
    }

    /// One call, then the owner check answered for as long as one is asked.
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
                        outcome: Some(locker_support::passed(wire::Biometry::Face)),
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

    /// Fail, refuse or answer every read from now on.
    fn reads(&self, mode: Mode) {
        self.door.mode.set(mode);
    }

    fn push(&mut self, route: wire::Route) -> u64 {
        let update = self.call(wire::screen_request::Kind::Nav(wire::NavEvent {
            kind: Some(wire::nav_event::Kind::Push(wire::NavPush {
                tab: locker::TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == locker::TAB))
            .and_then(|stack| stack.entries.last())
            .map(|entry| entry.instance)
            .expect("a push moves the stack")
    }

    fn send(&mut self, instance: u64, event: wire::screen_event::Kind) {
        self.call(wire::screen_request::Kind::Send(wire::InstanceEvent {
            instance,
            event: Some(wire::ScreenEvent { kind: Some(event) }),
        }));
    }

    fn retry_home(&mut self) {
        let root = self.root;
        self.send(
            root,
            wire::screen_event::Kind::LockerHome(wire::LockerHomeEvent {
                kind: Some(wire::locker_home_event::Kind::Refreshed(
                    wire::locker_home_event::Refreshed {},
                )),
            }),
        );
    }

    fn retry_item(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::LockerItem(wire::LockerItemEvent {
                kind: Some(wire::locker_item_event::Kind::Refreshed(
                    wire::locker_item_event::Refreshed {},
                )),
            }),
        );
    }

    fn retry_export(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::LockerExport(wire::LockerExportEvent {
                kind: Some(wire::locker_export_event::Kind::Refreshed(
                    wire::locker_export_event::Refreshed {},
                )),
            }),
        );
    }

    fn home(&self) -> &wire::LockerHomeState {
        match &self.views[&self.root].kind {
            Some(wire::view_state::Kind::LockerHome(state)) => state,
            other => panic!("not Locker's home: {other:?}"),
        }
    }

    fn item(&self, instance: u64) -> &wire::LockerItemState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::LockerItem(state)) => state,
            other => panic!("not an item: {other:?}"),
        }
    }

    fn export(&self, instance: u64) -> &wire::LockerExportState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::LockerExport(state)) => state,
            other => panic!("not the export: {other:?}"),
        }
    }
}

fn state_of(page: &Option<wire::PageState>) -> Option<&State> {
    page.as_ref().expect("a page").state.as_ref()
}

fn failed(page: &Option<wire::PageState>) -> &wire::Failure {
    let Some(State::Failed(failure)) = state_of(page) else {
        panic!("not failed: {page:?}");
    };
    failure
}

fn refused(page: &Option<wire::PageState>) {
    assert!(
        matches!(state_of(page), Some(State::Refused(_))),
        "{page:?}"
    );
}

fn ready(page: &Option<wire::PageState>) {
    let page = page.as_ref().expect("a page");
    assert!(page.state.is_none(), "not ready: {:?}", page.state);
    assert!(page.note.is_none(), "ready with no note: {page:?}");
}

/// Ready, with the one sentence a refresh that failed leaves over what is shown, and Retry.
fn refresh_failed(page: &Option<wire::PageState>) {
    let page = page.as_ref().expect("a page");
    assert!(page.state.is_none(), "not ready: {:?}", page.state);
    let note = page.note.as_ref().expect("a note over what is shown");
    assert_eq!(note.kind, wire::page_note::Kind::Partial as i32);
    assert_eq!(note.sentence, shared::read_refresh_failed(Locale::En));
    assert_eq!(note.action_label, shared::kit_retry(Locale::En));
}

#[test]
fn a_home_that_cannot_be_read_is_failed_or_refused_and_never_an_empty_shelf() {
    let d = locker_support::driver();
    locker_support::login(&d, "i1", "Bank");
    let mut shell = Shell::new(&d.handle, Mode::Fails);
    assert!(!failed(&shell.home().page).permanent);
    assert!(shell.home().content.is_none());
    shell.reads(Mode::Refuses);
    shell.retry_home();
    refused(&shell.home().page);
    assert!(shell.home().band.is_empty(), "no band while the gate is up");
    shell.reads(Mode::Answers);
    shell.retry_home();
    ready(&shell.home().page);
    assert!(shell.home().content.is_some());
}

#[test]
fn a_failed_refresh_keeps_the_shelf_shown_under_one_sentence() {
    let d = locker_support::driver();
    locker_support::login(&d, "i1", "Bank");
    let mut shell = Shell::new(&d.handle, Mode::Answers);
    ready(&shell.home().page);
    shell.reads(Mode::Fails);
    shell.retry_home();
    refresh_failed(&shell.home().page);
    assert!(shell.home().content.is_some(), "the shelf stays");
    shell.reads(Mode::Answers);
    shell.retry_home();
    ready(&shell.home().page);
}

#[test]
fn an_item_that_is_gone_is_a_final_failure_and_a_failed_or_refused_read_is_not() {
    let d = locker_support::driver();
    let mut shell = Shell::new(&d.handle, Mode::Answers);
    let gone = shell.push(routes::item("no-such-item", "Locker"));
    let failure = failed(&shell.item(gone).page);
    assert_eq!(failure.sentence, "This item is gone");
    assert!(failure.permanent, "trying again cannot bring it back");
    assert!(shell.item(gone).content.is_none());

    shell.reads(Mode::Fails);
    let unread = shell.push(routes::item("no-such-item", "Locker"));
    assert!(!failed(&shell.item(unread).page).permanent);
    shell.reads(Mode::Refuses);
    shell.retry_item(unread);
    refused(&shell.item(unread).page);
}

#[test]
fn the_export_page_is_failed_refused_or_ready_and_never_blank() {
    let d = locker_support::driver();
    let mut shell = Shell::new(&d.handle, Mode::Answers);
    shell.reads(Mode::Fails);
    let export = shell.push(routes::export("Locker"));
    assert!(!failed(&shell.export(export).page).permanent);
    assert!(shell.export(export).content.is_none());
    shell.reads(Mode::Refuses);
    shell.retry_export(export);
    refused(&shell.export(export).page);
    shell.reads(Mode::Answers);
    shell.retry_export(export);
    ready(&shell.export(export).page);
    shell.reads(Mode::Fails);
    shell.retry_export(export);
    refresh_failed(&shell.export(export).page);
}

#[test]
fn a_shelf_with_nothing_on_it_is_the_pages_empty_state_with_its_filter_kept() {
    let d = locker_support::driver();
    let mut shell = Shell::new(&d.handle, Mode::Answers);
    // Day one: no item at all is the page's own empty state, with its one action.
    let State::Empty(empty) = state_of(&shell.home().page).expect("a state") else {
        panic!("day one is not empty: {:?}", shell.home().page);
    };
    assert_eq!(empty.headline, "Nothing is kept here yet");
    assert!(!empty.action_label.is_empty());
    // The answer stays, because the header's filter is built from it.
    assert!(shell.home().content.is_some());
    // A refresh that fails over nothing is the failure, never an empty shelf.
    shell.reads(Mode::Fails);
    shell.retry_home();
    assert!(!failed(&shell.home().page).permanent);
}
