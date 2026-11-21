//! A NEW EVENT'S DRAFT SURVIVES THE PROCESS (#1202, owner ruling 29), through the doors a shell
//! uses: open a new event, type, send the app to the background, lose the process (a new runtime
//! over the same vault, the shell's device store carried across), find the editor reopened with
//! what was typed, Save, and find the draft gone. The vault holds no event until Save.
//! Every assertion is a value or a count.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::calendar::draft::{self, Stored};
use centraid_screens::catalog::load;
use centraid_screens::testing::{Driver, FakeShell};
use centraid_screens::{Runtime, agenda, calendar, proof};
use wire::agenda_editor_event::Kind as K;
use wire::screen_event::Kind as E;

const DAY: &str = "2099-06-15";

fn runtime() -> Runtime {
    Runtime::new(
        calendar::registry().with(proof::NAME, proof::build),
        vec![(agenda::TAB.to_owned(), proof::route())],
    )
    .with_services(draft::services())
}

/// The app opened: the runtime started and the shell has answered what the service asked of its
/// device store.
fn launched(driver: &mut Driver, shell: &mut FakeShell) {
    driver.start();
    driver.serve(shell);
}

fn events(driver: &Driver) -> Vec<wire::AgendaEvent> {
    let mut request: wire::LoadRequest = load::calendar::Upcoming {
        from: Some("1970-01-01T00:00:00Z".to_owned()),
        to: Some("2100-01-01T00:00:00Z".to_owned()),
        alerts: None,
    }
    .into();
    request.zone = "UTC".to_owned();
    let answer = driver
        .handle
        .load(&request)
        .expect("the load door answers")
        .answer
        .and_then(|answer| answer.answer);
    let Some(wire::app_query_response::Answer::AgendaUpcoming(upcoming)) = answer else {
        panic!("upcoming answered something else");
    };
    upcoming.events
}

fn titled(driver: &Driver, title: &str) -> usize {
    events(driver)
        .iter()
        .filter(|event| event.summary.as_deref() == Some(title))
        .count()
}

fn send(driver: &mut Driver, page: u64, kind: K) {
    driver.send(
        page,
        E::AgendaEditor(wire::AgendaEditorEvent { kind: Some(kind) }),
    );
}

fn type_title(driver: &mut Driver, page: u64, text: &str) {
    send(
        driver,
        page,
        K::Title(wire::agenda_editor_event::TitleChanged {
            text: text.to_owned(),
        }),
    );
}

fn state(driver: &Driver, page: u64) -> &wire::AgendaEditorState {
    match &driver.view(page).kind {
        Some(wire::view_state::Kind::AgendaEditor(state)) => state,
        other => panic!("not an editor: {other:?}"),
    }
}

fn draft_of(driver: &Driver, page: u64) -> wire::AgendaDraft {
    match &state(driver, page).content {
        Some(wire::agenda_editor_state::Content::Data(data)) => {
            data.draft.clone().expect("a draft")
        }
        other => panic!("the editor has no data: {other:?}"),
    }
}

fn background(driver: &mut Driver, shell: &mut FakeShell) {
    driver.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    driver.serve(shell);
}

/// The route the runtime asked the shell to open, taken off the pending effects.
fn opened(driver: &mut Driver) -> Option<wire::Route> {
    let at = driver.effects.iter().position(|request| {
        matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::OpenRoute(_))
        )
    })?;
    match driver.effects.remove(at).effect?.kind? {
        wire::effect::Kind::OpenRoute(open) => open.route,
        _ => None,
    }
}

fn kept(shell: &FakeShell) -> Option<Stored> {
    shell
        .device
        .get(draft::KEY)
        .and_then(|text| Stored::decode(text.as_bytes()))
}

#[test]
fn a_new_events_draft_comes_back_after_the_process_dies_and_is_gone_after_save() {
    let mut shell = FakeShell::default();
    let mut driver = Driver::with_runtime(runtime());
    launched(&mut driver, &mut shell);
    assert!(
        opened(&mut driver).is_none(),
        "nothing kept, nothing opened"
    );
    let before = events(&driver).len();

    // OPEN A NEW EVENT AND TYPE, a time and the notes among it.
    let page = driver.push(agenda::TAB, calendar::routes::editor("", "", None, DAY));
    type_title(&mut driver, page, "Dentist");
    send(
        &mut driver,
        page,
        K::Notes(wire::agenda_editor_event::NotesChanged {
            text: "Bring the form".to_owned(),
        }),
    );
    send(
        &mut driver,
        page,
        K::Start(wire::agenda_editor_event::StartChanged {
            day: DAY.to_owned(),
            time: "11:30".to_owned(),
        }),
    );
    let typed = draft_of(&driver, page);
    assert_eq!(typed.start_time, "11:30");

    // THE APP GOES TO THE BACKGROUND: the moment before Android may kill it.
    background(&mut driver, &mut shell);
    let stored = kept(&shell).expect("the device store holds the draft");
    assert_eq!(stored.draft, typed);
    assert_eq!(stored.vault, "");
    assert_eq!(events(&driver).len(), before, "a draft is not an event");

    // THE PROCESS DIES. Nothing of the runtime is left; the vault and the shell's store are.
    let mut driver = driver.restarted(runtime());
    launched(&mut driver, &mut shell);
    assert_eq!(events(&driver).len(), before, "relaunching makes no event");
    let route = opened(&mut driver).expect("the editor is reopened with the draft");
    assert_eq!(route.screen, calendar::EDITOR);
    assert!(opened(&mut driver).is_none(), "once");

    let page = driver.push(agenda::TAB, route);
    assert_eq!(draft_of(&driver, page), typed, "what was typed, as typed");
    assert!(!state(&driver, page).dismissed);
    assert_eq!(events(&driver).len(), before);

    // LEAVING STILL ASKS: the restored words are changes to a new event.
    send(
        &mut driver,
        page,
        K::Leave(wire::agenda_editor_event::LeaveRequested {}),
    );
    assert!(state(&driver, page).confirm.is_some());
    send(
        &mut driver,
        page,
        K::ConfirmDismissed(wire::agenda_editor_event::ConfirmDismissed {}),
    );
    assert!(state(&driver, page).confirm.is_none());
    assert!(!state(&driver, page).dismissed);
    assert!(kept(&shell).is_some(), "asking is not discarding");

    // SAVE: one event, and the draft is gone from the store.
    send(
        &mut driver,
        page,
        K::Save(wire::agenda_editor_event::SaveTapped {}),
    );
    driver.serve(&mut shell);
    assert!(state(&driver, page).dismissed);
    assert_eq!(titled(&driver, "Dentist"), 1);
    assert_eq!(events(&driver).len(), before + 1);
    assert!(
        !shell.device.contains_key(draft::KEY),
        "a saved event has no draft"
    );

    // THE NEXT LAUNCH OPENS NOTHING.
    let mut driver = driver.restarted(runtime());
    launched(&mut driver, &mut shell);
    assert!(opened(&mut driver).is_none());
    assert_eq!(titled(&driver, "Dentist"), 1);
}

#[test]
fn a_confirmed_discard_clears_the_draft_and_a_cancel_of_the_question_keeps_it() {
    let mut shell = FakeShell::default();
    let mut driver = Driver::with_runtime(runtime());
    launched(&mut driver, &mut shell);
    let before = events(&driver).len();

    let page = driver.push(agenda::TAB, calendar::routes::editor("", "", None, DAY));
    type_title(&mut driver, page, "Haircut");
    background(&mut driver, &mut shell);
    assert!(kept(&shell).is_some());

    send(
        &mut driver,
        page,
        K::Leave(wire::agenda_editor_event::LeaveRequested {}),
    );
    send(
        &mut driver,
        page,
        K::Confirmed(wire::agenda_editor_event::Confirmed {}),
    );
    driver.serve(&mut shell);
    assert!(state(&driver, page).dismissed);
    assert!(!shell.device.contains_key(draft::KEY), "discarded is gone");

    let mut driver = driver.restarted(runtime());
    launched(&mut driver, &mut shell);
    assert!(opened(&mut driver).is_none());
    assert_eq!(events(&driver).len(), before);
}

#[test]
fn putting_a_new_event_back_to_blank_leaves_no_draft() {
    let mut shell = FakeShell::default();
    let mut driver = Driver::with_runtime(runtime());
    launched(&mut driver, &mut shell);
    let page = driver.push(agenda::TAB, calendar::routes::editor("", "", None, DAY));
    type_title(&mut driver, page, "Standup");
    background(&mut driver, &mut shell);
    assert!(kept(&shell).is_some());
    type_title(&mut driver, page, "");
    background(&mut driver, &mut shell);
    assert!(!shell.device.contains_key(draft::KEY));
}

#[test]
fn a_draft_of_another_vault_is_deleted_and_never_shown() {
    let mut shell = FakeShell::default();
    let other = Stored {
        vault: "another-vault".to_owned(),
        draft: wire::AgendaDraft {
            title: "Not yours here".to_owned(),
            ..wire::AgendaDraft::default()
        },
        typed_place: String::new(),
    };
    shell.device.insert(
        draft::KEY.to_owned(),
        other.encode().expect("a small draft"),
    );
    let mut driver = Driver::with_runtime(runtime());
    launched(&mut driver, &mut shell);
    assert!(opened(&mut driver).is_none(), "another vault's draft");
    assert!(!shell.device.contains_key(draft::KEY), "and it is deleted");
}

#[test]
fn what_the_store_holds_that_is_not_a_draft_is_cleared() {
    let mut shell = FakeShell::default();
    shell
        .device
        .insert(draft::KEY.to_owned(), "not a draft".to_owned());
    let mut driver = Driver::with_runtime(runtime());
    launched(&mut driver, &mut shell);
    assert!(opened(&mut driver).is_none());
    assert!(!shell.device.contains_key(draft::KEY));
}

#[test]
fn an_edit_of_an_existing_event_keeps_no_draft() {
    let mut shell = FakeShell::default();
    let mut driver = Driver::with_runtime(runtime());
    launched(&mut driver, &mut shell);
    let event = events(&driver)
        .into_iter()
        .next()
        .expect("the example vault has an event");
    let page = driver.push(
        agenda::TAB,
        calendar::routes::editor(
            &event.event_id,
            &event.instance_key,
            event.original_start_local.as_deref(),
            "",
        ),
    );
    type_title(&mut driver, page, "A different title");
    background(&mut driver, &mut shell);
    assert!(!shell.device.contains_key(draft::KEY));
}
