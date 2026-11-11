//! THE FOLLOW COORDINATOR through the door a shell uses (#1183): when the phone's stores are
//! followed into the vault, whichever screen is showing. The shell's part is played here: it
//! answers the keychain habit, the watches and the reads; every assertion is a COUNT of the
//! reads the coordinator asked for, never a time.

mod people_support;

use std::collections::BTreeMap;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::custody::secrets::VaultSecrets;
use centraid_screens::field::Keyed;
use centraid_screens::follow::coordinator::READ_TIMER;
use centraid_screens::testing::Driver;
use centraid_screens::{Registry, Runtime, follow, imports, people, proof};
use people_support::{home_state, roster_of, send_home};
use wire::effect::Kind as F;
use wire::effect_result::Outcome as O;
use wire::people_home_event::{self as ev, Kind as H};
use wire::screen_event::Kind as E;

/// The instant the example vault is seeded at: the same vault on every day the suite runs.
const SEEDED_AT: i64 = 1_760_000_000_000;

const CONTACTS_KEY: &str = "people_contacts_imported";
const CALENDAR_KEY: &str = "agenda_calendar_imported";
const HEALTH_KEY: &str = "health_device";
const REMINDERS_KEY: &str = "agenda_reminders_followed";

/// What the shell was asked to read, and whether any ask carried a permission prompt.
#[derive(Default, Debug, PartialEq, Eq)]
struct Reads {
    contacts: u32,
    calendar: u32,
    health: u32,
    reminders: u32,
    folders: u32,
    permission_asked: u32,
}

/// A runtime whose only screen is the proof counter (not a home of any app), with the follow
/// coordinator and the folder follower beside it; or, with a People home, the screen that asks.
struct Rig {
    d: Driver,
    /// The keychain habits the phone holds, by key; a key not in it is "not found".
    habits: BTreeMap<&'static str, &'static [u8]>,
    /// The watches the coordinator asked for, by store.
    watches: Vec<(u64, u64, i32)>,
    contacts: Vec<wire::PhoneContact>,
    /// Whether the contacts read says it covered the whole address book.
    contacts_complete: bool,
    /// The accounts the contacts read lists, even one with nobody in it.
    containers: Vec<wire::PhoneContactContainer>,
    reads: Reads,
}

impl Rig {
    fn new() -> Self {
        Self::over(false)
    }

    /// People's home is the screen showing.
    fn with_people_home() -> Self {
        Self::over(true)
    }

    fn over(people_home: bool) -> Self {
        let secrets = VaultSecrets::new();
        let mut registry = Registry::default()
            .with(proof::NAME, proof::build)
            .merge(imports::registry(&secrets))
            .merge(follow::registry());
        let mut roots = vec![("proof".to_owned(), proof::route())];
        if people_home {
            registry = registry.merge(people::registry());
            roots = vec![(
                people::TAB.to_owned(),
                people::routes::home(wire::PeopleDestination::People),
            )];
        }
        roots.push(("imports-files".to_owned(), imports::routes::files("")));
        let runtime = Runtime::new(registry, roots).with_services(follow::services());
        let mut d = Driver::with_runtime_at(runtime, SEEDED_AT);
        d.start();
        let mut watches = Vec::new();
        d.effects.retain(
            |request| match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
                Some(F::PhoneWatch(watch)) if watch.on => {
                    watches.push((request.instance, request.effect_id, watch.source));
                    false
                }
                _ => true,
            },
        );
        Self {
            d,
            habits: BTreeMap::new(),
            watches,
            contacts: Vec::new(),
            contacts_complete: true,
            containers: Vec::new(),
            reads: Reads::default(),
        }
    }

    /// The phone's keychain says this device imported or connected.
    fn connected(mut self, key: &'static str, value: &'static [u8]) -> Self {
        self.habits.insert(key, value);
        self
    }

    /// The vault follows a folder, as the Docs drive's pick leaves it.
    fn following_a_folder(self) -> Self {
        let made = self.d.act(
            wire::ActRequest::from(act::docs::CreateFolder {
                title: "Taxes".to_owned(),
                ..act::docs::CreateFolder::default()
            })
            .keyed("arrange:folder"),
        );
        let folder: serde_json::Value = serde_json::from_slice(&made.output).expect("json");
        let told = self.d.act(
            wire::ActRequest::from(act::shell::FollowFiles {
                origin: serde_json::json!({
                    "ref": "folder:abc", "label": "Taxes", "fills": folder["id"],
                })
                .to_string(),
                records: "[]".to_owned(),
                complete: Some(false),
            })
            .keyed("arrange:follow"),
        );
        assert_eq!(
            told.status,
            wire::ActStatus::Executed as i32,
            "{}",
            told.reason
        );
        self
    }

    fn foreground(&mut self) {
        self.d
            .call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
                foreground: true,
            }));
    }

    /// The OS says the store changed, as the watch's one effect id carries it.
    fn changed(&mut self, source: wire::ImportSource) {
        let (instance, effect_id, _) = *self
            .watches
            .iter()
            .find(|(_, _, watched)| *watched == source as i32)
            .expect("the coordinator watches this store");
        self.d.send(
            instance,
            E::EffectResult(wire::EffectResult {
                effect_id,
                outcome: Some(O::PhoneChanged(wire::PhoneChanged {
                    source: source as i32,
                })),
            }),
        );
    }

    /// Wait out the settle: the gate's one timer, then the passes start.
    fn settle(&mut self) {
        self.d.pump(Duration::from_millis(2_600));
    }

    /// The effects the coordinator and the folder follower asked, as names.
    fn asked(&self) -> Vec<String> {
        self.d
            .effects
            .iter()
            .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                F::Keychain(op) => Some(format!("habit:{}", op.key)),
                F::ContactsRead(_) => Some("contacts-read".to_owned()),
                F::CalendarRead(_) => Some("calendar-read".to_owned()),
                F::HealthRead(_) => Some("health-read".to_owned()),
                F::RemindersRead(_) => Some("reminders-read".to_owned()),
                F::FoldersRead(_) => Some("folders-read".to_owned()),
                _ => None,
            })
            .collect()
    }

    /// Answer the oldest effect as the phone would, and count what it was asked to read.
    fn answer_next(&mut self) {
        let request = self.d.effects.remove(0);
        let outcome = match request.effect.and_then(|effect| effect.kind) {
            Some(F::Keychain(op)) => {
                let value = self.habits.get(op.key.as_str());
                O::Keychain(wire::KeychainValue {
                    found: value.is_some(),
                    value: value.map(|bytes| bytes.to_vec()).unwrap_or_default(),
                })
            }
            Some(F::ContactsRead(read)) => {
                self.reads.contacts += 1;
                self.reads.permission_asked += u32::from(read.ask_permission);
                O::Contacts(wire::ContactsSnapshot {
                    complete: self.contacts_complete,
                    device_id: "this-install".to_owned(),
                    containers: self.containers.clone(),
                    contacts: self.contacts.clone(),
                })
            }
            Some(F::CalendarRead(read)) => {
                self.reads.calendar += 1;
                self.reads.permission_asked += u32::from(read.ask_permission);
                O::Calendar(wire::CalendarSnapshot {
                    complete: true,
                    ..wire::CalendarSnapshot::default()
                })
            }
            Some(F::HealthRead(read)) => {
                self.reads.health += 1;
                self.reads.permission_asked += u32::from(read.ask_permission);
                O::Health(wire::HealthSnapshot {
                    store_present: true,
                    device_id: "this-install".to_owned(),
                    ..wire::HealthSnapshot::default()
                })
            }
            Some(F::RemindersRead(read)) => {
                self.reads.reminders += 1;
                self.reads.permission_asked += u32::from(read.ask_permission);
                assert!(
                    read.include_completed,
                    "a completed reminder is not a deleted one"
                );
                O::RemindersSnapshot(wire::RemindersSnapshot::default())
            }
            Some(F::FoldersRead(_)) => {
                self.reads.folders += 1;
                O::FoldersListing(wire::FoldersListing {
                    complete: true,
                    device_id: "this-install".to_owned(),
                    folders: Vec::new(),
                })
            }
            other => panic!("an effect nobody here performs: {other:?}"),
        };
        self.d.send(
            request.instance,
            E::EffectResult(wire::EffectResult {
                effect_id: request.effect_id,
                outcome: Some(outcome),
            }),
        );
    }

    /// Answer everything asked, and what answering asks, until nothing is.
    fn serve(&mut self) {
        while !self.d.effects.is_empty() {
            self.answer_next();
        }
    }
}

fn ana() -> wire::PhoneContact {
    wire::PhoneContact {
        name: "Ana".to_owned(),
        phone_id: "lookup:ana".to_owned(),
        ..wire::PhoneContact::default()
    }
}

#[test]
fn the_session_watches_contacts_calendar_and_reminders_and_nothing_else() {
    let rig = Rig::new();
    let mut sources: Vec<i32> = rig.watches.iter().map(|(_, _, source)| *source).collect();
    sources.sort_unstable();
    assert_eq!(
        sources,
        [
            wire::ImportSource::Contacts as i32,
            wire::ImportSource::Calendar as i32,
            wire::ImportSource::Reminders as i32
        ]
    );
}

#[test]
fn the_foreground_follows_every_connected_store_and_no_unconnected_one() {
    let mut rig = Rig::new()
        .connected(CONTACTS_KEY, b"1")
        .connected(HEALTH_KEY, b"1|steps")
        .following_a_folder();
    // Calendar is not connected: its habit is not found.
    rig.foreground();
    assert!(
        rig.d.effects.is_empty(),
        "nothing is read before the settle"
    );
    rig.settle();
    rig.serve();
    assert_eq!(
        rig.reads,
        Reads {
            contacts: 1,
            calendar: 0,
            health: 1,
            reminders: 0,
            folders: 1,
            permission_asked: 0,
        }
    );
}

#[test]
fn the_phones_reminders_are_read_only_where_this_device_follows_them_and_never_ask_a_permission() {
    let mut rig = Rig::new().connected(REMINDERS_KEY, b"1");
    rig.changed(wire::ImportSource::Reminders);
    rig.settle();
    rig.serve();
    assert_eq!(rig.reads.reminders, 1);
    assert_eq!(rig.reads.permission_asked, 0);
    let mut rig = Rig::new();
    rig.changed(wire::ImportSource::Reminders);
    rig.settle();
    rig.serve();
    assert_eq!(
        rig.reads.reminders, 0,
        "a restored vault follows nothing until a Connect"
    );
}

#[test]
fn a_repeated_foreground_is_not_a_trigger() {
    let mut rig = Rig::new().connected(CONTACTS_KEY, b"1");
    rig.foreground();
    rig.settle();
    rig.serve();
    rig.foreground();
    rig.settle();
    rig.serve();
    assert_eq!(rig.reads.contacts, 1);
}

#[test]
fn a_store_nobody_connected_is_never_read_and_never_asks_a_permission() {
    let mut rig = Rig::new();
    rig.foreground();
    rig.changed(wire::ImportSource::Contacts);
    rig.changed(wire::ImportSource::Calendar);
    rig.settle();
    rig.serve();
    assert_eq!(rig.reads, Reads::default());
}

#[test]
fn a_paused_contacts_follow_is_not_read() {
    let mut rig = Rig::new().connected(CONTACTS_KEY, b"paused");
    rig.changed(wire::ImportSource::Contacts);
    rig.settle();
    rig.serve();
    assert_eq!(rig.reads.contacts, 0);
}

#[test]
fn a_burst_of_changes_is_one_pass_and_a_burst_during_it_queues_exactly_one_more() {
    let mut rig = Rig::new().connected(CONTACTS_KEY, b"1");
    for _ in 0..8 {
        rig.changed(wire::ImportSource::Contacts);
    }
    assert!(
        rig.d.effects.is_empty(),
        "nothing is read before the settle"
    );
    rig.settle();
    // The habit first, then the read: a pass that is out and not yet answered.
    assert_eq!(rig.asked(), ["habit:people_contacts_imported"]);
    rig.answer_next();
    assert_eq!(rig.asked(), ["contacts-read"]);

    // Eight more while it runs: exactly one more pass, after it.
    for _ in 0..8 {
        rig.changed(wire::ImportSource::Contacts);
    }
    assert_eq!(rig.asked(), ["contacts-read"], "still the one pass");
    rig.answer_next();
    rig.serve();
    assert_eq!(rig.reads.contacts, 2);
    rig.settle();
    rig.serve();
    assert_eq!(rig.reads.contacts, 2, "and no third");
    assert_eq!(rig.reads.permission_asked, 0);
}

#[test]
fn a_change_runs_a_pass_while_a_screen_that_is_no_home_is_showing() {
    let mut rig = Rig::new().connected(CONTACTS_KEY, b"1");
    rig.contacts = vec![ana()];
    // The only screen open is the proof counter: no People, no Calendar.
    rig.changed(wire::ImportSource::Contacts);
    rig.settle();
    rig.serve();
    assert_eq!(rig.reads.contacts, 1);
    rig.d.pump(Duration::from_millis(300));
    let names: Vec<String> = roster_of(&rig.d)
        .people
        .into_iter()
        .map(|person| person.name)
        .collect();
    assert!(names.contains(&"Ana".to_owned()), "{names:?}");
}

#[test]
fn a_calendar_change_follows_a_connected_calendar_and_only_that() {
    let mut rig = Rig::new().connected(CALENDAR_KEY, b"1");
    rig.changed(wire::ImportSource::Calendar);
    rig.settle();
    rig.serve();
    assert_eq!(
        rig.reads,
        Reads {
            calendar: 1,
            ..Reads::default()
        }
    );
}

#[test]
fn a_home_appearing_and_a_pull_to_refresh_are_triggers_like_any_other() {
    let mut rig = Rig::with_people_home().connected(CONTACTS_KEY, b"1");
    // The home asked the keychain whether this device follows; the coordinator will too.
    rig.serve();
    assert_eq!(rig.reads.contacts, 0, "nothing is read before the settle");
    rig.settle();
    rig.serve();
    assert_eq!(rig.reads.contacts, 1, "the appearing home asked for a pass");
    let home = people_support::root(&rig.d);
    for _ in 0..3 {
        send_home(&mut rig.d, home, H::Refreshed(ev::Refreshed {}));
    }
    rig.settle();
    rig.serve();
    assert_eq!(
        rig.reads.contacts, 2,
        "a pull is one more pass, however many taps"
    );
    assert_eq!(rig.reads.permission_asked, 0);
}

#[test]
fn a_read_the_phone_refuses_is_said_on_the_row_and_changes_nothing() {
    let mut rig = Rig::with_people_home().connected(CONTACTS_KEY, b"1");
    rig.serve();
    rig.settle();
    rig.answer_next();
    // The OS says no to a read that asked for nothing: the pass ends, and the row says so.
    let request = rig.d.effects.remove(0);
    rig.d.send(
        request.instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(O::Failed(wire::EffectFailed {
                reason: "contacts access not given".to_owned(),
                denied: true,
                cancelled: false,
            })),
        }),
    );
    assert!(rig.d.effects.is_empty());
    let home = people_support::root(&rig.d);
    // The home reads the board when it draws: a change makes it draw again.
    rig.d
        .send(home, E::DataChanged(wire::DataChanged { tables: vec![] }));
    let row = home_state(rig.d.view(home))
        .contacts
        .clone()
        .expect("the row");
    assert_eq!(row.state, wire::people_contacts_row::State::Denied as i32);
    assert!(
        roster_of(&rig.d)
            .people
            .iter()
            .all(|person| person.name != "Ana")
    );
}

// ---- a pass that was doubted or partial is said, in the same words -----------------------------

fn people(count: usize) -> Vec<wire::PhoneContact> {
    (0..count)
        .map(|n| wire::PhoneContact {
            name: format!("Person {n}"),
            phone_id: format!("lookup:{n}"),
            container_key: "icloud".to_owned(),
            ..wire::PhoneContact::default()
        })
        .collect()
}

/// One pass over the address book, as the OS's change notice asks for it.
fn followed_pass(rig: &mut Rig) {
    rig.changed(wire::ImportSource::Contacts);
    rig.settle();
    rig.serve();
}

fn status_of(rig: &mut Rig) -> Option<String> {
    let home = people_support::root(&rig.d);
    rig.d
        .send(home, E::DataChanged(wire::DataChanged { tables: vec![] }));
    home_state(rig.d.view(home))
        .status
        .clone()
        .map(|line| line.sentence)
}

#[test]
fn a_read_that_lost_most_of_what_is_followed_is_doubted_and_says_so_without_removing_anyone() {
    let mut rig = Rig::with_people_home().connected(CONTACTS_KEY, b"1");
    rig.contacts = people(6);
    rig.containers = vec![wire::PhoneContactContainer {
        key: "icloud".to_owned(),
        name: "iCloud".to_owned(),
    }];
    followed_pass(&mut rig);
    assert_eq!(status_of(&mut rig), None);
    // The next complete read holds nobody: the vault doubts all six and trashes none.
    rig.contacts = Vec::new();
    followed_pass(&mut rig);
    assert_eq!(
        status_of(&mut rig).as_deref(),
        Some("Far fewer items than before in your phone’s contacts, so nothing was removed.")
    );
    let kept = roster_of(&rig.d)
        .people
        .iter()
        .filter(|person| person.name.starts_with("Person "))
        .count();
    assert_eq!(kept, 6);
    // A read that holds them again clears the line.
    rig.contacts = people(6);
    followed_pass(&mut rig);
    assert_eq!(status_of(&mut rig), None);
}

#[test]
fn an_incomplete_read_is_a_banner_over_what_was_read_and_not_a_failure() {
    let mut rig = Rig::with_people_home().connected(CONTACTS_KEY, b"1");
    rig.contacts = people(2);
    rig.contacts_complete = false;
    followed_pass(&mut rig);
    assert_eq!(
        status_of(&mut rig).as_deref(),
        Some("Only part of your phone’s contacts was readable, so this shows what was read.")
    );
    // What was read is there.
    assert!(
        roster_of(&rig.d)
            .people
            .iter()
            .any(|p| p.name == "Person 1")
    );
    rig.contacts_complete = true;
    followed_pass(&mut rig);
    assert_eq!(status_of(&mut rig), None);
}

// ---- the backstop, and an answer that arrives after it ------------------------------------------

impl Rig {
    /// The read backstop fires on the coordinator that owns `request`: what the runtime does
    /// when its timer comes due. Nothing here waits for it.
    fn read_timed_out(&mut self, request: &wire::EffectRequest) {
        self.d.send(
            request.instance,
            E::TimerFired(wire::TimerFired {
                timer: READ_TIMER.to_owned(),
            }),
        );
    }

    /// The effects asked now, as the requests themselves.
    fn take_asked(&mut self) -> Vec<wire::EffectRequest> {
        std::mem::take(&mut self.d.effects)
    }
}

fn named(request: &wire::EffectRequest) -> String {
    match request.effect.as_ref().and_then(|e| e.kind.as_ref()) {
        Some(F::Keychain(op)) => format!("habit:{}", op.key),
        Some(F::ContactsRead(_)) => "contacts-read".to_owned(),
        Some(F::CalendarRead(_)) => "calendar-read".to_owned(),
        other => format!("{other:?}"),
    }
}

/// Both stores connected, both changed: the first to run is out, the other waits its turn.
fn two_stores_out() -> Rig {
    let mut rig = Rig::new()
        .connected(CONTACTS_KEY, b"1")
        .connected(CALENDAR_KEY, b"1");
    rig.changed(wire::ImportSource::Contacts);
    rig.changed(wire::ImportSource::Calendar);
    rig.settle();
    rig
}

#[test]
fn the_late_answer_of_an_abandoned_pass_is_not_the_next_passes() {
    let mut rig = two_stores_out();
    // The first pass waits on its keychain habit, which never answers.
    let stale = rig.take_asked();
    assert_eq!(stale.len(), 1);
    rig.read_timed_out(&stale[0]);
    let next = rig.take_asked();
    assert_eq!(next.len(), 1);
    assert_ne!(named(&next[0]), named(&stale[0]), "the other store's habit");
    rig.d.effects = next;

    // The late habit answer of the first (found) is not the second's: nothing is read on it.
    rig.d.send(
        stale[0].instance,
        E::EffectResult(wire::EffectResult {
            effect_id: stale[0].effect_id,
            outcome: Some(O::Keychain(wire::KeychainValue {
                found: true,
                value: b"1".to_vec(),
            })),
        }),
    );
    assert_eq!(
        rig.asked().len(),
        1,
        "still the one habit: {:?}",
        rig.asked()
    );
    assert!(rig.asked()[0].starts_with("habit:"));

    // The second pass goes on to read on its own answer.
    rig.answer_next();
    assert!(rig.asked()[0].ends_with("-read"), "{:?}", rig.asked());
}

#[test]
fn the_late_snapshot_of_an_abandoned_pass_does_not_end_the_next_pass() {
    let mut rig = two_stores_out();
    rig.answer_next();
    let stale = rig.take_asked();
    assert_eq!(stale.len(), 1);
    // The first store's read never answers; the other store's pass runs to its own read.
    rig.read_timed_out(&stale[0]);
    rig.answer_next();
    let second = rig.take_asked();
    assert_eq!(second.len(), 1, "{second:?}");
    assert!(named(&second[0]).ends_with("-read"));
    rig.d.effects = second;

    // The first store's late snapshot arrives while the second's read is out.
    let late = match stale[0].effect.as_ref().and_then(|e| e.kind.as_ref()) {
        Some(F::ContactsRead(_)) => O::Contacts(wire::ContactsSnapshot {
            complete: true,
            device_id: "this-install".to_owned(),
            ..Default::default()
        }),
        _ => O::Calendar(wire::CalendarSnapshot {
            complete: true,
            ..Default::default()
        }),
    };
    rig.d.send(
        stale[0].instance,
        E::EffectResult(wire::EffectResult {
            effect_id: stale[0].effect_id,
            outcome: Some(late),
        }),
    );

    // The second pass is still out: a change to its store queues behind it and starts nothing.
    let second_source = if named(&rig.d.effects[0]) == "contacts-read" {
        wire::ImportSource::Contacts
    } else {
        wire::ImportSource::Calendar
    };
    rig.changed(second_source);
    rig.settle();
    assert_eq!(rig.d.effects.len(), 1, "{:?}", rig.asked());

    // It completes with its own read, and the change queued behind it runs exactly one more pass.
    let before = rig.reads.contacts + rig.reads.calendar;
    rig.answer_next();
    rig.serve();
    assert_eq!(rig.reads.contacts + rig.reads.calendar, before + 2);
}

#[test]
fn a_read_that_never_answers_is_abandoned_and_the_store_and_the_next_one_run() {
    let mut rig = two_stores_out();
    assert_eq!(rig.d.effects.len(), 1, "one store at a time");
    rig.answer_next();
    let stale = rig.take_asked();
    assert_eq!(stale.len(), 1);
    let first = named(&stale[0]);
    assert!(first.ends_with("-read"), "{first}");

    // The read never comes back: the backstop releases the store, and the other one runs.
    rig.read_timed_out(&stale[0]);
    let next = rig.take_asked();
    assert_eq!(next.len(), 1, "the next store's pass started: {next:?}");
    assert!(
        named(&next[0]).starts_with("habit:"),
        "{:?}",
        named(&next[0])
    );
    rig.d.effects = next;
    rig.serve();
    assert_eq!(
        rig.reads.contacts + rig.reads.calendar,
        1,
        "only the next store's own read: the first never answered"
    );

    // And the abandoned store is free: a new change runs a pass, not a queue behind a read that
    // is gone.
    rig.changed(if first == "contacts-read" {
        wire::ImportSource::Contacts
    } else {
        wire::ImportSource::Calendar
    });
    rig.settle();
    assert_eq!(rig.d.effects.len(), 1, "a pass for the released store");
}
