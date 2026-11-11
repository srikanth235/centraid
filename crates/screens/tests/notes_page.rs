//! Notes' reads on the shared page state (#1185): a read that came to nothing is the failure and
//! never an empty list, a refusal is the gate, a read that came with nothing is the screen's own
//! empty state, and a refresh that failed keeps what was shown under one sentence. On every screen
//! that reads: the three places, search, the editor and its link powerbox.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail or refuse.

mod notes_support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::notes::{self, routes};
use centraid_screens::strings::{Locale, shared};
use notes_support::{clear_notes, driver, note};
use wire::notes_editor_event as editor;
use wire::notes_home_event as home;
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

/// A shell: Notes' screens over the door, with the last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
}

impl<'a> Shell<'a> {
    fn new(core: &'a Handle) -> Self {
        let mut shell = Self {
            runtime: notes::runtime(),
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
                tab: notes::TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == notes::TAB))
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

    fn home_event(&mut self, instance: u64, event: home::Kind) {
        self.send(
            instance,
            wire::screen_event::Kind::NotesHome(wire::NotesHomeEvent { kind: Some(event) }),
        );
    }

    fn editor_event(&mut self, instance: u64, event: editor::Kind) {
        self.send(
            instance,
            wire::screen_event::Kind::NotesEditor(wire::NotesEditorEvent { kind: Some(event) }),
        );
    }

    fn retry_home(&mut self, instance: u64) {
        self.home_event(instance, home::Kind::Refreshed(home::Refreshed {}));
    }

    fn home(&self, instance: u64) -> &wire::NotesHomeState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::NotesHome(state)) => state,
            other => panic!("not the home: {other:?}"),
        }
    }

    fn editor(&self, instance: u64) -> &wire::NotesEditorState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::NotesEditor(state)) => state,
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
    assert!(ready_note(page).is_none(), "ready with no note: {:?}", page);
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

/// A journal entry on the day the core reads as today, so the journal has something to show.
fn journal_entry(d: &centraid_screens::testing::Driver) {
    let wire::app_query_response::Answer::NotesJournal(core) = notes_support::answer(
        d,
        centraid_screens::catalog::load::notes::Journal::default(),
    ) else {
        panic!("the journal answers");
    };
    notes_support::arrange(
        d,
        centraid_screens::catalog::act::people::AddJournalEntry {
            mood: "calm".into(),
            text: "A quiet morning".into(),
            entry_date: Some(core.today),
            tz: Some(core.tz),
        },
    );
}

fn place(shell: &mut Shell, place: wire::NotesPlace) -> u64 {
    shell.push(routes::home(place, "", "", false))
}

// ---- the three places ----

#[test]
fn a_notes_place_that_cannot_be_read_is_failed_and_never_the_day_one_sentence() {
    let d = driver();
    clear_notes(&d);
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = place(&mut shell, wire::NotesPlace::Notes);
    assert!(failed(&shell.home(i).page));
    assert!(shell.home(i).content.is_none());
    // Retry reads again, and an empty vault is then the empty state.
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    assert!(matches!(
        state_of(&shell.home(i).page),
        Some(State::Empty(_))
    ));
}

#[test]
fn a_refused_notes_place_is_the_gate_with_nothing_to_offer() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Refuses);
    let i = place(&mut shell, wire::NotesPlace::Notes);
    gate_words(&shell.home(i).page);
    assert!(shell.home(i).band.is_empty() && shell.home(i).more_rows.is_empty());
    assert!(shell.home(i).filter_menu.is_none());
}

#[test]
fn an_empty_notes_place_is_the_empty_state_with_its_own_sentence_and_action() {
    let d = driver();
    clear_notes(&d);
    let mut shell = Shell::new(&d.handle);
    let i = place(&mut shell, wire::NotesPlace::Notes);
    let Some(State::Empty(empty)) = state_of(&shell.home(i).page) else {
        panic!("not empty: {:?}", shell.home(i).page);
    };
    assert_eq!(empty.headline, "No notes yet");
    assert_eq!(empty.action_label, "New note");
    assert!(shell.home(i).content.is_none(), "empty is never ready data");
}

#[test]
fn a_failed_refresh_keeps_the_notes_shown_and_over_nothing_it_is_failed() {
    let d = driver();
    clear_notes(&d);
    let mut shell = Shell::new(&d.handle);
    // Over nothing shown: failed, never empty.
    let empty = place(&mut shell, wire::NotesPlace::Notes);
    assert!(matches!(
        state_of(&shell.home(empty).page),
        Some(State::Empty(_))
    ));
    shell.reads(Mode::Fails);
    shell.retry_home(empty);
    assert!(failed(&shell.home(empty).page));

    // Over notes shown: they stay, under the sentence.
    shell.reads(Mode::Answers);
    note(&d, "Grocery run", "milk");
    shell.retry_home(empty);
    ready(&shell.home(empty).page);
    shell.reads(Mode::Fails);
    shell.retry_home(empty);
    refresh_failed(&shell.home(empty).page);
    assert!(shell.home(empty).content.is_some(), "the notes stay");
    // Back, and the note goes.
    shell.reads(Mode::Answers);
    shell.retry_home(empty);
    ready(&shell.home(empty).page);
}

#[test]
fn a_filter_that_fails_to_read_is_failed_and_not_the_old_notes_under_a_new_filter() {
    let d = driver();
    clear_notes(&d);
    note(&d, "Grocery run", "milk");
    let mut shell = Shell::new(&d.handle);
    let i = place(&mut shell, wire::NotesPlace::Notes);
    ready(&shell.home(i).page);
    shell.reads(Mode::Fails);
    shell.home_event(
        i,
        home::Kind::FilterMenuPicked(wire::FilterMenuPicked {
            section_key: "show".to_owned(),
            option_key: "pinned".to_owned(),
        }),
    );
    assert!(failed(&shell.home(i).page));
    assert!(shell.home(i).content.is_none());
}

#[test]
fn notebooks_and_the_journal_are_failed_refused_and_noted_like_the_notes_place() {
    let d = driver();
    journal_entry(&d);
    let mut shell = Shell::new(&d.handle);
    for kind in [wire::NotesPlace::Notebooks, wire::NotesPlace::Journal] {
        shell.reads(Mode::Fails);
        let i = place(&mut shell, kind);
        assert!(failed(&shell.home(i).page), "{kind:?}");
        assert!(shell.home(i).content.is_none());
        shell.reads(Mode::Refuses);
        shell.retry_home(i);
        gate_words(&shell.home(i).page);
        shell.reads(Mode::Answers);
        shell.retry_home(i);
        // The notebooks always hold "Unfiled", so they are ready; the journal has a day.
        ready(&shell.home(i).page);
        assert!(shell.home(i).content.is_some());
        shell.reads(Mode::Fails);
        shell.retry_home(i);
        refresh_failed(&shell.home(i).page);
        assert!(shell.home(i).content.is_some(), "what was shown stays");
    }
}

#[test]
fn an_empty_journal_is_the_empty_state_and_still_takes_a_first_entry() {
    let d = driver();
    let journal = notes_support::answer(
        &d,
        centraid_screens::catalog::load::notes::Journal::default(),
    );
    let wire::app_query_response::Answer::NotesJournal(core) = journal else {
        panic!("the journal answers");
    };
    for day in core.days {
        for entry in day.entries {
            notes_support::arrange(
                &d,
                centraid_screens::catalog::act::notes::DeleteNote {
                    note_id: entry.note_id,
                },
            );
        }
    }
    let mut shell = Shell::new(&d.handle);
    let i = place(&mut shell, wire::NotesPlace::Journal);
    let Some(State::Empty(empty)) = state_of(&shell.home(i).page) else {
        panic!("not empty: {:?}", shell.home(i).page);
    };
    assert_eq!(empty.headline, "No journal entries yet");
    // An empty journal holds no data, but the day to file an entry on is still known.
    shell.home_event(i, home::Kind::NewEntry(home::NewEntryTapped {}));
    assert!(shell.home(i).compose.is_some());
    // A journal that cannot be read opens no sheet: there is no day to date it by.
    shell.home_event(i, home::Kind::ComposeClosed(home::ComposeClosed {}));
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    assert!(
        failed(&shell.home(i).page),
        "failed over empty, never empty"
    );
    shell.home_event(i, home::Kind::NewEntry(home::NewEntryTapped {}));
    assert!(shell.home(i).compose.is_none());
}

// ---- search ----

fn search_for(shell: &mut Shell, i: u64, term: &str) {
    shell.home_event(i, home::Kind::SearchOpened(home::SearchOpened {}));
    shell.home_event(
        i,
        home::Kind::SearchTerm(home::SearchTerm {
            term: term.to_owned(),
        }),
    );
}

#[test]
fn a_search_that_cannot_be_read_is_failed_refused_or_empty_but_never_the_wrong_one() {
    let d = driver();
    clear_notes(&d);
    note(&d, "Shopping", "buy milk today");
    let mut shell = Shell::new(&d.handle);
    let i = place(&mut shell, wire::NotesPlace::Notes);

    // Nothing typed: ready, with the hint.
    shell.home_event(i, home::Kind::SearchOpened(home::SearchOpened {}));
    ready(&shell.home(i).page);
    assert!(
        !shell
            .home(i)
            .search
            .as_ref()
            .unwrap()
            .results
            .as_ref()
            .unwrap()
            .hint
            .is_empty()
    );

    // Failed, never "no matches".
    shell.reads(Mode::Fails);
    shell.home_event(
        i,
        home::Kind::SearchTerm(home::SearchTerm {
            term: "milk".to_owned(),
        }),
    );
    assert!(failed(&shell.home(i).page));
    let search = shell.home(i).search.as_ref().unwrap();
    assert!(search.results.is_none() && search.ask.is_none());

    // Refused: the gate.
    shell.reads(Mode::Refuses);
    shell.retry_home(i);
    gate_words(&shell.home(i).page);

    // Answered with a match, then with none: the empty state, with the ask still offered.
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
    assert_eq!(
        shell
            .home(i)
            .search
            .as_ref()
            .unwrap()
            .results
            .as_ref()
            .unwrap()
            .rows
            .len(),
        1
    );
    shell.home_event(
        i,
        home::Kind::SearchTerm(home::SearchTerm {
            term: "zzqxv".to_owned(),
        }),
    );
    let Some(State::Empty(empty)) = state_of(&shell.home(i).page) else {
        panic!("not empty: {:?}", shell.home(i).page);
    };
    assert_eq!(empty.headline, "No matches");
    assert!(shell.home(i).search.as_ref().unwrap().ask.is_some());
    // A failed refresh of an empty answer is failed.
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    assert!(failed(&shell.home(i).page));
}

#[test]
fn a_failed_refresh_of_the_term_shown_keeps_its_rows_and_a_new_term_that_fails_does_not() {
    let d = driver();
    clear_notes(&d);
    note(&d, "Shopping", "buy milk today");
    let mut shell = Shell::new(&d.handle);
    let i = place(&mut shell, wire::NotesPlace::Notes);
    search_for(&mut shell, i, "milk");
    ready(&shell.home(i).page);
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    refresh_failed(&shell.home(i).page);
    assert_eq!(
        shell
            .home(i)
            .search
            .as_ref()
            .unwrap()
            .results
            .as_ref()
            .unwrap()
            .rows
            .len(),
        1,
        "the rows stay"
    );
    shell.home_event(
        i,
        home::Kind::SearchTerm(home::SearchTerm {
            term: "buy".to_owned(),
        }),
    );
    assert!(failed(&shell.home(i).page));
}

// ---- the editor ----

#[test]
fn an_editor_that_cannot_read_its_note_is_failed_and_not_an_empty_page() {
    let d = driver();
    let id = note(&d, "Keep", "words");
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = shell.push(routes::editor(&id));
    assert!(failed(&shell.editor(i).page));
    assert!(shell.editor(i).draft.is_none() && shell.editor(i).rich.is_none());
    // Retry reads it again.
    shell.reads(Mode::Answers);
    shell.editor_event(i, editor::Kind::Refreshed(editor::Refreshed {}));
    ready(&shell.editor(i).page);
    assert_eq!(shell.editor(i).draft.as_ref().unwrap().body, "words");
}

#[test]
fn a_refused_editor_is_the_gate_in_notes_own_words() {
    let d = driver();
    let id = note(&d, "Keep", "words");
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Refuses);
    let i = shell.push(routes::editor(&id));
    gate_words(&shell.editor(i).page);
    assert!(shell.editor(i).draft.is_none());
}

#[test]
fn a_failed_reread_leaves_the_words_under_one_sentence_and_not_on_the_status_line() {
    let d = driver();
    let id = note(&d, "Keep", "words");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::editor(&id));
    ready(&shell.editor(i).page);
    shell.reads(Mode::Fails);
    shell.editor_event(i, editor::Kind::Refreshed(editor::Refreshed {}));
    refresh_failed(&shell.editor(i).page);
    assert_eq!(shell.editor(i).draft.as_ref().unwrap().body, "words");
    let status = &shell.editor(i).chrome.as_ref().unwrap().status;
    assert_ne!(*status, shared::read_refresh_failed(Locale::En));
    // The note clears once a read comes.
    shell.reads(Mode::Answers);
    shell.editor_event(i, editor::Kind::Refreshed(editor::Refreshed {}));
    ready(&shell.editor(i).page);
}

// ---- the link powerbox ----

#[test]
fn the_powerbox_is_loading_failed_refused_or_empty_never_a_blank_list() {
    let d = driver();
    let id = note(&d, "Keep", "words");
    note(&d, "Something to link to", "x");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::editor(&id));

    shell.reads(Mode::Fails);
    shell.editor_event(i, editor::Kind::LinkRequested(editor::LinkRequested {}));
    let sheet = shell.editor(i).link.as_ref().expect("the powerbox is open");
    assert!(failed(&sheet.page));
    assert!(sheet.data.is_none());

    shell.reads(Mode::Refuses);
    shell.editor_event(i, editor::Kind::Refreshed(editor::Refreshed {}));
    gate_words(&shell.editor(i).link.as_ref().unwrap().page);

    // Nothing typed finds nothing to link: the empty state, with the sentence for no term.
    shell.reads(Mode::Answers);
    shell.editor_event(i, editor::Kind::Refreshed(editor::Refreshed {}));
    let sheet = shell.editor(i).link.as_ref().unwrap();
    let Some(State::Empty(empty)) = state_of(&sheet.page) else {
        panic!("not empty: {:?}", sheet.page);
    };
    assert_eq!(empty.headline, "Nothing to link");
    shell.editor_event(
        i,
        editor::Kind::LinkTerm(editor::LinkTerm {
            term: "something".to_owned(),
        }),
    );
    let sheet = shell.editor(i).link.as_ref().unwrap();
    ready(&sheet.page);
    assert!(sheet.data.is_some());

    // Nothing the term finds is the empty state, with the sentence for a term.
    shell.editor_event(
        i,
        editor::Kind::LinkTerm(editor::LinkTerm {
            term: "zzqxvv".to_owned(),
        }),
    );
    let sheet = shell.editor(i).link.as_ref().unwrap();
    let Some(State::Empty(empty)) = state_of(&sheet.page) else {
        panic!("not empty: {:?}", sheet.page);
    };
    assert_eq!(empty.body, "Nothing matches that search.");
    assert!(sheet.data.is_none());

    // A failed refresh of the term shown over nothing is failed.
    shell.reads(Mode::Fails);
    shell.editor_event(i, editor::Kind::Refreshed(editor::Refreshed {}));
    assert!(failed(&shell.editor(i).link.as_ref().unwrap().page));
}
