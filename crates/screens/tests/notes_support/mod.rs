//! Support for Notes' tests: arranging the vault through the typed catalogue and
//! reading the views the screens draw. Every test goes through `Driver`, the
//! door a shell uses.
#![allow(dead_code)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::notes::{self, routes};
use centraid_screens::testing::Driver;
use wire::app_query_response::Answer;

pub fn driver() -> Driver {
    let mut driver = Driver::with_runtime(notes::runtime());
    driver.start();
    driver
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

/// A note, created as another surface would; its id.
pub fn note(d: &Driver, title: &str, body: &str) -> String {
    id_of(&arrange(
        d,
        act::notes::CreateNote {
            title: title.to_owned(),
            body: body.to_owned(),
            ..Default::default()
        },
    ))
}

pub fn notebook(d: &Driver, title: &str) -> String {
    id_of(&arrange(
        d,
        act::notes::CreateNotebook {
            title: title.to_owned(),
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

/// The core's own reading of one note.
pub fn note_of(d: &Driver, id: &str) -> wire::NotesNote {
    match answer(
        d,
        load::notes::Note {
            note_id: id.to_owned(),
        },
    ) {
        Answer::NotesNote(note) => note,
        other => panic!("a note answered {other:?}"),
    }
}

/// Trash every live note, so a test's own are the only ones.
pub fn clear_notes(d: &Driver) {
    loop {
        let Answer::NotesLibrary(library) = answer(
            d,
            load::notes::Library {
                limit: 2000,
                ..Default::default()
            },
        ) else {
            panic!("the library answers");
        };
        if library.notes.is_empty() {
            break;
        }
        for row in library.notes {
            arrange(
                d,
                act::notes::DeleteNote {
                    note_id: row.note_id,
                },
            );
        }
    }
}

/// Open the home on `place` and return its instance.
pub fn home(d: &mut Driver, place: wire::NotesPlace) -> u64 {
    d.push(notes::TAB, routes::home(place, "", "", false))
}

pub fn home_state(v: &wire::ViewState) -> &wire::NotesHomeState {
    match &v.kind {
        Some(wire::view_state::Kind::NotesHome(state)) => state,
        other => panic!("not the notes home: {other:?}"),
    }
}

pub fn editor_state(v: &wire::ViewState) -> &wire::NotesEditorState {
    match &v.kind {
        Some(wire::view_state::Kind::NotesEditor(state)) => state,
        other => panic!("not the notes editor: {other:?}"),
    }
}

pub fn history_state(v: &wire::ViewState) -> &wire::NotesHistoryState {
    match &v.kind {
        Some(wire::view_state::Kind::NotesHistory(state)) => state,
        other => panic!("not the notes history: {other:?}"),
    }
}

pub fn trash_state(v: &wire::ViewState) -> &wire::TrashView {
    match &v.kind {
        Some(wire::view_state::Kind::Trash(state)) => state,
        other => panic!("not the trash: {other:?}"),
    }
}

/// The library's rows, flat.
pub fn library_rows(v: &wire::ViewState) -> Vec<&wire::NotesNoteRow> {
    match &home_state(v).content {
        Some(wire::notes_home_state::Content::Library(data)) => data
            .sections
            .iter()
            .flat_map(|section| section.rows.iter())
            .collect(),
        other => panic!("not the library: {other:?}"),
    }
}

pub fn library_data(v: &wire::ViewState) -> &wire::NotesLibraryData {
    match &home_state(v).content {
        Some(wire::notes_home_state::Content::Library(data)) => data,
        other => panic!("not the library: {other:?}"),
    }
}

pub fn titles(v: &wire::ViewState) -> Vec<String> {
    library_rows(v)
        .iter()
        .map(|row| row.title.clone())
        .collect()
}

pub fn send_home(d: &mut Driver, i: u64, event: wire::notes_home_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::NotesHome(wire::NotesHomeEvent { kind: Some(event) }),
    );
}

pub fn send_editor(d: &mut Driver, i: u64, event: wire::notes_editor_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::NotesEditor(wire::NotesEditorEvent { kind: Some(event) }),
    );
}

pub fn send_history(d: &mut Driver, i: u64, event: wire::notes_history_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::NotesHistory(wire::NotesHistoryEvent { kind: Some(event) }),
    );
}

pub fn send_trash(d: &mut Driver, i: u64, event: wire::trash_event::Kind) {
    d.send(
        i,
        wire::screen_event::Kind::Trash(wire::TrashEvent { kind: Some(event) }),
    );
}
