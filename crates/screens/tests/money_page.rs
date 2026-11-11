//! Money's reads on the shared page state (#1185): a read that came to nothing is the failure and
//! never an empty page, a refusal is the gate, a list with nothing in it is the page's own empty
//! state, a line that is gone is a final failure in its own words, and a refresh that failed keeps
//! what was shown under one sentence.
//!
//! Each page is opened over a door that answers as the core does until the test says it should
//! fail, refuse or answer with nothing.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::{ScreenCtx, ScreenHost};
use centraid_core::{CoreError, Handle, Result};
use centraid_screens::money::{self, routes};
use centraid_screens::strings::{Locale, shared};
use centraid_screens::testing::Driver;
use wire::page_state::State;

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Answers,
    Fails,
    Refuses,
    /// Every list the page reads is there and holds nothing.
    Empty,
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
            Mode::Empty => Ok(wire::LoadResponse {
                answer: Some(wire::AppQueryResponse {
                    answer: Some(match request.query.as_str() {
                        "accounts" => wire::app_query_response::Answer::MoneyAccounts(
                            wire::MoneyAccounts::default(),
                        ),
                        "categories" => wire::app_query_response::Answer::MoneyCategories(
                            wire::MoneyCategories::default(),
                        ),
                        "recurring" => wire::app_query_response::Answer::MoneyRecurring(
                            wire::MoneyRecurring::default(),
                        ),
                        "rules" => {
                            wire::app_query_response::Answer::MoneyRules(wire::MoneyRules::default())
                        }
                        "search" => wire::app_query_response::Answer::MoneySearch(
                            wire::MoneySearch::default(),
                        ),
                        "activity" => wire::app_query_response::Answer::MoneyActivity(
                            wire::MoneyActivity::default(),
                        ),
                        "spending" => {
                            wire::app_query_response::Answer::MoneySpending(wire::MoneySpending {
                                empty: true,
                                ..Default::default()
                            })
                        }
                        "cashflow" => wire::app_query_response::Answer::MoneyCashflow(
                            wire::MoneyCashflow::default(),
                        ),
                        other => panic!("the empty door has no answer for {other}"),
                    }),
                }),
                ..Default::default()
            }),
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

/// A shell: Money's screens over the door, with the last view of each open page.
struct Shell<'a> {
    runtime: centraid_screens::Runtime,
    door: Door<'a>,
    views: BTreeMap<u64, wire::ViewState>,
}

impl<'a> Shell<'a> {
    fn new(core: &'a Handle) -> Self {
        let mut shell = Self {
            runtime: money::runtime(),
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

    /// Fail, refuse, empty or answer every read from now on.
    fn reads(&self, mode: Mode) {
        self.door.mode.set(mode);
    }

    fn push(&mut self, route: wire::Route) -> u64 {
        let update = self.call(wire::screen_request::Kind::Nav(wire::NavEvent {
            kind: Some(wire::nav_event::Kind::Push(wire::NavPush {
                tab: money::TAB.to_owned(),
                route: Some(route),
            })),
        }));
        update
            .navigation
            .as_ref()
            .and_then(|nav| nav.tabs.iter().find(|stack| stack.tab == money::TAB))
            .and_then(|stack| stack.entries.last())
            .map(|entry| entry.instance)
            .expect("a push moves the stack")
    }

    /// The vault said something changed: every page reads again.
    fn changed(&mut self, instance: u64) {
        self.call(wire::screen_request::Kind::Send(wire::InstanceEvent {
            instance,
            event: Some(wire::ScreenEvent {
                kind: Some(wire::screen_event::Kind::DataChanged(
                    wire::DataChanged::default(),
                )),
            }),
        }));
    }

    /// The page of whichever Money screen `instance` is.
    fn page(&self, instance: u64) -> &Option<wire::PageState> {
        use wire::view_state::Kind as K;
        match &self.views[&instance].kind {
            Some(K::MoneyHome(s)) => &s.page,
            Some(K::MoneyAccounts(s)) => &s.page,
            Some(K::MoneyCategories(s)) => &s.page,
            Some(K::MoneyRules(s)) => &s.page,
            Some(K::MoneyRecurring(s)) => &s.page,
            Some(K::MoneySearch(s)) => &s.page,
            Some(K::MoneyTransaction(s)) => &s.page,
            Some(K::MoneyTarget(s)) => &s.page,
            other => panic!("not a Money page: {other:?}"),
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

fn empty(page: &Option<wire::PageState>) -> &wire::EmptyState {
    let Some(State::Empty(empty)) = state_of(page) else {
        panic!("not empty: {page:?}");
    };
    empty
}

fn ready(page: &Option<wire::PageState>) {
    let page = page.as_ref().expect("a page");
    assert!(page.state.is_none(), "not ready: {:?}", page.state);
    assert!(page.note.is_none(), "ready with no note: {page:?}");
}

/// Ready, with the one sentence a refresh that failed leaves over what is shown, and Retry.
fn refresh_failed(page: &Option<wire::PageState>) {
    let page = page.as_ref().expect("a page");
    assert!(page.state.is_none(), "not ready: {:?}", page.state);
    let note = page.note.as_ref().expect("a note over what is shown");
    assert_eq!(note.kind, wire::page_note::Kind::Partial as i32);
    assert_eq!(note.sentence, shared::read_refresh_failed(Locale::En));
    assert_eq!(note.action_label, shared::kit_retry(Locale::En));
}

/// Every page that reads, as a route to open it.
fn pages() -> Vec<(&'static str, wire::Route)> {
    vec![
        ("activity", routes::home(wire::MoneyDestination::Activity)),
        ("spending", routes::home(wire::MoneyDestination::Spending)),
        ("cashflow", routes::home(wire::MoneyDestination::Cashflow)),
        ("accounts", routes::accounts("Money")),
        ("categories", routes::categories("Money")),
        ("rules", routes::rules("Money")),
        ("recurring", routes::recurring("Money")),
    ]
}

#[test]
fn a_page_that_cannot_be_read_is_failed_or_refused_and_never_empty_or_ready() {
    let d = Driver::founded();
    for (name, route) in pages() {
        let mut shell = Shell::new(&d.handle);
        shell.reads(Mode::Fails);
        let i = shell.push(route.clone());
        assert!(!failed(shell.page(i)).permanent, "{name}");
        shell.reads(Mode::Refuses);
        shell.changed(i);
        refused(shell.page(i));
        shell.reads(Mode::Answers);
        shell.changed(i);
        ready(shell.page(i));
    }
}

#[test]
fn a_failed_refresh_keeps_what_was_shown_under_one_sentence_and_a_failed_one_over_nothing_is_failed()
 {
    let d = Driver::founded();
    for (name, route) in pages() {
        let mut shell = Shell::new(&d.handle);
        let i = shell.push(route.clone());
        ready(shell.page(i));
        shell.reads(Mode::Fails);
        shell.changed(i);
        refresh_failed(shell.page(i));
        shell.reads(Mode::Answers);
        shell.changed(i);
        ready(shell.page(i));
        let _ = name;
    }
    // Over an empty list the same failure is the failure, never an empty list.
    for route in [routes::accounts("Money"), routes::recurring("Money")] {
        let mut shell = Shell::new(&d.handle);
        shell.reads(Mode::Empty);
        let i = shell.push(route);
        empty(shell.page(i));
        shell.reads(Mode::Fails);
        shell.changed(i);
        failed(shell.page(i));
    }
}

#[test]
fn a_list_with_nothing_in_it_is_the_pages_own_empty_state() {
    let d = Driver::founded();
    let mut shell = Shell::new(&d.handle);
    shell.reads(Mode::Empty);
    let accounts = shell.push(routes::accounts("Money"));
    let a = empty(shell.page(accounts));
    assert_eq!(a.headline, "No accounts yet.");
    assert!(!a.action_label.is_empty(), "its action adds one");
    let categories = shell.push(routes::categories("Money"));
    assert!(!empty(shell.page(categories)).headline.is_empty());
    let rules = shell.push(routes::rules("Money"));
    assert_eq!(empty(shell.page(rules)).headline, "No rules yet.");
    let recurring = shell.push(routes::recurring("Money"));
    assert!(!empty(shell.page(recurring)).headline.is_empty());
    // The sheets of the lists that edit still read what they offer, so the answer stays.
    let state = |i| match &shell.views[&i].kind {
        Some(wire::view_state::Kind::MoneyCategories(s)) => s.content.is_some(),
        _ => unreachable!(),
    };
    assert!(state(categories), "the add sheet still offers its groups");
}

#[test]
fn a_search_rests_or_matches_nothing_as_an_empty_page_and_fails_as_a_failure() {
    let d = Driver::founded();
    let mut shell = Shell::new(&d.handle);
    let i = shell.push(routes::search("Money"));
    assert_eq!(
        empty(shell.page(i)).headline,
        "Search by name, bank words or category."
    );
    shell.reads(Mode::Fails);
    let term = |term: &str| {
        wire::screen_event::Kind::MoneySearch(wire::MoneySearchEvent {
            kind: Some(wire::money_search_event::Kind::Term(
                wire::money_search_event::TermChanged {
                    term: term.to_owned(),
                },
            )),
        })
    };
    shell.call(wire::screen_request::Kind::Send(wire::InstanceEvent {
        instance: i,
        event: Some(wire::ScreenEvent {
            kind: Some(term("coffee")),
        }),
    }));
    failed(shell.page(i));
    shell.reads(Mode::Empty);
    shell.changed(i);
    assert_eq!(empty(shell.page(i)).headline, "Nothing matches coffee.");
}

#[test]
fn a_line_that_is_gone_is_a_final_failure_and_a_refusal_is_the_gate() {
    let d = Driver::founded();
    let mut shell = Shell::new(&d.handle);
    let gone = shell.push(routes::transaction("no-such-line", "Money"));
    let failure = failed(shell.page(gone));
    assert_eq!(failure.sentence, "This transaction is no longer here.");
    assert!(failure.permanent, "trying again cannot bring it back");
    shell.reads(Mode::Refuses);
    shell.changed(gone);
    refused(shell.page(gone));
}

#[test]
fn a_month_or_filter_with_nothing_is_the_pages_empty_state_with_the_header_kept() {
    let d = Driver::founded();
    for (name, route) in pages().into_iter().take(3) {
        let mut shell = Shell::new(&d.handle);
        shell.reads(Mode::Empty);
        let i = shell.push(route);
        assert!(!empty(shell.page(i)).headline.is_empty(), "{name}");
        // The band and the answer stay: the month and the filter in the header are built from it.
        let Some(wire::view_state::Kind::MoneyHome(state)) = &shell.views[&i].kind else {
            panic!("not Money's home");
        };
        assert!(!state.band.is_empty(), "{name}");
        assert!(state.content.is_some(), "{name}");
    }
}
