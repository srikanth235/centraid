//! Support for People's tests: arranging the vault through the typed catalogue and
//! reading the views the screens draw. Every test goes through `Driver`, the door a
//! shell uses.
#![allow(dead_code)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::people::{self, routes};
use centraid_screens::testing::Driver;
use wire::app_query_response::Answer;

/// A driver with People's screens and one tab rooted at its home, started.
pub fn driver() -> Driver {
    let mut driver = Driver::with_runtime(people::runtime());
    driver.start();
    driver
}

/// The root of the `people` tab: People's home.
pub fn root(d: &Driver) -> u64 {
    d.navigation
        .as_ref()
        .expect("navigation")
        .tabs
        .iter()
        .find(|stack| stack.tab == people::TAB)
        .and_then(|stack| stack.entries.first())
        .map(|entry| entry.instance)
        .expect("People's root")
}

/// Write as another surface, and insist it committed.
pub fn arrange(d: &Driver, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
    let response = d.act(
        request
            .into()
            .keyed(format!("arrange:{}", kit_act::fresh())),
    );
    assert_eq!(
        response.status,
        wire::ActStatus::Executed as i32,
        "arranging was refused: {}",
        response.reason
    );
    response
}

pub fn id_of(response: &wire::ActResponse) -> String {
    let value: serde_json::Value =
        serde_json::from_slice(&response.output).expect("the output is JSON");
    value["id"]
        .as_str()
        .expect("the output names an id")
        .to_owned()
}

/// A person, added as another surface would; their id.
pub fn person(d: &Driver, name: &str) -> String {
    id_of(&arrange(
        d,
        act::people::AddPerson {
            title: name.to_owned(),
            ..Default::default()
        },
    ))
}

pub fn answer(d: &Driver, request: impl Into<wire::LoadRequest>) -> Answer {
    let mut request = request.into();
    request.zone = "UTC".to_owned();
    let answered = d
        .handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Load(Box::new(request))),
        })
        .expect("the load door answers");
    let Some(wire::response::Kind::Load(loaded)) = answered.kind else {
        panic!("a load answered {:?}", answered.kind);
    };
    loaded.answer.and_then(|a| a.answer).expect("an answer")
}

/// The core's own reading of the roster, by name.
pub fn roster_of(d: &Driver) -> wire::PeopleRoster {
    match answer(
        d,
        load::people::People {
            limit: 0,
            sort: Some("name".to_owned()),
            ..Default::default()
        },
    ) {
        Answer::PeopleRoster(roster) => roster,
        other => panic!("the roster answered {other:?}"),
    }
}

/// The core's own reading of one person's sheet.
pub fn sheet_of(d: &Driver, id: &str) -> wire::PeoplePerson {
    match answer(
        d,
        load::people::Person {
            party_id: id.to_owned(),
        },
    ) {
        Answer::PeoplePerson(person) => person,
        other => panic!("a person answered {other:?}"),
    }
}

/// Trash every live person, so a test's own are the only ones.
pub fn clear_people(d: &Driver) {
    for row in roster_of(d).people {
        arrange(
            d,
            act::people::TrashPerson {
                person_id: row.party_id,
            },
        );
    }
}

/// A driver over an empty roster, not yet started: arrange, then [`begin`].
pub fn clean() -> Driver {
    let d = Driver::with_runtime(people::runtime());
    clear_people(&d);
    d
}

/// Start the shell and return the root: People's home, which loads what the vault holds now.
pub fn begin(d: &mut Driver) -> u64 {
    d.start();
    root(d)
}

/// The member comes back to the screen: it reads again.
pub fn refresh(d: &mut Driver, i: u64) {
    d.send(i, wire::screen_event::Kind::Appeared(wire::Appeared {}));
}

// --- views ---------------------------------------------------------------

pub fn home_state(v: &wire::ViewState) -> &wire::PeopleHomeState {
    match &v.kind {
        Some(wire::view_state::Kind::PeopleHome(state)) => state,
        other => panic!("not People's home: {other:?}"),
    }
}

pub fn person_state(v: &wire::ViewState) -> &wire::PeoplePersonState {
    match &v.kind {
        Some(wire::view_state::Kind::PeoplePerson(state)) => state,
        other => panic!("not a person: {other:?}"),
    }
}

pub fn editor_state(v: &wire::ViewState) -> &wire::PeopleEditorState {
    match &v.kind {
        Some(wire::view_state::Kind::PeopleEditor(state)) => state,
        other => panic!("not the editor: {other:?}"),
    }
}

/// The roster surface of People's home.
pub fn roster_data(v: &wire::ViewState) -> &wire::PeopleRosterData {
    match &home_state(v).content {
        Some(wire::people_home_state::Content::Roster(data)) => data,
        other => panic!("not the roster: {other:?}"),
    }
}

pub fn touch_data(v: &wire::ViewState) -> &wire::PeopleTouchData {
    match &home_state(v).content {
        Some(wire::people_home_state::Content::Touch(data)) => data,
        other => panic!("not Touch: {other:?}"),
    }
}

pub fn person_data(v: &wire::ViewState) -> &wire::PeoplePersonData {
    match &person_state(v).content {
        Some(wire::people_person_state::Content::Data(data)) => data,
        other => panic!("not a person's data: {other:?}"),
    }
}

pub fn draft(v: &wire::ViewState) -> &wire::PeopleProfileDraft {
    match &editor_state(v).content {
        Some(wire::people_editor_state::Content::Draft(draft)) => draft,
        other => panic!("not a draft: {other:?}"),
    }
}

pub fn names(data: &wire::PeopleRosterData) -> Vec<String> {
    data.rows.iter().map(|row| row.name.clone()).collect()
}

// --- events --------------------------------------------------------------

pub fn open_home(d: &mut Driver, destination: wire::PeopleDestination) -> u64 {
    d.push(people::TAB, routes::home(destination))
}

pub fn send_home(d: &mut Driver, i: u64, event: wire::people_home_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::PeopleHome(wire::PeopleHomeEvent { kind: Some(event) }),
    );
}

pub fn send_person(d: &mut Driver, i: u64, event: wire::people_person_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::PeoplePerson(wire::PeoplePersonEvent { kind: Some(event) }),
    );
}

pub fn send_editor(d: &mut Driver, i: u64, event: wire::people_editor_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::PeopleEditor(wire::PeopleEditorEvent { kind: Some(event) }),
    );
}

pub fn open_person(d: &mut Driver, id: &str, name: &str) -> u64 {
    d.push(people::TAB, routes::person(id, name, false))
}
