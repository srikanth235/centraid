//! `agenda.editor` through the door a shell uses: defaults, validation, the day
//! math, the explicit save and which command each save is, dirty leave, scope
//! and skip, and the Event | Task switch. Ports `AgendaEditorSpec`.

mod calendar_support;

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use std::time::Duration;

use calendar_support::{World, asked};
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::kit::civil;
use centraid_screens::strings::Locale;
use wire::agenda_editor_event::Kind as K;
use wire::agenda_editor_state::Sheet;
use wire::{AgendaEditorKind as Kind, AgendaScope as Scope};

fn ev<T>(make: impl FnOnce(T) -> K, body: T) -> K {
    make(body)
}

fn notes(text: &str) -> K {
    ev(
        K::Notes,
        wire::agenda_editor_event::NotesChanged {
            text: text.to_owned(),
        },
    )
}

fn link(text: &str) -> K {
    ev(
        K::Link,
        wire::agenda_editor_event::LinkChanged {
            text: text.to_owned(),
        },
    )
}

fn start(day: &str, time: &str) -> K {
    ev(
        K::Start,
        wire::agenda_editor_event::StartChanged {
            day: day.to_owned(),
            time: time.to_owned(),
        },
    )
}

fn end(day: &str, time: &str) -> K {
    ev(
        K::End,
        wire::agenda_editor_event::EndChanged {
            day: day.to_owned(),
            time: time.to_owned(),
        },
    )
}

fn all_day(on: bool) -> K {
    ev(K::AllDay, wire::agenda_editor_event::AllDayToggled { on })
}

fn guest(id: &str) -> K {
    ev(
        K::Guest,
        wire::agenda_editor_event::GuestToggled {
            party_id: id.to_owned(),
        },
    )
}

fn repeat(key: &str) -> K {
    ev(
        K::Repeat,
        wire::agenda_editor_event::RepeatPicked {
            key: key.to_owned(),
        },
    )
}

fn reminder(key: &str) -> K {
    ev(
        K::Reminder,
        wire::agenda_editor_event::ReminderPicked {
            key: key.to_owned(),
        },
    )
}

fn calendar(id: &str) -> K {
    ev(
        K::Calendar,
        wire::agenda_editor_event::CalendarPicked {
            calendar_id: id.to_owned(),
        },
    )
}

fn leave() -> K {
    K::Leave(wire::agenda_editor_event::LeaveRequested {})
}

fn confirmed() -> K {
    K::Confirmed(wire::agenda_editor_event::Confirmed {})
}

fn kind(kind: Kind) -> K {
    ev(
        K::KindPicked,
        wire::agenda_editor_event::KindPicked { kind: kind as i32 },
    )
}

fn scope(scope: Scope) -> K {
    ev(
        K::Scope,
        wire::agenda_editor_event::ScopePicked {
            scope: scope as i32,
        },
    )
}

fn skip() -> K {
    K::Skip(wire::agenda_editor_event::SkipTapped {})
}

fn sheet(sheet: Sheet) -> K {
    ev(
        K::SheetOpened,
        wire::agenda_editor_event::SheetOpened {
            sheet: sheet as i32,
        },
    )
}

fn labels(choices: &[wire::AgendaChoice]) -> Vec<&str> {
    choices.iter().map(|c| c.label.as_str()).collect()
}

/// The minutes after midnight of `HH:MM`.
fn minutes(time: &str) -> u32 {
    time[..2].parse::<u32>().expect("hours") * 60 + time[3..5].parse::<u32>().expect("minutes")
}

fn keychain_ops(world: &World) -> Vec<(i32, String, Vec<u8>)> {
    world
        .driver
        .effects
        .iter()
        .filter_map(|request| match request.effect.as_ref()?.kind.as_ref()? {
            wire::effect::Kind::Keychain(op) => Some((op.op, op.key.clone(), op.value.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn a_new_event_reads_today_and_the_people_and_starts_at_the_next_half_hour_for_an_hour() {
    let mut world = World::new();
    let page = world.open_new("", Kind::Unspecified);
    // Calendar adds events only: nothing asks the device what it last added.
    assert!(keychain_ops(&world).is_empty());

    let (today, now) = world.today();
    let data = world.editor_data(page);
    assert_eq!(data.heading, "New event");
    let draft = data.draft.clone().expect("a draft");
    // The next half hour after 23:30 is tomorrow's midnight.
    assert!(
        draft.start_day == today || Some(draft.start_day.clone()) == civil::plus_days(&today, 1),
        "{} vs {today}",
        draft.start_day
    );
    // The next half hour after now: on a half hour, and ahead.
    assert!(
        draft.start_time.ends_with(":00") || draft.start_time.ends_with(":30"),
        "{}",
        draft.start_time
    );
    assert!(
        format!("{}T{}", draft.start_day, draft.start_time) > now,
        "{now} vs {draft:?}"
    );
    let span = minutes(&draft.end_time) as i64 - minutes(&draft.start_time) as i64;
    assert!(span == 60 || span == -1380, "an hour long: {draft:?}");
    assert_eq!(draft.repeat_key, "none");
    assert_eq!(draft.reminder_key, "none");
    let calendars = world.calendar_names();
    assert_eq!(draft.calendar_id, calendars[0].0);
    assert_eq!(data.calendar_label, calendars[0].1);
    assert_eq!(data.guests_label, "Nobody else");
    // THE OWNER IS NOT A GUEST OF THEIR OWN EVENT.
    let names: Vec<String> = data.guests.iter().map(|g| g.label.clone()).collect();
    assert_eq!(
        names,
        [
            "Chris Okafor",
            "Grandpa Ray",
            "Jake Bennett",
            "Maya Alvarez"
        ]
    );
    assert_eq!(data.foot_note, "A new event starts tentative.");
    assert!(!data.can_save);
    assert_eq!(data.start_field_label, "Starts");
    let chrome = world.editor_state(page).chrome.clone().expect("chrome");
    assert_eq!(
        (chrome.pick_date.as_str(), chrome.pick_time.as_str()),
        ("Pick a date", "Pick a time")
    );
    // There is no Event | Task switch, so the chrome carries no label for one (round 10).
    assert_eq!(chrome.kind_label, "");

    // NOTHING TOUCHED, NOTHING SAID: why Save is not armed waits for a change or a Save pressed.
    assert_eq!(data.blocked_reason, "");
    world.save(page);
    assert_eq!(
        world.editor_data(page).blocked_reason,
        "Add a title to save."
    );
    let again = world.open_new("2099-06-17", Kind::Event);
    assert_eq!(world.editor_data(again).blocked_reason, "");
    world.send_editor(again, notes("Bring the form"));
    assert_eq!(
        world.editor_data(again).blocked_reason,
        "Add a title to save."
    );
    // Another day starts at 09:00 for an hour.
    let draft = world.draft(again);
    assert_eq!(
        (draft.start_time.as_str(), draft.end_time.as_str()),
        ("09:00", "10:00")
    );
    assert_eq!(
        (draft.start_day.as_str(), draft.end_day.as_str()),
        ("2099-06-17", "2099-06-17")
    );
    // Nothing typed: leaving is done, not a question.
    let fresh = world.open_new("2099-06-17", Kind::Event);
    world.send_editor(fresh, leave());
    assert!(world.editor_state(fresh).dismissed);
}

#[test]
fn save_proposes_in_the_phones_zone_and_a_commit_ends_the_editor() {
    let mut world = World::new();
    let maya = world.person("Maya Alvarez");
    let page = world.open_new("2099-06-15", Kind::Event);
    world.title(page, "  Dentist ");
    world.send_editor(page, guest(&maya));
    world.send_editor(page, repeat("weekly"));
    world.send_editor(page, reminder("30"));
    let data = world.editor_data(page);
    assert!(data.can_save);
    assert_eq!(data.guests_label, "Maya Alvarez");
    assert_eq!(data.repeat_label, "Every week on Monday");
    assert_eq!(
        labels(&data.repeats),
        [
            "Does not repeat",
            "Every day",
            "Every week on Monday",
            "Every other week on Monday",
            "Every month on the 15th",
            "Every year on 15 June",
            "Custom"
        ]
    );
    assert_eq!(data.reminder_label, "30 minutes before");
    assert_eq!(data.start_label, "Monday 15 June · 09:00");
    assert_eq!(data.start_day_label, "Mon 15 Jun");
    assert_eq!(data.start_time_label, "09:00");
    assert_eq!(data.end_time_label, "10:00");

    let update = world.save(page);
    assert!(world.editor_state(page).dismissed);
    // The editor makes events only, so it remembers no kind and asks the keychain nothing.
    assert!(asked(&update).is_empty(), "a save asks no one anything");
    assert!(keychain_ops(&world).is_empty());

    // THE MEMBER'S WALL CLOCK AND THE PHONE'S ZONE: 09:00 in London in June is 08:00Z, and reads back as 09:00.
    let made: Vec<_> = world
        .window("2099-06-15T00:00:00Z", "2099-06-16T00:00:00Z")
        .into_iter()
        .filter(|e| e.summary.as_deref() == Some("Dentist"))
        .collect();
    assert_eq!(made.len(), 1);
    let event = &made[0];
    assert_eq!(
        (event.local_start.as_str(), event.local_end.as_str()),
        ("2099-06-15T09:00", "2099-06-15T10:00")
    );
    assert_eq!(event.dtstart, "2099-06-15T08:00:00.000Z");
    assert_eq!(event.rrule.as_deref(), Some("FREQ=WEEKLY"));
    assert_eq!(
        event
            .reminders
            .iter()
            .map(|r| r.minutes_before)
            .collect::<Vec<_>>(),
        [30]
    );
    assert_eq!(
        event
            .attendees
            .iter()
            .map(|a| a.party_id.as_str())
            .collect::<Vec<_>>(),
        [maya.as_str()]
    );

    // A SAVE AFTER THE COMMIT FILES NOTHING MORE: the core keeps no replay ledger.
    world.save(page);
    world.send_editor(page, leave());
    let count = world
        .window("2099-06-15T00:00:00Z", "2099-06-16T00:00:00Z")
        .into_iter()
        .filter(|e| e.summary.as_deref() == Some("Dentist"))
        .count();
    assert_eq!(count, 1);
    assert!(world.editor_data(page).draft.is_some());
    assert!(!world.editor_data(page).can_save);
}

#[test]
fn a_refused_save_keeps_the_draft_says_the_cores_sentence_and_tries_again() {
    let mut world = World::new();
    world.propose(
        "Standing",
        "2099-06-15T09:00:00",
        "2099-06-15T10:00:00",
        |_| {},
    );
    let page = world.open_new("2099-06-15", Kind::Event);
    world.title(page, "  Dentist ");
    world.save(page);
    let state = world.editor_state(page);
    assert!(!state.dismissed);
    let status = state.status.as_ref().expect("the refusal");
    assert!(status.refused);
    assert_eq!(
        status.sentence,
        "This time conflicts with another event on your calendar."
    );
    assert_eq!(
        world.draft(page).title,
        "  Dentist ",
        "the words stay as typed"
    );
    assert!(
        world.editor_data(page).can_save,
        "a refused save is not a committed one"
    );
    // Typing again is the member acting again: the refusal goes, and a new time saves.
    world.send_editor(page, start("2099-06-15", "13:00"));
    assert!(world.editor_state(page).status.is_none());
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    assert_eq!(
        world
            .window("2099-06-15T00:00:00Z", "2099-06-16T00:00:00Z")
            .into_iter()
            .filter(|e| e.summary.as_deref() == Some("Dentist"))
            .count(),
        1
    );
    // No save, refused or committed, asks the keychain anything.
    assert!(keychain_ops(&world).is_empty());
}

#[test]
fn the_day_math_a_start_moves_the_end_with_it_all_day_is_days_and_an_inverted_range_cannot_save() {
    let mut world = World::new();
    let page = world.open_new("2099-06-15", Kind::Event);
    world.title(page, "Flight");
    world.send_editor(page, start("2099-06-15", "23:30"));
    let draft = world.draft(page);
    assert_eq!(
        (draft.end_day.as_str(), draft.end_time.as_str()),
        ("2099-06-16", "00:30")
    );
    world.send_editor(page, end("2099-06-15", "22:00"));
    let data = world.editor_data(page);
    assert!(!data.can_save);
    assert_eq!(data.blocked_reason, "An event must end after it starts.");
    world.save(page);
    assert!(!world.editor_state(page).dismissed);

    world.send_editor(page, all_day(true));
    let data = world.editor_data(page);
    let draft = data.draft.clone().expect("draft");
    assert!(draft.all_day);
    assert_eq!(draft.end_day, "2099-06-15");
    assert_eq!(data.start_label, "Monday 15 June");
    assert_eq!(data.start_time_label, "");
    // An all-day start moves its end by the same days.
    world.send_editor(page, start("2099-06-18", ""));
    assert_eq!(world.draft(page).end_day, "2099-06-18");
    world.send_editor(page, start("2099-06-15", ""));
    // OFF AGAIN: timed, and whole.
    world.send_editor(page, all_day(false));
    assert!(world.editor_data(page).can_save);
    world.send_editor(page, all_day(true));
    // A malformed pick is ignored.
    let before = world.draft(page).clone();
    world.send_editor(page, start("June", "9"));
    world.send_editor(page, end("June", "9"));
    assert_eq!(*world.draft(page), before);

    // The round trip through timed gave the end its hour back, past midnight; all-day keeps both days.
    assert_eq!(world.draft(page).end_day, "2099-06-16");
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    let flight: Vec<_> = world
        .window("2099-06-15T00:00:00Z", "2099-06-17T00:00:00Z")
        .into_iter()
        .filter(|e| e.summary.as_deref() == Some("Flight"))
        .collect();
    assert_eq!(flight.len(), 1);
    assert!(flight[0].all_day);
    assert_eq!(
        (flight[0].local_start.as_str(), flight[0].local_end.as_str()),
        ("2099-06-15", "2099-06-16"),
        "the end is the last day, inclusive"
    );

    // ALL-DAY SAVES ITS DAYS: a one-day event starts and ends on the same day.
    let single = world.open_new("2099-06-22", Kind::Event);
    world.title(single, "Holiday");
    world.send_editor(single, all_day(true));
    world.save(single);
    let holiday: Vec<_> = world
        .window("2099-06-22T00:00:00Z", "2099-06-23T00:00:00Z")
        .into_iter()
        .filter(|e| e.summary.as_deref() == Some("Holiday"))
        .collect();
    assert_eq!(holiday.len(), 1);
    assert_eq!(
        (
            holiday[0].local_start.as_str(),
            holiday[0].local_end.as_str()
        ),
        ("2099-06-22", "2099-06-22")
    );
}

#[test]
fn editing_a_one_off_sends_only_what_changed_clears_what_was_emptied_and_keeps_the_owner_a_guest() {
    let mut world = World::new();
    let (me, maya, jake) = (
        world.me.clone(),
        world.person("Maya Alvarez"),
        world.person("Jake Bennett"),
    );
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |p| {
            p.description = Field::Is("Old notes".to_owned());
            p.url = Field::Is("https://call.example/x".to_owned());
            p.reminders = Field::Is("[45]".to_owned());
            p.attendees = Some(serde_json::to_string(&[&me, &maya]).expect("json"));
        },
    );
    let page = world.open_edit(&id, &id, None, "2099-06-15");
    let data = world.editor_data(page);
    assert_eq!(data.heading, "Edit event");
    assert_eq!(
        data.draft.as_ref().expect("draft").guest_ids,
        std::slice::from_ref(&maya)
    );
    assert_eq!(
        labels(&data.reminders),
        [
            "No reminder",
            "At the start",
            "10 minutes before",
            "30 minutes before",
            "45 minutes before",
            "1 hour before",
            "1 day before"
        ]
    );
    assert_eq!(data.reminder_label, "45 minutes before");
    assert!(!data.can_save, "nothing changed");
    assert_eq!(data.blocked_reason, "");
    assert!(!data.show_skip);
    assert_eq!(data.foot_note, "");
    assert!(data.kinds.is_empty(), "an edit has no switch");

    world.title(page, "Design review");
    world.send_editor(page, notes("  "));
    world.send_editor(page, link(""));
    world.send_editor(page, guest(&jake));
    assert!(world.editor_data(page).dirty);
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    let row = world.event_row(&id).expect("event");
    assert_eq!(row.summary.as_deref(), Some("Design review"));
    assert_eq!(row.description, None, "an emptied note is cleared");
    assert_eq!(row.conferencing_uri, None, "an emptied link is cleared");
    assert_eq!(
        row.reminders
            .iter()
            .map(|r| r.minutes_before)
            .collect::<Vec<_>>(),
        [45],
        "untouched"
    );
    assert_eq!(
        (row.local_start.as_str(), row.local_end.as_str()),
        ("2099-06-15T14:00", "2099-06-15T15:00")
    );
    let mut guests: Vec<String> = row.attendees.iter().map(|a| a.party_id.clone()).collect();
    guests.sort();
    let mut expected = vec![me.clone(), maya.clone(), jake.clone()];
    expected.sort();
    assert_eq!(guests, expected, "the owner stays on their own invitation");
    assert!(keychain_ops(&world).is_empty(), "an edit remembers no kind");

    // A new time is the wall clock with the zone it was picked in.
    let page = world.open_edit(&id, &id, None, "2099-06-15");
    world.send_editor(page, start("2099-06-15", "16:00"));
    world.save(page);
    let row = world.event_row(&id).expect("event");
    assert_eq!(
        (row.local_start.as_str(), row.local_end.as_str()),
        ("2099-06-15T16:00", "2099-06-15T17:00")
    );
    assert_eq!(row.dtstart, "2099-06-15T15:00:00.000Z");
}

#[test]
fn leaving_with_changes_asks_and_only_discard_leaves() {
    let mut world = World::new();
    let page = world.open_new("2099-06-15", Kind::Event);
    world.title(page, "Lunch");
    world.send_editor(page, leave());
    let state = world.editor_state(page);
    assert!(!state.dismissed);
    let confirm = state.confirm.clone().expect("a question");
    assert_eq!(confirm.title, "Discard this event?");
    assert_eq!(confirm.body, "Nothing has been saved.");
    assert_eq!(confirm.confirm_label, "Discard");
    assert!(confirm.destructive);
    world.send_editor(
        page,
        K::ConfirmDismissed(wire::agenda_editor_event::ConfirmDismissed {}),
    );
    let state = world.editor_state(page);
    assert!(state.confirm.is_none() && !state.dismissed);
    assert_eq!(world.draft(page).title, "Lunch");
    world.send_editor(page, leave());
    world.send_editor(page, confirmed());
    assert!(world.editor_state(page).dismissed);
    // Nothing was filed.
    assert!(
        world
            .window("2099-06-15T00:00:00Z", "2099-06-16T00:00:00Z")
            .is_empty()
    );

    // An edit asks in its own words.
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let edit = world.open_edit(&id, &id, None, "2099-06-15");
    world.title(edit, "Changed");
    world.send_editor(edit, leave());
    assert_eq!(
        world
            .editor_state(edit)
            .confirm
            .as_ref()
            .expect("question")
            .title,
        "Discard your changes?"
    );
    // Leaving the view writes nothing: Save is the only write.
    assert_eq!(
        world.event_row(&id).expect("event").summary.as_deref(),
        Some("Review")
    );
}

#[test]
fn a_series_occurrence_asks_which_occurrences_and_each_scope_writes_its_command() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    let key = format!("{series}:2099-06-16T10:00:00");
    let open = |world: &mut World| {
        world.open_edit(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16")
    };

    let page = open(&mut world);
    let data = world.editor_data(page);
    assert!(data.show_skip);
    assert_eq!(data.skip_label, "Skip this one");
    assert_eq!(
        data.repeat_note,
        "A repeat rule belongs to the whole series."
    );
    assert_eq!(data.draft.as_ref().expect("draft").repeat_key, "custom");
    let rule = world
        .event_row(&series)
        .expect("event")
        .rrule
        .expect("a rule");
    let summary =
        centraid_screens::kit::schedule::rule_words::of_rule(Locale::En, &rule).expect("a summary");
    assert_eq!(
        data.repeats.last().expect("custom last").label,
        summary,
        "a rule as stored says what the one summariser says"
    );

    world.title(page, "Daily sync");
    world.save(page);
    let state = world.editor_state(page);
    assert_eq!(state.sheet, Sheet::Scope as i32);
    let data = world.editor_data(page);
    assert!(data.scopes.iter().all(|s| !s.selected));
    assert!(!data.scope_armed);
    // NOTHING PICKED, NOTHING WRITTEN.
    world.save(page);
    assert!(!world.editor_state(page).dismissed);

    world.send_editor(page, scope(Scope::Occurrence));
    assert!(world.editor_data(page).scope_armed);
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    let titles: Vec<(String, String)> = world
        .window("2099-06-15T00:00:00Z", "2099-06-18T00:00:00Z")
        .into_iter()
        .filter(|e| e.event_id == series)
        .map(|e| (e.local_start, e.summary.unwrap_or_default()))
        .collect();
    assert_eq!(
        titles,
        [
            ("2099-06-15T10:00".to_owned(), "Stand-up".to_owned()),
            ("2099-06-16T10:00".to_owned(), "Daily sync".to_owned()),
            ("2099-06-17T10:00".to_owned(), "Stand-up".to_owned()),
        ],
        "only that day was renamed"
    );

    // THE WHOLE SERIES is the series' own edit.
    let page = open(&mut world);
    world.title(page, "Sync");
    world.save(page);
    world.send_editor(page, scope(Scope::Series));
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    assert_eq!(
        world.event_row(&series).expect("event").summary.as_deref(),
        Some("Sync")
    );

    // A NEW RULE is the whole series' alone.
    let page = open(&mut world);
    world.send_editor(page, repeat("daily"));
    world.save(page);
    let scopes: Vec<(i32, bool)> = world
        .editor_data(page)
        .scopes
        .iter()
        .map(|s| (s.scope, s.enabled))
        .collect();
    assert_eq!(
        scopes,
        [
            (Scope::Occurrence as i32, false),
            (Scope::Future as i32, false),
            (Scope::Series as i32, true)
        ]
    );
    assert_eq!(
        world.editor_data(page).scopes[0].note,
        "A new repeat rule reaches the whole series."
    );
    world.send_editor(page, scope(Scope::Occurrence));
    assert!(
        !world.editor_data(page).scope_armed,
        "a disabled scope cannot be picked"
    );

    // A GUEST, A REMINDER, A LINK OR A CALENDAR belongs to the whole series too.
    let page = open(&mut world);
    world.send_editor(page, reminder("10"));
    world.save(page);
    let data = world.editor_data(page);
    assert!(!data.scopes[0].enabled);
    assert_eq!(
        data.scopes[0].note,
        "Guests, reminders, the link and the calendar belong to the whole series."
    );

    // MOVING THE SERIES from a later occurrence is not offered.
    let page = open(&mut world);
    world.send_editor(page, start("2099-06-16", "11:00"));
    world.save(page);
    let series_row = world
        .editor_data(page)
        .scopes
        .iter()
        .find(|s| s.scope == Scope::Series as i32)
        .cloned()
        .expect("row");
    assert!(!series_row.enabled);
    assert_eq!(
        series_row.note,
        "To move every event in the series, edit the first one."
    );
}

#[test]
fn this_and_the_ones_after_overrides_from_that_day_on() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    let key = format!("{series}:2099-06-17T10:00:00");
    let page = world.open_edit(&series, &key, Some("2099-06-17T10:00:00"), "2099-06-17");
    world.title(page, "Late sync");
    world.save(page);
    world.send_editor(page, scope(Scope::Future));
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    let titles: Vec<String> = world
        .window("2099-06-15T00:00:00Z", "2099-06-19T00:00:00Z")
        .into_iter()
        .filter(|e| e.event_id == series)
        .map(|e| e.summary.unwrap_or_default())
        .collect();
    assert_eq!(titles, ["Stand-up", "Stand-up", "Late sync", "Late sync"]);
}

#[test]
fn skip_asks_then_skips_the_occurrence_and_a_one_off_has_no_skip() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    let key = format!("{series}:2099-06-16T10:00:00");
    let page = world.open_edit(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16");
    world.send_editor(page, skip());
    let state = world.editor_state(page);
    assert_eq!(
        state.confirm.as_ref().expect("question").title,
        "Skip this one?"
    );
    // Not now: nothing is written.
    world.send_editor(
        page,
        K::ConfirmDismissed(wire::agenda_editor_event::ConfirmDismissed {}),
    );
    assert_eq!(
        world
            .window("2099-06-15T00:00:00Z", "2099-06-18T00:00:00Z")
            .len(),
        3
    );
    world.send_editor(page, skip());
    world.send_editor(page, confirmed());
    assert!(world.editor_state(page).dismissed);
    let days: Vec<String> = world
        .window("2099-06-15T00:00:00Z", "2099-06-18T00:00:00Z")
        .into_iter()
        .map(|e| e.local_start)
        .collect();
    assert_eq!(days, ["2099-06-15T10:00", "2099-06-17T10:00"]);

    let one_off = world.propose("A", "2099-06-22T14:00:00", "2099-06-22T15:00:00", |_| {});
    let page = world.open_edit(&one_off, &one_off, None, "2099-06-22");
    world.send_editor(page, skip());
    assert!(world.editor_state(page).confirm.is_none());
}

#[test]
fn a_change_elsewhere_re_reads_and_never_overwrites_the_draft_and_a_search_hit_edits_the_series() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    // A SEARCH HIT IS THE SERIES: its instance key is its event id, which no window lists.
    let page = world.open_edit(&series, &series, None, "");
    let data = world.editor_data(page);
    assert_eq!(data.draft.as_ref().expect("draft").title, "Stand-up");
    assert_eq!(data.draft.as_ref().expect("draft").repeat_key, "custom");
    assert!(!data.show_skip, "the series row has no occurrence to skip");
    world.title(page, "Mine");
    world.act(act::calendar::EditEvent {
        event_id: series.clone(),
        title: Some("Theirs".to_owned()),
        ..Default::default()
    });
    world.driver.pump(Duration::from_millis(300));
    assert_eq!(
        world.draft(page).title,
        "Mine",
        "what the member is typing stands"
    );
    // The save names the revision the draft was read at, and the event has moved on: refused,
    // the other surface's title stands and the member's is kept as an earlier version.
    world.save(page);
    assert!(!world.editor_state(page).dismissed);
    assert_eq!(
        world.event_row(&series).expect("event").summary.as_deref(),
        Some("Theirs")
    );
    assert_eq!(world.draft(page).title, "Theirs");
    assert_eq!(
        world
            .editor_state(page)
            .status
            .as_ref()
            .expect("a line")
            .sentence,
        "This event changed somewhere else. Your text is in Earlier versions."
    );
}

#[test]
fn the_add_sheet_is_for_events_with_no_switch_and_an_edit_has_none() {
    let mut world = World::new();
    let page = world.open_new("2099-06-17", Kind::Event);
    let state = world.editor_state(page);
    assert_eq!(state.kind, Kind::Event as i32);
    let data = world.editor_data(page);
    // Calendar adds events only: no Event | Task switch is offered (round 10).
    assert!(data.kinds.is_empty());
    assert!(data.show_event_fields);
    assert!(
        world.driver.effects.is_empty(),
        "a route asks no one what kind it is"
    );

    // AN EDIT IS AN EVENT and says nothing of kinds; a stray pick changes nothing.
    let id = world.propose(
        "Dentist",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let edit = world.open_edit(&id, &id, None, "2099-06-15");
    world.send_editor(edit, kind(Kind::Task));
    assert_eq!(world.editor_state(edit).kind, Kind::Event as i32);
    assert_eq!(world.editor_data(edit).heading, "Edit event");
}

#[test]
fn an_edit_whose_event_is_gone_says_so_and_a_failed_first_read_is_a_failure() {
    let mut world = World::new();
    let page = world.open_edit("no-such-event", "no-such-event", None, "2099-06-15");
    let state = world.editor_state(page);
    assert!(state.content.is_none());
    let Some(wire::page_state::State::Failed(gone)) =
        state.page.as_ref().and_then(|page| page.state.as_ref())
    else {
        panic!("gone is a failure: {:?}", state.page)
    };
    assert_eq!(gone.sentence, "This event was removed.");
    assert!(gone.permanent, "trying again cannot bring it back");

    world.zone("Not/A_Zone");
    let failed = world.open_new("2099-06-15", Kind::Event);
    let Some(wire::page_state::State::Failed(failure)) = world
        .editor_state(failed)
        .page
        .as_ref()
        .and_then(|page| page.state.as_ref())
    else {
        panic!("{:?}", world.editor_state(failed).page)
    };
    assert_eq!(failure.sentence, "Part of this didn't arrive. Try again.");
    world.zone(calendar_support::ZONE);
    world.send_editor(
        failed,
        K::Refreshed(wire::agenda_editor_event::Refreshed {}),
    );
    assert!(world.editor_state(failed).content.is_some());
    assert_eq!(world.editor_data(failed).heading, "New event");
}

#[test]
fn a_calendar_pick_closes_its_sheet_and_unknown_picks_are_ignored() {
    let mut world = World::new();
    let page = world.open_new("2099-06-15", Kind::Event);
    world.send_editor(page, sheet(Sheet::Calendar));
    assert_eq!(world.editor_state(page).sheet, Sheet::Calendar as i32);
    let calendars = world.calendar_names();
    world.send_editor(page, calendar(&calendars[0].0));
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    let before = world.draft(page).clone();
    world.send_editor(page, calendar("not-a-calendar"));
    world.send_editor(page, repeat("hourly"));
    world.send_editor(page, reminder("999999"));
    world.send_editor(page, guest("not-a-person"));
    assert_eq!(*world.draft(page), before);
    // The scope sheet is not the member's to open.
    world.send_editor(page, sheet(Sheet::Scope));
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    let hues: Vec<&str> = world
        .editor_data(page)
        .calendars
        .iter()
        .map(|c| c.hue_key.as_str())
        .collect();
    // Every calendar reads from the list palette, the one the More sheet and the grid share.
    assert!(hues.iter().all(|hue| hue.starts_with("list")), "{hues:?}");
}

// ---- AGENDA WAVE 2 (#1173): the event editor's place, second alert,
// availability, zone and travel, and a task's address. ----

fn second_reminder(key: &str) -> K {
    ev(
        K::SecondReminder,
        wire::agenda_editor_event::SecondReminderPicked {
            key: key.to_owned(),
        },
    )
}

fn availability(key: &str) -> K {
    ev(
        K::Availability,
        wire::agenda_editor_event::AvailabilityPicked {
            key: key.to_owned(),
        },
    )
}

fn zone(key: &str) -> K {
    ev(
        K::Zone,
        wire::agenda_editor_event::ZonePicked {
            key: key.to_owned(),
        },
    )
}

fn zone_search(text: &str) -> K {
    ev(
        K::ZoneSearch,
        wire::agenda_editor_event::ZoneSearched {
            text: text.to_owned(),
        },
    )
}

fn travel(key: &str) -> K {
    ev(
        K::Travel,
        wire::agenda_editor_event::TravelPicked {
            key: key.to_owned(),
        },
    )
}

fn place(key: &str) -> K {
    ev(
        K::Place,
        wire::agenda_editor_event::PlacePicked {
            key: key.to_owned(),
        },
    )
}

fn place_search(text: &str) -> K {
    ev(
        K::PlaceSearch,
        wire::agenda_editor_event::PlaceSearched {
            text: text.to_owned(),
        },
    )
}

fn minutes_before(event: &wire::AgendaEvent) -> Vec<i64> {
    event.reminders.iter().map(|r| r.minutes_before).collect()
}

fn made(world: &World, title: &str, day: &str) -> wire::AgendaEvent {
    let next = civil::plus_days(day, 1).expect("a day");
    world
        .window(&format!("{day}T00:00:00Z"), &format!("{next}T00:00:00Z"))
        .into_iter()
        .find(|e| e.summary.as_deref() == Some(title))
        .unwrap_or_else(|| panic!("{title} was not filed on {day}"))
}

#[test]
fn the_second_alert_waits_for_the_first_never_repeats_it_and_saves_both() {
    let mut world = World::new();
    let page = world.open_new("2099-06-15", Kind::Event);
    world.title(page, "Flight");
    let data = world.editor_data(page);
    assert!(!data.show_second_reminder);
    assert!(data.second_reminders.is_empty());
    // Nothing happens to a second alert before the first is set.
    world.send_editor(page, second_reminder("60"));
    world.send_editor(page, sheet(Sheet::SecondReminder));
    assert_eq!(world.draft(page).second_reminder_key, "none");
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);

    world.send_editor(page, reminder("1440"));
    let data = world.editor_data(page);
    assert!(data.show_second_reminder);
    assert_eq!(data.second_reminder_label, "No reminder");
    // The first one's lead is not offered again.
    assert_eq!(
        labels(&data.second_reminders),
        [
            "No reminder",
            "At the start",
            "10 minutes before",
            "30 minutes before",
            "1 hour before"
        ]
    );
    world.send_editor(page, sheet(Sheet::SecondReminder));
    assert_eq!(world.editor_state(page).sheet, Sheet::SecondReminder as i32);
    world.send_editor(page, second_reminder("1440"));
    assert_eq!(world.draft(page).second_reminder_key, "none");
    world.send_editor(page, second_reminder("60"));
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    assert_eq!(
        world.editor_data(page).second_reminder_label,
        "1 hour before"
    );

    // A first set to the second's lead takes its place and the second clears.
    world.send_editor(page, reminder("60"));
    assert_eq!(world.draft(page).second_reminder_key, "none");
    world.send_editor(page, second_reminder("10"));
    // Clearing the first clears the second.
    world.send_editor(page, reminder("none"));
    assert_eq!(world.draft(page).second_reminder_key, "none");
    assert!(!world.editor_data(page).show_second_reminder);
    world.send_editor(page, reminder("1440"));
    world.send_editor(page, second_reminder("60"));
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    assert_eq!(
        minutes_before(&made(&world, "Flight", "2099-06-15")),
        [1440, 60]
    );
    // TODO(#1173 notify): `cloud/agenda-notify` consumes the second lead; this
    // editor only writes it.
}

#[test]
fn an_edit_opens_both_alerts_and_changing_only_the_second_writes_both() {
    let mut world = World::new();
    let id = world.propose("Train", "2099-06-17T09:00:00", "2099-06-17T10:00:00", |p| {
        p.reminders = Field::Is("[30,10]".to_owned());
    });
    let page = world.open_edit(&id, "", None, "2099-06-17");
    let draft = world.draft(page).clone();
    assert_eq!(
        (
            draft.reminder_key.as_str(),
            draft.second_reminder_key.as_str()
        ),
        ("30", "10")
    );
    assert!(!world.editor_data(page).dirty);
    world.send_editor(page, second_reminder("1440"));
    assert!(world.editor_data(page).dirty);
    world.save(page);
    assert_eq!(
        minutes_before(&world.event_row(&id).expect("event")),
        // Longest lead first, whichever slot the member typed it in (#1191).
        [1440, 30]
    );
}

#[test]
fn availability_is_busy_until_set_free_and_a_free_event_blocks_nothing() {
    let mut world = World::new();
    world.propose(
        "Busy block",
        "2099-06-17T09:00:00",
        "2099-06-17T10:00:00",
        |_| {},
    );
    let page = world.open_new("2099-06-17", Kind::Event);
    world.title(page, "Second thing");
    world.send_editor(page, start("2099-06-17", "09:00"));
    let data = world.editor_data(page);
    assert_eq!(data.availability_label, "Busy");
    assert_eq!(labels(&data.availabilities), ["Busy", "Free"]);
    assert!(!world.draft(page).free);
    // Busy lands on a busy event: the vault says no, in its own sentence.
    world.save(page);
    assert!(!world.editor_state(page).dismissed);
    assert!(world.editor_state(page).status.is_some());

    world.send_editor(page, sheet(Sheet::Availability));
    assert_eq!(world.editor_state(page).sheet, Sheet::Availability as i32);
    world.send_editor(page, availability("free"));
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    assert_eq!(world.editor_data(page).availability_label, "Free");
    assert!(world.draft(page).free);
    world.send_editor(page, availability("tentative"));
    assert!(world.draft(page).free);
    world.save(page);
    assert!(
        world.editor_state(page).dismissed,
        "{:?}",
        world.editor_state(page).status
    );
    made(&world, "Second thing", "2099-06-17");
}

#[test]
fn an_edit_flips_availability_with_busy_on_the_command() {
    let mut world = World::new();
    let id = world.propose(
        "Block",
        "2099-06-17T09:00:00",
        "2099-06-17T10:00:00",
        |_| {},
    );
    let page = world.open_edit(&id, "", None, "2099-06-17");
    world.send_editor(page, availability("free"));
    assert!(world.editor_data(page).dirty);
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    // Now free: a busy event at the same time is accepted.
    world.propose(
        "Overlap",
        "2099-06-17T09:00:00",
        "2099-06-17T10:00:00",
        |_| {},
    );
}

#[test]
fn a_timed_event_has_a_zone_the_phones_by_default_and_all_day_has_none() {
    let mut world = World::new();
    let page = world.open_new("2099-06-17", Kind::Event);
    world.title(page, "Call");
    let data = world.editor_data(page);
    assert!(data.show_zone);
    assert_eq!(world.draft(page).zone, "Europe/London");
    assert_eq!(data.zone_label, "London, Europe");
    // The list is drawn with its sheet and narrows by search, in any case.
    assert!(data.zones.is_empty());
    world.send_editor(page, sheet(Sheet::Zone));
    let data = world.editor_data(page);
    assert!(data.zones.len() > 60);
    assert!(
        data.zones
            .iter()
            .any(|z| z.key == "Europe/London" && z.selected)
    );
    world.send_editor(page, zone_search("  TOKYO "));
    let data = world.editor_data(page);
    assert_eq!(data.zone_query, "  TOKYO ");
    assert_eq!(
        data.zones
            .iter()
            .map(|z| z.key.as_str())
            .collect::<Vec<_>>(),
        ["Asia/Tokyo"]
    );
    world.send_editor(page, zone_search("america/new"));
    assert_eq!(world.editor_data(page).zones[0].key, "America/New_York");
    world.send_editor(page, zone_search("zzzz"));
    assert!(world.editor_data(page).zones.is_empty());
    // An id not in the list is ignored.
    world.send_editor(page, zone("Mars/Olympus"));
    assert_eq!(world.draft(page).zone, "Europe/London");
    world.send_editor(page, zone("Asia/Tokyo"));
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    assert_eq!(world.editor_data(page).zone_query, "");
    assert_eq!(world.draft(page).zone, "Asia/Tokyo");
    assert_eq!(world.editor_data(page).zone_label, "Tokyo, Asia");

    // 10:00 in Tokyo in June is 01:00Z: the zone keeps the wall clock.
    world.send_editor(page, start("2099-06-17", "10:00"));
    world.save(page);
    assert!(
        world.editor_state(page).dismissed,
        "{:?}",
        world.editor_state(page).status
    );
    let event = world
        .window("2099-06-17T00:00:00Z", "2099-06-18T00:00:00Z")
        .into_iter()
        .find(|e| e.summary.as_deref() == Some("Call"))
        .expect("filed");
    assert_eq!(event.dtstart, "2099-06-17T01:00:00.000Z");
    assert_eq!(event.start_tz.as_deref(), Some("Asia/Tokyo"));

    // ALL DAY HAS NO ZONE ROW and no zone sheet.
    let day = world.open_new("2099-06-18", Kind::Event);
    world.send_editor(day, all_day(true));
    assert!(!world.editor_data(day).show_zone);
    world.send_editor(day, sheet(Sheet::Zone));
    assert_eq!(world.editor_state(day).sheet, Sheet::None as i32);
    world.send_editor(day, all_day(false));
    assert!(world.editor_data(day).show_zone);
    assert_eq!(world.draft(day).zone, "Europe/London");
}

#[test]
fn the_alert_row_says_so_when_the_event_is_all_day_and_a_timed_one_has_no_such_sentence() {
    let mut world = World::new();
    let page = world.open_new("2099-06-18", Kind::Event);
    // A TIMED EVENT: the alert control is as it always was.
    assert_eq!(world.editor_data(page).reminder_note, "");
    // ALL DAY HAS NO MOMENT: the alert sounds at 09:00 that day, and the row says so.
    world.send_editor(page, all_day(true));
    let data = world.editor_data(page);
    assert_eq!(
        data.reminder_note,
        "An alert for an all-day event sounds at 09:00 that day."
    );
    let keys: Vec<_> = data.reminders.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(keys, ["No reminder", "On the day, 09:00"], "{keys:?}");
    assert!(!data.show_second_reminder);
    world.send_editor(page, all_day(false));
    assert_eq!(world.editor_data(page).reminder_note, "");
}

#[test]
fn an_event_in_another_zone_opens_in_its_own_wall_clock_and_a_zone_change_edits_it() {
    let mut world = World::new();
    let id = world.propose(
        "Standup",
        "2099-06-17T10:00:00",
        "2099-06-17T11:00:00",
        |p| {
            p.zone = Field::Is("Asia/Tokyo".to_owned());
        },
    );
    // London reads it at 02:00; the editor reads it at 10:00, in Tokyo.
    let page = world.open_edit(&id, "", None, "2099-06-17");
    let draft = world.draft(page).clone();
    assert_eq!(
        (
            draft.zone.as_str(),
            draft.start_time.as_str(),
            draft.end_time.as_str()
        ),
        ("Asia/Tokyo", "10:00", "11:00")
    );
    assert!(!world.editor_data(page).dirty);
    world.send_editor(page, zone("America/New_York"));
    assert!(world.editor_data(page).dirty);
    world.save(page);
    assert!(
        world.editor_state(page).dismissed,
        "{:?}",
        world.editor_state(page).status
    );
    let row = world.event_row(&id).expect("event");
    assert_eq!(row.start_tz.as_deref(), Some("America/New_York"));
    // 10:00 in New York in June is 14:00Z.
    assert_eq!(row.dtstart, "2099-06-17T14:00:00.000Z");
}

#[test]
fn a_floating_event_has_no_zone_and_keeps_none_unless_one_is_picked() {
    let mut world = World::new();
    let id = world.propose("Lunch", "2099-06-17T12:00:00", "2099-06-17T13:00:00", |p| {
        p.timing = Some(act::calendar::ProposeTiming::Floating);
        p.zone = Field::Keep;
    });
    let page = world.open_edit(&id, "", None, "2099-06-17");
    assert_eq!(world.draft(page).zone, "");
    assert_eq!(world.editor_data(page).zone_label, "No time zone");
    world.send_editor(page, sheet(Sheet::Zone));
    let zones = world.editor_data(page).zones.clone();
    assert_eq!(zones[0].key, "floating");
    assert!(zones[0].selected);
    // A move keeps it floating.
    world.send_editor(page, start("2099-06-17", "12:30"));
    world.save(page);
    let row = world.event_row(&id).expect("event");
    assert_eq!(row.recurrence_semantics.as_deref(), Some("floating"));
    assert_eq!(row.local_start, "2099-06-17T12:30");
}

#[test]
fn travel_time_is_none_until_chosen_from_the_offered_lengths() {
    let mut world = World::new();
    let page = world.open_new("2099-06-17", Kind::Event);
    world.title(page, "Dentist");
    let data = world.editor_data(page);
    assert_eq!(data.travel_label, "None");
    assert_eq!(
        labels(&data.travels),
        [
            "None",
            "5 minutes",
            "15 minutes",
            "30 minutes",
            "1 hour",
            "1 hour 30 minutes",
            "2 hours"
        ]
    );
    world.send_editor(page, sheet(Sheet::Travel));
    assert_eq!(world.editor_state(page).sheet, Sheet::Travel as i32);
    world.send_editor(page, travel("45"));
    assert_eq!(world.draft(page).travel_min, 0);
    world.send_editor(page, travel("30"));
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    assert_eq!(world.draft(page).travel_min, 30);
    assert_eq!(world.editor_data(page).travel_label, "30 minutes");
    assert!(world.editor_data(page).dirty);
}

fn the_places(world: &World) -> Vec<(String, String)> {
    let wire::app_query_response::Answer::PhotosPlaces(places) =
        world.load(centraid_screens::catalog::load::photos::Places::default())
    else {
        panic!("places answered something else");
    };
    places
        .places
        .into_iter()
        .filter_map(|card| {
            Some((
                card.place?.place_id,
                card.name.filter(|n| !n.trim().is_empty())?,
            ))
        })
        .collect()
}

/// A place the member named, founded through `add-place`: its id.
fn found_place(world: &mut World, title: &str) -> String {
    let done = world.act(act::calendar::AddPlace {
        title: title.to_owned(),
        ..Default::default()
    });
    let output: serde_json::Value = serde_json::from_slice(&done.output).expect("json output");
    output["id"].as_str().expect("the id").to_owned()
}

/// The ids of the example vault's places the member never named (a photograph's bare spot).
fn unnamed_places(world: &World) -> Vec<String> {
    let wire::app_query_response::Answer::PhotosPlaces(places) =
        world.load(centraid_screens::catalog::load::photos::Places::default())
    else {
        panic!("places answered something else");
    };
    places
        .places
        .into_iter()
        .filter(|card| card.name.as_deref().is_none_or(|n| n.trim().is_empty()))
        .filter_map(|card| card.place.map(|place| place.place_id))
        .collect()
}

#[test]
fn a_location_sheet_offers_only_places_the_member_named() {
    let mut world = World::new();
    let unnamed = unnamed_places(&world);
    assert!(
        !unnamed.is_empty(),
        "the example vault has photograph spots with no name"
    );
    let page = world.open_new("2099-06-17", Kind::Event);
    world.title(page, "Dinner");
    world.send_editor(page, sheet(Sheet::Location));
    // No place is named yet: the sheet is the search and nothing else; typing offers the words.
    assert!(world.editor_data(page).places.is_empty());
    world.send_editor(page, place_search("Harbour Cafe"));
    let typed = world.editor_data(page).places.clone();
    assert_eq!(typed.len(), 1, "{typed:?}");
    assert_eq!(typed[0].label, "Use “Harbour Cafe”");

    // A named place is offered, and no photograph spot is, whatever the phrase it has.
    let named = found_place(&mut world, "Harbour Cafe");
    let page = world.open_new("2099-06-18", Kind::Event);
    world.send_editor(page, sheet(Sheet::Location));
    let listed = world.editor_data(page).places.clone();
    assert_eq!(listed.len(), 1, "{listed:?}");
    assert_eq!(
        (listed[0].key.as_str(), listed[0].label.as_str()),
        (named.as_str(), "Harbour Cafe")
    );
    assert!(listed.iter().all(|c| !unnamed.contains(&c.key)));
    assert!(listed.iter().all(|c| c.label != "A place with no name yet"));
}

#[test]
fn an_event_already_at_an_unnamed_place_still_shows_it_chosen() {
    let mut world = World::new();
    let spot = unnamed_places(&world).remove(0);
    let at = world.propose(
        "Picnic",
        "2099-06-15T12:00:00",
        "2099-06-15T13:00:00",
        |p| p.place_id = Field::Is(spot.clone()),
    );
    let page = world.open_edit(&at, &at, None, "2099-06-15");
    world.send_editor(page, sheet(Sheet::Location));
    let listed = world.editor_data(page).places.clone();
    let here = listed
        .iter()
        .find(|c| c.key == spot)
        .unwrap_or_else(|| panic!("the event's own place is listed: {listed:?}"));
    assert!(here.selected, "{listed:?}");
    assert_eq!(listed.len(), 1, "{listed:?}");
}

#[test]
fn a_location_is_picked_from_the_vaults_places_searched_and_cleared() {
    let mut world = World::new();
    for title in ["Harbour Cafe", "Aunt Lena's house"] {
        found_place(&mut world, title);
    }
    let known = the_places(&world);
    assert!(known.len() >= 2, "the example vault has places: {known:?}");
    let (first_id, first_name) = known[0].clone();
    let page = world.open_new("2099-06-17", Kind::Event);
    world.title(page, "Dinner");
    let data = world.editor_data(page);
    assert_eq!(data.location_label, "No location");
    assert!(!data.show_clear_location);
    assert!(data.places.is_empty(), "the list is drawn with its sheet");

    world.send_editor(page, sheet(Sheet::Location));
    let listed = world.editor_data(page).places.clone();
    assert_eq!(listed.len(), known.len());
    assert!(listed.iter().all(|c| !c.selected));
    // The search narrows by the place's words, in any case.
    let word = first_name
        .split_whitespace()
        .next()
        .expect("a word")
        .to_uppercase();
    world.send_editor(page, place_search(&word));
    let narrowed = world.editor_data(page).places.clone();
    assert!(
        narrowed.iter().any(|c| c.key == first_id),
        "{word}: {narrowed:?}"
    );
    // (Typed words are offered beside the matches; they are not a place of the vault.)
    assert!(
        narrowed
            .iter()
            .filter(|c| !c.key.starts_with("text:"))
            .count()
            <= listed.len()
    );
    // Words no place is called are offered as a place to use, and nothing else matches.
    world.send_editor(page, place_search("zzzzzz"));
    let offered = world.editor_data(page).places.clone();
    assert_eq!(offered.len(), 1, "{offered:?}");
    assert_eq!(offered[0].label, "Use “zzzzzz”");
    world.send_editor(page, place_search(""));

    // A place that is not the vault's is ignored; a real one is chosen.
    world.send_editor(page, place("not-a-place"));
    assert_eq!(world.draft(page).place_id, "");
    world.send_editor(page, place(&first_id));
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    assert_eq!(world.draft(page).place_id, first_id);
    let data = world.editor_data(page);
    assert_eq!(data.location_label, first_name);
    assert!(data.show_clear_location);
    world.save(page);
    assert!(
        world.editor_state(page).dismissed,
        "{:?}",
        world.editor_state(page).status
    );
    let event = made(&world, "Dinner", "2099-06-17");
    assert_eq!(event.location_place_id.as_deref(), Some(first_id.as_str()));

    // Opening it again shows the place; clearing it writes a clear.
    let edit = world.open_edit(&event.event_id, &event.instance_key, None, "2099-06-17");
    assert_eq!(world.editor_data(edit).location_label, first_name);
    assert!(!world.editor_data(edit).dirty);
    world.send_editor(
        edit,
        ev(K::PlaceCleared, wire::agenda_editor_event::PlaceCleared {}),
    );
    assert_eq!(world.draft(edit).place_id, "");
    assert!(world.editor_data(edit).dirty);
    world.save(edit);
    assert!(world.editor_state(edit).dismissed);
    assert_eq!(
        world
            .event_row(&event.event_id)
            .expect("event")
            .location_place_id,
        None
    );
}

#[test]
fn a_location_may_be_typed_and_is_founded_as_a_place_once() {
    let mut world = World::new();
    let before = the_places(&world).len();
    let page = world.open_new("2099-06-17", Kind::Event);
    world.title(page, "Coffee");
    world.send_editor(page, sheet(Sheet::Location));
    world.send_editor(page, place_search("Café Roma"));
    let offered = world.editor_data(page).places.clone();
    let row = offered
        .iter()
        .find(|c| c.label == "Use “Café Roma”")
        .unwrap_or_else(|| panic!("no row offers the typed words: {offered:?}"));
    world.send_editor(page, place(&row.key.clone()));
    // Nothing is founded by picking: the draft holds the words and no place yet.
    assert_eq!(the_places(&world).len(), before);
    assert_eq!(world.draft(page).place_id, "");
    let data = world.editor_data(page);
    assert_eq!(data.location_label, "Café Roma");
    assert!(data.show_clear_location && data.dirty);
    // The sheet shows the typed words as the chosen place.
    world.send_editor(page, sheet(Sheet::Location));
    let chosen = world.editor_data(page).places.clone();
    assert!(
        chosen.iter().any(|c| c.label == "Café Roma" && c.selected),
        "{chosen:?}"
    );
    world.send_editor(page, place_search(""));
    world.send_editor(page, sheet(Sheet::None));
    world.save(page);
    assert!(
        world.editor_state(page).dismissed,
        "{:?}",
        world.editor_state(page).status
    );
    let event = made(&world, "Coffee", "2099-06-17");
    let id = event.location_place_id.clone().expect("a place");
    assert_eq!(the_places(&world).len(), before + 1);
    assert!(
        the_places(&world).contains(&(id.clone(), "Café Roma".to_owned())),
        "{:?}",
        the_places(&world)
    );

    // The event page names it, and offers it to the maps app.
    let shown = world.open_event(&event.event_id, &event.instance_key, None, "2099-06-17");
    assert!(
        world
            .event_data(shown)
            .facts
            .iter()
            .any(|f| f.detail == "Café Roma")
    );

    // A page opened now lists the place by its name, so it is picked, not founded again.
    let lunch = {
        let early = world.open_new("2099-06-18", Kind::Event);
        world.title(early, "Lunch");
        world.send_editor(early, sheet(Sheet::Location));
        world.send_editor(early, place_search("café roma"));
        let listed = world.editor_data(early).places.clone();
        assert_eq!(listed.len(), 1, "{listed:?}");
        assert_eq!(listed[0].key, id, "the existing place, found by its name");
        world.send_editor(early, place(&listed[0].key.clone()));
        world.save(early);
        assert!(world.editor_state(early).dismissed);
        made(&world, "Lunch", "2099-06-18")
    };
    assert_eq!(lunch.location_place_id.as_deref(), Some(id.as_str()));
    assert_eq!(the_places(&world).len(), before + 1);
}

#[test]
fn typed_words_that_became_a_place_meanwhile_are_that_place() {
    let mut world = World::new();
    let before = the_places(&world).len();
    // Two pages are open before either saves; each types the same words.
    let first = world.open_new("2099-06-17", Kind::Event);
    let second = world.open_new("2099-06-18", Kind::Event);
    for (page, title) in [(first, "Coffee"), (second, "Lunch")] {
        world.title(page, title);
        world.send_editor(page, sheet(Sheet::Location));
        world.send_editor(page, place_search("Café Roma"));
        let typed = world
            .editor_data(page)
            .places
            .last()
            .expect("the typed words are offered")
            .key
            .clone();
        world.send_editor(page, place(&typed));
    }
    world.save(first);
    world.save(second);
    assert!(world.editor_state(first).dismissed && world.editor_state(second).dismissed);
    assert_eq!(the_places(&world).len(), before + 1, "one place, not two");
    let coffee = made(&world, "Coffee", "2099-06-17");
    let lunch = made(&world, "Lunch", "2099-06-18");
    assert!(coffee.location_place_id.is_some());
    assert_eq!(coffee.location_place_id, lunch.location_place_id);
}

// ---- THE WRITES CARRY THE FIELDS: the act payloads the editor builds. ----

use centraid_screens::calendar::editor::write;
use centraid_screens::reminders::ops::{NewTask, add_request};

fn timed_draft() -> wire::AgendaDraft {
    wire::AgendaDraft {
        title: "Review".into(),
        all_day: false,
        start_day: "2099-06-17".into(),
        start_time: "10:00".into(),
        end_day: "2099-06-17".into(),
        end_time: "11:00".into(),
        calendar_id: "cal".into(),
        repeat_key: "none".into(),
        reminder_key: "none".into(),
        second_reminder_key: "none".into(),
        zone: "Europe/London".into(),
        ..Default::default()
    }
}

fn text_of(request: &wire::ActRequest, name: &str) -> Option<String> {
    match request.input.get(name)?.kind.as_ref()? {
        wire::value::Kind::Text(text) => Some(text.clone()),
        wire::value::Kind::Integer(n) => Some(n.to_string()),
        wire::value::Kind::Null(_) => Some("null".to_owned()),
        other => panic!("{name}: {other:?}"),
    }
}

#[test]
fn a_new_event_write_carries_place_both_alerts_availability_zone_travel_and_rule() {
    let plain = write::propose(&timed_draft()).request();
    assert_eq!(plain.action, "propose");
    // Nothing the member left alone is sent.
    for absent in ["place_id", "reminders", "busy", "travel_min", "rule", "url"] {
        assert!(!plain.input.contains_key(absent), "{absent}");
    }
    assert_eq!(text_of(&plain, "zone").as_deref(), Some("Europe/London"));
    assert!(!plain.input.contains_key("timing"));

    let full = write::propose(&wire::AgendaDraft {
        place_id: "place-1".into(),
        reminder_key: "30".into(),
        second_reminder_key: "1440".into(),
        free: true,
        zone: "Asia/Tokyo".into(),
        travel_min: 90,
        repeat_key: "custom".into(),
        repeat_rule: "FREQ=WEEKLY;BYDAY=MO,WE".into(),
        ..timed_draft()
    })
    .request();
    assert_eq!(text_of(&full, "place_id").as_deref(), Some("place-1"));
    assert_eq!(text_of(&full, "reminders").as_deref(), Some("[30,1440]"));
    assert_eq!(text_of(&full, "busy").as_deref(), Some("0"));
    assert_eq!(text_of(&full, "zone").as_deref(), Some("Asia/Tokyo"));
    assert_eq!(text_of(&full, "travel_min").as_deref(), Some("90"));
    assert_eq!(
        text_of(&full, "rule").as_deref(),
        Some("FREQ=WEEKLY;BYDAY=MO,WE")
    );

    // A second alert alone, or the same lead twice, is only the first.
    let twice = write::propose(&wire::AgendaDraft {
        reminder_key: "30".into(),
        second_reminder_key: "30".into(),
        ..timed_draft()
    })
    .request();
    assert_eq!(text_of(&twice, "reminders").as_deref(), Some("[30]"));
    let orphan = write::propose(&wire::AgendaDraft {
        second_reminder_key: "30".into(),
        ..timed_draft()
    })
    .request();
    assert!(!orphan.input.contains_key("reminders"));

    // A floating event is a wall clock with no zone; all-day has no zone at all.
    let floating = write::propose(&wire::AgendaDraft {
        zone: String::new(),
        ..timed_draft()
    })
    .request();
    assert_eq!(text_of(&floating, "timing").as_deref(), Some("floating"));
    assert!(!floating.input.contains_key("zone"));
    let all_day = write::propose(&wire::AgendaDraft {
        all_day: true,
        ..timed_draft()
    })
    .request();
    assert_eq!(text_of(&all_day, "timing").as_deref(), Some("all-day"));
    assert!(!all_day.input.contains_key("zone"));
}

#[test]
fn an_edit_write_carries_only_the_changed_fields_and_spells_a_clear_as_null() {
    let base = wire::AgendaDraft {
        place_id: "place-1".into(),
        reminder_key: "30".into(),
        second_reminder_key: "10".into(),
        travel_min: 30,
        repeat_key: "weekly".into(),
        ..timed_draft()
    };
    let unchanged = write::edit_event("ev", &base, &base, &[]).request();
    assert_eq!(unchanged.input.len(), 1, "{:?}", unchanged.input.keys());

    let cleared = write::edit_event(
        "ev",
        &wire::AgendaDraft {
            place_id: String::new(),
            second_reminder_key: "none".into(),
            travel_min: 0,
            free: true,
            repeat_key: "none".into(),
            ..base.clone()
        },
        &base,
        &[],
    )
    .request();
    assert_eq!(text_of(&cleared, "place_id").as_deref(), Some("null"));
    assert_eq!(text_of(&cleared, "travel_min").as_deref(), Some("null"));
    assert_eq!(text_of(&cleared, "reminders").as_deref(), Some("[30]"));
    assert_eq!(text_of(&cleared, "busy").as_deref(), Some("0"));
    assert_eq!(text_of(&cleared, "rule").as_deref(), Some("null"));
    assert!(!cleared.input.contains_key("zone"));

    // A new zone moves the wall clock into it.
    let moved = write::edit_event(
        "ev",
        &wire::AgendaDraft {
            zone: "America/New_York".into(),
            ..base.clone()
        },
        &base,
        &[],
    )
    .request();
    assert_eq!(text_of(&moved, "zone").as_deref(), Some("America/New_York"));
    assert_eq!(
        text_of(&moved, "starts").as_deref(),
        Some("2099-06-17T10:00:00")
    );
    // A custom rule is written as the draft holds it; the same rule is no change.
    let custom = wire::AgendaDraft {
        repeat_key: "custom".into(),
        repeat_rule: "FREQ=MONTHLY;BYDAY=2MO".into(),
        ..base.clone()
    };
    let changed = write::edit_event("ev", &custom, &base, &[]).request();
    assert_eq!(
        text_of(&changed, "rule").as_deref(),
        Some("FREQ=MONTHLY;BYDAY=2MO")
    );
    let same = write::edit_event("ev", &custom, &custom, &[]).request();
    assert!(!same.input.contains_key("rule"));
}

#[test]
fn a_new_task_write_carries_its_address_and_rule() {
    let rule = "FREQ=DAILY;INTERVAL=2".to_owned();
    let request = add_request(&NewTask {
        title: "Read",
        due: "2099-06-17",
        rule: Some(&rule),
        url: Some("https://example.com/a"),
        ..NewTask::default()
    })
    .request();
    assert_eq!(request.action, "add-task");
    assert_eq!(
        text_of(&request, "url").as_deref(),
        Some("https://example.com/a")
    );
    assert_eq!(text_of(&request, "rule").as_deref(), Some(rule.as_str()));
    let none = add_request(&NewTask {
        title: "Read",
        ..NewTask::default()
    })
    .request();
    assert!(!none.input.contains_key("url"));
}

/// AN EXISTING EVENT OPENS AS IT WAS SAVED (#1173): free, and its travel time, from the read, so a
/// Save that touches neither writes neither; and choosing "None" for travel writes the column null.
#[test]
fn an_event_opens_with_its_stored_availability_and_travel_and_none_clears_travel() {
    let mut world = World::new();
    let id = world.propose(
        "Dinner out",
        "2099-06-17T19:00:00",
        "2099-06-17T20:00:00",
        |p| {
            p.busy = Some(false);
            p.travel_min = Field::Is(45);
        },
    );
    let stored = world.event_row(&id).expect("event");
    assert!(!stored.busy);
    assert_eq!(stored.travel_min, Some(45));

    let page = world.open_edit(&id, "", None, "2099-06-17");
    assert!(world.draft(page).free, "it opens free, as it was saved");
    assert_eq!(world.draft(page).travel_min, 45);
    let data = world.editor_data(page);
    assert_eq!(data.availability_label, "Free");
    assert_eq!(data.travel_label, "45 minutes");
    assert!(
        data.travels.iter().any(|t| t.key == "45" && t.selected),
        "a stored length is offered and picked"
    );
    assert!(!data.dirty, "opening an event is no change");

    world.send_editor(page, travel("0"));
    assert!(world.editor_data(page).dirty);
    world.save(page);
    assert!(
        world.editor_state(page).dismissed,
        "{:?}",
        world.editor_state(page).status
    );
    let saved = world.event_row(&id).expect("event");
    assert_eq!(saved.travel_min, None, "None writes null, not zero");
    assert!(!saved.busy, "the availability it did not touch stands");
}

/// An event that is busy opens busy and with no travel, and a Save that changes only its title
/// leaves both alone.
#[test]
fn a_busy_event_with_no_travel_opens_as_the_defaults_and_a_title_edit_keeps_them() {
    let mut world = World::new();
    let id = world.propose(
        "Standup",
        "2099-06-18T09:00:00",
        "2099-06-18T09:15:00",
        |_| {},
    );
    let page = world.open_edit(&id, "", None, "2099-06-18");
    assert!(!world.draft(page).free);
    assert_eq!(world.draft(page).travel_min, 0);
    world.title(page, "Daily standup");
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    let saved = world.event_row(&id).expect("event");
    assert_eq!(saved.summary.as_deref(), Some("Daily standup"));
    assert!(saved.busy);
    assert_eq!(saved.travel_min, None);
}

#[test]
fn a_save_over_an_event_that_changed_elsewhere_is_refused_and_the_words_are_kept_as_a_version() {
    let mut world = World::new();
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |p| p.description = Field::Is("Old notes".to_owned()),
    );
    let page = world.open_edit(&id, &id, None, "2099-06-15");
    world.title(page, "My title");
    world.send_editor(page, notes("My notes"));
    // Another surface edits the event after the page read it.
    world.act(act::calendar::EditEvent {
        event_id: id.clone(),
        title: Some("Elsewhere".to_owned()),
        ..Default::default()
    });
    world.save(page);
    // Nothing of the member's overwrote the other edit, and the editor shows the event as it is.
    let row = world.event_row(&id).expect("event");
    assert_eq!(row.summary.as_deref(), Some("Elsewhere"));
    assert_eq!(row.description.as_deref(), Some("Old notes"));
    let state = world.editor_state(page);
    assert!(
        !state.dismissed,
        "the editor stays open on the vault's event"
    );
    assert_eq!(
        state.status.as_ref().expect("a line").sentence,
        "This event changed somewhere else. Your text is in Earlier versions."
    );
    assert_eq!(
        world.editor_data(page).draft.as_ref().expect("draft").title,
        "Elsewhere"
    );
    // The next save is from the new revision, and lands.
    world.title(page, "Third title");
    world.save(page);
    assert_eq!(
        world.event_row(&id).expect("event").summary.as_deref(),
        Some("Third title")
    );
}

/// What the newest earlier version of an event held: field to the value it held, as JSON.
fn newest_version(
    world: &World,
    id: &str,
) -> std::collections::BTreeMap<String, serde_json::Value> {
    let wire::app_query_response::Answer::EarlierVersions(listed) =
        world.load(centraid_screens::catalog::load::shell::EarlierVersions {
            entity_id: id.to_owned(),
        })
    else {
        panic!("earlier versions answered something else");
    };
    let newest = listed
        .versions
        .iter()
        .max_by_key(|version| version.seq)
        .expect("a version");
    newest
        .field_changes
        .iter()
        .map(|change| {
            (
                change.field.clone(),
                serde_json::from_str(&change.before_json).expect("json"),
            )
        })
        .collect()
}

#[test]
fn a_refused_save_keeps_every_field_the_member_changed_as_an_earlier_version() {
    let mut world = World::new();
    let maya = world.person("Maya Alvarez");
    let place = found_place(&mut world, "Harbour Cafe");
    let made = world.act(act::calendar::CreateCalendar {
        title: "Work".to_owned(),
        ..Default::default()
    });
    let output: serde_json::Value = serde_json::from_slice(&made.output).expect("json output");
    let other_calendar = output["id"].as_str().expect("the id").to_owned();
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |p| p.description = Field::Is("Old notes".to_owned()),
    );
    let page = world.open_edit(&id, &id, None, "2099-06-15");
    world.title(page, "My title");
    world.send_editor(page, notes("My notes"));
    world.send_editor(page, start("2099-06-16", "10:00"));
    world.send_editor(page, end("2099-06-16", "11:30"));
    world.send_editor(page, zone("Asia/Tokyo"));
    world.send_editor(page, repeat("weekly"));
    world.send_editor(page, reminder("30"));
    world.send_editor(page, link("https://example.test/room"));
    world.send_editor(page, self::place(&place));
    world.send_editor(page, availability("free"));
    world.send_editor(page, travel("30"));
    world.send_editor(page, calendar(&other_calendar));
    world.send_editor(page, guest(&maya));
    // Another surface edits the event after the page read it.
    world.act(act::calendar::EditEvent {
        event_id: id.clone(),
        title: Some("Elsewhere".to_owned()),
        ..Default::default()
    });
    world.save(page);
    assert_eq!(
        world.event_row(&id).expect("event").summary.as_deref(),
        Some("Elsewhere"),
        "nothing of the draft overwrote the other edit"
    );
    assert_eq!(
        world
            .editor_state(page)
            .status
            .as_ref()
            .expect("a line")
            .sentence,
        "This event changed somewhere else. Your text is in Earlier versions."
    );
    // EVERY FIELD THE MEMBER CHANGED is in the version kept: the words, the times as the instants
    // the vault would hold, the repeat, place, availability, travel, calendar, link, alert, guest.
    let kept = newest_version(&world, &id);
    let held = |field: &str| {
        kept.get(field)
            .unwrap_or_else(|| panic!("`{field}` kept: {kept:?}"))
    };
    assert_eq!(held("entity.title"), "My title");
    assert_eq!(held("event.description"), "My notes");
    // 10:00-11:30 on the 16th, in Tokyo.
    assert_eq!(held("event.starts"), "2099-06-16T01:00:00.000Z");
    assert_eq!(held("event.ends"), "2099-06-16T02:30:00.000Z");
    assert_eq!(held("event.zone"), "Asia/Tokyo");
    assert_eq!(held("event.rule"), "FREQ=WEEKLY");
    assert_eq!(held("event.place_id"), place.as_str());
    assert_eq!(held("event.busy"), 0);
    assert_eq!(held("event.travel_min"), 30);
    assert_eq!(held("event.calendar_id"), other_calendar.as_str());
    assert_eq!(held("event.url"), "https://example.test/room");
    assert_eq!(held("reminder[30]")["offset_min"], 30);
    assert_eq!(held(&format!("attendee[{maya}]"))["to_id"], maya.as_str());
    // The event itself stands as the other surface left it.
    let row = world.event_row(&id).expect("event");
    assert_eq!(row.summary.as_deref(), Some("Elsewhere"));
    assert_eq!(row.description.as_deref(), Some("Old notes"));
}

#[test]
fn changing_one_day_of_a_series_that_changed_elsewhere_is_refused_and_the_words_are_kept() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    let key = format!("{series}:2099-06-16T10:00:00");
    let page = world.open_edit(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16");
    world.title(page, "Daily sync");
    world.send_editor(page, notes("Bring the numbers"));
    // Another surface edits the series after the page read it.
    world.act(act::calendar::EditEvent {
        event_id: series.clone(),
        title: Some("Elsewhere".to_owned()),
        ..Default::default()
    });
    world.save(page);
    world.send_editor(page, scope(Scope::Occurrence));
    world.save(page);
    // The day was not changed; the editor stays open on the event as the vault has it.
    let state = world.editor_state(page);
    assert!(!state.dismissed);
    let status = state.status.as_ref().expect("a line");
    assert_eq!(
        status.sentence,
        "This event changed somewhere else. Your text is in Earlier versions."
    );
    assert!(status.refused);
    let titles: Vec<String> = world
        .window("2099-06-15T00:00:00Z", "2099-06-18T00:00:00Z")
        .into_iter()
        .filter(|e| e.event_id == series)
        .map(|e| e.summary.unwrap_or_default())
        .collect();
    assert_eq!(titles, ["Elsewhere", "Elsewhere", "Elsewhere"]);
    // The day's words are kept as the day's own override; the series' title is not touched.
    let kept = newest_version(&world, &series);
    let day = kept
        .get("occurrence[2099-06-16T10:00:00/occurrence]")
        .unwrap_or_else(|| panic!("the day kept: {kept:?}"));
    assert_eq!(day["title"], "Daily sync");
    assert_eq!(day["description"], "Bring the numbers");
    assert!(day["starts"].is_null() && day["ends"].is_null());
    assert!(!kept.contains_key("entity.title"));
    // The next change is from the revision just read, and lands.
    world.title(page, "Sync");
    world.save(page);
    world.send_editor(page, scope(Scope::Occurrence));
    world.save(page);
    assert!(world.editor_state(page).dismissed);
}

#[test]
fn a_refused_change_to_the_days_times_keeps_the_days_override_and_restore_puts_it_back() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    let key = format!("{series}:2099-06-16T10:00:00");
    let page = world.open_edit(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16");
    world.send_editor(page, start("2099-06-16", "15:00"));
    world.send_editor(page, end("2099-06-16", "16:00"));
    world.act(act::calendar::EditEvent {
        event_id: series.clone(),
        title: Some("Elsewhere".to_owned()),
        ..Default::default()
    });
    world.save(page);
    world.send_editor(page, scope(Scope::Occurrence));
    world.save(page);
    assert!(!world.editor_state(page).dismissed);
    let day_of = |world: &World| -> Vec<(String, String)> {
        world
            .window("2099-06-15T00:00:00Z", "2099-06-18T00:00:00Z")
            .into_iter()
            .filter(|e| e.event_id == series)
            .map(|e| (e.dtstart, e.summary.unwrap_or_default()))
            .collect()
    };
    let before = day_of(&world);
    assert!(
        before
            .iter()
            .all(|(starts, _)| !starts.contains("T15:00") && !starts.contains("T13:00")),
        "the day was not moved: {before:?}"
    );
    let kept = newest_version(&world, &series);
    let day = kept
        .get("occurrence[2099-06-16T10:00:00/occurrence]")
        .unwrap_or_else(|| panic!("the day kept: {kept:?}"));
    assert!(
        day["starts"]
            .as_str()
            .is_some_and(|s| s.starts_with("2099-06-16"))
    );
    assert!(day["ends"].as_str().is_some());
    // Restore on that version moves the day.
    let wire::app_query_response::Answer::EarlierVersions(listed) =
        world.load(centraid_screens::catalog::load::shell::EarlierVersions {
            entity_id: series.clone(),
        })
    else {
        panic!("earlier versions answered something else");
    };
    let seq = listed
        .versions
        .iter()
        .map(|v| v.seq)
        .max()
        .expect("a version");
    world.act(act::shell::RestoreVersion {
        earlier_version_id: series.clone(),
        seq,
    });
    let after = day_of(&world);
    assert_ne!(after, before, "the restored day reads at its own time");
    assert!(
        after
            .iter()
            .any(|(starts, _)| starts.contains("2099-06-16") && !starts.contains("T10:00")),
        "the 16th moved: {after:?}"
    );
}
