//! A BACKGROUND FOLLOW PASS LEAVES THE PHONE'S OWN ALERT ALONE (#1185, #1188 NA2): the app is in the
//! background and the member opens nothing. The phone's calendar changes, the
//! follow pass Calendar's home hosts reads it and writes an event that has an
//! alert, and the notification service, which hears every commit, still holds no
//! notification for it: the phone's calendar sounds it. Counted on what the set holds, never on time. The runtime runs the
//! follow coordinator, as the app does: it hears the OS, reads the habit, then the phone.

mod reminders_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda;
use centraid_screens::testing::{Driver, FakeShell};
use reminders_support::day;
use wire::screen_event::Kind as E;

fn sets(d: &Driver) -> Vec<wire::ScheduleNotifications> {
    d.effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::ScheduleNotifications(set) => Some(set.clone()),
            _ => None,
        })
        .collect()
}

fn position(d: &Driver, wants: fn(&wire::effect::Kind) -> bool) -> Option<usize> {
    d.effects.iter().position(|request| {
        request
            .effect
            .as_ref()
            .and_then(|e| e.kind.as_ref())
            .is_some_and(wants)
    })
}

/// Answer the oldest pending effect of a kind, the way a shell does; the instance that asked.
fn answer(
    d: &mut Driver,
    wants: fn(&wire::effect::Kind) -> bool,
    outcome: wire::effect_result::Outcome,
) -> u64 {
    let at = position(d, wants).expect("the effect was asked");
    let request = d.effects.remove(at);
    d.send(
        request.instance,
        E::EffectResult(wire::EffectResult {
            effect_id: request.effect_id,
            outcome: Some(outcome),
        }),
    );
    request.instance
}

fn is_keychain(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::Keychain(_))
}

fn is_read(kind: &wire::effect::Kind) -> bool {
    matches!(kind, wire::effect::Kind::CalendarRead(_))
}

#[test]
fn a_background_follow_pass_that_brings_in_an_alerted_event_leaves_the_phones_own_alert_alone() {
    let runtime = centraid_screens::Runtime::new(
        agenda::registry().merge(centraid_screens::follow::registry()),
        vec![(
            agenda::TAB.to_owned(),
            routes::home(wire::AgendaDestination::Day, ""),
        )],
    )
    .with_services(
        [
            agenda::notify::services(),
            centraid_screens::follow::services(),
        ]
        .concat(),
    );
    let mut d = Driver::with_runtime(runtime);
    d.start();
    d.serve(&mut FakeShell::default());
    // This device imported before, so Calendar's home follows the phone's store.
    answer(
        &mut d,
        is_keychain,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue {
            found: true,
            value: b"1".to_vec(),
        }),
    );
    let tomorrow = day(&d, 1);
    d.pump(Duration::from_millis(150));

    // THE APP GOES TO THE BACKGROUND, and no screen is opened from here on.
    d.call(wire::screen_request::Kind::Lifecycle(wire::AppLifecycle {
        foreground: false,
    }));
    // The coordinator, which the lifecycle woke, asked the OS to watch the calendar.
    let host = d
        .effects
        .iter()
        .find_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::PhoneWatch(watch)
                if watch.source == wire::ImportSource::Calendar as i32 =>
            {
                Some(request.instance)
            }
            _ => None,
        })
        .expect("the coordinator watches the phone's calendar");
    d.effects.clear();

    // The OS tells the coordinator the calendar changed; the pass first asks whether this
    // device follows (it does), then reads once the settle time is up.
    d.send(
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
    d.pump(Duration::from_millis(2_500));
    answer(
        &mut d,
        is_keychain,
        wire::effect_result::Outcome::Keychain(wire::KeychainValue {
            found: true,
            value: b"1".to_vec(),
        }),
    );
    assert!(position(&d, is_read).is_some(), "the pass read the phone");
    d.effects.retain(|request| {
        !matches!(
            request.effect.as_ref().and_then(|e| e.kind.as_ref()),
            Some(wire::effect::Kind::ScheduleNotifications(_))
        )
    });

    // The phone answers with an event tomorrow at noon that alerts ten minutes before.
    let event = wire::PhoneCalendarEvent {
        title: "Offsite".to_owned(),
        start: format!("{tomorrow}T12:00:00"),
        end: format!("{tomorrow}T13:00:00"),
        tz: "Europe/Paris".to_owned(),
        phone_id: "uid:offsite@google".to_owned(),
        calendar_key: "work".to_owned(),
        alerts: vec![10],
        ..wire::PhoneCalendarEvent::default()
    };
    answer(
        &mut d,
        is_read,
        wire::effect_result::Outcome::Calendar(wire::CalendarSnapshot {
            now_ms: 1_792_000_000_000,
            device_zone: "Europe/Paris".to_owned(),
            complete: true,
            calendars: vec![wire::PhoneCalendar {
                key: "work".to_owned(),
                source_title: "Google".to_owned(),
                title: "Work".to_owned(),
                ..wire::PhoneCalendar::default()
            }],
            events: vec![event],
            device_id: "device-a".to_owned(),
        }),
    );
    // The commit the pass made reaches the service; nothing else was done by the member.
    d.pump(Duration::from_millis(500));

    // ONE ALERT PER REAL THING (#1188, NA2): the phone's own calendar sounds this alert, as it
    // stated it, so the pass leaves Centraid holding no notification for the event.
    let spoken = sets(&d);
    assert!(
        spoken
            .iter()
            .flat_map(|set| set.all.iter())
            .all(|n| !n.notification_id.starts_with("event|")),
        "the phone alerts for it: {spoken:?}"
    );
}
