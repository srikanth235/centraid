//! `agenda.editor` through the door a shell uses: defaults, validation, the day
//! math, the explicit save and which command each save is, dirty leave, scope
//! and skip, and the Event | Task switch. Ports `AgendaEditorSpec`.

mod agenda_event_support;

use std::time::Duration;

use agenda_event_support::{World, asked};
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::kit::civil;
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

fn answer_kind(world: &mut World, remembered: Option<&str>) {
    world
        .driver
        .answer_effect(wire::effect_result::Outcome::Keychain(
            wire::KeychainValue {
                found: remembered.is_some(),
                value: remembered.unwrap_or_default().as_bytes().to_vec(),
            },
        ));
}

#[test]
fn a_new_event_reads_today_and_the_people_and_starts_at_the_next_half_hour_for_an_hour() {
    let mut world = World::new();
    let page = world.open_new("", Kind::Unspecified);
    // A create that names no kind asks the device what it last added.
    let ops = keychain_ops(&world);
    assert_eq!(ops.len(), 1, "{ops:?}");
    assert_eq!(
        (ops[0].0, ops[0].1.as_str()),
        (wire::keychain_op::Op::Get as i32, "agenda_add_kind")
    );
    answer_kind(&mut world, None);

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
    assert_eq!(chrome.kind_label, "What to add");

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
            "Every year on 15 June"
        ]
    );
    assert_eq!(data.reminder_label, "30 minutes before");
    assert_eq!(data.start_label, "Monday 15 June · 09:00");
    assert_eq!(data.start_day_label, "Monday 15 June");
    assert_eq!(data.start_time_label, "09:00");
    assert_eq!(data.end_time_label, "10:00");

    let update = world.save(page);
    assert!(world.editor_state(page).dismissed);
    // An event is the absence of the remembered kind.
    assert_eq!(
        asked(&update).len(),
        1,
        "one effect: the device forgets a remembered task"
    );
    let ops = keychain_ops(&world);
    assert_eq!(
        (ops[0].0, ops[0].1.as_str()),
        (wire::keychain_op::Op::Delete as i32, "agenda_add_kind")
    );

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
    // Nothing was remembered by the refused attempt; only the commit asked the keychain.
    assert_eq!(keychain_ops(&world).len(), 1);
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
    assert_eq!(data.skip_label, "Skip this occurrence");
    assert_eq!(
        data.repeat_note,
        "A repeat rule belongs to the whole series."
    );
    assert_eq!(data.draft.as_ref().expect("draft").repeat_key, "custom");
    let summary = world
        .event_row(&series)
        .expect("event")
        .recurrence_summary
        .expect("a summary");
    assert_eq!(data.repeats.last().expect("custom last").label, summary);

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
        "To move every occurrence, edit the first one."
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
        "Skip this occurrence?"
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
    world.act(act::agenda::EditEvent {
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
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    assert_eq!(
        world.event_row(&series).expect("event").summary.as_deref(),
        Some("Mine")
    );
}

#[test]
fn the_add_sheet_has_an_event_task_switch_and_an_edit_has_none() {
    let mut world = World::new();
    let page = world.open_new("2099-06-17", Kind::Event);
    let state = world.editor_state(page);
    assert_eq!(state.kind, Kind::Event as i32);
    let data = world.editor_data(page);
    let kinds: Vec<(i32, &str, bool)> = data
        .kinds
        .iter()
        .map(|k| (k.kind, k.label.as_str(), k.selected))
        .collect();
    assert_eq!(
        kinds,
        [
            (Kind::Event as i32, "Event", true),
            (Kind::Task as i32, "Task", false)
        ]
    );
    assert!(data.show_event_fields);
    assert!(
        world.driver.effects.is_empty(),
        "a route that names its kind asks no one"
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
    // ... even when the route names a task.
    let named = world.driver.push(
        "agenda",
        centraid_screens::agenda::routes::editor(&id, &id, None, "2099-06-15", Kind::Task),
    );
    assert_eq!(world.editor_state(named).kind, Kind::Event as i32);
    assert_eq!(world.editor_data(named).heading, "Edit event");
}

#[test]
fn a_sheet_opened_on_task_is_a_title_and_a_due_day_all_day_until_a_time_is_wanted() {
    let mut world = World::new();
    let page = world.open_new("2099-06-17", Kind::Task);
    let state = world.editor_state(page);
    assert_eq!(state.kind, Kind::Task as i32);
    let data = world.editor_data(page);
    assert_eq!(
        data.kinds.iter().find(|k| k.selected).expect("one").label,
        "Task"
    );
    assert_eq!(data.heading, "New task");
    assert!(!data.show_event_fields);
    assert_eq!(data.start_field_label, "Due");
    assert_eq!(data.foot_note, "");
    // THE DUE DEFAULTS TO THE DAY THE SHEET OPENED ON, a bare date.
    let draft = data.draft.clone().expect("draft");
    assert_eq!(draft.start_day, "2099-06-17");
    assert!(draft.all_day);
    assert_eq!(data.start_day_label, "Wednesday 17 June");
    assert_eq!(data.start_time_label, "");
    assert!(!data.can_save);
    // Nothing typed: leaving is done, not a question.
    let fresh = world.open_new("2099-06-17", Kind::Task);
    world.send_editor(fresh, leave());
    assert!(world.editor_state(fresh).dismissed);
    // A task needs a title, and nothing else (no calendar, no range).
    world.save(page);
    assert_eq!(
        world.editor_data(page).blocked_reason,
        "Add a title to save."
    );
    world.title(page, "Call Mum");
    assert!(world.editor_data(page).can_save);

    // THE EVENT FIELDS ARE NOT A TASK'S: their events change nothing.
    let before = world.driver.view(page).clone();
    let maya = world.person("Maya Alvarez");
    let calendar_id = world.calendar_names()[0].0.clone();
    for stray in [
        guest(&maya),
        repeat("weekly"),
        reminder("30"),
        calendar(&calendar_id),
        end("2099-06-18", "10:00"),
        notes("x"),
        link("https://x.example"),
        sheet(Sheet::Calendar),
        skip(),
    ] {
        world.send_editor(page, stray);
    }
    assert_eq!(world.driver.view(page), &before);
}

#[test]
fn switching_kinds_keeps_the_title_and_the_day_and_is_never_a_change_to_discard() {
    let mut world = World::new();
    let page = world.open_new("2099-06-17", Kind::Event);
    world.send_editor(page, kind(Kind::Task));
    let state = world.editor_state(page);
    assert_eq!(state.kind, Kind::Task as i32);
    let data = world.editor_data(page);
    assert_eq!(
        data.kinds.iter().find(|k| k.selected).expect("one").label,
        "Task"
    );
    assert_eq!(data.heading, "New task");
    assert!(data.draft.as_ref().expect("draft").all_day);
    assert_eq!(data.draft.as_ref().expect("draft").start_day, "2099-06-17");
    assert!(!data.dirty);
    // THE SWITCH ALONE LEAVES FREELY.
    let to_task = world.open_new("2099-06-17", Kind::Event);
    world.send_editor(to_task, kind(Kind::Task));
    world.send_editor(to_task, leave());
    assert!(world.editor_state(to_task).dismissed);

    // Typed on one kind, kept on the other; the picked day goes with it.
    world.title(page, "Plan the trip");
    world.send_editor(page, start("2099-06-19", "09:00"));
    world.send_editor(page, kind(Kind::Event));
    let data = world.editor_data(page);
    assert_eq!(data.heading, "New event");
    assert!(data.show_event_fields);
    assert_eq!(data.foot_note, "A new event starts tentative.");
    let draft = data.draft.clone().expect("draft");
    assert_eq!(draft.title, "Plan the trip");
    assert_eq!(draft.start_day, "2099-06-19");
    assert!(!draft.all_day);
    assert_eq!(draft.end_time, "10:00");
    // ... and a typed title asks first, in the kind's words.
    world.send_editor(page, leave());
    assert_eq!(
        world.editor_state(page).confirm.as_ref().expect("q").title,
        "Discard this event?"
    );
    world.send_editor(
        page,
        K::ConfirmDismissed(wire::agenda_editor_event::ConfirmDismissed {}),
    );
    world.send_editor(page, kind(Kind::Task));
    world.send_editor(page, leave());
    assert_eq!(
        world.editor_state(page).confirm.as_ref().expect("q").title,
        "Discard this task?"
    );
}

#[test]
fn a_task_saves_as_a_task_with_a_bare_day_or_a_floating_time_and_a_commit_ends_the_sitting() {
    let mut world = World::new();
    let page = world.open_new("2099-06-17", Kind::Task);
    world.title(page, "  Renew passport ");
    assert!(world.editor_data(page).can_save);
    let update = world.save(page);
    assert!(world.editor_state(page).dismissed);
    let found = world.tasks_titled("Renew passport");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].due_day, "2099-06-17");
    assert_eq!(found[0].due_time, "");
    // A task add remembers the kind on this device.
    assert_eq!(update.effects.len(), 1);
    let ops = keychain_ops(&world);
    assert_eq!(
        (ops[0].0, ops[0].1.as_str(), ops[0].2.as_slice()),
        (
            wire::keychain_op::Op::Set as i32,
            "agenda_add_kind",
            b"task".as_slice()
        )
    );
    // A Save before the shell has gone files nothing more, and the kind cannot be switched.
    world.save(page);
    world.send_editor(page, kind(Kind::Event));
    assert_eq!(world.tasks_titled("Renew passport").len(), 1);
    assert_eq!(world.editor_state(page).kind, Kind::Task as i32);

    // A TIME turns All day off: the due is the floating wall clock the command reads.
    let timed = world.open_new("2099-06-17", Kind::Task);
    world.title(timed, "Call the bank");
    world.send_editor(timed, all_day(false));
    world.send_editor(timed, start("2099-06-17", "14:30"));
    assert_eq!(world.editor_data(timed).start_time_label, "14:30");
    world.save(timed);
    let found = world.tasks_titled("Call the bank");
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].due_day, "2099-06-17");
    assert_eq!(found[0].due_time, "14:30");
}

#[test]
fn the_device_remembers_the_kind_of_the_last_add_an_event_is_absence_and_an_unknown_word_is_an_event()
 {
    let mut world = World::new();
    // A task was the last thing added: the next sheet opens on it.
    let page = world.open_new("2099-06-17", Kind::Unspecified);
    answer_kind(&mut world, Some("task"));
    assert_eq!(world.editor_state(page).kind, Kind::Task as i32);
    let data = world.editor_data(page);
    assert_eq!(data.heading, "New task");
    assert!(
        !data.dirty,
        "the remembered kind is the starting point, not a change"
    );
    assert!(data.draft.as_ref().expect("draft").all_day);

    // An unknown word opens on an event; so does a store that failed.
    let page = world.open_new("2099-06-17", Kind::Unspecified);
    answer_kind(&mut world, Some("habit"));
    assert_eq!(world.editor_state(page).kind, Kind::Event as i32);
    let page = world.open_new("2099-06-17", Kind::Unspecified);
    world
        .driver
        .answer_effect(wire::effect_result::Outcome::Failed(wire::EffectFailed {
            reason: "locked".to_owned(),
            denied: false,
            ..Default::default()
        }));
    assert_eq!(world.editor_state(page).kind, Kind::Event as i32);

    // A kind the member picks before the memory answers wins over it.
    let page = world.open_new("2099-06-17", Kind::Unspecified);
    world.send_editor(page, kind(Kind::Task));
    world.send_editor(page, kind(Kind::Event));
    answer_kind(&mut world, Some("task"));
    assert_eq!(world.editor_state(page).kind, Kind::Event as i32);
    // An edit never asks the memory.
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    world.driver.effects.clear();
    world.open_edit(&id, &id, None, "2099-06-15");
    assert!(keychain_ops(&world).is_empty());
}

#[test]
fn an_edit_whose_event_is_gone_says_so_and_a_failed_first_read_is_a_failure() {
    let mut world = World::new();
    let page = world.open_edit("no-such-event", "no-such-event", None, "2099-06-15");
    let state = world.editor_state(page);
    let Some(wire::agenda_editor_state::Content::Gone(gone)) = &state.content else {
        panic!("{:?}", state.content)
    };
    assert_eq!(gone.title, "This event was removed.");

    world.zone("Not/A_Zone");
    let failed = world.open_new("2099-06-15", Kind::Event);
    let Some(wire::agenda_editor_state::Content::Failure(failure)) =
        &world.editor_state(failed).content
    else {
        panic!("{:?}", world.editor_state(failed).content)
    };
    assert_eq!(failure.sentence, "Part of this didn't arrive. Try again.");
    world.zone(agenda_event_support::ZONE);
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
    assert!(hues.iter().all(|hue| hue.starts_with('c')), "{hues:?}");
}
