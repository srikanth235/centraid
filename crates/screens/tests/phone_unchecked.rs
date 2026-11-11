//! A CHECK THAT WAS NOT MADE SAYS SO (#1183, product principle 7): when what the phone's store says
//! cannot be read (the read failed, or the vault refused it), a followed row's page draws no
//! "phone says" line and says in one sentence on its status line that the check was not made. It
//! never reads as "the phone agrees". Each kind of page is opened over a door that answers every
//! other read as the core does and that one as a failure or a refusal.

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::testing::Driver;
use serde_json::Value;

#[derive(Clone, Copy)]
enum Check {
    Made,
    Failed,
    Refused,
}

/// The core's own door, except for `phone-differences`.
struct Door<'a> {
    core: &'a Handle,
    check: Check,
}

impl ScreenCtx for Door<'_> {
    fn load(&self, request: &wire::LoadRequest) -> Result<wire::LoadResponse> {
        if request.query != "phone-differences" {
            return self.core.load(request);
        }
        match self.check {
            Check::Made => self.core.load(request),
            Check::Failed => Err(CoreError::Unavailable {
                reason: "test read failure".into(),
            }),
            Check::Refused => Ok(wire::LoadResponse {
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

/// Open `route` on `tab` over a phone that is an iPhone in London, and give the page's view.
fn open(
    d: &Driver,
    runtime: centraid_screens::Runtime,
    check: Check,
    tab: &str,
    route: wire::Route,
) -> wire::ViewState {
    let door = Door {
        core: &d.handle,
        check,
    };
    let call = |kind: wire::screen_request::Kind| {
        runtime
            .call(&door, &wire::ScreenRequest { kind: Some(kind) })
            .expect("the runtime answers")
            .update
            .unwrap_or_default()
    };
    call(wire::screen_request::Kind::Environment(wire::Environment {
        locale: "en-GB".to_owned(),
        zone: "Europe/London".to_owned(),
        platform: "ios".to_owned(),
        ..Default::default()
    }));
    call(wire::screen_request::Kind::Snapshot(
        wire::SnapshotRequest {},
    ));
    let update = call(wire::screen_request::Kind::Nav(wire::NavEvent {
        kind: Some(wire::nav_event::Kind::Push(wire::NavPush {
            tab: tab.to_owned(),
            route: Some(route),
        })),
    }));
    let instance = update
        .navigation
        .as_ref()
        .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == tab))
        .and_then(|stack| stack.entries.last())
        .map(|entry| entry.instance)
        .expect("a push moves the stack");
    update
        .views
        .into_iter()
        .find(|view| view.instance == instance)
        .expect("the page is drawn")
}

fn arrange(d: &Driver, request: impl Into<wire::ActRequest>) -> Value {
    let response = d.act(
        request
            .into()
            .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(response.status, wire::ActStatus::Executed as i32);
    serde_json::from_slice(&response.output).unwrap_or(Value::Null)
}

fn id_of(output: &Value) -> String {
    output["id"].as_str().expect("an id").to_owned()
}

/// What a page says of the check: its status sentence, and whether any "phone says" line is drawn.
struct Page {
    status: Option<String>,
    lines: usize,
}

fn person(view: &wire::ViewState) -> Page {
    let Some(wire::view_state::Kind::PeoplePerson(state)) = &view.kind else {
        panic!("not a person: {:?}", view.kind)
    };
    let Some(wire::people_person_state::Content::Data(data)) = &state.content else {
        panic!("no data: {:?}", state.content)
    };
    Page {
        status: state.status.as_ref().map(|line| line.sentence.clone()),
        lines: usize::from(data.name_phone_says.is_some())
            + usize::from(data.role_phone_says.is_some())
            + usize::from(data.nickname_phone_says.is_some())
            + usize::from(data.birthday_phone_says.is_some())
            + data.channels_phone_says.len(),
    }
}

fn event(view: &wire::ViewState) -> Page {
    let Some(wire::view_state::Kind::AgendaEvent(state)) = &view.kind else {
        panic!("not an event: {:?}", view.kind)
    };
    let Some(wire::agenda_event_state::Content::Data(data)) = &state.content else {
        panic!("no data: {:?}", state.content)
    };
    Page {
        status: state.status.as_ref().map(|line| line.sentence.clone()),
        lines: usize::from(data.title_phone_says.is_some())
            + usize::from(data.notes_phone_says.is_some())
            + data.when_phone_says.len()
            + data.facts_phone_says.len()
            + data.guests_phone_says.len(),
    }
}

fn document(view: &wire::ViewState) -> Page {
    let Some(wire::view_state::Kind::DocsDocument(state)) = &view.kind else {
        panic!("not a document: {:?}", view.kind)
    };
    let Some(wire::docs_document_state::Content::Data(data)) = &state.content else {
        panic!("no data: {:?}", state.content)
    };
    // The document says it as the page's note over the data, not on the status line (#1185).
    assert!(state.status.is_none(), "{:?}", state.status);
    Page {
        status: state
            .page
            .as_ref()
            .and_then(|page| page.note.as_ref())
            .map(|note| note.sentence.clone()),
        lines: usize::from(data.title_phone_says.is_some()),
    }
}

fn workout(view: &wire::ViewState) -> Page {
    let Some(wire::view_state::Kind::HealthWorkout(state)) = &view.kind else {
        panic!("not a workout: {:?}", view.kind)
    };
    let Some(wire::health_workout_state::Content::Data(data)) = &state.content else {
        panic!("no data: {:?}", state.content)
    };
    Page {
        status: state.status.as_ref().map(|line| line.sentence.clone()),
        lines: data.figures_phone_says.len(),
    }
}

/// Every way the check can fail says the one sentence and draws no line; a check that is made says
/// nothing.
fn says_unchecked(
    d: &Driver,
    runtime: fn() -> centraid_screens::Runtime,
    tab: &str,
    route: &wire::Route,
    page: fn(&wire::ViewState) -> Page,
    sentence: &str,
) {
    for check in [Check::Failed, Check::Refused] {
        let shown = page(&open(d, runtime(), check, tab, route.clone()));
        assert_eq!(shown.status.as_deref(), Some(sentence));
        assert_eq!(shown.lines, 0, "no line is drawn for a check not made");
    }
    let shown = page(&open(d, runtime(), Check::Made, tab, route.clone()));
    assert_eq!(shown.status, None, "a check that was made says nothing");
}

#[test]
fn a_person_page_whose_check_was_not_made_says_so() {
    let d = Driver::founded();
    let id = id_of(&arrange(
        &d,
        act::people::AddPerson {
            title: "Ada".to_owned(),
            ..Default::default()
        },
    ));
    says_unchecked(
        &d,
        centraid_screens::people::runtime,
        "people",
        &centraid_screens::people::routes::person(&id, "Ada", false),
        person,
        "Couldn’t check what your phone says.",
    );
}

#[test]
fn an_event_page_whose_check_was_not_made_says_so() {
    let d = Driver::founded();
    let id = id_of(&arrange(
        &d,
        act::calendar::Propose {
            title: "Sync".to_owned(),
            starts: "2099-06-19T09:00:00".to_owned(),
            ends: centraid_screens::field::Field::Is("2099-06-19T10:00:00".to_owned()),
            zone: centraid_screens::field::Field::Is("Europe/London".to_owned()),
            ..Default::default()
        },
    ));
    says_unchecked(
        &d,
        centraid_screens::agenda::runtime,
        "calendar",
        &centraid_screens::calendar::routes::event(&id, &id, None, "2099-06-19"),
        event,
        "Couldn’t check what your phone says.",
    );
}

#[test]
fn a_document_page_whose_check_was_not_made_says_so() {
    let d = Driver::founded();
    let id = id_of(&arrange(
        &d,
        act::docs::CreateText {
            title: "Notes".to_owned(),
            body_text: Some("body".to_owned()),
            ..Default::default()
        },
    ));
    says_unchecked(
        &d,
        centraid_screens::docs::runtime,
        "docs",
        &centraid_screens::docs::routes::document(&id, "Notes", ""),
        document,
        "Couldn’t check what the folder says.",
    );
}

#[test]
fn a_workout_page_whose_check_was_not_made_says_so_in_the_stores_name() {
    let d = Driver::founded();
    arrange(
        &d,
        act::health::LogWorkout {
            r#type: Some("run".to_owned()),
            starts: "2026-03-04T07:00:00Z".to_owned(),
            distance_m: Some(4_000.0),
            moving_s: Some(1_800),
            ..Default::default()
        },
    );
    let mut request: wire::LoadRequest = load::health::Workouts {
        limit: 10,
        ..Default::default()
    }
    .into();
    request.zone = "UTC".to_owned();
    let answered = d
        .handle
        .load(&request)
        .expect("the workouts load")
        .answer
        .and_then(|response| response.answer);
    let Some(wire::app_query_response::Answer::HealthWorkouts(found)) = answered else {
        panic!("{answered:?}")
    };
    let id = found.workouts[0].activity_id.clone();
    says_unchecked(
        &d,
        centraid_screens::health::runtime,
        "health",
        &centraid_screens::health::routes::workout(&id, "Today"),
        workout,
        "Couldn’t check what Apple Health says.",
    );
}
