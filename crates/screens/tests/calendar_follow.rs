//! Calendar import and the phone-calendar follow, through the door a shell
//! uses: the shell reads the OS (`CalendarRead`) and answers a snapshot; the
//! rules (what to import, how it maps, what the status line says, when a pass
//! runs) are Rust's. Ports `CalendarImportRuleSpec` and `CalendarFollowSpec`,
//! and the part of `PhoneFollowSpec` that pins Agenda's calendar pass.

mod calendar_support;

use std::time::Duration;

use calendar_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::calendar::follow::{self as calendar, CalendarFollow};
use centraid_screens::kit::civil;
use centraid_screens::strings::Locale;
use centraid_screens::{Registry, Screen};
use serde_json::{Value, json};
use wire::screen_event::Kind as E;

// ---------------------------------------------------------------------------
// The rule (CalendarImportRuleSpec)
// ---------------------------------------------------------------------------

const FIFTEENTH: &str = "2026-03-15T09:00:00";
const THIRTY_FIRST: &str = "2026-03-31T09:00:00";

#[test]
fn a_monthly_bymonthday_stays_on_the_anchors_day_or_not() {
    assert_eq!(
        calendar::rule("RRULE:FREQ=MONTHLY;BYMONTHDAY=15", FIFTEENTH),
        "FREQ=MONTHLY;BYMONTHDAY=15"
    );
    assert_eq!(
        calendar::rule("FREQ=MONTHLY;BYMONTHDAY=31", THIRTY_FIRST),
        "FREQ=MONTHLY;BYMONTHDAY=31"
    );
    assert_eq!(
        calendar::rule("FREQ=MONTHLY;BYMONTHDAY=-1", THIRTY_FIRST),
        "FREQ=MONTHLY;BYMONTHDAY=-1"
    );
    assert_eq!(
        calendar::rule("FREQ=MONTHLY;BYMONTHDAY=1", FIFTEENTH),
        "FREQ=MONTHLY;BYMONTHDAY=1"
    );
}

#[test]
fn a_monthly_positional_byday_stays() {
    assert_eq!(
        calendar::rule("RRULE:FREQ=MONTHLY;BYDAY=2MO", FIFTEENTH),
        "FREQ=MONTHLY;BYDAY=2MO"
    );
    assert_eq!(
        calendar::rule("FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR", THIRTY_FIRST),
        "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR"
    );
}

#[test]
fn what_the_vault_still_refuses_is_left_in_the_rule_for_the_vault_to_refuse() {
    for rule in [
        "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=2",
        "FREQ=MONTHLY;BYMONTHDAY=1,15",
        "FREQ=MONTHLY;BYDAY=2MO,3TU",
    ] {
        assert_eq!(calendar::rule(rule, FIFTEENTH), rule);
    }
}

#[test]
fn a_part_that_only_restates_the_anchor_goes_where_the_vault_takes_no_such_part() {
    assert_eq!(
        calendar::rule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=15", FIFTEENTH),
        "FREQ=YEARLY"
    );
    assert_eq!(
        calendar::rule("FREQ=WEEKLY;BYDAY=MO;WKST=MO", FIFTEENTH),
        "FREQ=WEEKLY;BYDAY=MO"
    );
    assert_eq!(
        calendar::rule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=MO", FIFTEENTH),
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=MO"
    );
}

#[test]
fn no_rule_or_no_start_is_no_rule() {
    assert_eq!(calendar::rule("", FIFTEENTH), "");
    assert_eq!(calendar::rule("FREQ=MONTHLY;BYMONTHDAY=15", ""), "");
    assert_eq!(calendar::rule("BYDAY=MO", FIFTEENTH), "");
}

// ---------------------------------------------------------------------------
// The records (CalendarFollowSpec)
// ---------------------------------------------------------------------------

const NOW: i64 = 1_792_000_000_000;

fn event(title: &str, start: &str, end: &str, phone_id: &str) -> wire::PhoneCalendarEvent {
    wire::PhoneCalendarEvent {
        title: title.to_owned(),
        start: start.to_owned(),
        end: end.to_owned(),
        tz: "UTC".to_owned(),
        phone_id: phone_id.to_owned(),
        calendar_key: "work".to_owned(),
        ..wire::PhoneCalendarEvent::default()
    }
}

fn work() -> wire::PhoneCalendar {
    wire::PhoneCalendar {
        key: "work".to_owned(),
        source_title: "Google".to_owned(),
        title: "Work".to_owned(),
        color: "#007AFF".to_owned(),
    }
}

fn snapshot(events: Vec<wire::PhoneCalendarEvent>) -> wire::CalendarSnapshot {
    wire::CalendarSnapshot {
        now_ms: NOW,
        device_zone: "Europe/Paris".to_owned(),
        complete: true,
        calendars: vec![work()],
        events,
        device_id: "device-a".to_owned(),
    }
}

fn standup(start: &str, moved: bool, original: &str) -> wire::PhoneCalendarEvent {
    wire::PhoneCalendarEvent {
        title: "Standup".to_owned(),
        start: start.to_owned(),
        end: format!("{}09:30:00", &start[..11]),
        tz: "America/Los_Angeles".to_owned(),
        series: Some(wire::PhoneCalendarSeries {
            id: "uid:standup@google".to_owned(),
            rrule: "FREQ=WEEKLY;BYDAY=MO".to_owned(),
            start: "2026-10-05T09:00:00".to_owned(),
            end: "2026-10-05T09:30:00".to_owned(),
        }),
        original_start: original.to_owned(),
        moved,
        phone_id: format!("local:ek-{}", &start[..10]),
        calendar_key: "work".to_owned(),
        ..wire::PhoneCalendarEvent::default()
    }
}

#[test]
fn an_event_is_a_record_keyed_by_its_own_id_with_the_wall_clock_and_the_zone_the_vault_resolves() {
    let lunch = event(
        " Lunch ",
        "2026-10-21T12:00:00",
        "2026-10-21T13:00:00",
        "uid:lunch@google",
    );
    let gym = wire::PhoneCalendarEvent {
        title: "Gym".to_owned(),
        free: true,
        tz: String::new(),
        phone_id: "local:ek-2".to_owned(),
        ..lunch.clone()
    };
    let batch = calendar::batch(Locale::En, &snapshot(vec![lunch, gym]));
    let ids: Vec<&str> = batch.records.iter().map(|r| r.phone_id.as_str()).collect();
    assert_eq!(ids, ["uid:lunch@google", "local:ek-2"]);
    assert_eq!(
        batch.origins,
        [calendar::OriginRef {
            id: "calendar:work".to_owned(),
            label: "Google: Work".to_owned(),
            color: Some("var(--c-slate)".to_owned()),
        }]
    );
    let first = &batch.records[0].fields;
    assert_eq!(first["title"], "Lunch");
    assert_eq!(first["starts"], "2026-10-21T12:00:00");
    assert_eq!(
        (first["timing"].as_str(), first["zone"].as_str()),
        (Some("zoned"), Some("UTC"))
    );
    assert_eq!(first["busy"], true);
    assert!(first.get("overrides").is_none());
    // A free event does not block its time, and one with no zone of its own is the device's.
    let second = &batch.records[1].fields;
    assert_eq!(second["busy"], false);
    assert_eq!(second["zone"], "Europe/Paris");
}

#[test]
fn an_all_day_event_is_its_days_and_with_no_zone_known_a_timed_one_is_floating() {
    let day = wire::PhoneCalendarEvent {
        all_day: true,
        start: "2026-10-21".to_owned(),
        end: "2026-10-22".to_owned(),
        ..event("Lunch", "", "", "uid:lunch@google")
    };
    let batch = calendar::batch(Locale::En, &snapshot(vec![day]));
    let fields = &batch.records[0].fields;
    assert_eq!(fields["starts"], "2026-10-21");
    assert_eq!(fields["ends"], "2026-10-22");
    assert_eq!(fields["timing"], "all-day");
    assert_eq!(fields["zone"], Value::Null);

    let timed = wire::PhoneCalendarEvent {
        tz: String::new(),
        ..event(
            "Lunch",
            "2026-10-21T12:00:00",
            "2026-10-21T13:00:00",
            "uid:l",
        )
    };
    let floating = calendar::batch(
        Locale::En,
        &wire::CalendarSnapshot {
            device_zone: String::new(),
            ..snapshot(vec![timed])
        },
    );
    assert_eq!(floating.records[0].fields["timing"], "floating");
    assert_eq!(floating.records[0].fields["zone"], Value::Null);
}

#[test]
fn a_repeating_series_is_one_record_keyed_by_its_id_and_states_the_days_it_shows_and_the_ones_it_moved()
 {
    let lunch = event(
        "Lunch",
        "2026-10-21T12:00:00",
        "2026-10-21T13:00:00",
        "uid:lunch@google",
    );
    let batch = calendar::batch(
        Locale::En,
        &snapshot(vec![
            standup("2026-10-12T09:00:00", false, ""),
            standup("2026-10-19T09:00:00", false, ""),
            standup("2026-10-26T10:00:00", true, "2026-10-26T09:00:00"),
            lunch,
        ]),
    );
    let ids: Vec<&str> = batch.records.iter().map(|r| r.phone_id.as_str()).collect();
    assert_eq!(ids, ["uid:lunch@google", "uid:standup@google"]);
    let series = &batch.records[1].fields;
    assert_eq!(series["starts"], "2026-10-05T09:00:00");
    assert_eq!(series["rule"], "FREQ=WEEKLY;BYDAY=MO");
    assert_eq!(
        series["overrides"]["shown"],
        json!(["2026-10-12T09:00:00", "2026-10-19T09:00:00"])
    );
    let moved = &series["overrides"]["moved"][0];
    assert_eq!(moved["original_start"], "2026-10-26T09:00:00");
    assert_eq!(moved["starts"], "2026-10-26T10:00:00");
    assert!(
        series["overrides"]["from"]
            .as_str()
            .is_some_and(|from| from.ends_with("T00:00:00Z"))
    );
    // The window is a day inside what was read, as UTC midnights.
    assert!(series["overrides"]["from"].as_str() < series["overrides"]["to"].as_str());
}

#[test]
fn an_event_with_no_valid_id_or_no_title_is_skipped_and_one_id_is_one_record() {
    let base = event(
        "Lunch",
        "2026-10-21T12:00:00",
        "2026-10-21T13:00:00",
        "uid:lunch@google",
    );
    let batch = calendar::batch(
        Locale::En,
        &snapshot(vec![
            wire::PhoneCalendarEvent {
                phone_id: String::new(),
                ..base.clone()
            },
            wire::PhoneCalendarEvent {
                phone_id: "12".to_owned(),
                ..base.clone()
            },
            wire::PhoneCalendarEvent {
                title: " ".to_owned(),
                ..base.clone()
            },
            base.clone(),
            wire::PhoneCalendarEvent {
                title: "Lunch, again".to_owned(),
                ..base
            },
        ]),
    );
    let ids: Vec<&str> = batch.records.iter().map(|r| r.phone_id.as_str()).collect();
    assert_eq!(ids, ["uid:lunch@google"]);
    assert_eq!(batch.records[0].fields["title"], "Lunch");
}

#[test]
fn a_moved_day_states_its_own_timing_link_and_place_and_a_series_states_its_link() {
    // An all-day series ("Trash day"); the phone moved one day to 15:00 with a link and a place.
    let day = |start: &str, end: &str, all_day: bool, moved: bool| wire::PhoneCalendarEvent {
        title: "Trash day".to_owned(),
        all_day,
        start: start.to_owned(),
        end: end.to_owned(),
        tz: if all_day {
            String::new()
        } else {
            "UTC".to_owned()
        },
        url: "https://example.org/series".to_owned(),
        location: "Kerbside".to_owned(),
        series: Some(wire::PhoneCalendarSeries {
            id: "uid:trash@google".to_owned(),
            rrule: "FREQ=WEEKLY".to_owned(),
            start: "2026-10-05".to_owned(),
            end: "2026-10-05".to_owned(),
        }),
        original_start: if moved {
            "2026-10-19".to_owned()
        } else {
            String::new()
        },
        moved,
        phone_id: format!("local:ek-{start}"),
        calendar_key: "work".to_owned(),
        ..wire::PhoneCalendarEvent::default()
    };
    let mut moved = day("2026-10-19T15:00:00", "2026-10-19T16:00:00", false, true);
    moved.url = "https://example.org/day".to_owned();
    moved.location = "The depot".to_owned();
    let batch = calendar::batch(
        Locale::En,
        &snapshot(vec![
            day("2026-10-12", "2026-10-12", true, false),
            moved,
            day("2026-10-26", "2026-10-26", true, false),
        ]),
    );
    let series = &batch.records[0].fields;
    assert_eq!(series["timing"], "all-day");
    assert_eq!(series["url"], "https://example.org/series");
    let moved = &series["overrides"]["moved"][0];
    assert_eq!(
        moved["timing"], "zoned",
        "the day's timing, not its series'"
    );
    assert_eq!(moved["zone"], "UTC");
    assert_eq!(
        moved["starts"], "2026-10-19T15:00:00",
        "a time, not the day"
    );
    assert_eq!(moved["ends"], "2026-10-19T16:00:00");
    assert_eq!(moved["url"], "https://example.org/day");
    assert_eq!(moved["location"], "The depot");
    // A day at the series' own place says none of it.
    let mut same = day("2026-10-19", "2026-10-19", true, true);
    same.url = String::new();
    let batch = calendar::batch(
        Locale::En,
        &snapshot(vec![day("2026-10-12", "2026-10-12", true, false), same]),
    );
    let moved = &batch.records[0].fields["overrides"]["moved"][0];
    assert_eq!(
        moved["location"], "",
        "the series' own place is not the day's"
    );
    assert_eq!(moved["timing"], "all-day");
}

#[test]
fn a_calendar_is_painted_with_the_wheel_hue_nearest_its_phone_colour_and_a_grey_has_none() {
    let painted = |color: &str| {
        calendar::origin_of(
            Locale::En,
            &wire::PhoneCalendar {
                key: "k".to_owned(),
                source_title: String::new(),
                title: "Home".to_owned(),
                color: color.to_owned(),
            },
        )
        .color
    };
    assert_eq!(painted("#34C759").as_deref(), Some("var(--c-forest)"));
    assert_eq!(painted("#808080"), None);
    assert_eq!(painted(""), None);
    let batch = calendar::batch(Locale::En, &snapshot(Vec::new()));
    let request = calendar::follow_request(&batch.origins[0], &[], true, "device-a");
    let origin: serde_json::Value = serde_json::from_str(&request.origin).expect("json");
    assert_eq!(origin["color"], "var(--c-slate)");
}

#[test]
fn a_calendar_names_itself_by_its_source_and_title() {
    let name = |source: &str, title: &str| {
        calendar::origin_of(
            Locale::En,
            &wire::PhoneCalendar {
                key: "k".to_owned(),
                source_title: source.to_owned(),
                title: title.to_owned(),
                color: String::new(),
            },
        )
        .label
    };
    assert_eq!(name("iCloud", "Home"), "iCloud: Home");
    assert_eq!(name("Gmail", "Gmail"), "Gmail");
    assert_eq!(name("", "Home"), "Home");
    assert_eq!(name("Gmail", ""), "Gmail");
    assert_eq!(name("  ", " "), "This phone's calendars");
    assert_eq!(name("  iCloud  ", "My\u{a0}  Home"), "iCloud: My Home");
}

#[test]
fn the_sentence_an_import_ends_on() {
    let said = |added, refused, add_account| {
        calendar::sentence(
            Locale::En,
            &calendar::Outcome {
                added,
                refused,
                add_account,
                ..calendar::Outcome::default()
            },
        )
    };
    assert_eq!(
        said(0, 0, true),
        "No calendars found. Add your Google or other account in your phone's Settings, then come back."
    );
    assert_eq!(said(0, 0, false), "No events to import");
    assert_eq!(said(0, 3, false), "The calendar did not import.");
    assert_eq!(said(1, 0, false), "1 event imported");
    assert_eq!(said(6, 2, false), "6 events imported");
}

// ---------------------------------------------------------------------------
// The flow, through the runtime
// ---------------------------------------------------------------------------

/// A long-lived screen that hosts the import the way Calendar's home does: the Import tap is the
/// proof screen's copy tap, and the status line is its title. Following is the coordinator's
/// (`centraid_screens::follow`), which the following tests run beside it.
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
            Some(E::Appeared(_)) => self.follow.attach(),
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

fn host_route() -> wire::Route {
    wire::Route {
        sheet: false,
        screen: "test.calendar".to_owned(),
        args: None,
    }
}

fn hosts() -> Registry {
    Registry::default().with("test.calendar", |_| {
        Some(Box::new(Host {
            follow: CalendarFollow::new(),
        }))
    })
}

fn world() -> World {
    World::with(hosts())
}

fn status(world: &World, host: u64) -> String {
    match &world.driver.view(host).kind {
        Some(wire::view_state::Kind::Counter(view)) => view.title.clone(),
        other => panic!("{other:?}"),
    }
}

fn tap_import(world: &mut World, host: u64) -> wire::ScreenUpdate {
    world.driver.send(
        host,
        E::Counter(wire::CounterEvent {
            kind: Some(wire::counter_event::Kind::CopyTapped(
                wire::CounterCopyTapped {},
            )),
        }),
    )
}

/// Answer the oldest pending effect of `kind` (the shell's reply to one ask).
fn answer(
    world: &mut World,
    wants: fn(&wire::effect::Kind) -> bool,
    outcome: wire::effect_result::Outcome,
) -> wire::ScreenUpdate {
    let at = world
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
    let request = world.driver.effects.remove(at);
    world.driver.send(
        request.instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    )
}

fn is_read(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::CalendarRead(_))
}

fn is_keychain(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::Keychain(_))
}

/// The habit read: what a device asks the keychain before it follows.
fn is_habit_read(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::Keychain(op) if op.op == wire::keychain_op::Op::Get as i32)
}

fn reads(world: &World) -> Vec<wire::CalendarRead> {
    world
        .driver
        .effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::CalendarRead(read) => Some(*read),
            _ => None,
        })
        .collect()
}

fn watches(world: &World) -> Vec<bool> {
    world
        .driver
        .effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::PhoneWatch(watch) => {
                assert_eq!(watch.source, wire::ImportSource::Calendar as i32);
                Some(watch.on)
            }
            _ => None,
        })
        .collect()
}

/// The OS says the calendar changed, under the one effect id of the watch the coordinator asked.
fn changed(world: &mut World) {
    let watch = world
        .driver
        .effects
        .iter()
        .find(|request| {
            matches!(
                request.effect.as_ref().and_then(|e| e.kind.as_ref()),
                Some(wire::effect::Kind::PhoneWatch(watch))
                    if watch.on && watch.source == wire::ImportSource::Calendar as i32
            )
        })
        .cloned()
        .expect("the coordinator watches the calendar");
    world.driver.send(
        watch.instance,
        E::EffectResult(wire::EffectResult {
            effect_id: watch.effect_id,
            outcome: Some(wire::effect_result::Outcome::PhoneChanged(
                wire::PhoneChanged {
                    source: wire::ImportSource::Calendar as i32,
                },
            )),
        }),
    );
}

fn in_window(world: &World, title: &str) -> Vec<wire::AgendaEvent> {
    world
        .window("2099-01-01T00:00:00Z", "2099-12-31T00:00:00Z")
        .into_iter()
        .filter(|e| e.summary.as_deref() == Some(title))
        .collect()
}

fn future(title: &str, day: &str, phone_id: &str) -> wire::PhoneCalendarEvent {
    wire::PhoneCalendarEvent {
        // An import of 2099 events: the window the OS reads is the shell's, the rules are the same.
        tz: ZONE_PARIS.to_owned(),
        ..event(
            title,
            &format!("{day}T12:00:00"),
            &format!("{day}T13:00:00"),
            phone_id,
        )
    }
}

const ZONE_PARIS: &str = "Europe/Paris";

#[test]
fn the_import_tap_asks_the_os_reads_say_importing_and_the_vault_merges_what_it_is_told() {
    let mut world = world();
    let host = world.driver.push("calendar", host_route());
    // Appearing asks the device whether it follows; a first launch has not imported.
    answer(
        &mut world,
        is_keychain,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue {
            found: false,
            value: vec![],
        }),
    );
    tap_import(&mut world, host);
    let ask = reads(&world);
    assert_eq!(ask.len(), 1);
    assert!(ask[0].ask_permission, "the member's tap lets the OS ask");
    assert_eq!((ask[0].days_back, ask[0].days_on), (7, 62));
    assert_eq!(status(&world, host), "Importing calendar");
    // A second tap while one runs is nothing: it would write every event twice.
    tap_import(&mut world, host);
    assert_eq!(reads(&world).len(), 1);

    let events = vec![
        future("Offsite", "2099-03-10", "uid:offsite@google"),
        future("Dentist", "2099-03-11", "uid:dentist@google"),
    ];
    let done = answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(events.clone())),
    );
    assert_eq!(status(&world, host), "2 events imported");
    assert_eq!(in_window(&world, "Offsite").len(), 1);
    let dentist = in_window(&world, "Dentist");
    assert_eq!(dentist.len(), 1);
    // The wall clock and its zone: noon in Paris in March is 11:00Z, and reads back in London as 11:00.
    assert_eq!(dentist[0].local_start, "2099-03-11T11:00");
    // This device follows from now on: remembered. The store is watched by the follow
    // coordinator, not by this screen.
    assert!(done.effects.iter().any(|r| matches!(
        r.effect.as_ref().and_then(|e| e.kind.as_ref()),
        Some(wire::effect::Kind::Keychain(op)) if op.op == wire::keychain_op::Op::Set as i32 && op.key == "agenda_calendar_imported"
    )));
    assert!(watches(&world).is_empty(), "this screen watches nothing");

    assert!(reads(&world).is_empty(), "the second tap was nothing");

    // Importing again adds nothing twice.
    tap_import(&mut world, host);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(events)),
    );
    assert_eq!(in_window(&world, "Offsite").len(), 1);
    assert_eq!(in_window(&world, "Dentist").len(), 1);
}

#[test]
fn a_denied_read_says_where_to_turn_it_on_and_a_calendarless_phone_says_to_add_an_account() {
    let mut world = world();
    let host = world.driver.push("calendar", host_route());
    answer(
        &mut world,
        is_keychain,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue::default()),
    );
    tap_import(&mut world, host);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Failed(wire::EffectFailed {
            reason: "no".to_owned(),
            denied: true,
            ..Default::default()
        }),
    );
    assert_eq!(
        status(&world, host),
        "Calendar access is off. Turn it on in Settings."
    );
    assert!(watches(&world).is_empty());

    tap_import(&mut world, host);
    let done = answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(wire::CalendarSnapshot {
            now_ms: NOW,
            complete: true,
            ..wire::CalendarSnapshot::default()
        }),
    );
    assert_eq!(
        status(&world, host),
        "No calendars found. Add your Google or other account in your phone's Settings, then come back."
    );
    // Nothing was imported, so nothing is followed.
    assert!(done.effects.is_empty(), "{:?}", done.effects);

    // A read that failed some other way is a failed import.
    tap_import(&mut world, host);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Failed(wire::EffectFailed {
            reason: "io".to_owned(),
            denied: false,
            ..Default::default()
        }),
    );
    assert_eq!(status(&world, host), "The calendar did not import.");
}

#[test]
fn a_calendar_with_nothing_in_it_is_still_told_and_an_event_that_left_a_complete_read_goes_but_not_from_a_partial_one()
 {
    let mut world = world();
    let host = world.driver.push("calendar", host_route());
    answer(
        &mut world,
        is_keychain,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue::default()),
    );
    tap_import(&mut world, host);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![future(
            "Offsite",
            "2099-03-10",
            "uid:offsite@google",
        )])),
    );
    assert_eq!(in_window(&world, "Offsite").len(), 1);

    // A partial read that lacks it trashes nothing.
    tap_import(&mut world, host);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(wire::CalendarSnapshot {
            complete: false,
            ..snapshot(vec![])
        }),
    );
    assert_eq!(in_window(&world, "Offsite").len(), 1);

    // A complete read that lacks it (the calendar is still there, empty) moves it to the trash.
    tap_import(&mut world, host);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![])),
    );
    assert!(in_window(&world, "Offsite").is_empty());
}

#[test]
fn a_repeating_series_imports_as_one_event_that_skips_what_the_phone_does_not_show() {
    let mut world = world();
    let host = world.driver.push("calendar", host_route());
    answer(
        &mut world,
        is_keychain,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue::default()),
    );
    tap_import(&mut world, host);
    let occurrence = |day: &str| wire::PhoneCalendarEvent {
        title: "Standup".to_owned(),
        start: format!("{day}T09:00:00"),
        end: format!("{day}T09:30:00"),
        tz: ZONE_PARIS.to_owned(),
        series: Some(wire::PhoneCalendarSeries {
            id: "uid:standup@google".to_owned(),
            rrule: "RRULE:FREQ=WEEKLY".to_owned(),
            start: "2099-03-02T09:00:00".to_owned(),
            end: "2099-03-02T09:30:00".to_owned(),
        }),
        phone_id: format!("local:ek-{day}"),
        calendar_key: "work".to_owned(),
        ..wire::PhoneCalendarEvent::default()
    };
    // Every Monday the phone showed in its window (2099-03-01 .. +62 days) but the 9th.
    let mut days = Vec::new();
    let mut day = "2099-03-02".to_owned();
    while day.as_str() <= "2099-04-27" {
        if day != "2099-03-09" {
            days.push(day.clone());
        }
        day = civil::plus_days(&day, 7).expect("a day");
    }
    let mut snap = snapshot(days.iter().map(|day| occurrence(day)).collect());
    snap.now_ms = 4_076_006_400_000; // 2099-03-01
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snap),
    );
    let all = in_window(&world, "Standup");
    assert!(!all.is_empty(), "the series was imported");
    assert_eq!(
        all[0].event_id,
        all.last().expect("some").event_id,
        "one event, many occurrences"
    );
    let starts: Vec<&str> = all.iter().map(|e| e.local_start.as_str()).take(3).collect();
    assert_eq!(
        starts[0], "2099-03-02T08:00",
        "09:00 in Paris is 08:00 in London"
    );
    assert!(
        !all.iter().any(|e| e.local_start.starts_with("2099-03-09")),
        "the 9th, which the phone did not show inside its window, is skipped: {starts:?}"
    );
}

// ---------------------------------------------------------------------------
// The follow (PhoneFollowSpec, Agenda's pass)
// ---------------------------------------------------------------------------

/// The coordinator runs beside a screen that hosts the import; nobody has imported yet.
fn following_world() -> World {
    World::following(hosts())
}

/// The coordinator's habit read is answered: this device did import (`found`), or never did.
fn habit(world: &mut World, found: bool) {
    answer(
        world,
        is_habit_read,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue {
            found,
            value: if found { b"1".to_vec() } else { Vec::new() },
        }),
    );
}

/// The OS says it changed, the settle passes, and the pass reads the habit; the device imported.
fn changed_and_followed(world: &mut World) {
    changed(world);
    world.driver.pump(Duration::from_millis(2_500));
    habit(world, true);
}

#[test]
fn a_device_that_never_imported_is_not_followed_and_the_phone_is_not_even_read() {
    let mut world = following_world();
    changed(&mut world);
    world.driver.pump(Duration::from_millis(2_500));
    habit(&mut world, false);
    assert!(reads(&world).is_empty());
}

#[test]
fn an_imported_device_follows_once_the_two_seconds_are_up_never_asking_the_os() {
    let mut world = following_world();
    changed(&mut world);
    // Following starts after the settle time, and not before.
    world.driver.pump(Duration::from_millis(1_000));
    assert!(reads(&world).is_empty(), "not before the two seconds");
    world.driver.pump(Duration::from_millis(1_600));
    habit(&mut world, true);
    let ask = reads(&world);
    assert_eq!(ask.len(), 1);
    assert!(!ask[0].ask_permission, "a pass never asks the OS");
    assert_eq!((ask[0].days_back, ask[0].days_on), (7, 62));

    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![future(
            "Offsite",
            "2099-03-10",
            "uid:offsite@google",
        )])),
    );
    assert_eq!(in_window(&world, "Offsite").len(), 1);
}

#[test]
fn a_burst_of_changes_is_one_pass_and_changes_during_a_pass_queue_exactly_one_more() {
    let mut world = following_world();
    changed_and_followed(&mut world);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![])),
    );
    assert!(reads(&world).is_empty());

    // TEN TRIGGERS, ONE PASS.
    for _ in 0..10 {
        changed(&mut world);
    }
    world.driver.pump(Duration::from_millis(2_500));
    habit(&mut world, true);
    assert_eq!(reads(&world).len(), 1);

    // FOUR MORE DURING THE PASS: the one in flight read before them, so one more follows it, and no third.
    for _ in 0..4 {
        changed(&mut world);
    }
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![])),
    );
    habit(&mut world, true);
    assert_eq!(reads(&world).len(), 1, "the queued pass starts at once");
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![])),
    );
    world.driver.pump(Duration::from_millis(2_500));
    assert!(
        !world.driver.effects.iter().any(|request| request
            .effect
            .as_ref()
            .and_then(|e| e.kind.as_ref())
            .is_some_and(is_habit_read)),
        "and no third follows"
    );
}

#[test]
fn a_pass_with_no_access_asks_nothing_and_the_next_change_follows_again() {
    let mut world = following_world();
    changed_and_followed(&mut world);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Failed(wire::EffectFailed {
            reason: "off".to_owned(),
            denied: true,
            ..Default::default()
        }),
    );
    assert!(
        world.driver.effects.iter().all(|request| !request
            .effect
            .as_ref()
            .and_then(|e| e.kind.as_ref())
            .is_some_and(is_keychain)),
        "a following pass is silent when access is off: it asks no one"
    );
    changed_and_followed(&mut world);
    assert_eq!(reads(&world).len(), 1);
    assert!(!reads(&world)[0].ask_permission);
}

#[test]
fn an_import_turns_the_follow_on_and_a_pass_follows_it_without_asking() {
    let mut world = World::following(hosts());
    let host = world.driver.push("calendar", host_route());
    // The screen's own habit read is the oldest: this device has not imported yet.
    answer(
        &mut world,
        is_habit_read,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue::default()),
    );
    tap_import(&mut world, host);
    assert!(
        reads(&world)[0].ask_permission,
        "the member's import may ask"
    );
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![future(
            "Offsite",
            "2099-03-10",
            "uid:offsite@google",
        )])),
    );
    assert_eq!(status(&world, host), "1 event imported");
    // The import told the coordinator; after the settle it reads the habit the import kept.
    world.driver.pump(Duration::from_millis(2_500));
    habit(&mut world, true);
    let ask = reads(&world);
    assert_eq!(ask.len(), 1);
    assert!(
        !ask[0].ask_permission,
        "the follow that comes of it never asks"
    );
}

#[test]
fn alerts_and_guests_ride_the_record_alerts_once_each_and_guests_only_when_there_are_any() {
    let mut party = event(
        "Party",
        "2099-03-10T12:00:00",
        "2099-03-10T13:00:00",
        "uid:party",
    );
    party.alerts = vec![10, 60, 10];
    party.attendees = vec![
        wire::PhoneAttendee {
            name: " Ada ".into(),
            email: "ada@example.com".into(),
            status: "accepted".into(),
        },
        wire::PhoneAttendee::default(),
    ];
    let bare = event(
        "Bare",
        "2099-03-10T12:00:00",
        "2099-03-10T13:00:00",
        "uid:bare",
    );
    let batch = calendar::batch(Locale::En, &snapshot(vec![party, bare]));
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
    let mut world = world();
    let host = world.driver.push("calendar", host_route());
    answer(
        &mut world,
        is_keychain,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue {
            found: false,
            value: vec![],
        }),
    );
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
        calendar_key: "work".to_owned(),
        ..wire::PhoneCalendarEvent::default()
    };
    tap_import(&mut world, host);
    answer(
        &mut world,
        is_read,
        wire::effect_result::Outcome::Calendar(snapshot(vec![day("2099-03-02")])),
    );

    // It shows, once, at its anchor, carrying the stored rule for the editor.
    let shown: Vec<wire::AgendaEvent> = world
        .window("2099-01-01T00:00:00Z", "2099-12-31T00:00:00Z")
        .into_iter()
        .filter(|event| event.summary.as_deref() == Some("Standup"))
        .collect();
    assert_eq!(shown.len(), 1, "{shown:?}");
    let id = shown[0].event_id.clone();
    assert_eq!(shown[0].rrule.as_deref(), Some(UNREADABLE));

    // Its detail renders, and says "Custom" for a rule nobody can read, never the rule.
    let page = world.open_event(&id, &id, None, "2099-03-02");
    let data = world.event_data(page);
    let repeats = data
        .facts
        .iter()
        .find(|fact| fact.label == "Repeats")
        .expect("a repeat fact");
    assert_eq!(repeats.detail, "Custom");
    assert!(!data.facts.iter().any(|fact| fact.detail.contains("BYHOUR")));

    // The editor opens it read-only as Custom, with Replace.
    let editor = world.open_edit(&id, "", None, "2099-03-02");
    assert_eq!(world.draft(editor).repeat_key, "custom");
    world.send_editor(
        editor,
        K::Repeat(events::RepeatPicked {
            key: "custom".into(),
        }),
    );
    let sheet = world
        .editor_data(editor)
        .custom_repeat
        .clone()
        .expect("the sheet");
    assert!(sheet.read_only);
    assert_eq!(sheet.replace_label, "Replace this rule");
    assert!(!sheet.summary.is_empty() && !sheet.summary.contains("BYHOUR"));
    // Done leaves the stored rule alone: nothing to save.
    world.send_editor(editor, K::CustomApplied(events::CustomApplied {}));
    assert!(!world.editor_data(editor).dirty);
    // Replace starts a fresh rule the engine reads, and saving writes it.
    world.send_editor(
        editor,
        K::Repeat(events::RepeatPicked {
            key: "custom".into(),
        }),
    );
    world.send_editor(editor, K::CustomReplace(events::CustomReplaceTapped {}));
    assert!(
        !world
            .editor_data(editor)
            .custom_repeat
            .clone()
            .expect("sheet")
            .read_only
    );
    world.send_editor(editor, K::CustomApplied(events::CustomApplied {}));
    assert!(world.editor_data(editor).dirty);
}
