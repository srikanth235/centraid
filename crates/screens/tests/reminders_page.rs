//! Reminders' reads on the shared page state (#1185): a read that came to nothing is the failure and
//! never an empty list, a refusal is the gate, a read that came with nothing is the screen's own
//! empty state, and a refresh that failed keeps what was shown under one sentence. On every screen
//! that reads: the home (and its search), a list, a project, a task, Catch up and the new-reminder
//! sheet.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail or refuse.

mod reminders_support;

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::kit::read as kit_read;
use centraid_screens::reminders::routes;
use centraid_screens::strings::{Locale, shared};
use reminders_support::{clear_tasks, driver, project, task};
use wire::page_state::State;
use wire::todo_catch_up_event as catch_up;
use wire::todo_detail_event as detail;
use wire::todo_list_event as list;
use wire::todo_project_event as proj;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Answers,
    Fails,
    Refuses,
    /// Only the read of this query fails.
    FailsQuery(&'static str),
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
            Mode::FailsQuery(query) if request.query != query => self.core.load(request),
            Mode::Fails | Mode::FailsQuery(_) => Err(CoreError::Unavailable {
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

/// A shell: Reminders' screens over the door, with the last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
}

const TAB: &str = "reminders";

impl<'a> Shell<'a> {
    fn new(core: &'a Handle) -> Self {
        let mut shell = Self {
            runtime: centraid_screens::Runtime::new(
                centraid_screens::agenda::registry(),
                vec![(TAB.to_owned(), routes::home())],
            ),
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
                tab: TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == TAB))
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

    // -- home
    fn home_event(&mut self, instance: u64, event: wire::agenda_home_event::Kind) {
        self.send(
            instance,
            wire::screen_event::Kind::AgendaHome(wire::AgendaHomeEvent { kind: Some(event) }),
        );
    }

    fn retry_home(&mut self, instance: u64) {
        self.home_event(
            instance,
            wire::agenda_home_event::Kind::Refreshed(wire::agenda_home_event::Refreshed {}),
        );
    }

    fn search(&mut self, instance: u64, term: &str) {
        self.home_event(
            instance,
            wire::agenda_home_event::Kind::SearchTerm(wire::agenda_home_event::SearchTermChanged {
                term: term.to_owned(),
            }),
        );
    }

    fn home(&self, instance: u64) -> &wire::AgendaHomeState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::AgendaHome(state)) => state,
            other => panic!("not the home: {other:?}"),
        }
    }

    // -- a list
    fn list_event(&mut self, instance: u64, event: list::Kind) {
        self.send(
            instance,
            wire::screen_event::Kind::TodoList(wire::TodoListEvent { kind: Some(event) }),
        );
    }

    fn retry_list(&mut self, instance: u64) {
        self.list_event(instance, list::Kind::Refreshed(list::Refreshed {}));
    }

    fn list(&self, instance: u64) -> &wire::TodoListState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::TodoList(state)) => state,
            other => panic!("not a list: {other:?}"),
        }
    }

    // -- a project
    fn retry_project(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::TodoProject(wire::TodoProjectEvent {
                kind: Some(proj::Kind::Refreshed(proj::Refreshed {})),
            }),
        );
    }

    fn project(&self, instance: u64) -> &wire::TodoProjectState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::TodoProject(state)) => state,
            other => panic!("not a project: {other:?}"),
        }
    }

    // -- a task
    fn retry_task(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::TodoDetail(wire::TodoDetailEvent {
                kind: Some(detail::Kind::Refreshed(detail::Refreshed {})),
            }),
        );
    }

    fn task(&self, instance: u64) -> &wire::TodoDetailState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::TodoDetail(state)) => state,
            other => panic!("not a task: {other:?}"),
        }
    }

    // -- catch up
    fn retry_catch_up(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::TodoCatchUp(wire::TodoCatchUpEvent {
                kind: Some(catch_up::Kind::Refreshed(catch_up::Refreshed {})),
            }),
        );
    }

    fn catch_up(&self, instance: u64) -> &wire::TodoCatchUpState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::TodoCatchUp(state)) => state,
            other => panic!("not catch up: {other:?}"),
        }
    }

    // -- the new-reminder sheet
    fn retry_editor(&mut self, instance: u64) {
        self.send(
            instance,
            wire::screen_event::Kind::AgendaEditor(wire::AgendaEditorEvent {
                kind: Some(wire::agenda_editor_event::Kind::Refreshed(
                    wire::agenda_editor_event::Refreshed {},
                )),
            }),
        );
    }

    fn editor(&self, instance: u64) -> &wire::AgendaEditorState {
        match &self.views[&instance].kind {
            Some(wire::view_state::Kind::AgendaEditor(state)) => state,
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

fn failed_sentence(page: &Option<wire::PageState>) -> &str {
    let Some(State::Failed(failure)) = state_of(page) else {
        panic!("not failed: {page:?}");
    };
    &failure.sentence
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

// ---- the home ----

#[test]
fn a_home_that_cannot_be_read_is_failed_and_never_the_day_one_sentence() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = shell.push(routes::home());
    assert!(failed(&shell.home(i).page));
    assert!(shell.home(i).content.is_none());
    // Retry reads again, and the home is then ready.
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
    assert!(shell.home(i).content.is_some());
}

#[test]
fn a_refused_home_is_the_gate_with_no_band_and_nothing_to_add() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Refuses);
    let i = shell.push(routes::home());
    gate_words(&shell.home(i).page);
    assert!(shell.home(i).content.is_none());
    assert!(shell.home(i).band.is_empty());
    assert!(!shell.home(i).quick_add.as_ref().unwrap().shown);
    // A gate never retries itself, and a read that lands clears it.
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
}

#[test]
fn a_failed_refresh_keeps_the_lists_shown_and_a_failed_first_read_does_not_invent_them() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home());
    ready(&shell.home(i).page);
    shell.reads(Mode::Fails);
    shell.retry_home(i);
    refresh_failed(&shell.home(i).page);
    assert!(shell.home(i).content.is_some(), "the lists stay");
    shell.reads(Mode::Answers);
    shell.retry_home(i);
    ready(&shell.home(i).page);
}

#[test]
fn a_search_that_matches_nothing_is_the_empty_state_with_its_sentence() {
    let d = driver();
    task(&d, "Pay rent");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home());
    shell.home_event(
        i,
        wire::agenda_home_event::Kind::SearchOpened(wire::agenda_home_event::SearchOpened {}),
    );
    shell.search(i, "zzzzqq");
    let empty = empty_of(&shell.home(i).page);
    assert_eq!(empty.headline, "Nothing matches that.");
    assert!(!empty.body.is_empty());
    assert!(shell.home(i).content.is_none(), "empty is never ready data");
    assert!(
        shell.home(i).search_ask_row.is_some(),
        "the ask row closes an answer"
    );
    // A term that matches is ready.
    shell.search(i, "rent");
    ready(&shell.home(i).page);
    assert!(shell.home(i).content.is_some());
}

#[test]
fn a_search_that_fails_is_failed_and_not_the_old_rows_under_a_new_term() {
    let d = driver();
    task(&d, "Pay rent");
    task(&d, "Pay tax");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::home());
    shell.home_event(
        i,
        wire::agenda_home_event::Kind::SearchOpened(wire::agenda_home_event::SearchOpened {}),
    );
    shell.search(i, "rent");
    ready(&shell.home(i).page);

    // The same term read again and failing keeps its rows under the sentence.
    shell.reads(Mode::FailsQuery("search"));
    shell.retry_home(i);
    refresh_failed(&shell.home(i).page);
    assert!(shell.home(i).content.is_some());

    // Another term that fails starts from nothing: failed, never the old hits.
    shell.search(i, "tax");
    assert!(failed(&shell.home(i).page));
    assert!(shell.home(i).content.is_none());

    // And a refusal of a search is the gate.
    shell.reads(Mode::Refuses);
    shell.search(i, "rent");
    gate_words(&shell.home(i).page);
    assert!(shell.home(i).band.is_empty());
}

// ---- a list ----

#[test]
fn a_list_that_cannot_be_read_is_failed_and_never_its_empty_sentence() {
    let d = driver();
    clear_tasks(&d);
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Fails);
    let i = shell.push(routes::todo_list(wire::TodoView::Anytime));
    assert!(failed(&shell.list(i).page));
    assert!(shell.list(i).content.is_none());
    assert!(shell.list(i).add_label.is_empty(), "nothing to add against");
    shell.reads(Mode::Answers);
    shell.retry_list(i);
    assert_eq!(
        empty_of(&shell.list(i).page).headline,
        "Nothing undated is open."
    );
}

#[test]
fn a_refused_list_is_the_gate() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Refuses);
    let i = shell.push(routes::todo_list(wire::TodoView::All));
    gate_words(&shell.list(i).page);
    assert!(shell.list(i).content.is_none());
    shell.reads(Mode::Answers);
    shell.retry_list(i);
    ready(&shell.list(i).page);
}

#[test]
fn an_empty_list_says_its_sentence_and_still_adds_and_a_failed_refresh_keeps_or_fails() {
    let d = driver();
    clear_tasks(&d);
    task(&d, "Idea");
    let mut shell = Shell::new(&d.handle);
    let all = shell.push(routes::todo_list(wire::TodoView::All));
    ready(&shell.list(all).page);
    // Over rows shown: they stay, under the sentence.
    shell.reads(Mode::Fails);
    shell.retry_list(all);
    refresh_failed(&shell.list(all).page);
    assert!(shell.list(all).content.is_some());
    shell.reads(Mode::Answers);
    shell.retry_list(all);
    ready(&shell.list(all).page);

    // The Logbook has nothing done: its own sentence, the plus still there.
    let logbook = shell.push(routes::todo_list(wire::TodoView::Logbook));
    assert_eq!(
        empty_of(&shell.list(logbook).page).headline,
        "Nothing is done yet."
    );
    assert!(shell.list(logbook).content.is_none());
    assert!(shell.list(logbook).add_route.is_some());
    // Over an empty answer a failed refresh is failed, never empty.
    shell.reads(Mode::Fails);
    shell.retry_list(logbook);
    assert!(failed(&shell.list(logbook).page));
}

#[test]
fn a_window_that_does_not_widen_keeps_the_rows_under_its_own_sentence() {
    let d = driver();
    clear_tasks(&d);
    for n in 0..105 {
        task(&d, &format!("Idea {n:03}"));
    }
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::todo_list(wire::TodoView::All));
    ready(&shell.list(i).page);
    shell.reads(Mode::Fails);
    shell.list_event(i, list::Kind::NextPage(list::NextPageRequested {}));
    let note = ready_note(&shell.list(i).page).expect("a note");
    assert_eq!(
        note.sentence,
        kit_read::Note::more_failed(Locale::En).sentence
    );
    assert!(shell.list(i).content.is_some());
}

// ---- a project ----

#[test]
fn a_project_that_cannot_be_read_is_failed_refused_or_empty_but_never_the_wrong_one() {
    let d = driver();
    let garden = project(&d, "Garden");
    let mut shell = Shell::new(&d.handle);

    shell.reads(Mode::Fails);
    let i = shell.push(routes::project(&garden, "Garden"));
    assert!(failed(&shell.project(i).page));
    assert!(shell.project(i).head.is_none() && shell.project(i).content.is_none());

    shell.reads(Mode::Refuses);
    shell.retry_project(i);
    gate_words(&shell.project(i).page);
    assert!(!shell.project(i).quick_add.as_ref().unwrap().shown);

    // Nothing filed: the project's empty sentence, with its header verbs and quick add.
    shell.reads(Mode::Answers);
    shell.retry_project(i);
    let state = shell.project(i);
    assert_eq!(empty_of(&state.page).headline, "Nothing is filed here yet.");
    assert!(state.content.is_none());
    assert_eq!(state.head.as_ref().unwrap().rename_label, "Rename");
    assert!(state.quick_add.as_ref().unwrap().shown);

    // A failed refresh over an empty project is failed.
    shell.reads(Mode::Fails);
    shell.retry_project(i);
    assert!(failed(&shell.project(i).page));
}

#[test]
fn a_failed_refresh_keeps_the_projects_rows_and_a_project_that_is_gone_says_so() {
    let d = driver();
    let garden = project(&d, "Garden");
    reminders_support::add(
        &d,
        centraid_screens::catalog::act::reminders::AddTask {
            title: "Order seeds".into(),
            project_id: centraid_screens::field::Field::Is(garden.clone()),
            ..Default::default()
        },
    );
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::project(&garden, "Garden"));
    ready(&shell.project(i).page);
    shell.reads(Mode::Fails);
    shell.retry_project(i);
    refresh_failed(&shell.project(i).page);
    assert!(shell.project(i).content.is_some());
    assert!(shell.project(i).head.is_some(), "the header stays");

    // A project the answer does not name is failed in its own sentence.
    shell.reads(Mode::Answers);
    let ghost = shell.push(routes::project("no-such-project", "Ghost"));
    assert_eq!(
        failed_sentence(&shell.project(ghost).page),
        "This project is gone."
    );
    assert!(shell.project(ghost).head.is_none());
}

// ---- a task ----

#[test]
fn a_task_that_cannot_be_read_is_failed_or_refused_and_a_gone_one_says_so() {
    let d = driver();
    let id = task(&d, "Pay rent");
    let mut shell = Shell::new(&d.handle);

    shell.reads(Mode::Fails);
    let i = shell.push(routes::task(&id));
    assert!(failed(&shell.task(i).page));
    assert_eq!(
        failed_sentence(&shell.task(i).page),
        shared::read_failed(Locale::En)
    );
    assert!(shell.task(i).content.is_none());

    shell.reads(Mode::Refuses);
    shell.retry_task(i);
    gate_words(&shell.task(i).page);

    shell.reads(Mode::Answers);
    shell.retry_task(i);
    ready(&shell.task(i).page);
    assert!(shell.task(i).content.is_some());

    // Gone is the failure in its own sentence, never an empty page or the generic one.
    let gone = shell.push(routes::task("no-such-task"));
    assert_eq!(
        failed_sentence(&shell.task(gone).page),
        "This task is gone."
    );
    assert!(shell.task(gone).content.is_none());
}

#[test]
fn a_failed_reread_leaves_the_task_under_one_sentence() {
    let d = driver();
    let id = task(&d, "Pay rent");
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::task(&id));
    ready(&shell.task(i).page);
    shell.reads(Mode::Fails);
    shell.retry_task(i);
    refresh_failed(&shell.task(i).page);
    assert!(shell.task(i).content.is_some(), "the task stays");
    shell.reads(Mode::Answers);
    shell.retry_task(i);
    ready(&shell.task(i).page);
}

#[test]
fn a_check_of_what_the_phone_says_that_was_not_made_is_the_page_note_and_not_the_status_line() {
    let d = driver();
    let id = task(&d, "Pay rent");
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::FailsQuery("phone-differences"));
    let i = shell.push(routes::task(&id));
    let note = ready_note(&shell.task(i).page).expect("a note over the task");
    assert_eq!(note.kind, wire::page_note::Kind::NotChecked as i32);
    assert_eq!(note.sentence, "Couldn’t check what your phone says.");
    assert!(
        note.action_label.is_empty(),
        "a check not made carries no action"
    );
    assert!(shell.task(i).status.is_none());
    assert!(shell.task(i).phone_says.is_empty());
    // A check that is made says nothing.
    shell.reads(Mode::Answers);
    shell.retry_task(i);
    ready(&shell.task(i).page);
}

// ---- catch up ----

#[test]
fn catch_up_that_cannot_be_read_is_failed_and_one_short_of_its_lists_says_so() {
    let d = driver();
    clear_tasks(&d);
    let mut shell = Shell::new(&d.handle);

    shell.reads(Mode::Fails);
    let i = shell.push(routes::catch_up());
    assert_eq!(
        failed_sentence(&shell.catch_up(i).page),
        shared::read_failed(Locale::En)
    );
    assert!(shell.catch_up(i).content.is_none());

    // The catch-up came and the lists its rows name did not: neither can be made up.
    shell.reads(Mode::FailsQuery("projects"));
    shell.retry_catch_up(i);
    assert_eq!(
        failed_sentence(&shell.catch_up(i).page),
        shared::read_incomplete(Locale::En)
    );

    shell.reads(Mode::Refuses);
    shell.retry_catch_up(i);
    gate_words(&shell.catch_up(i).page);

    // Nothing behind is the page's empty state, in its own sentence.
    shell.reads(Mode::Answers);
    shell.retry_catch_up(i);
    assert_eq!(
        empty_of(&shell.catch_up(i).page).headline,
        "Nothing is overdue."
    );
    assert!(shell.catch_up(i).content.is_none());
    // A failed refresh over an empty answer is failed.
    shell.reads(Mode::Fails);
    shell.retry_catch_up(i);
    assert!(failed(&shell.catch_up(i).page));
}

#[test]
fn a_failed_refresh_keeps_the_piles_shown() {
    let d = driver();
    clear_tasks(&d);
    let yesterday = reminders_support::day(&d, -2);
    reminders_support::add(
        &d,
        centraid_screens::catalog::act::reminders::AddTask {
            title: "Invoice".into(),
            due: reminders_support::due(&yesterday),
            ..Default::default()
        },
    );
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::catch_up());
    ready(&shell.catch_up(i).page);
    assert!(shell.catch_up(i).content.is_some());
    // Either read failing leaves the piles, under the sentence.
    for mode in [Mode::Fails, Mode::FailsQuery("projects")] {
        shell.reads(mode);
        shell.retry_catch_up(i);
        refresh_failed(&shell.catch_up(i).page);
        assert!(shell.catch_up(i).content.is_some());
    }
    shell.reads(Mode::Answers);
    shell.retry_catch_up(i);
    ready(&shell.catch_up(i).page);
}

// ---- the new-reminder sheet ----

#[test]
fn the_new_reminder_sheet_is_failed_refused_or_ready_and_a_failed_reread_keeps_the_draft() {
    let d = driver();
    let mut shell = Shell::new(&d.handle);

    shell.reads(Mode::Fails);
    let i = shell.push(routes::editor("2099-01-01"));
    assert!(failed(&shell.editor(i).page));
    assert!(shell.editor(i).content.is_none());

    shell.reads(Mode::Refuses);
    shell.retry_editor(i);
    gate_words(&shell.editor(i).page);

    shell.reads(Mode::Answers);
    shell.retry_editor(i);
    ready(&shell.editor(i).page);
    assert!(shell.editor(i).content.is_some());

    // The draft is the member's: a re-read that fails leaves it under the sentence.
    shell.reads(Mode::Fails);
    shell.retry_editor(i);
    refresh_failed(&shell.editor(i).page);
    assert!(shell.editor(i).content.is_some());
    shell.reads(Mode::Answers);
    shell.retry_editor(i);
    ready(&shell.editor(i).page);
}
