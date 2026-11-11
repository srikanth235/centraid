//! Health's reads on the shared page state (#1185): a read that came to nothing is the failure
//! and never an empty page, a refusal is the gate, a read that came with nothing is the screen's
//! own empty state (nothing connected, a Trends period or a Workouts list with nothing in it, a
//! metric with no row in its period), a workout that is gone is a final failure in its own
//! words, and a refresh that failed keeps what was shown under one sentence.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail or refuse.

mod health_support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::health::{self, routes};
use centraid_screens::strings::{Locale, shared};
use health_support::{connect_store, driver, record, today, workout};
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

/// A shell: Health's screens over the door, with the last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
}

impl<'a> Shell<'a> {
    fn new(core: &'a Handle) -> Self {
        let mut shell = Self {
            runtime: health::runtime(),
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
                tab: health::TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == health::TAB))
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
            wire::screen_event::Kind::HealthHome(wire::HealthHomeEvent {
                kind: Some(wire::health_home_event::Kind::Refreshed(
                    wire::health_home_event::Refreshed {},
                )),
            }),
        );
    }

    fn retry_metric(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::HealthMetric(wire::HealthMetricEvent {
                kind: Some(wire::health_metric_event::Kind::Refreshed(
                    wire::health_metric_event::Refreshed {},
                )),
            }),
        );
    }

    fn retry_workout(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::HealthWorkout(wire::HealthWorkoutEvent {
                kind: Some(wire::health_workout_event::Kind::Refreshed(
                    wire::health_workout_event::Refreshed {},
                )),
            }),
        );
    }

    fn home(&self, instance: u64) -> &wire::HealthHomeState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::HealthHome(state)) => state,
            other => panic!("not Health's home: {other:?}"),
        }
    }

    fn metric(&self, instance: u64) -> &wire::HealthMetricState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::HealthMetric(state)) => state,
            other => panic!("not a metric: {other:?}"),
        }
    }

    fn workout(&self, instance: u64) -> &wire::HealthWorkoutState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::HealthWorkout(state)) => state,
            other => panic!("not a workout: {other:?}"),
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
fn nothing_connected_is_the_empty_state_with_connect_and_never_ready_data() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::HealthDestination::Today));
    let state = shell.home(i);
    let empty = empty_of(&state.page);
    assert_eq!(
        empty.headline,
        "Bring in your steps, sleep and workouts from Apple Health."
    );
    assert_eq!(empty.action_label, "Connect to Apple Health");
    assert!(state.content.is_none());
    assert_eq!(
        state.connect.as_ref().map(|route| route.screen.as_str()),
        Some("health.connect")
    );
}

#[test]
fn a_home_that_cannot_be_read_is_failed_or_refused_and_never_the_connect_sentence() {
    let d = driver();
    connect_store(&d);
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = shell.push(routes::home(wire::HealthDestination::Today));
    assert!(!failed(&shell.home(i).page).permanent);
    assert!(shell.home(i).content.is_none());
    // The gate is the gate, not a failure.
    shell.reads(Mode::Refuses);
    shell.retry_home(i);
    refused(&shell.home(i).page);
    assert!(
        shell.home(i).band.is_empty(),
        "no band while the gate is up"
    );
    // Reading again heals it.
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
    assert!(shell.home(i).content.is_some());
}

#[test]
fn a_failed_refresh_keeps_the_day_shown_under_one_sentence_and_over_nothing_it_is_failed() {
    let d = driver();
    connect_store(&d);
    let day = today(&d);
    record(&d, &day, &[(0, "steps", 7000.0)]);
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::HealthDestination::Today));
    ready(&shell.home(i).page);
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    refresh_failed(&shell.home(i).page);
    assert!(shell.home(i).content.is_some(), "the day stays");
    // A refresh that works clears the note.
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
}

#[test]
fn an_empty_workouts_list_is_the_pages_empty_state_and_keeps_its_place_in_the_band() {
    let d = driver();
    connect_store(&d);
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::HealthDestination::Workouts));
    let state = shell.home(i);
    assert_eq!(empty_of(&state.page).headline, "No workouts yet.");
    assert!(state.content.is_none());
    assert!(state.band.iter().any(|tab| tab.current));
    // Failing to read it again is the failure, never the empty state.
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    failed(&shell.home(i).page);
}

#[test]
fn a_workouts_list_with_a_workout_is_ready() {
    let d = driver();
    connect_store(&d);
    let day = today(&d);
    workout(
        &d,
        "w1",
        "run",
        &format!("{day}T09:00:00.000Z"),
        &format!("{day}T09:31:00.000Z"),
    );
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::HealthDestination::Workouts));
    ready(&shell.home(i).page);
    assert!(shell.home(i).content.is_some());
}

#[test]
fn trends_with_no_row_is_empty_and_keeps_its_range_chips() {
    let d = driver();
    connect_store(&d);
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home(wire::HealthDestination::Trends));
    let state = shell.home(i);
    let empty = empty_of(&state.page);
    assert!(!empty.headline.is_empty());
    assert!(
        !state.segments.is_empty(),
        "an empty period can still be left"
    );
    // A failed read has no chips to offer.
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    failed(&shell.home(i).page);
}

#[test]
fn a_metric_is_failed_refused_empty_or_ready_never_the_wrong_one() {
    let d = driver();
    connect_store(&d);
    let day = today(&d);
    let mut shell = Shell::new(&d.handle);
    // No row in the period is the page's empty state, with its chips.
    let i = shell.push(routes::metric("weight_kg", ""));
    assert_eq!(
        empty_of(&shell.metric(i).page).headline,
        "Nothing in this period."
    );
    assert!(shell.metric(i).content.is_none());
    assert!(!shell.metric(i).segments.is_empty());
    shell.reads(Mode::Fails);
    shell.retry_metric(i);
    assert!(!failed(&shell.metric(i).page).permanent);
    assert!(shell.metric(i).segments.is_empty());
    shell.reads(Mode::Refuses);
    shell.retry_metric(i);
    refused(&shell.metric(i).page);
    // With a row it is ready; a failed refresh keeps the bars under one sentence.
    record(&d, &day, &[(0, "steps", 7000.0)]);
    shell.reads(Mode::Answers);
    let steps = shell.push(routes::metric("steps", ""));
    ready(&shell.metric(steps).page);
    assert!(shell.metric(steps).content.is_some());
    shell.reads(Mode::Fails);
    shell.retry_metric(steps);
    refresh_failed(&shell.metric(steps).page);
    assert!(shell.metric(steps).content.is_some());
}

#[test]
fn a_workout_is_failed_refused_or_gone_and_a_gone_one_offers_no_retry() {
    let d = driver();
    connect_store(&d);
    let day = today(&d);
    workout(
        &d,
        "w1",
        "run",
        &format!("{day}T09:00:00.000Z"),
        &format!("{day}T09:31:00.000Z"),
    );
    let mut shell = Shell::new(&d.handle);
    let list = shell.push(routes::home(wire::HealthDestination::Workouts));
    let id = match &shell.home(list).content {
        Some(wire::health_home_state::Content::Data(data)) => data
            .workouts
            .as_ref()
            .and_then(|workouts| workouts.sections.first())
            .and_then(|section| section.rows.first())
            .and_then(|row| row.route.as_ref())
            .and_then(|route| match &route.args {
                Some(wire::route::Args::HealthWorkout(args)) => Some(args.activity_id.clone()),
                _ => None,
            })
            .expect("a workout row"),
        other => panic!("no workouts: {other:?}"),
    };
    let i = shell.push(routes::workout(&id, ""));
    ready(&shell.workout(i).page);
    assert!(shell.workout(i).content.is_some());
    // A failed read is a failure with Retry; the gate is the gate.
    shell.reads(Mode::Fails);
    shell.retry_workout(i);
    refresh_failed(&shell.workout(i).page);
    shell.reads(Mode::Refuses);
    shell.retry_workout(i);
    refused(&shell.workout(i).page);
    shell.reads(Mode::Answers);
    // A workout nothing holds is gone: a final failure in its own words, never an empty page.
    let gone = shell.push(routes::workout("no-such-workout", ""));
    let failure = failed(&shell.workout(gone).page);
    assert_eq!(failure.sentence, "This workout is no longer here.");
    assert!(failure.permanent, "trying again cannot bring it back");
    assert!(shell.workout(gone).content.is_none());
    // Failing to read it again is an ordinary failure, with Retry.
    shell.reads(Mode::Fails);
    shell.retry_workout(gone);
    assert!(!failed(&shell.workout(gone).page).permanent);
}
