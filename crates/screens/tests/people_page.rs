//! People's reads on the shared page state (#1185): a read that came to nothing is the failure
//! and never an empty page, a refusal is the gate, a read that came with nothing is the screen's
//! own empty state (day one, a chip with no one, a term that matched no one, no list yet, no one
//! to merge in), a person who is gone is a final failure in its own words, and a refresh that
//! failed keeps what was shown under one sentence.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail or refuse.

mod people_support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::people::{self, routes};
use centraid_screens::strings::{Locale, shared};
use people_support::{clean, person};
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

/// A shell: People's screens over the door, with the last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
}

impl<'a> Shell<'a> {
    fn new(core: &'a Handle) -> Self {
        let mut shell = Self {
            runtime: people::runtime(),
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
                tab: people::TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == people::TAB))
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
            wire::screen_event::Kind::PeopleHome(wire::PeopleHomeEvent {
                kind: Some(wire::people_home_event::Kind::Refreshed(
                    wire::people_home_event::Refreshed {},
                )),
            }),
        );
    }

    fn retry_person(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::PeoplePerson(wire::PeoplePersonEvent {
                kind: Some(wire::people_person_event::Kind::Refreshed(
                    wire::people_person_event::Refreshed {},
                )),
            }),
        );
    }

    fn retry_lists(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::PeopleLists(wire::PeopleListsEvent {
                kind: Some(wire::people_lists_event::Kind::Refreshed(
                    wire::people_lists_event::Refreshed {},
                )),
            }),
        );
    }

    fn home(&self, instance: u64) -> &wire::PeopleHomeState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::PeopleHome(state)) => state,
            other => panic!("not People's home: {other:?}"),
        }
    }

    fn person(&self, instance: u64) -> &wire::PeoplePersonState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::PeoplePerson(state)) => state,
            other => panic!("not a person: {other:?}"),
        }
    }

    fn lists(&self, instance: u64) -> &wire::PeopleListsState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::PeopleLists(state)) => state,
            other => panic!("not the lists: {other:?}"),
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

fn empty_of(page: &Option<wire::PageState>) -> &wire::EmptyState {
    let Some(State::Empty(empty)) = state_of(page) else {
        panic!("not empty: {page:?}");
    };
    empty
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
fn day_one_is_the_empty_state_with_the_phones_contacts_and_never_ready_data() {
    let d = clean();
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::PeopleDestination::People));
    let state = shell.home(i);
    let empty = empty_of(&state.page);
    assert_eq!(empty.headline, "Add people you keep up with");
    assert_eq!(empty.import_source, wire::ImportSource::Contacts as i32);
    assert!(state.content.is_none());
    // Touch has the same day one.
    let touch = shell.push(routes::home(wire::PeopleDestination::Touch));
    assert_eq!(
        empty_of(&shell.home(touch).page).import_source,
        wire::ImportSource::Contacts as i32
    );
}

#[test]
fn a_home_that_cannot_be_read_is_failed_or_refused_and_never_day_one() {
    let d = clean();
    person(&d, "Dana");
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = shell.push(routes::home(wire::PeopleDestination::People));
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
    ready(&shell.home(i).page);
    assert!(shell.home(i).content.is_some());
}

#[test]
fn a_failed_refresh_keeps_the_people_shown_under_one_sentence() {
    let d = clean();
    person(&d, "Dana");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::PeopleDestination::People));
    ready(&shell.home(i).page);
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    refresh_failed(&shell.home(i).page);
    assert!(shell.home(i).content.is_some(), "the people stay");
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
}

#[test]
fn a_person_that_is_gone_is_a_final_failure_in_its_own_words() {
    let d = clean();
    let dana = person(&d, "Dana");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::person(&dana, "Dana", false));
    ready(&shell.person(i).page);
    shell.reads(Mode::Fails);
    shell.retry_person(i);
    refresh_failed(&shell.person(i).page);
    shell.reads(Mode::Refuses);
    shell.retry_person(i);
    refused(&shell.person(i).page);
    shell.reads(Mode::Answers);
    let gone = shell.push(routes::person("p-nobody", "Nobody", false));
    let failure = failed(&shell.person(gone).page);
    assert_eq!(failure.sentence, "This person is not in People.");
    assert!(failure.permanent, "trying again cannot bring them back");
    assert!(shell.person(gone).content.is_none());
    // Failing to read it again is an ordinary failure, with Retry.
    shell.reads(Mode::Fails);
    shell.retry_person(gone);
    assert!(!failed(&shell.person(gone).page).permanent);
}

#[test]
fn the_lists_page_is_failed_refused_empty_or_ready_never_the_wrong_one() {
    let d = clean();
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::lists("People"));
    assert_eq!(empty_of(&shell.lists(i).page).headline, "No lists yet");
    assert!(!shell.lists(i).add_label.is_empty(), "New list stays");
    shell.reads(Mode::Fails);
    shell.retry_lists(i);
    failed(&shell.lists(i).page);
    assert!(shell.lists(i).add_label.is_empty(), "nothing to add to");
    shell.reads(Mode::Refuses);
    shell.retry_lists(i);
    refused(&shell.lists(i).page);
}
