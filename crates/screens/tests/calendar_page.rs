//! Calendar's reads on the shared page state (#1185): a read that came to nothing is the failure
//! and never an empty page, a refusal is the gate, an event that is gone is a final failure in its
//! own words, and a refresh that failed keeps what was shown under one sentence.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail or refuse.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::agenda;
use centraid_screens::calendar::routes;
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

    fn push(&self, _update: wire::ScreenUpdate) {}

    fn wake_after(&self, _after: Duration) {}
}

/// A shell: Calendar's screens over the door, with the last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
}

impl<'a> Shell<'a> {
    fn new(core: &'a Handle) -> Self {
        let mut shell = Self {
            runtime: agenda::runtime(),
            door: Door {
                core,
                mode: Cell::new(Mode::Answers),
            },
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

    fn call(&mut self, kind: wire::screen_request::Kind) -> wire::ScreenUpdate {
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
                tab: agenda::TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == agenda::TAB))
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

    fn retry_home(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::AgendaHome(wire::AgendaHomeEvent {
                kind: Some(wire::agenda_home_event::Kind::Refreshed(
                    wire::agenda_home_event::Refreshed {},
                )),
            }),
        );
    }

    fn retry_event(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::AgendaEvent(wire::AgendaEventEvent {
                kind: Some(wire::agenda_event_event::Kind::Refreshed(
                    wire::agenda_event_event::Refreshed {},
                )),
            }),
        );
    }

    fn home(&self, instance: u64) -> &wire::AgendaHomeState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::AgendaHome(state)) => state,
            other => panic!("not Calendar's home: {other:?}"),
        }
    }

    fn event(&self, instance: u64) -> &wire::AgendaEventState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::AgendaEvent(state)) => state,
            other => panic!("not an event: {other:?}"),
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

/// Ready, with the note it carries.
fn ready_note(page: &Option<wire::PageState>) -> Option<&wire::PageNote> {
    let page = page.as_ref().expect("a page");
    assert!(page.state.is_none(), "not ready: {:?}", page.state);
    page.note.as_ref()
}

fn ready(page: &Option<wire::PageState>) {
    assert!(ready_note(page).is_none(), "ready with no note: {page:?}");
}

/// The one sentence a refresh that failed leaves over what is shown, with Retry.
fn refresh_failed(page: &Option<wire::PageState>) {
    let note = ready_note(page).expect("a note over what is shown");
    assert_eq!(note.kind, wire::page_note::Kind::Partial as i32);
    assert_eq!(note.sentence, shared::read_refresh_failed(Locale::En));
    assert_eq!(note.action_label, shared::kit_retry(Locale::En));
}

#[test]
fn a_home_that_cannot_be_read_is_failed_or_refused_and_never_an_empty_agenda() {
    let d = Driver::founded();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = shell.push(routes::home(wire::AgendaDestination::Schedule));
    assert!(!failed(&shell.home(i).page).permanent);
    assert!(shell.home(i).content.is_none());
    shell.reads(Mode::Refuses);
    shell.retry_home(i);
    refused(&shell.home(i).page);
    assert!(
        shell.home(i).band.is_empty(),
        "no band while the gate is up"
    );
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    assert!(
        shell
            .home(i)
            .page
            .as_ref()
            .is_some_and(|page| matches!(page.state, None | Some(State::Empty(_))))
    );
}

#[test]
fn a_failed_refresh_keeps_the_window_shown_under_one_sentence() {
    let d = Driver::founded();
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::AgendaDestination::Month));
    ready(&shell.home(i).page);
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    refresh_failed(&shell.home(i).page);
    assert!(shell.home(i).content.is_some(), "the month stays");
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
}

#[test]
fn an_event_that_is_gone_is_a_final_failure_and_a_refusal_is_the_gate() {
    let d = Driver::founded();
    let mut shell = Shell::new(&d.handle);
    let gone = shell.push(routes::event(
        "no-such-event",
        "no-such-event",
        None,
        "2099-06-15",
    ));
    let failure = failed(&shell.event(gone).page);
    assert_eq!(failure.sentence, "This event was removed.");
    assert!(failure.permanent, "trying again cannot bring it back");
    assert!(shell.event(gone).content.is_none());
    // Failing to read it again is an ordinary failure, with Retry.
    shell.reads(Mode::Fails);
    shell.retry_event(gone);
    assert!(!failed(&shell.event(gone).page).permanent);
    shell.reads(Mode::Refuses);
    shell.retry_event(gone);
    refused(&shell.event(gone).page);
}
