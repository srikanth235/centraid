//! Docs' reads on the shared page state (#1185): a read that came to nothing is the failure and
//! never an empty shelf, a refusal is the gate, a read that came with nothing is the screen's own
//! empty state, and a refresh that failed keeps what was shown under one sentence. On every screen
//! that reads: the drive (its shelves, folders and search), one document and the text editor.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail or refuse.

mod docs_support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::docs::{self, routes};
use centraid_screens::strings::{Locale, shared};
use docs_support::{driver, folder, pdf, text};
use wire::docs_document_event as document;
use wire::docs_drive_event as drive;
use wire::docs_editor_event as editor;
use wire::page_state::State;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Answers,
    Fails,
    Refuses,
    /// Only the read of what the phone says differs fails.
    FailsPhone,
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
            Mode::FailsPhone if request.query != "phone-differences" => self.core.load(request),
            Mode::Fails | Mode::FailsPhone => Err(CoreError::Unavailable {
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

/// A shell: Docs' screens over the door, with the last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
}

impl<'a> Shell<'a> {
    fn new(core: &'a Handle) -> Self {
        let mut shell = Self {
            runtime: docs::runtime(),
            door: Door {
                core,
                mode: Cell::new(Mode::Answers),
            },
            views: BTreeMap::new(),
        };
        shell.call(wire::screen_request::Kind::Environment(wire::Environment {
            locale: "en".to_owned(),
            zone: "UTC".to_owned(),
            platform: "android".to_owned(),
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
                tab: docs::TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == docs::TAB))
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

    fn drive_event(&mut self, instance: u64, event: drive::Kind) {
        self.send(
            instance,
            wire::screen_event::Kind::DocsDrive(wire::DocsDriveEvent { kind: Some(event) }),
        );
    }

    fn document_event(&mut self, instance: u64, event: document::Kind) {
        self.send(
            instance,
            wire::screen_event::Kind::DocsDocument(wire::DocsDocumentEvent { kind: Some(event) }),
        );
    }

    fn editor_event(&mut self, instance: u64, event: editor::Kind) {
        self.send(
            instance,
            wire::screen_event::Kind::DocsEditor(wire::DocsEditorEvent { kind: Some(event) }),
        );
    }

    fn retry_drive(&mut self, instance: u64) {
        self.drive_event(instance, drive::Kind::Refreshed(drive::Refreshed {}));
    }

    fn retry_document(&mut self, instance: u64) {
        self.document_event(instance, document::Kind::Refreshed(document::Refreshed {}));
    }

    fn retry_editor(&mut self, instance: u64) {
        self.editor_event(instance, editor::Kind::Refreshed(editor::Refreshed {}));
    }

    fn drive(&self, instance: u64) -> &wire::DocsDriveState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::DocsDrive(state)) => state,
            other => panic!("not the drive: {other:?}"),
        }
    }

    fn document(&self, instance: u64) -> &wire::DocsDocumentState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::DocsDocument(state)) => state,
            other => panic!("not a document: {other:?}"),
        }
    }

    fn editor(&self, instance: u64) -> &wire::DocsEditorState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::DocsEditor(state)) => state,
            other => panic!("not the editor: {other:?}"),
        }
    }
}

fn state_of(page: &Option<wire::PageState>) -> Option<&State> {
    page.as_ref().expect("a page").state.as_ref()
}

fn failed(page: &Option<wire::PageState>) -> bool {
    matches!(state_of(page), Some(State::Failed(_)))
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

fn gate_words(page: &Option<wire::PageState>) {
    let Some(State::Refused(gate)) = state_of(page) else {
        panic!("not refused: {page:?}");
    };
    assert_eq!(gate.receipt, "consent.revoked");
    assert!(!gate.title.is_empty() && !gate.body.is_empty());
}

fn empty_of(page: &Option<wire::PageState>) -> &wire::EmptyState {
    let Some(State::Empty(empty)) = state_of(page) else {
        panic!("not empty: {page:?}");
    };
    empty
}

/// A folder with nothing in it, and its page.
fn empty_folder(d: &centraid_screens::testing::Driver, shell: &mut Shell, name: &str) -> u64 {
    let id = folder(d, name, None);
    shell.push(routes::folder(&id, name, "Docs"))
}

fn root(shell: &mut Shell) -> u64 {
    shell.push(routes::drive(wire::DocsDestination::All, "", "", ""))
}

// ---- the drive ----

#[test]
fn a_drive_that_cannot_be_read_is_failed_and_never_the_day_one_sentence() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = root(&mut shell);
    assert!(failed(&shell.drive(i).page));
    assert!(shell.drive(i).content.is_none());
    assert_eq!(
        shell.drive(i).empty_action,
        wire::docs_drive_data::EmptyAction::None as i32
    );
    // Retry reads again, and the shelf is then ready.
    shell.reads(Mode::Answers);
    shell.retry_drive(i);
    ready(&shell.drive(i).page);
    assert!(shell.drive(i).content.is_some());
}

#[test]
fn a_refused_drive_is_the_gate_with_nothing_to_offer() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Refuses);
    let i = root(&mut shell);
    gate_words(&shell.drive(i).page);
    assert!(shell.drive(i).content.is_none());
    assert!(shell.drive(i).band.is_empty());
    assert!(shell.drive(i).filter_menu.is_none());
    // A gate never retries itself, and a read that lands clears it.
    shell.reads(Mode::Answers);
    shell.retry_drive(i);
    ready(&shell.drive(i).page);
}

#[test]
fn a_folder_with_nothing_in_it_is_the_empty_state_with_its_sentence_and_action() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    let i = empty_folder(&d, &mut shell, "Receipts");
    let empty = empty_of(&shell.drive(i).page);
    assert_eq!(empty.headline, "This folder is empty.");
    assert!(!empty.action_label.is_empty());
    assert_eq!(
        shell.drive(i).empty_action,
        wire::docs_drive_data::EmptyAction::Add as i32
    );
    assert!(
        shell.drive(i).content.is_none(),
        "empty is never ready data"
    );
}

#[test]
fn a_failed_refresh_keeps_the_documents_shown_and_over_nothing_it_is_failed() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);

    // Over documents shown: they stay, under the sentence.
    let i = root(&mut shell);
    ready(&shell.drive(i).page);
    shell.reads(Mode::Fails);
    shell.retry_drive(i);
    refresh_failed(&shell.drive(i).page);
    assert!(shell.drive(i).content.is_some(), "the documents stay");
    // Back, and the note goes.
    shell.reads(Mode::Answers);
    shell.retry_drive(i);
    ready(&shell.drive(i).page);

    // Over an empty answer: failed, never empty.
    let empty = empty_folder(&d, &mut shell, "Receipts");
    empty_of(&shell.drive(empty).page);
    shell.reads(Mode::Fails);
    shell.retry_drive(empty);
    assert!(failed(&shell.drive(empty).page));
    assert!(shell.drive(empty).content.is_none());
}

#[test]
fn a_shelf_that_fails_to_read_is_failed_and_not_the_old_documents_under_a_new_shelf() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    let i = root(&mut shell);
    ready(&shell.drive(i).page);
    shell.reads(Mode::Fails);
    shell.drive_event(
        i,
        drive::Kind::Band(drive::BandPicked {
            key: "starred".to_owned(),
        }),
    );
    assert!(failed(&shell.drive(i).page));
    assert!(shell.drive(i).content.is_none());
}

#[test]
fn a_filter_that_leaves_nothing_is_the_empty_state_and_clear_filters_is_its_action() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    let i = root(&mut shell);
    shell.drive_event(
        i,
        drive::Kind::FilterMenuPicked(wire::FilterMenuPicked {
            section_key: "type".to_owned(),
            option_key: "video".to_owned(),
        }),
    );
    let empty = empty_of(&shell.drive(i).page);
    assert_eq!(empty.headline, "Nothing matches these filters.");
    assert_eq!(empty.action_label, "Clear filters");
    assert_eq!(
        shell.drive(i).empty_action,
        wire::docs_drive_data::EmptyAction::ClearFilters as i32
    );
    // The filter that fails to read is the failure, not the empty state.
    shell.reads(Mode::Fails);
    shell.retry_drive(i);
    assert!(failed(&shell.drive(i).page));
}

// ---- search ----

fn search_for(shell: &mut Shell, i: u64, term: &str) {
    shell.drive_event(i, drive::Kind::SearchOpened(drive::SearchOpened {}));
    shell.drive_event(
        i,
        drive::Kind::SearchTerm(drive::SearchTermChanged {
            term: term.to_owned(),
        }),
    );
}

#[test]
fn a_search_that_cannot_be_read_is_failed_refused_or_empty_but_never_the_wrong_one() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    let i = root(&mut shell);

    // Nothing matched: the page's empty state, and the Ask row still closes the answer.
    search_for(&mut shell, i, "zzzqqq");
    let empty = empty_of(&shell.drive(i).page);
    assert_eq!(empty.headline, "Nothing matches that.");
    assert!(shell.drive(i).search.as_ref().unwrap().ask_row.is_some());
    assert!(shell.drive(i).content.is_none());

    // A term that cannot be read is the failure, not the empty answer.
    shell.reads(Mode::Fails);
    shell.drive_event(
        i,
        drive::Kind::SearchTerm(drive::SearchTermChanged {
            term: "lease".to_owned(),
        }),
    );
    assert!(failed(&shell.drive(i).page));
    assert!(shell.drive(i).search.as_ref().unwrap().ask_row.is_none());

    shell.reads(Mode::Refuses);
    shell.retry_drive(i);
    gate_words(&shell.drive(i).page);

    // Answered, a search that matched is ready; a failed refresh keeps its rows under the note.
    shell.reads(Mode::Answers);
    shell.drive_event(
        i,
        drive::Kind::SearchTerm(drive::SearchTermChanged {
            term: "Tahoe".to_owned(),
        }),
    );
    ready(&shell.drive(i).page);
    assert!(shell.drive(i).content.is_some());
    shell.reads(Mode::Fails);
    shell.retry_drive(i);
    refresh_failed(&shell.drive(i).page);
    assert!(shell.drive(i).content.is_some(), "the hits stay");
    // Another term that fails starts from nothing: never the last term's hits under a note.
    shell.drive_event(
        i,
        drive::Kind::SearchTerm(drive::SearchTermChanged {
            term: "Tahoe trip".to_owned(),
        }),
    );
    assert!(failed(&shell.drive(i).page));
    assert!(shell.drive(i).content.is_none());
}

// ---- one document ----

#[test]
fn a_document_that_cannot_be_read_is_failed_refused_or_gone_but_never_the_wrong_one() {
    let d = driver();
    let id = text(&d, "Letter", "first");
    let mut shell = Shell::new(&d.handle);

    shell.reads(Mode::Fails);
    let i = shell.push(routes::document(&id, "Letter", "Docs"));
    assert!(failed(&shell.document(i).page));
    assert!(shell.document(i).content.is_none());

    shell.reads(Mode::Refuses);
    shell.retry_document(i);
    gate_words(&shell.document(i).page);
    assert!(shell.document(i).sheet.is_none());

    shell.reads(Mode::Answers);
    shell.retry_document(i);
    ready(&shell.document(i).page);
    assert!(shell.document(i).content.is_some());

    // A document nothing holds is the empty state in its own words, not a failure.
    let gone = shell.push(routes::document("nope", "", ""));
    let empty = empty_of(&shell.document(gone).page);
    assert_eq!(empty.headline, "This document is no longer here.");
    assert!(shell.document(gone).content.is_none());
    // Failing to read it again is the failure, never the empty state.
    shell.reads(Mode::Fails);
    shell.retry_document(gone);
    assert!(failed(&shell.document(gone).page));
}

#[test]
fn a_failed_refresh_keeps_the_document_shown_under_the_sentence() {
    let d = driver();
    let id = text(&d, "Letter", "first");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::document(&id, "Letter", "Docs"));
    ready(&shell.document(i).page);
    shell.reads(Mode::Fails);
    shell.retry_document(i);
    refresh_failed(&shell.document(i).page);
    assert!(shell.document(i).content.is_some(), "the document stays");
    shell.reads(Mode::Answers);
    shell.retry_document(i);
    ready(&shell.document(i).page);
}

#[test]
fn what_the_folder_says_that_was_not_checked_is_a_note_over_the_document_with_no_action() {
    let d = driver();
    let id = pdf(&d, "Lease.pdf", 'a');
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::FailsPhone);
    let i = shell.push(routes::document(&id, "Lease.pdf", "Docs"));
    let note = ready_note(&shell.document(i).page).expect("a note over the document");
    assert_eq!(note.kind, wire::page_note::Kind::NotChecked as i32);
    assert!(!note.sentence.is_empty());
    assert!(note.action_label.is_empty(), "nothing to retry from here");
    assert!(shell.document(i).content.is_some());
    // The read that did not land is no longer said on the status line.
    assert!(
        shell
            .document(i)
            .status
            .as_ref()
            .is_none_or(|status| status.sentence != note.sentence)
    );
    // Read, and the note goes.
    shell.reads(Mode::Answers);
    shell.retry_document(i);
    ready(&shell.document(i).page);
}

// ---- the editor ----

#[test]
fn an_editor_that_cannot_read_is_failed_refused_or_says_why_it_cannot_edit() {
    let d = driver();
    let id = text(&d, "Letter", "first");
    let binary = pdf(&d, "Lease.pdf", 'b');
    let mut shell = Shell::new(&d.handle);

    shell.reads(Mode::Fails);
    let i = shell.push(routes::editor(&id, "Letter"));
    assert!(failed(&shell.editor(i).page));
    assert!(shell.editor(i).content.is_none());

    shell.reads(Mode::Refuses);
    shell.retry_editor(i);
    gate_words(&shell.editor(i).page);

    shell.reads(Mode::Answers);
    shell.retry_editor(i);
    ready(&shell.editor(i).page);
    assert!(shell.editor(i).content.is_some());

    // A document with no text to edit is a failure in its own words, with no words drawn.
    let none = shell.push(routes::editor(&binary, "Lease.pdf"));
    let Some(State::Failed(failure)) = state_of(&shell.editor(none).page) else {
        panic!("not failed: {:?}", shell.editor(none).page);
    };
    assert_eq!(failure.sentence, "This document has no text to edit.");
    assert!(shell.editor(none).content.is_none());
}

#[test]
fn a_failed_re_read_leaves_the_words_with_a_note_and_never_in_their_place() {
    let d = driver();
    let id = text(&d, "Letter", "first");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::editor(&id, "Letter"));
    ready(&shell.editor(i).page);
    shell.reads(Mode::Fails);
    shell.retry_editor(i);
    refresh_failed(&shell.editor(i).page);
    let Some(wire::docs_editor_state::Content::Draft(draft)) = &shell.editor(i).content else {
        panic!("the words stay: {:?}", shell.editor(i).content);
    };
    assert_eq!(draft.body, "first");
    shell.reads(Mode::Answers);
    shell.retry_editor(i);
    ready(&shell.editor(i).page);
}
