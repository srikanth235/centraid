//! TWO-WAY CALENDAR SYNC at the screen/core level (#1173): the shell reads the phone and answers
//! snapshots, the core merges them into the vault and, when something is owed to a writable phone
//! calendar, asks the shell to write it with ONE `CalendarWrite`; the shell answers
//! `CalendarWritten` and the core records it (`follow.pushed`). Each conflict rule of the design
//! (C1..C12) has its own test, driven through a real vault and the runtime: snapshots and answers
//! go in, the effects asked and the vault's rows come out.

mod agenda_event_support;

use std::time::Duration;

use agenda_event_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::calendar::CalendarFollow;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::Field;
use centraid_screens::{Registry, Screen};
use wire::calendar_write_item::{Op, Span};
use wire::screen_event::Kind as E;

const NOW: i64 = 4_076_006_400_000; // 2099-03-01
const WORK: &str = "work";

// ---------------------------------------------------------------------------
// The host: Agenda's home in miniature
// ---------------------------------------------------------------------------

/// Hosts the flow the way Agenda's home does: it reads events (so the runtime tells it when the
/// vault moves, `DataChanged`) and hands every other event to the flow.
struct Host {
    follow: CalendarFollow,
}

impl Screen for Host {
    fn update(
        &mut self,
        event: wire::ScreenEvent,
        ctx: &centraid_screens::Ctx,
    ) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                // The home's own read: the tables of events are the ones whose change it hears.
                let _ = ctx.load(
                    load::agenda::Upcoming {
                        from: Some("2099-01-01T00:00:00Z".to_owned()),
                        to: Some("2099-12-31T00:00:00Z".to_owned()),
                    }
                    .into(),
                );
                self.follow.attach()
            }
            Some(E::Counter(_)) => self.follow.import(ctx),
            Some(other) => self.follow.on_event(&other, ctx).unwrap_or_default(),
            None => Vec::new(),
        }
    }

    fn view(&self, _ctx: &centraid_screens::Ctx) -> wire::ViewState {
        wire::ViewState {
            kind: Some(wire::view_state::Kind::Counter(wire::CounterView {
                title: self
                    .follow
                    .status()
                    .map(|s| s.sentence.clone())
                    .unwrap_or_default(),
                content: None,
            })),
            ..wire::ViewState::default()
        }
    }
}

struct Phone {
    world: World,
    host: u64,
}

fn phone(imported: bool) -> Phone {
    let mut world = World::with(Registry::default().with("test.sync", |_| {
        Some(Box::new(Host {
            follow: CalendarFollow::new(),
        }))
    }));
    let host = world.driver.push(
        "agenda",
        wire::Route {
            sheet: false,
            screen: "test.sync".to_owned(),
            args: None,
        },
    );
    let value = if imported { b"1".to_vec() } else { Vec::new() };
    world
        .driver
        .answer_effect(wire::effect_result::Outcome::Keychain(
            wire::KeychainValue {
                found: imported,
                value,
            },
        ));
    Phone { world, host }
}

impl Phone {
    fn status(&self) -> String {
        match &self.world.driver.view(self.host).kind {
            Some(wire::view_state::Kind::Counter(view)) => view.title.clone(),
            other => panic!("{other:?}"),
        }
    }

    /// Let the runtime deliver what the vault pushed (`DataChanged`) and the timers it holds.
    fn settle(&mut self) {
        self.world.driver.pump(Duration::from_millis(150));
    }

    /// The next following pass: past the settle time, the read is out; answer it.
    fn pass(&mut self, snapshot: wire::CalendarSnapshot) {
        self.changed();
        self.world.driver.pump(Duration::from_millis(2_500));
        self.answer(
            |kind| matches!(kind, wire::effect::Kind::CalendarRead(_)),
            wire::effect_result::Outcome::Calendar(snapshot),
        );
        self.settle();
    }

    fn changed(&mut self) {
        let host = self.host;
        self.world.driver.send(
            host,
            E::EffectResult(wire::EffectResult {
                effect_id: 0,
                outcome: Some(wire::effect_result::Outcome::PhoneChanged(
                    wire::PhoneChanged {
                        source: wire::ImportSource::Calendar as i32,
                    },
                )),
            }),
        );
    }

    /// The member's Import tap and the shell's snapshot: this device now follows.
    fn import(&mut self, snapshot: wire::CalendarSnapshot) {
        let host = self.host;
        self.world.driver.send(
            host,
            E::Counter(wire::CounterEvent {
                kind: Some(wire::counter_event::Kind::CopyTapped(
                    wire::CounterCopyTapped {},
                )),
            }),
        );
        self.answer(
            |kind| matches!(kind, wire::effect::Kind::CalendarRead(_)),
            wire::effect_result::Outcome::Calendar(snapshot),
        );
        self.settle();
    }

    fn answer(
        &mut self,
        wants: fn(&wire::effect::Kind) -> bool,
        outcome: wire::effect_result::Outcome,
    ) -> wire::ScreenUpdate {
        let at = self
            .world
            .driver
            .effects
            .iter()
            .position(|request| {
                request
                    .effect
                    .as_ref()
                    .and_then(|e| e.kind.as_ref())
                    .is_some_and(wants)
            })
            .expect("the effect was asked");
        let request = self.world.driver.effects.remove(at);
        self.world.driver.send(
            request.instance,
            E::EffectResult(wire::EffectResult {
                effect_id: request.effect_id,
                outcome: Some(outcome),
            }),
        )
    }

    /// The writes asked and not yet answered.
    fn writes(&self) -> Vec<wire::CalendarWrite> {
        self.world
            .driver
            .effects
            .iter()
            .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
                wire::effect::Kind::CalendarWrite(write) => Some(write.clone()),
                _ => None,
            })
            .collect()
    }

    /// The shell answers the one write in flight with `items`.
    fn written(&mut self, items: Vec<wire::CalendarWrittenItem>) {
        self.answer(
            |kind| matches!(kind, wire::effect::Kind::CalendarWrite(_)),
            wire::effect_result::Outcome::CalendarWritten(wire::CalendarWritten { items }),
        );
        self.settle();
    }

    /// The shell performed everything it was asked.
    fn written_ok(&mut self) {
        let items = self.writes()[0]
            .items
            .iter()
            .map(|item| wire::CalendarWrittenItem {
                event_id: item.event_id.clone(),
                ok: true,
                external_id: if item.op == Op::Create as i32 {
                    format!("local:made-{}", item.event_id)
                } else {
                    String::new()
                },
                ..wire::CalendarWrittenItem::default()
            })
            .collect();
        self.written(items);
    }

    fn event(&self, title: &str) -> Option<wire::AgendaEvent> {
        self.world
            .window("2099-01-01T00:00:00Z", "2099-12-31T00:00:00Z")
            .into_iter()
            .find(|event| event.summary.as_deref() == Some(title))
    }

    fn id(&self, title: &str) -> String {
        self.event(title)
            .unwrap_or_else(|| panic!("no event `{title}`"))
            .event_id
    }

    fn act(&mut self, request: impl Into<wire::ActRequest>) {
        self.world.act(request);
        self.settle();
    }

    fn edit_title(&mut self, id: &str, title: &str) {
        self.act(act::agenda::EditEvent {
            event_id: id.to_owned(),
            title: Some(title.to_owned()),
            ..act::agenda::EditEvent::default()
        });
    }
}

// ---------------------------------------------------------------------------
// The phone, as the shell reads it
// ---------------------------------------------------------------------------

fn calendar(key: &str, writable: bool) -> wire::PhoneCalendar {
    wire::PhoneCalendar {
        key: key.to_owned(),
        source_title: "Google".to_owned(),
        title: key.to_owned(),
        color: "#007AFF".to_owned(),
        writable,
        allows_modifications: writable,
    }
}

fn meeting(title: &str, id: &str) -> wire::PhoneCalendarEvent {
    wire::PhoneCalendarEvent {
        title: title.to_owned(),
        start: "2099-03-10T12:00:00".to_owned(),
        end: "2099-03-10T13:00:00".to_owned(),
        tz: "Europe/Paris".to_owned(),
        phone_id: id.to_owned(),
        calendar_key: WORK.to_owned(),
        ..wire::PhoneCalendarEvent::default()
    }
}

fn snapshot(
    calendars: Vec<wire::PhoneCalendar>,
    events: Vec<wire::PhoneCalendarEvent>,
) -> wire::CalendarSnapshot {
    wire::CalendarSnapshot {
        now_ms: NOW,
        device_zone: "Europe/Paris".to_owned(),
        complete: true,
        calendars,
        events,
        device_id: "device-a".to_owned(),
    }
}

fn writable_work(events: Vec<wire::PhoneCalendarEvent>) -> wire::CalendarSnapshot {
    snapshot(vec![calendar(WORK, true)], events)
}

/// A device that imported `Offsite` from a writable calendar: nothing is owed yet.
fn with_offsite() -> Phone {
    let mut phone = phone(false);
    phone.import(writable_work(vec![meeting("Offsite", "uid:offsite")]));
    assert!(phone.event("Offsite").is_some());
    assert!(
        phone.writes().is_empty(),
        "an import owes the phone nothing"
    );
    phone
}

fn only(write: &wire::CalendarWrite) -> &wire::CalendarWriteItem {
    assert_eq!(write.items.len(), 1, "{write:?}");
    &write.items[0]
}

// ---------------------------------------------------------------------------
// C1..C12
// ---------------------------------------------------------------------------

/// C1: the phone changed a field and the vault did not: the vault takes it, and nothing is written.
#[test]
fn c1_a_phone_change_the_vault_did_not_make_is_taken_and_never_written_back() {
    let mut phone = with_offsite();
    phone.pass(writable_work(vec![meeting(
        "Offsite (moved room)",
        "uid:offsite",
    )]));
    assert!(phone.event("Offsite (moved room)").is_some());
    assert!(phone.event("Offsite").is_none());
    assert!(phone.writes().is_empty());
}

/// C2: the vault changed a field and the phone did not: it is written, and only that field.
#[test]
fn c2_a_centraid_edit_is_written_to_the_phone_and_then_stated() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.edit_title(&id, "Offsite day");
    let writes = phone.writes();
    assert_eq!(writes.len(), 1);
    let item = only(&writes[0]);
    assert_eq!(item.op, Op::Update as i32);
    assert_eq!(item.event_id, id);
    assert_eq!(item.calendar_key, WORK);
    assert_eq!(item.external_id, "uid:offsite");
    assert_eq!(item.span, Span::Series as i32);
    let fields = item.fields.as_ref().expect("fields");
    assert_eq!(fields.title, "Offsite day");
    assert!(fields.states_title);
    // Only what the member changed is stated: the times are the phone's own.
    assert!(!fields.states_when && !fields.states_notes && !fields.states_alerts);
    phone.written_ok();
    assert!(phone.writes().is_empty(), "recorded: nothing is owed now");
    // The phone now holds the new title: the next pass has nothing to change or push.
    phone.pass(writable_work(vec![meeting("Offsite day", "uid:offsite")]));
    assert!(phone.writes().is_empty());
    assert!(phone.event("Offsite day").is_some());
}

/// An event's link rides with the phone's copy: the Android writer keeps it in the description and
/// its reader splits it out again, so the vault sees the same notes and link it wrote. A link
/// written is stated only when it changed, and a pass that reads back what was written owes nothing.
#[test]
fn an_events_link_is_stated_only_when_it_changed_and_reads_back_without_a_write() {
    let mut phone = phone(false);
    let linked = |notes: &str, url: &str| wire::PhoneCalendarEvent {
        notes: notes.to_owned(),
        url: url.to_owned(),
        ..meeting("Offsite", "uid:offsite")
    };
    phone.import(writable_work(vec![linked(
        "Bring slides",
        "https://example.com/offsite",
    )]));
    let event = phone.event("Offsite").expect("imported");
    assert_eq!(
        event.conferencing_uri.as_deref(),
        Some("https://example.com/offsite")
    );
    assert_eq!(event.description.as_deref(), Some("Bring slides"));
    assert!(phone.writes().is_empty());

    // The member changes the notes: the notes are stated, the link is not.
    let id = event.event_id;
    phone.act(act::agenda::EditEvent {
        event_id: id.clone(),
        description: Field::Is("Bring slides and badge".into()),
        ..act::agenda::EditEvent::default()
    });
    let writes = phone.writes();
    let fields = only(&writes[0]).fields.clone().expect("fields");
    assert_eq!(fields.notes, "Bring slides and badge");
    assert!(fields.states_notes && !fields.states_url);
    phone.written_ok();
    // The phone reads back the notes and the link apart: nothing is owed, nothing changes.
    phone.pass(writable_work(vec![linked(
        "Bring slides and badge",
        "https://example.com/offsite",
    )]));
    assert!(phone.writes().is_empty());
    let event = phone.event("Offsite").expect("still there");
    assert_eq!(
        event.conferencing_uri.as_deref(),
        Some("https://example.com/offsite")
    );
    assert_eq!(event.description.as_deref(), Some("Bring slides and badge"));

    // The member changes the link: the link is stated with the value, the notes are not.
    phone.act(act::agenda::EditEvent {
        event_id: id,
        url: Field::Is("https://example.com/moved".into()),
        ..act::agenda::EditEvent::default()
    });
    let writes = phone.writes();
    let fields = only(&writes[0]).fields.clone().expect("fields");
    assert_eq!(fields.url, "https://example.com/moved");
    assert!(fields.states_url && !fields.states_notes);
}

/// C3: both changed the same field: the member's edit wins, and the phone is overwritten.
#[test]
fn c3_when_both_changed_the_same_field_the_members_edit_wins_and_is_written() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.edit_title(&id, "Mine");
    // The shell could not write it yet.
    phone.written(vec![wire::CalendarWrittenItem {
        event_id: id.clone(),
        ok: false,
        error: "busy".into(),
        ..wire::CalendarWrittenItem::default()
    }]);
    // Meanwhile the phone changed the title too.
    phone.pass(writable_work(vec![meeting("Theirs", "uid:offsite")]));
    assert!(phone.event("Mine").is_some(), "the member's edit stands");
    assert!(phone.event("Theirs").is_none());
    let writes = phone.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        only(&writes[0]).fields.as_ref().expect("fields").title,
        "Mine"
    );
}

/// C4: the phone deleted it and the vault never edited it: the vault trashes it, writing nothing.
#[test]
fn c4_a_delete_on_the_phone_the_vault_never_edited_trashes_it_and_writes_nothing() {
    let mut phone = with_offsite();
    phone.pass(writable_work(vec![]));
    assert!(phone.event("Offsite").is_none());
    assert!(phone.writes().is_empty());
}

/// C5: the phone deleted it but the vault edited it: the vault keeps it and is NOT re-created on
/// the phone (it is no longer linked).
#[test]
fn c5_a_phone_delete_of_an_event_the_member_edited_keeps_it_and_does_not_recreate_it() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.edit_title(&id, "Mine");
    phone.written(vec![wire::CalendarWrittenItem {
        event_id: id.clone(),
        ok: false,
        ..wire::CalendarWrittenItem::default()
    }]);
    phone.pass(writable_work(vec![]));
    assert!(phone.event("Mine").is_some(), "the vault keeps it");
    assert!(
        phone.writes().is_empty(),
        "and never writes it back as a create"
    );
    // Not on a later pass either.
    phone.pass(writable_work(vec![]));
    assert!(phone.writes().is_empty());
}

/// C6: the vault trashed it and the phone's copy is unchanged: deleted there, then tombstoned.
#[test]
fn c6_a_trashed_event_the_phone_still_holds_is_deleted_there_once() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.act(act::agenda::TrashEvent {
        event_id: id.clone(),
    });
    let writes = phone.writes();
    assert_eq!(writes.len(), 1);
    let item = only(&writes[0]);
    assert_eq!(item.op, Op::Delete as i32);
    assert_eq!(item.external_id, "uid:offsite");
    assert_eq!(item.calendar_key, WORK);
    // The shell compares its own copy with what the phone last stated.
    let expected = item.expected.as_ref().expect("what the phone last said");
    assert_eq!(expected.title, "Offsite");
    assert_eq!(expected.start, "2099-03-10T12:00:00");
    phone.written_ok();
    assert!(phone.writes().is_empty());
    // Gone from the phone: no later pass writes anything for it.
    phone.pass(writable_work(vec![]));
    assert!(phone.writes().is_empty());
}

/// C12: the member restores an event whose phone copy was deleted (C6): it is owed a CREATE again
/// in its writable phone calendar, the shell answers with the new id, and the event is linked to it.
#[test]
fn c12_a_restored_event_is_created_again_on_the_phone_and_linked_to_its_new_id() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    // C6: trashed, and deleted on the phone.
    phone.act(act::agenda::TrashEvent {
        event_id: id.clone(),
    });
    assert_eq!(only(&phone.writes()[0]).op, Op::Delete as i32);
    phone.written_ok();
    assert!(phone.writes().is_empty());

    // The member restores it from the trash.
    phone.act(act::agenda::RestoreEvent {
        event_id: id.clone(),
    });
    let writes = phone.writes();
    assert_eq!(writes.len(), 1, "one CalendarWrite: {writes:?}");
    let item = only(&writes[0]);
    assert_eq!(item.op, Op::Create as i32);
    assert_eq!(item.event_id, id);
    assert_eq!(item.calendar_key, WORK);
    assert!(item.external_id.is_empty(), "the phone mints the id");
    let fields = item.fields.as_ref().expect("fields");
    assert_eq!(fields.title, "Offsite");
    assert_eq!(fields.start, "2099-03-10T12:00:00");
    assert_eq!(fields.tz, "Europe/Paris");

    // The shell created it and answers with the id the phone gave it: the event is linked.
    phone.written_ok();
    assert!(phone.writes().is_empty(), "linked: not created twice");
    let reborn = format!("local:made-{id}");
    phone.pass(writable_work(vec![meeting("Offsite", &reborn)]));
    assert!(phone.writes().is_empty());
    let shown: Vec<wire::AgendaEvent> = phone
        .world
        .window("2099-01-01T00:00:00Z", "2099-12-31T00:00:00Z")
        .into_iter()
        .filter(|event| event.summary.as_deref() == Some("Offsite"))
        .collect();
    assert_eq!(shown.len(), 1, "one event, linked, not imported twice");
    assert_eq!(shown[0].event_id, id);
    // And editing it now writes an UPDATE to the new copy, which is the proof it is linked.
    phone.edit_title(&id, "Offsite (again)");
    let writes = phone.writes();
    let item = only(&writes[0]);
    assert_eq!(item.op, Op::Update as i32);
    assert_eq!(item.external_id, reborn);
}

/// C12 does not reach C5: an event the phone deleted and the member had edited is never created
/// again, even after the member trashes and restores it.
#[test]
fn c12_never_recreates_an_event_the_phone_deleted_after_the_member_edited_it() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.edit_title(&id, "Mine");
    phone.written(vec![wire::CalendarWrittenItem {
        event_id: id.clone(),
        ok: false,
        ..wire::CalendarWrittenItem::default()
    }]);
    phone.pass(writable_work(vec![]));
    assert!(phone.event("Mine").is_some());
    phone.act(act::agenda::TrashEvent {
        event_id: id.clone(),
    });
    phone.act(act::agenda::RestoreEvent { event_id: id });
    assert!(phone.writes().is_empty(), "the phone's delete is final");
}

/// C7: the vault trashed it but the phone's copy changed since: the phone keeps it, the vault
/// forgets the link, and the member is told.
#[test]
fn c7_a_trashed_event_the_phone_changed_stays_on_the_phone_and_says_so() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.act(act::agenda::TrashEvent {
        event_id: id.clone(),
    });
    assert_eq!(only(&phone.writes()[0]).op, Op::Delete as i32);
    phone.written(vec![wire::CalendarWrittenItem {
        event_id: id,
        ok: true,
        phone_kept: true,
        ..wire::CalendarWrittenItem::default()
    }]);
    assert_eq!(
        phone.status(),
        "1 deleted event was kept on your phone's calendar because it changed there."
    );
    assert!(phone.writes().is_empty(), "never owed again");
}

/// C8: a calendar the phone does not let the app write is never written, however it is edited.
#[test]
fn c8_a_read_only_phone_calendar_is_never_written() {
    let mut phone = phone(false);
    let mut read_only = calendar(WORK, false);
    // Birthdays, holidays and subscriptions are `writable: false`; so is one that adds but cannot
    // change (`allows_modifications: false`).
    phone.import(snapshot(
        vec![read_only.clone()],
        vec![meeting("Holiday", "uid:h")],
    ));
    let id = phone.id("Holiday");
    phone.edit_title(&id, "My holiday");
    assert!(phone.writes().is_empty());
    read_only.writable = true;
    read_only.allows_modifications = false;
    phone.pass(snapshot(
        vec![read_only],
        vec![meeting("My holiday", "uid:h")],
    ));
    phone.edit_title(&id, "Mine again");
    assert!(phone.writes().is_empty());
    assert!(
        phone.event("Mine again").is_some(),
        "the edit stays in the vault"
    );
}

/// C9: a Centraid-only calendar (no phone origin) never reaches the phone.
#[test]
fn c9_a_centraid_only_calendar_never_reaches_the_phone() {
    let mut phone = with_offsite();
    // Born in the vault's own calendar (no calendar named).
    phone.world.propose(
        "Private",
        "2099-04-01T10:00:00",
        "2099-04-01T11:00:00",
        |_| {},
    );
    phone.settle();
    assert!(phone.writes().is_empty());
    phone.pass(writable_work(vec![meeting("Offsite", "uid:offsite")]));
    assert!(phone.writes().is_empty());
}

/// C10: a series edited as a whole is one series write; a cancelled day is that day only.
#[test]
fn c10_a_series_edit_is_one_series_write_and_a_cancelled_day_is_that_day_only() {
    let mut phone = phone(false);
    let day = |day: &str| wire::PhoneCalendarEvent {
        title: "Standup".to_owned(),
        start: format!("{day}T09:00:00"),
        end: format!("{day}T09:30:00"),
        tz: "Europe/Paris".to_owned(),
        series: Some(wire::PhoneCalendarSeries {
            id: "uid:standup".to_owned(),
            rrule: "RRULE:FREQ=WEEKLY".to_owned(),
            start: "2099-03-02T09:00:00".to_owned(),
            end: "2099-03-02T09:30:00".to_owned(),
        }),
        phone_id: format!("local:ek-{day}"),
        calendar_key: WORK.to_owned(),
        ..wire::PhoneCalendarEvent::default()
    };
    let days = ["2099-03-02", "2099-03-09", "2099-03-16", "2099-03-23"];
    phone.import(writable_work(days.iter().map(|d| day(d)).collect()));
    let id = phone.id("Standup");
    assert!(phone.writes().is_empty());

    // The whole series: its title, and nothing about days.
    phone.edit_title(&id, "Daily sync");
    let writes = phone.writes();
    let item = only(&writes[0]);
    assert_eq!(item.span, Span::Series as i32);
    assert_eq!(item.external_id, "uid:standup");
    let fields = item.fields.as_ref().expect("fields");
    assert_eq!(fields.title, "Daily sync");
    assert!(item.original_start.is_empty() && !item.cancel);
    phone.written_ok();

    // One day cancelled: that occurrence only.
    phone.act(act::agenda::EditOccurrence {
        action: act::agenda::EditOccurrenceAction::Skip,
        event_id: id.clone(),
        original_start: "2099-03-09T09:00:00".to_owned(),
        scope: act::agenda::EditOccurrenceScope::Occurrence,
        ..act::agenda::EditOccurrence::default()
    });
    let writes = phone.writes();
    let item = only(&writes[0]);
    assert_eq!(item.span, Span::This as i32);
    assert_eq!(item.original_start, "2099-03-09T09:00:00");
    assert!(item.cancel);
    assert_eq!(item.op, Op::Update as i32);
    phone.written_ok();
    assert!(phone.writes().is_empty());
}

/// C10: a moved day is written as that day, in the series' own wall clock and with its length.
#[test]
fn c10_a_moved_day_is_written_as_that_day_with_the_series_length() {
    let mut phone = phone(false);
    let day = |day: &str| wire::PhoneCalendarEvent {
        title: "Standup".to_owned(),
        start: format!("{day}T09:00:00"),
        end: format!("{day}T09:30:00"),
        tz: "Europe/Paris".to_owned(),
        series: Some(wire::PhoneCalendarSeries {
            id: "uid:standup".to_owned(),
            rrule: "RRULE:FREQ=WEEKLY".to_owned(),
            start: "2099-03-02T09:00:00".to_owned(),
            end: "2099-03-02T09:30:00".to_owned(),
        }),
        phone_id: format!("local:ek-{day}"),
        calendar_key: WORK.to_owned(),
        ..wire::PhoneCalendarEvent::default()
    };
    phone.import(writable_work(
        ["2099-03-02", "2099-03-09", "2099-03-16"]
            .iter()
            .map(|d| day(d))
            .collect(),
    ));
    let id = phone.id("Standup");
    phone.act(act::agenda::EditOccurrence {
        action: act::agenda::EditOccurrenceAction::Override,
        event_id: id,
        original_start: "2099-03-09T09:00:00".to_owned(),
        scope: act::agenda::EditOccurrenceScope::Occurrence,
        starts: Some("2099-03-09T10:00:00".to_owned()),
        zone: Field::Is("Europe/Paris".to_owned()),
        ..act::agenda::EditOccurrence::default()
    });
    let writes = phone.writes();
    let item = only(&writes[0]);
    assert_eq!(item.span, Span::This as i32);
    assert!(!item.cancel);
    assert_eq!(item.original_start, "2099-03-09T09:00:00");
    let fields = item.fields.as_ref().expect("fields");
    assert_eq!(fields.start, "2099-03-09T10:00:00");
    assert_eq!(fields.end, "2099-03-09T10:30:00");
    assert_eq!(fields.tz, "Europe/Paris");
}

/// C11: a write that fails (or is never answered) changes nothing and is owed again.
#[test]
fn c11_a_failed_write_is_retried_at_the_next_pass() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.edit_title(&id, "Offsite day");
    assert_eq!(phone.writes().len(), 1);
    phone.written(vec![wire::CalendarWrittenItem {
        event_id: id.clone(),
        ok: false,
        error: "the calendar is locked".into(),
        ..wire::CalendarWrittenItem::default()
    }]);
    assert!(phone.writes().is_empty(), "no hot retry");
    assert_eq!(
        phone.status(),
        "Some changes did not reach your phone's calendar. They will be tried again."
    );
    // The next pass asks again, with the same edit.
    phone.pass(writable_work(vec![meeting("Offsite", "uid:offsite")]));
    let writes = phone.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        only(&writes[0]).fields.as_ref().expect("fields").title,
        "Offsite day"
    );
    phone.written_ok();
    assert_eq!(phone.status(), "", "a clean write clears the line");
}

#[test]
fn c11_a_write_nobody_answers_times_out_as_a_failure_and_is_owed_again() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.edit_title(&id, "Offsite day");
    assert_eq!(phone.writes().len(), 1);
    // Never answered: the effect is abandoned when the timer fires, and nothing is recorded.
    phone.world.driver.effects.clear();
    let host = phone.host;
    phone.world.driver.send(
        host,
        E::TimerFired(wire::TimerFired {
            timer: "calendar-write".to_owned(),
        }),
    );
    assert_eq!(
        phone.status(),
        "Some changes did not reach your phone's calendar. They will be tried again."
    );
    phone.pass(writable_work(vec![meeting("Offsite", "uid:offsite")]));
    assert_eq!(phone.writes().len(), 1);
}

/// An event made in Centraid inside a followed writable calendar is created on the phone, and the
/// id the phone minted links it.
#[test]
fn an_event_born_in_a_writable_calendar_is_created_on_the_phone_and_linked() {
    let mut phone = with_offsite();
    let calendar_id = phone
        .world
        .calendar_names()
        .into_iter()
        .find(|(_, name)| name.contains("work"))
        .expect("the work calendar")
        .0;
    phone.world.propose(
        "Brunch",
        "2099-05-01T10:00:00",
        "2099-05-01T11:00:00",
        |p| {
            p.calendar_id = Some(calendar_id.clone());
            p.reminders = Field::Is("[15]".to_owned());
        },
    );
    phone.settle();
    let writes = phone.writes();
    let item = only(&writes[0]);
    assert_eq!(item.op, Op::Create as i32);
    assert_eq!(item.calendar_key, WORK);
    assert!(item.external_id.is_empty());
    let fields = item.fields.as_ref().expect("fields");
    assert_eq!(fields.title, "Brunch");
    // London 10:00 in May is 09:00Z; the write is the event's own zone's wall clock.
    assert_eq!(fields.start, "2099-05-01T10:00:00");
    assert_eq!(fields.tz, "Europe/London");
    assert_eq!(fields.alerts, [15]);
    assert!(fields.states_alerts);
    phone.written_ok();
    assert!(phone.writes().is_empty(), "linked: not created twice");
    // The phone's next read has it under the id it minted: still nothing owed, and one event.
    let mut made = meeting("Brunch", "local:unused");
    made.start = "2099-05-01T10:00:00".into();
    made.end = "2099-05-01T11:00:00".into();
    made.tz = "Europe/London".into();
    let brunch = phone.id("Brunch");
    made.phone_id = format!("local:made-{brunch}");
    phone.pass(writable_work(vec![meeting("Offsite", "uid:offsite"), made]));
    assert!(phone.writes().is_empty());
    assert_eq!(
        phone
            .world
            .window("2099-01-01T00:00:00Z", "2099-12-31T00:00:00Z")
            .into_iter()
            .filter(|event| event.summary.as_deref() == Some("Brunch"))
            .count(),
        1
    );
}

// ---------------------------------------------------------------------------
// When a write may be asked for
// ---------------------------------------------------------------------------

#[test]
fn no_write_is_asked_before_this_device_imported() {
    // A device that never imported: the vault holds an event in a calendar of the phone, but no
    // snapshot ever came (the keychain says never imported), so nothing is writable and nothing
    // is asked, even when the vault moves.
    let mut phone = phone(false);
    phone.world.propose(
        "Anywhere",
        "2099-04-01T10:00:00",
        "2099-04-01T11:00:00",
        |_| {},
    );
    phone.settle();
    assert!(phone.writes().is_empty());
    // And a following pass does not even read the phone.
    phone.changed();
    phone.world.driver.pump(Duration::from_millis(2_500));
    assert!(phone.writes().is_empty());
    assert!(!phone.world.driver.effects.iter().any(|request| matches!(
        request.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::CalendarRead(_))
    )));
}

#[test]
fn no_write_is_asked_once_the_os_refused_the_calendar() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    // The member turned calendar access off: the next pass is denied.
    phone.changed();
    phone.world.driver.pump(Duration::from_millis(2_500));
    phone.answer(
        |kind| matches!(kind, wire::effect::Kind::CalendarRead(_)),
        wire::effect_result::Outcome::Failed(wire::EffectFailed {
            reason: "denied".into(),
            denied: true,
            cancelled: false,
        }),
    );
    phone.edit_title(&id, "Offsite day");
    assert!(phone.writes().is_empty(), "no permission, no write");
}

#[test]
fn a_write_in_flight_blocks_a_second_and_one_waits_its_turn() {
    let mut phone = with_offsite();
    let id = phone.id("Offsite");
    phone.edit_title(&id, "First");
    assert_eq!(phone.writes().len(), 1);
    // The vault moves again while the first write is out: nothing second is asked.
    phone.edit_title(&id, "Second");
    assert_eq!(phone.writes().len(), 1, "one in flight");
    assert_eq!(
        only(&phone.writes()[0]).fields.as_ref().expect("f").title,
        "First"
    );
    // A following pass waits for it too: no read is asked while the write is out.
    phone.changed();
    phone.world.driver.pump(Duration::from_millis(2_500));
    assert!(!phone.world.driver.effects.iter().any(|request| matches!(
        request.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::CalendarRead(_))
    )));
    // The first is answered: the queued one goes out, carrying the later edit.
    phone.written_ok();
    let writes = phone.writes();
    assert_eq!(writes.len(), 1);
    assert_eq!(only(&writes[0]).fields.as_ref().expect("f").title, "Second");
}

#[test]
fn a_calendar_the_shell_never_reported_is_treated_as_read_only() {
    let mut phone = phone(false);
    // The snapshot's calendar carries no `writable`: the proto default is false.
    phone.import(snapshot(
        vec![wire::PhoneCalendar {
            key: WORK.into(),
            title: "Work".into(),
            ..wire::PhoneCalendar::default()
        }],
        vec![meeting("Offsite", "uid:offsite")],
    ));
    let id = phone.id("Offsite");
    phone.edit_title(&id, "Changed");
    assert!(phone.writes().is_empty());
}

// ---------------------------------------------------------------------------
// What an import carries of alerts and guests
// ---------------------------------------------------------------------------

#[test]
fn alerts_and_guests_ride_the_record_alerts_once_each_and_guests_only_when_there_are_any() {
    use centraid_screens::agenda::calendar;
    use centraid_screens::strings::Locale;
    let mut event = meeting("Party", "uid:party");
    event.alerts = vec![10, 60, 10];
    event.attendees = vec![
        wire::PhoneAttendee {
            name: " Ada ".into(),
            email: "ada@example.com".into(),
            status: "accepted".into(),
        },
        wire::PhoneAttendee::default(),
    ];
    let bare = meeting("Bare", "uid:bare");
    let batch = calendar::batch(Locale::En, &writable_work(vec![event, bare]));
    let party = &batch.records[0].fields;
    assert_eq!(party["reminders"], serde_json::json!([10, 60]));
    assert_eq!(
        party["attendees"],
        serde_json::json!([{ "name": "Ada", "email": "ada@example.com", "state": "accepted" }])
    );
    let bare = &batch.records[1].fields;
    assert!(bare["reminders"].is_null());
    assert!(bare.get("attendees").is_none());
}

// ---------------------------------------------------------------------------
// A stored rule this build cannot read (#1173, owner decision)
// ---------------------------------------------------------------------------

/// An imported series whose rule the engine does not expand (a sub-daily rule, `BYHOUR`) is
/// stored as the phone said it. It must still load: the event shows once, at its anchor; its
/// detail renders; the editor opens it read-only as Custom and offers Replace; and Replace with a
/// rule the engine reads writes it.
#[test]
fn a_followed_series_whose_rule_this_build_cannot_read_still_loads_everywhere() {
    use wire::agenda_editor_event as events;
    use wire::agenda_editor_event::Kind as K;

    const UNREADABLE: &str = "FREQ=DAILY;BYHOUR=9";
    let mut phone = phone(false);
    let day = |day: &str| wire::PhoneCalendarEvent {
        title: "Standup".to_owned(),
        start: format!("{day}T09:00:00"),
        end: format!("{day}T09:30:00"),
        tz: "Europe/Paris".to_owned(),
        series: Some(wire::PhoneCalendarSeries {
            id: "uid:standup".to_owned(),
            rrule: format!("RRULE:{UNREADABLE}"),
            start: "2099-03-02T09:00:00".to_owned(),
            end: "2099-03-02T09:30:00".to_owned(),
        }),
        phone_id: format!("local:ek-{day}"),
        calendar_key: WORK.to_owned(),
        ..wire::PhoneCalendarEvent::default()
    };
    phone.import(writable_work(vec![day("2099-03-02")]));

    // It shows, once, at its anchor, carrying the stored rule for the editor.
    let shown: Vec<wire::AgendaEvent> = phone
        .world
        .window("2099-01-01T00:00:00Z", "2099-12-31T00:00:00Z")
        .into_iter()
        .filter(|event| event.summary.as_deref() == Some("Standup"))
        .collect();
    assert_eq!(shown.len(), 1, "{shown:?}");
    let id = shown[0].event_id.clone();
    assert_eq!(shown[0].rrule.as_deref(), Some(UNREADABLE));

    // Its detail renders, and says "Custom" for a rule nobody can read, never the rule.
    let page = phone.world.open_event(&id, &id, None, "2099-03-02");
    let data = phone.world.event_data(page);
    let repeats = data
        .facts
        .iter()
        .find(|fact| fact.label == "Repeats")
        .expect("a repeat fact");
    assert_eq!(repeats.detail, "Custom");
    assert!(!data.facts.iter().any(|fact| fact.detail.contains("BYHOUR")));

    // The editor opens it read-only as Custom, with Replace.
    let editor = phone.world.open_edit(&id, "", None, "2099-03-02");
    assert_eq!(phone.world.draft(editor).repeat_key, "custom");
    phone.world.send_editor(
        editor,
        K::Repeat(events::RepeatPicked {
            key: "custom".into(),
        }),
    );
    let sheet = phone
        .world
        .editor_data(editor)
        .custom_repeat
        .clone()
        .expect("the sheet");
    assert!(sheet.read_only);
    assert_eq!(sheet.replace_label, "Replace this rule");
    assert!(!sheet.summary.is_empty() && !sheet.summary.contains("BYHOUR"));
    // Done leaves the stored rule alone: nothing to save.
    phone
        .world
        .send_editor(editor, K::CustomApplied(events::CustomApplied {}));
    assert!(!phone.world.editor_data(editor).dirty);
    // Replace starts a fresh rule the engine reads, and saving writes it.
    phone.world.send_editor(
        editor,
        K::Repeat(events::RepeatPicked {
            key: "custom".into(),
        }),
    );
    phone
        .world
        .send_editor(editor, K::CustomReplace(events::CustomReplaceTapped {}));
    assert!(
        !phone
            .world
            .editor_data(editor)
            .custom_repeat
            .clone()
            .expect("sheet")
            .read_only
    );
    phone
        .world
        .send_editor(editor, K::CustomApplied(events::CustomApplied {}));
    assert!(phone.world.editor_data(editor).dirty);
}
