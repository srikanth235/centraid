//! The vault in front: screens read through whichever core the shelf has in
//! front, a switch closes and reopens the tabs, and a shelf that changes under
//! them is followed (#1135, lane H2). Ports `HomeSwitchSpec`'s law — a switch
//! re-points every read — over real screens and real vaults.

mod people_support;
mod vault_support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_core::vaults::Vaults;
use centraid_screens::catalog::act;
use centraid_screens::field::Keyed;
use centraid_screens::kit::act as kit_act;
use centraid_screens::people::{self, routes};
use centraid_screens::vault;
use centraid_screens::{Ctx, Registry, Runtime, Screen};
use people_support::{names, roster_data};
use prost::Message as _;
use vault_support::*;
use wire::screen_event::Kind as E;

const SWITCHER: &str = "probe.switcher";
const PROBE: &str = "probe.service";

/// What the probes saw, shared with the test.
#[derive(Default)]
struct Seen {
    /// Every `Left` the switcher heard.
    left: usize,
    /// What the probe service's slow jobs answered.
    jobs: Vec<String>,
    /// Typed on the switcher, written when it is left.
    typed: Option<String>,
}

/// The tab root that asks for a switch and draws what the shelf holds.
struct Switcher {
    seen: Arc<Mutex<Seen>>,
    shown: String,
}

fn holdings(ctx: &Ctx) -> Option<wire::Holdings> {
    let loaded = ctx
        .load(wire::LoadRequest {
            app: "shell".to_owned(),
            query: "holdings".to_owned(),
            ..Default::default()
        })
        .ok()?;
    match loaded.answer?.answer? {
        wire::app_query_response::Answer::Holdings(holdings) => Some(holdings),
        _ => None,
    }
}

impl Switcher {
    fn read(&mut self, ctx: &Ctx) {
        if let Some(held) = holdings(ctx) {
            self.shown = held
                .vaults
                .iter()
                .map(|v| {
                    format!(
                        "{}{}{}{}",
                        if v.foreground { "*" } else { "" },
                        v.name,
                        if v.resting { "~" } else { "" },
                        if v.frozen.is_some() { "!" } else { "" },
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
        }
    }
}

impl Screen for Switcher {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_) | E::DataChanged(_)) => self.read(ctx),
            Some(E::OffThreadDone(done)) if done.tag == "switch" => {
                ctx.switch_vault(&String::from_utf8_lossy(&done.bytes));
            }
            Some(E::Left(_)) => {
                let mut seen = self.seen.lock().expect("seen");
                seen.left += 1;
                if let Some(name) = seen.typed.take() {
                    let request: wire::ActRequest = act::people::AddPerson {
                        title: name,
                        ..Default::default()
                    }
                    .into();
                    let _ = ctx.act(&request.keyed(format!("typed:{}", kit_act::fresh())));
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: self.shown.clone(),
                content: None,
            })),
            ..Default::default()
        }
    }
}

/// A service: it has no view, a switch does not close it, and a job it starts
/// is bound to the vault in front when it asked.
struct Probe {
    seen: Arc<Mutex<Seen>>,
}

fn who(handle: &centraid_core::Handle) -> String {
    handle
        .with_vault(|vault| Ok(vault.self_id()?))
        .ok()
        .flatten()
        .unwrap_or_else(|| "none".to_owned())
}

impl Screen for Probe {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::EnvironmentChanged(_)) => {
                // BOUND WHEN ASKED: the core of the vault in front now.
                let bound = ctx.vaults().and_then(|vaults| vaults.foreground_core());
                ctx.off_thread("who", move |_| {
                    std::thread::sleep(Duration::from_millis(400));
                    bound
                        .as_ref()
                        .map_or_else(|| "none".to_owned(), who)
                        .into_bytes()
                });
            }
            // A DOOR ASKED OF THE VAULT IN FRONT: founding into a file that
            // already holds a vault is refused by name, and the refusal names the
            // vault the door ran on.
            Some(E::Lifecycle(_)) => ctx.vault_async(
                "found",
                centraid_core::screens::VaultRequest::Found(wire::FoundRequest {
                    display_name: "Again".to_owned(),
                    ..Default::default()
                }),
            ),
            Some(E::OffThreadDone(done)) if done.tag == "found" => {
                let called = wire::VaultCalled::decode(done.bytes.as_slice()).expect("a call");
                self.seen
                    .lock()
                    .expect("seen")
                    .jobs
                    .push(called.error.map(|error| error.detail).unwrap_or_default());
            }
            Some(E::OffThreadDone(done)) => self
                .seen
                .lock()
                .expect("seen")
                .jobs
                .push(String::from_utf8_lossy(&done.bytes).into_owned()),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, _ctx: &Ctx) -> wire::ViewState {
        wire::ViewState::default()
    }
}

fn route(name: &str) -> wire::Route {
    wire::Route {
        screen: name.to_owned(),
        ..Default::default()
    }
}

/// People's home (reads the vault in front) beside the switcher.
fn switching(
    seen: Arc<Mutex<Seen>>,
) -> impl FnOnce(&Arc<vault::Shelf>, &centraid_screens::custody::secrets::VaultSecrets) -> Runtime {
    move |shelf, secrets| {
        let for_switcher = Arc::clone(&seen);
        let for_probe = Arc::clone(&seen);
        Runtime::new(
            people::registry()
                .merge(vault::registry(shelf, secrets))
                .merge(
                    Registry::default()
                        .with(SWITCHER, move |_| {
                            Some(Box::new(Switcher {
                                seen: Arc::clone(&for_switcher),
                                shown: String::new(),
                            }) as Box<dyn Screen>)
                        })
                        .with(PROBE, move |_| {
                            Some(Box::new(Probe {
                                seen: Arc::clone(&for_probe),
                            }) as Box<dyn Screen>)
                        }),
                ),
            vec![
                (
                    people::TAB.to_owned(),
                    routes::home(wire::PeopleDestination::People),
                ),
                ("switcher".to_owned(), route(SWITCHER)),
            ],
        )
        .with_services(
            std::iter::once(route(PROBE))
                .chain(vault::services())
                .collect(),
        )
    }
}

/// Two vaults laid down, a phone launched over them, the runtime started.
fn two_vaults() -> (Phone, String, String, Arc<Mutex<Seen>>, Scratch) {
    let dir = scratch();
    let a = lay_down(&dir, "a", "Alpha");
    let b = lay_down(&dir, "b", "Bravo");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let mut phone = Phone::running(&dir, switching(Arc::clone(&seen)));
    phone.launch();
    // The shelf's launch moved the tabs onto the vault it opened.
    phone.driver.pump(Duration::from_millis(500));
    (phone, a, b, seen, dir)
}

fn root_of(phone: &Phone, tab: &str) -> u64 {
    phone
        .driver
        .navigation
        .as_ref()
        .expect("navigation")
        .tabs
        .iter()
        .find(|stack| stack.tab == tab)
        .and_then(|stack| stack.entries.first())
        .map(|entry| entry.instance)
        .expect("a root")
}

fn people_names(phone: &Phone) -> Vec<String> {
    names(roster_data(phone.driver.view(root_of(phone, people::TAB))))
}

fn shown(phone: &Phone) -> String {
    match &phone.driver.view(root_of(phone, "switcher")).kind {
        Some(wire::view_state::Kind::Counter(counter)) => counter.title.clone(),
        other => panic!("the switcher is not a counter: {other:?}"),
    }
}

fn ask_switch(phone: &mut Phone, vault_id: &str) -> wire::ScreenUpdate {
    let switcher = root_of(phone, "switcher");
    phone.driver.send(
        switcher,
        E::OffThreadDone(wire::OffThreadDone {
            tag: "switch".to_owned(),
            bytes: vault_id.as_bytes().to_vec(),
        }),
    )
}

fn person_in_front(phone: &Phone, name: &str) {
    people_support::person(&phone.driver, name);
}

#[test]
fn a_launch_moves_the_tabs_onto_the_vault_the_shelf_opened() {
    let (phone, a, _b, _seen, _dir) = two_vaults();
    assert_eq!(phone.holdings().foreground, a);
    // The tabs opened before any vault was held; the shelf's launch followed.
    assert_eq!(shown(&phone), "*Alpha,Bravo");
}

#[test]
fn a_switch_closes_and_reopens_the_tabs_and_every_read_follows_the_vault_in_front() {
    let (mut phone, a, b, _seen, _dir) = two_vaults();
    person_in_front(&phone, "Alice");
    phone.driver.pump(Duration::from_millis(500));
    assert!(people_names(&phone).contains(&"Alice".to_owned()));

    let old_people = root_of(&phone, people::TAB);
    let old_switcher = root_of(&phone, "switcher");
    let update = ask_switch(&mut phone, &b);

    // THE SHELL SEES AN ORDINARY UPDATE: both roots closed, both reopened.
    assert!(update.closed.contains(&old_people) && update.closed.contains(&old_switcher));
    let nav = update.navigation.expect("a new navigation");
    assert_eq!(nav.tabs.len(), 2);
    assert_ne!(root_of(&phone, people::TAB), old_people);
    assert_eq!(phone.holdings().foreground, b);
    assert_eq!(shown(&phone), "*Bravo,Alpha");
    // A vault of its own: Alice is not in it.
    assert!(!people_names(&phone).contains(&"Alice".to_owned()));
    person_in_front(&phone, "Bob");
    phone.driver.pump(Duration::from_millis(500));
    assert!(people_names(&phone).contains(&"Bob".to_owned()));

    // AND BACK: the first vault's rows are still its own.
    ask_switch(&mut phone, &a);
    assert_eq!(phone.holdings().foreground, a);
    let back = people_names(&phone);
    assert!(back.contains(&"Alice".to_owned()), "{back:?}");
    assert!(!back.contains(&"Bob".to_owned()), "{back:?}");
}

#[test]
fn what_was_typed_is_written_to_the_vault_it_was_typed_in() {
    let (mut phone, a, b, seen, _dir) = two_vaults();
    seen.lock().expect("seen").typed = Some("Typed in Alpha".to_owned());
    ask_switch(&mut phone, &b);
    assert_eq!(
        seen.lock().expect("seen").left,
        1,
        "the screens were told first"
    );
    assert!(
        !people_names(&phone).contains(&"Typed in Alpha".to_owned()),
        "the vault now in front did not get it"
    );
    ask_switch(&mut phone, &a);
    assert!(people_names(&phone).contains(&"Typed in Alpha".to_owned()));
}

#[test]
fn a_switch_to_a_vault_nothing_holds_leaves_the_phone_where_it_was() {
    let (mut phone, a, _b, seen, _dir) = two_vaults();
    let root = root_of(&phone, people::TAB);
    let update = ask_switch(&mut phone, "nobody");
    assert!(update.closed.is_empty());
    assert!(update.navigation.is_none());
    assert_eq!(root_of(&phone, people::TAB), root);
    assert_eq!(phone.holdings().foreground, a);
    assert_eq!(
        seen.lock().expect("seen").left,
        0,
        "no screen was left for nothing"
    );
    // Switching to the vault already in front is the same: nothing to follow.
    let again = ask_switch(&mut phone, &a);
    assert!(again.closed.is_empty());
}

#[test]
fn a_vault_made_while_another_is_in_front_moves_the_tabs_and_sends_no_last_event() {
    let (mut phone, a, _b, seen, _dir) = two_vaults();
    seen.lock().expect("seen").typed = Some("Never written".to_owned());
    let old = root_of(&phone, people::TAB);
    let found = phone.shelf.found(None, "Charlie");
    assert!(matches!(found.value, vault::Found::Made(_)));
    // The shelf announced itself; the shell's event thread follows.
    assert!(phone.driver.pump(Duration::from_secs(2)) >= 1);
    assert!(phone.driver.closed.contains(&old));
    assert_ne!(root_of(&phone, people::TAB), old);
    assert_eq!(shown(&phone), "*Charlie,Alpha,Bravo");
    // THE VAULT THEY WOULD HAVE WRITTEN TO IS NOT THE ONE THEY WERE TYPED IN:
    // the last event is not sent, and nothing was written anywhere.
    assert_eq!(seen.lock().expect("seen").left, 0);
    assert!(!people_names(&phone).contains(&"Never written".to_owned()));
    ask_switch(&mut phone, &a);
    assert!(!people_names(&phone).contains(&"Never written".to_owned()));
}

#[test]
fn forgetting_the_vault_in_front_moves_the_tabs_to_the_next_and_the_last_to_none() {
    let (mut phone, a, b, _seen, _dir) = two_vaults();
    phone.shelf.forget(&a);
    assert!(phone.driver.pump(Duration::from_secs(2)) >= 1);
    assert_eq!(phone.holdings().foreground, b);
    assert_eq!(shown(&phone), "*Bravo");
    phone.shelf.forget(&b);
    assert!(phone.driver.pump(Duration::from_secs(2)) >= 1);
    assert_eq!(phone.holdings().foreground, "");
    assert_eq!(shown(&phone), "");
}

#[test]
fn the_vault_in_fronts_changes_reach_its_screens_and_a_background_vaults_do_not() {
    let (mut phone, _a, b, _seen, _dir) = two_vaults();
    // A commit in the vault in front re-renders People's home by itself.
    person_in_front(&phone, "Carol");
    assert!(phone.driver.pump(Duration::from_secs(3)) >= 1);
    assert!(people_names(&phone).contains(&"Carol".to_owned()));
    // A commit in a vault behind it is nothing the screens read.
    let core = phone.shelf.core_of(&b).expect("B's core");
    let request: wire::ActRequest = act::people::AddPerson {
        title: "Dave".to_owned(),
        ..Default::default()
    }
    .into();
    let answered = core
        .act(&request.keyed(format!("behind:{}", kit_act::fresh())))
        .expect("the act answers");
    assert_eq!(answered.status, wire::ActStatus::Executed as i32);
    assert_eq!(phone.driver.pump(Duration::from_millis(700)), 0);
    assert!(!people_names(&phone).contains(&"Dave".to_owned()));
}

#[test]
fn a_screen_that_read_the_holdings_hears_every_change_to_them() {
    let (mut phone, a, b, _seen, _dir) = two_vaults();
    phone.shelf.freeze(&b, "2026-03-14T09:31:00Z", 4);
    phone.driver.pump(Duration::from_secs(1));
    assert_eq!(shown(&phone), "*Alpha,Bravo!");
    phone.shelf.rest();
    phone.driver.pump(Duration::from_secs(1));
    assert_eq!(shown(&phone), "*Alpha,Bravo~!");
    assert!(phone.shelf.rename(&a, "Alpine"));
    phone.driver.pump(Duration::from_secs(1));
    assert_eq!(shown(&phone), "*Alpine,Bravo~!");
}

#[test]
fn a_job_started_on_one_vault_finishes_on_it_after_a_switch_and_a_service_outlives_the_switch() {
    let (mut phone, a, b, seen, _dir) = two_vaults();
    // The probe service starts a slow job bound to the vault in front (A) ...
    phone
        .driver
        .call(wire::screen_request::Kind::Environment(wire::Environment {
            locale: "en".to_owned(),
            zone: "UTC".to_owned(),
            platform: "ios".to_owned(),
        }));
    // ... and the member switches to B before it is done.
    ask_switch(&mut phone, &b);
    assert_eq!(phone.holdings().foreground, b);
    phone.driver.pump(Duration::from_secs(2));
    // The service was not closed by the switch, and heard its job answer from
    // the vault it was asked on.
    assert_eq!(seen.lock().expect("seen").jobs, [a]);
}

#[test]
fn a_door_asked_of_the_vault_in_front_runs_on_it_even_when_the_call_is_made_after_a_switch() {
    let (mut phone, a, b, seen, _dir) = two_vaults();
    // The service asks `found` of the vault in front (A); the job is bound then.
    phone
        .driver
        .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: true,
        }));
    ask_switch(&mut phone, &b);
    phone.driver.pump(Duration::from_secs(2));
    let jobs = seen.lock().expect("seen").jobs.clone();
    assert_eq!(jobs.len(), 1, "{jobs:?}");
    assert!(jobs[0].contains(&a) && !jobs[0].contains(&b), "{jobs:?}");
}

#[test]
fn leaving_the_foreground_relocks_every_held_vault_and_a_switch_relocks_the_one_left() {
    let dir = scratch();
    let a = lay_down(&dir, "a", "A");
    let b = lay_down(&dir, "b", "B");
    let mut phone = Phone::on(&dir, None);
    phone.keep_seed();
    phone.record_index(&a, 0);
    phone.record_index(&b, 1);
    phone.launch();
    let unlock = |core: &centraid_core::Handle| {
        core.locker_session(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::Unlock(
                wire::LockerUnlock::default(),
            )),
        })
        .expect("a keyed core unlocks")
    };
    let state = |core: &centraid_core::Handle| {
        core.locker_session(&wire::LockerSessionRequest {
            step: Some(wire::locker_session_request::Step::State(
                wire::LockerStateAsk::default(),
            )),
        })
        .expect("the state answers")
        .state
    };
    let core_a = phone.shelf.core_of(&a).expect("A");
    let core_b = phone.shelf.core_of(&b).expect("B");
    unlock(&core_a);
    unlock(&core_b);
    assert_eq!(state(&core_a), wire::LockerSessionState::Unlocked as i32);
    // Switching away relocks the vault left, not the one brought forward.
    assert!(phone.shelf.bring_to_front(&b));
    assert_eq!(state(&core_a), wire::LockerSessionState::Locked as i32);
    assert_eq!(state(&core_b), wire::LockerSessionState::Unlocked as i32);
    // The app leaving the foreground relocks every held vault.
    unlock(&core_a);
    phone
        .driver
        .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
            foreground: false,
        }));
    assert_eq!(state(&core_a), wire::LockerSessionState::Locked as i32);
    assert_eq!(state(&core_b), wire::LockerSessionState::Locked as i32);
}

#[test]
fn the_os_asking_for_memory_rests_every_vault_but_the_one_in_front_and_the_roster_says_so() {
    let (mut phone, a, b, _seen, _dir) = two_vaults();
    phone.driver.call(wire::screen_request::Kind::MemoryWarning(
        wire::MemoryWarning {},
    ));
    phone.driver.pump(Duration::from_millis(500));
    assert!(!phone.held(&a).resting);
    assert!(phone.held(&b).resting);
    assert_eq!(shown(&phone), "*Alpha,Bravo~");
}

#[test]
fn a_request_for_the_vault_goes_to_the_vault_in_front_and_the_front_keeps_its_own_business() {
    let (phone, a, b, _seen, _dir) = two_vaults();
    let name_of = |phone: &Phone| {
        let answered = phone
            .driver
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Page(wire::PageRequest {
                    query: Some(wire::PageQuery {
                        name: "vault".to_owned(),
                        select: vec!["self_id".to_owned()],
                        from: "vault".to_owned(),
                        order: Some(wire::PageOrder {
                            sort_column: "self_id".to_owned(),
                            pk_column: "self_id".to_owned(),
                            descending: false,
                        }),
                        ..Default::default()
                    }),
                    limit: 1,
                    after: None,
                })),
            })
            .expect("the page answers");
        match answered.kind {
            Some(wire::response::Kind::Page(page)) => match page.rows[0].values[0].kind.clone() {
                Some(wire::value::Kind::Text(id)) => id,
                other => panic!("a vault id is text: {other:?}"),
            },
            other => panic!("a page answered {other:?}"),
        }
    };
    assert_eq!(name_of(&phone), a);
    assert!(phone.shelf.bring_to_front(&b));
    assert_eq!(name_of(&phone), b);
}
