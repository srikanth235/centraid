//! Support for Docs' tests: arranging the vault through the typed catalogue and
//! reading the views the screens draw. Every test goes through `Driver`, the
//! door a shell uses.
#![allow(dead_code)]

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::docs::{self, routes};
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::testing::Driver;
use wire::app_query_response::Answer;
use wire::screen_event::Kind as E;

pub fn driver() -> Driver {
    let mut driver = Driver::with_runtime(docs::runtime());
    driver.start();
    driver
}

/// The drive at the tab's root.
pub fn root(d: &Driver) -> u64 {
    d.navigation
        .as_ref()
        .and_then(|nav| nav.tabs.first())
        .and_then(|stack| stack.entries.first())
        .map(|entry| entry.instance)
        .expect("the tab has a root")
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

/// A live text document with a body, at the top level.
pub fn text(d: &Driver, title: &str, body: &str) -> String {
    id_of(&arrange(
        d,
        act::docs::CreateText {
            title: title.to_owned(),
            body_text: Some(body.to_owned()),
            ..Default::default()
        },
    ))
}

/// A document over bytes nobody stored: a PDF is a stage, not a reader.
pub fn pdf(d: &Driver, title: &str, seed: char) -> String {
    id_of(&arrange(
        d,
        act::docs::Upload {
            blob: seed.to_string().repeat(64),
            media_type: "application/pdf".to_owned(),
            title: title.to_owned(),
            size: Some(2048),
            ..Default::default()
        },
    ))
}

pub fn folder(d: &Driver, title: &str, parent: Option<&str>) -> String {
    id_of(&arrange(
        d,
        act::docs::CreateFolder {
            title: title.to_owned(),
            parent: parent.map(str::to_owned),
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

/// The core's document, for assertions on what committed.
pub fn document(d: &Driver, id: &str) -> wire::DocsDocument {
    match answer(
        d,
        load::docs::History {
            document_id: id.to_owned(),
        },
    ) {
        Answer::DocsDocument(document) => document,
        other => panic!("a document answered {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

pub fn drive_state(v: &wire::ViewState) -> &wire::DocsDriveState {
    match &v.kind {
        Some(wire::view_state::Kind::DocsDrive(state)) => state,
        other => panic!("not a drive: {other:?}"),
    }
}

pub fn drive_data(v: &wire::ViewState) -> &wire::DocsDriveData {
    match &drive_state(v).content {
        Some(wire::docs_drive_state::Content::Data(data)) => data,
        other => panic!("the drive has no data: {other:?}"),
    }
}

pub fn titles(v: &wire::ViewState) -> Vec<String> {
    drive_data(v)
        .rows
        .iter()
        .map(|row| row.title.clone())
        .collect()
}

pub fn row<'a>(v: &'a wire::ViewState, title: &str) -> &'a wire::DocsRowView {
    drive_data(v)
        .rows
        .iter()
        .find(|row| row.title == title)
        .unwrap_or_else(|| panic!("no row titled {title}: {:?}", titles(v)))
}

pub fn document_state(v: &wire::ViewState) -> &wire::DocsDocumentState {
    match &v.kind {
        Some(wire::view_state::Kind::DocsDocument(state)) => state,
        other => panic!("not a document: {other:?}"),
    }
}

pub fn document_data(v: &wire::ViewState) -> &wire::DocsDocumentData {
    match &document_state(v).content {
        Some(wire::docs_document_state::Content::Data(data)) => data,
        other => panic!("the document has no data: {other:?}"),
    }
}

pub fn editor_state(v: &wire::ViewState) -> &wire::DocsEditorState {
    match &v.kind {
        Some(wire::view_state::Kind::DocsEditor(state)) => state,
        other => panic!("not an editor: {other:?}"),
    }
}

pub fn versions_state(v: &wire::ViewState) -> &wire::DocsVersionsState {
    match &v.kind {
        Some(wire::view_state::Kind::DocsVersions(state)) => state,
        other => panic!("not a version history: {other:?}"),
    }
}

pub fn trash_view(v: &wire::ViewState) -> &wire::TrashView {
    match &v.kind {
        Some(wire::view_state::Kind::Trash(view)) => view,
        other => panic!("not a trash: {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

pub fn drive_send(d: &mut Driver, i: u64, kind: wire::docs_drive_event::Kind) {
    d.send(i, E::DocsDrive(wire::DocsDriveEvent { kind: Some(kind) }));
}

pub fn document_send(d: &mut Driver, i: u64, kind: wire::docs_document_event::Kind) {
    d.send(
        i,
        E::DocsDocument(wire::DocsDocumentEvent { kind: Some(kind) }),
    );
}

pub fn editor_send(d: &mut Driver, i: u64, kind: wire::docs_editor_event::Kind) {
    d.send(i, E::DocsEditor(wire::DocsEditorEvent { kind: Some(kind) }));
}

pub fn pick(d: &mut Driver, i: u64, key: &str) {
    drive_send(
        d,
        i,
        wire::docs_drive_event::Kind::Action(wire::docs_drive_event::ActionPicked {
            key: key.to_owned(),
        }),
    );
}

pub fn choose(d: &mut Driver, i: u64, key: &str) {
    drive_send(
        d,
        i,
        wire::docs_drive_event::Kind::Choice(wire::docs_drive_event::ChoicePicked {
            key: key.to_owned(),
        }),
    );
}

pub fn open_sheet(d: &mut Driver, i: u64, kind: wire::docs_sheet::Kind) {
    drive_send(
        d,
        i,
        wire::docs_drive_event::Kind::SheetOpened(wire::docs_drive_event::SheetOpened {
            kind: kind as i32,
        }),
    );
}

pub fn band(d: &mut Driver, i: u64, key: &str) {
    drive_send(
        d,
        i,
        wire::docs_drive_event::Kind::Band(wire::docs_drive_event::BandPicked {
            key: key.to_owned(),
        }),
    );
}

pub fn row_menu(d: &mut Driver, i: u64, document_id: &str) {
    drive_send(
        d,
        i,
        wire::docs_drive_event::Kind::RowMenu(wire::docs_drive_event::RowMenuOpened {
            document_id: document_id.to_owned(),
        }),
    );
}

pub fn search(d: &mut Driver, i: u64, term: &str) {
    drive_send(
        d,
        i,
        wire::docs_drive_event::Kind::SearchTerm(wire::docs_drive_event::SearchTermChanged {
            term: term.to_owned(),
        }),
    );
}

pub fn confirm(d: &mut Driver, i: u64) {
    drive_send(
        d,
        i,
        wire::docs_drive_event::Kind::Confirmed(wire::docs_drive_event::Confirmed {}),
    );
}

pub fn drive_route(destination: wire::DocsDestination) -> wire::Route {
    routes::drive(destination, "", "", "")
}

/// Every action key of the sheet that is up.
pub fn sheet_keys(state: &wire::DocsDriveState) -> Vec<String> {
    match state.sheet.as_ref().and_then(|sheet| sheet.body.as_ref()) {
        Some(wire::docs_sheet::Body::Actions(list)) => {
            list.actions.iter().map(|a| a.key.clone()).collect()
        }
        Some(wire::docs_sheet::Body::Choices(list)) => {
            list.choices.iter().map(|c| c.key.clone()).collect()
        }
        _ => Vec::new(),
    }
}

/// An effect of one kind that is waiting, if any.
pub fn waiting(d: &Driver) -> Vec<&wire::Effect> {
    d.effects
        .iter()
        .filter_map(|request| request.effect.as_ref())
        .collect()
}

/// The shell's answer to an effect, by value: the screen ignores which request
/// it answers, so one effect can be answered more than once (progress, then the
/// file).
pub fn result(d: &mut Driver, i: u64, outcome: wire::effect_result::Outcome) {
    d.send(
        i,
        E::EffectResult(wire::EffectResult {
            effect_id: 0,
            outcome: Some(outcome),
        }),
    );
}
