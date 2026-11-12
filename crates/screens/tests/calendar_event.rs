//! `agenda.event` through the door a shell uses: the occurrence read by its key,
//! every fact in the words the screen chose, the member's reply, Edit, and Cancel
//! with its confirm and its scope sheet. Ports `AgendaEventSpec`.

mod calendar_support;

use std::time::Duration;

use calendar_support::{World, ZONE};
use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use wire::agenda_event_event::Kind as K;
use wire::agenda_event_state::Sheet;

fn rsvp(partstat: &str) -> K {
    K::Rsvp(wire::agenda_event_event::RsvpPicked {
        partstat: partstat.to_owned(),
    })
}

fn action(key: &str) -> K {
    K::Action(wire::agenda_event_event::ActionPicked {
        key: key.to_owned(),
    })
}

fn scope(scope: wire::AgendaScope) -> K {
    K::Scope(wire::agenda_event_event::ScopePicked {
        scope: scope as i32,
    })
}

fn confirmed() -> K {
    K::Confirmed(wire::agenda_event_event::Confirmed {})
}

fn facts(data: &wire::AgendaEventData) -> Vec<(&str, &str)> {
    data.facts
        .iter()
        .map(|fact| (fact.label.as_str(), fact.detail.as_str()))
        .collect()
}

#[test]
fn opening_reads_the_occurrence_by_its_key_and_names_its_calendar() {
    let mut world = World::new();
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");
    let data = world.event_data(page);
    assert_eq!(data.title, "Review");
    let (calendar_id, name) = world.calendar_names().remove(0);
    assert!(!calendar_id.is_empty());
    assert_eq!(data.calendar_name, name);
    assert!(
        data.calendar_hue_key.starts_with("list"),
        "{}",
        data.calendar_hue_key
    );
    assert_eq!(
        world
            .event_state(page)
            .chrome
            .as_ref()
            .expect("chrome")
            .back,
        "Calendar"
    );
    // The route's key defaults to the event id: a page opened with none still finds it.
    let bare = world.open_event(&id, "", None, "");
    assert_eq!(world.event_data(bare).title, "Review");
}

#[test]
fn the_detail_says_every_fact_in_words_the_screen_chose() {
    let mut world = World::new();
    let priya = world.person("Maya Alvarez");
    let tom = world.person("Jake Bennett");
    let me = world.me.clone();
    let id = world.propose(
        "Survey walk-through",
        "2099-06-15T08:15:00",
        "2099-06-15T09:30:00",
        |p| {
            p.description = Field::Is("  Bring the drawings.  ".to_owned());
            p.url = Field::Is("https://call.example/abc".to_owned());
            p.reminders = Field::Is("[30]".to_owned());
            p.attendees = Some(serde_json::to_string(&[&me, &priya, &tom]).expect("json"));
        },
    );
    world.act(act::calendar::Rsvp {
        event_id: id.clone(),
        person_id: priya.clone(),
        state: act::calendar::RsvpState::Accepted,
    });
    let page = world.open_event(&id, &id, None, "2099-06-15");
    let data = world.event_data(page);
    assert_eq!(data.title, "Survey walk-through");
    assert_eq!(data.date_label, "Monday 15 June");
    assert_eq!(data.when_label, "08:15 – 09:30");
    let (_, calendar) = world.calendar_names().remove(0);
    assert_eq!(
        facts(data),
        [
            ("Joining link", "https://call.example/abc"),
            ("Reminder", "30 minutes before"),
            ("Calendar", calendar.as_str()),
        ]
    );
    assert_eq!(data.notes, "Bring the drawings.");
    assert_eq!(data.call_uri, "https://call.example/abc");
    assert_eq!(data.call_label, "Join call");
    assert_eq!(data.guest_heading, "3 guests · 2 awaiting");
    let guests: Vec<(&str, &str)> = data
        .guests
        .iter()
        .map(|g| (g.name.as_str(), g.reply_label.as_str()))
        .collect();
    assert_eq!(
        guests,
        [
            ("Me · you", "No answer yet"),
            ("Jake Bennett", "No answer yet"),
            ("Maya Alvarez", "Going")
        ]
    );
    let initials: Vec<&str> = data.guests.iter().map(|g| g.initial.as_str()).collect();
    assert_eq!(initials, ["M", "J", "M"]);
    assert!(data.guests.iter().all(|g| g.hue_key.starts_with('c')));
    assert_eq!(
        data.guests[0].accessibility_label,
        "Me · you, No answer yet"
    );
    let rsvp = data.rsvp.as_ref().expect("the owner is a guest");
    assert_eq!(rsvp.question, "Are you going?");
    let labels: Vec<&str> = rsvp.choices.iter().map(|c| c.label.as_str()).collect();
    assert_eq!(labels, ["Going", "Maybe", "Not going"]);
    assert!(rsvp.choices.iter().all(|c| c.enabled && !c.selected));
    assert_eq!(rsvp.note, "");
    let actions: Vec<(&str, &str)> = data
        .actions
        .iter()
        .map(|a| (a.key.as_str(), a.label.as_str()))
        .collect();
    assert_eq!(
        actions,
        [
            ("edit", "Edit"),
            ("cancel", "Cancel…"),
            ("trash", "Move to trash")
        ]
    );
    // SHARE SITS IN THE "…" MENU, not the bar of three.
    let menu: Vec<(&str, &str)> = data
        .menu
        .iter()
        .map(|a| (a.key.as_str(), a.label.as_str()))
        .collect();
    assert_eq!(menu, [("share", "Share")]);
    assert_eq!(data.menu_label, "More");
    assert!(!data.is_past, "2099 is ahead");
    assert_eq!(
        data.accessibility_label,
        "Survey walk-through, Monday 15 June, 08:15 to 09:30"
    );
    // THE PLACE'S NAME, where the core answers one, would follow the rule and be spoken: the
    // example vault names no place for this event, so its row is absent.
    assert!(data.facts.iter().all(|f| f.label != "Where"));
}

#[test]
fn a_past_event_says_it_is_past() {
    let mut world = World::new();
    let id = world.propose(
        "Long ago",
        "2020-06-15T08:15:00",
        "2020-06-15T09:30:00",
        |_| {},
    );
    let page = world.open_event(&id, &id, None, "2020-06-15");
    assert!(world.event_data(page).is_past);
}

#[test]
fn all_day_and_multi_day_occurrences_say_days_never_a_clock_time_and_a_series_says_it_repeats() {
    let mut world = World::new();
    let weekend = world.propose("Weekend away", "2099-06-19", "2099-06-21", |p| {
        p.timing = Some(act::calendar::ProposeTiming::AllDay);
        p.zone = Field::Keep;
    });
    let page = world.open_event(&weekend, &weekend, None, "2099-06-19");
    let data = world.event_data(page);
    assert_eq!(data.when_label, "All day");
    assert_eq!(data.date_label, "Friday 19 June – Sunday 21 June");
    assert_eq!(data.guest_heading, "");
    assert!(data.rsvp.is_none(), "no invitation, no reply");

    // A timed event that ends at midnight is on the day before only.
    let late = world.propose(
        "Late film",
        "2099-06-15T22:00:00",
        "2099-06-16T00:00:00",
        |_| {},
    );
    let late_page = world.open_event(&late, &late, None, "2099-06-15");
    assert_eq!(world.event_data(late_page).date_label, "Monday 15 June");

    let series = world.weekdays("Stand-up");
    let me = world.me.clone();
    world.act(act::calendar::EditEvent {
        event_id: series.clone(),
        attendees: Some(serde_json::to_string(&[&me]).expect("json")),
        ..Default::default()
    });
    let key = format!("{series}:2099-06-16T10:00:00");
    let page = world.open_event(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16");
    let data = world.event_data(page);
    assert_eq!(data.facts[0].label, "Repeats");
    assert!(!data.facts[0].detail.is_empty());
    assert_eq!(data.actions[data.actions.len() - 2].label, "Cancel…");
    assert_eq!(data.actions.last().expect("trash").label, "Move to trash");
    assert_eq!(
        data.rsvp.as_ref().expect("a guest").note,
        "Your answer is for every event in the series."
    );
    assert!(
        data.accessibility_label.ends_with(", repeats"),
        "{}",
        data.accessibility_label
    );
    assert_eq!(data.date_label, "Tuesday 16 June");
}

#[test]
fn an_occurrence_the_answer_does_not_have_is_gone_not_an_error() {
    let mut world = World::new();
    let page = world.open_event("no-such-event", "no-such-event", None, "2099-06-15");
    let state = world.event_state(page);
    assert!(state.content.is_none());
    let gone = gone_of(&state.page);
    assert_eq!(gone.sentence, "This event was removed.");

    // Skipped since it was picked: the series has no such day any more.
    let series = world.weekdays("Stand-up");
    world.act(act::calendar::EditOccurrence {
        action: act::calendar::EditOccurrenceAction::Skip,
        event_id: series.clone(),
        original_start: "2099-06-16T10:00:00".to_owned(),
        scope: act::calendar::EditOccurrenceScope::Occurrence,
        ..Default::default()
    });
    let key = format!("{series}:2099-06-16T10:00:00");
    let skipped = world.open_event(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16");
    assert!(world.event_state(skipped).content.is_none());
    gone_of(&world.event_state(skipped).page);
}

#[test]
fn rsvp_writes_as_the_owner_and_the_chip_follows_the_vault() {
    let mut world = World::new();
    let priya = world.person("Maya Alvarez");
    let me = world.me.clone();
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |p| {
            p.attendees = Some(serde_json::to_string(&[&priya, &me]).expect("json"));
        },
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");
    // The owner's row is theirs, whatever order the guests were invited in.
    assert!(
        world
            .event_data(page)
            .guests
            .iter()
            .any(|g| g.name.ends_with(" · you"))
    );
    world.send_event(page, rsvp("accepted"));
    let data = world.event_data(page);
    let choices = &data.rsvp.as_ref().expect("rsvp").choices;
    assert_eq!(
        choices
            .iter()
            .find(|c| c.selected)
            .expect("one chosen")
            .partstat,
        "accepted"
    );
    assert_eq!(
        data.guests
            .iter()
            .find(|g| g.name.ends_with(" · you"))
            .expect("you")
            .reply_label,
        "Going"
    );
    // The reply says what happened, with Undo (#1185).
    let status = world.event_state(page).status.as_ref().expect("a line");
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Reply changed", "Undo")
    );
    // The vault holds it.
    let row = world.event_row(&id).expect("the event");
    assert_eq!(
        row.attendees
            .iter()
            .find(|a| a.is_you)
            .expect("you")
            .partstat,
        "accepted"
    );
    // A guest that is not the owner kept their own answer.
    assert_eq!(
        row.attendees
            .iter()
            .find(|a| !a.is_you)
            .expect("guest")
            .partstat,
        "needs-action"
    );

    // The same answer again, an unknown one, or no invitation writes nothing.
    let before = world.driver.view(page).revision;
    world.send_event(page, rsvp("accepted"));
    world.send_event(page, rsvp("sure"));
    assert_eq!(world.driver.view(page).revision, before);
    let solo = world.propose("Solo", "2099-06-15T16:00:00", "2099-06-15T17:00:00", |_| {});
    let solo_page = world.open_event(&solo, &solo, None, "2099-06-15");
    world.send_event(solo_page, rsvp("accepted"));
    assert!(world.event_data(solo_page).rsvp.is_none());

    // MAYBE moves it.
    world.send_event(page, rsvp("tentative"));
    let row = world.event_row(&id).expect("the event");
    assert_eq!(
        row.attendees
            .iter()
            .find(|a| a.is_you)
            .expect("you")
            .partstat,
        "tentative"
    );
}

#[test]
fn a_refused_reply_says_why_and_leaves_the_chip_where_the_vault_has_it() {
    let mut world = World::new();
    let me = world.me.clone();
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |p| {
            p.attendees = Some(serde_json::to_string(&[&me]).expect("json"));
        },
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");
    // Cancelled elsewhere while this page is open: the vault refuses the reply.
    world.act(act::calendar::CancelEvent {
        event_id: id.clone(),
    });
    world.send_event(page, rsvp("accepted"));
    let status = world
        .event_state(page)
        .status
        .as_ref()
        .expect("the refusal is said");
    assert!(status.refused);
    assert!(!status.sentence.is_empty());
    assert!(
        world
            .event_data(page)
            .rsvp
            .as_ref()
            .expect("rsvp")
            .choices
            .iter()
            .all(|c| !c.selected),
        "nothing was recorded"
    );
}

#[test]
fn cancelling_a_one_off_asks_first_writes_cancel_event_and_ends_the_screen() {
    let mut world = World::new();
    let id = world.propose(
        "Dentist",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");
    world.send_event(page, action("cancel"));
    let confirm = world.event_state(page).confirm.clone().expect("a confirm");
    assert_eq!(confirm.title, "Cancel this event?");
    assert_eq!(confirm.confirm_label, "Cancel event");
    assert!(confirm.destructive);
    assert_eq!(
        world.event_row(&id).expect("event").status.as_deref(),
        Some("confirmed")
    );
    world.send_event(
        page,
        K::ConfirmDismissed(wire::agenda_event_event::ConfirmDismissed {}),
    );
    assert!(world.event_state(page).confirm.is_none());

    world.send_event(page, action("cancel"));
    let update = world.driver.send(
        page,
        wire::screen_event::Kind::AgendaEvent(wire::AgendaEventEvent {
            kind: Some(confirmed()),
        }),
    );
    let state = world.event_state(page);
    assert!(state.dismissed, "the shell pops on this");
    assert!(state.confirm.is_none());
    assert!(!update.views.is_empty());
    assert_eq!(
        world
            .event_row(&id)
            .expect("a cancelled event is still answered")
            .status
            .as_deref(),
        Some("cancelled")
    );
    // A screen that is done does nothing more.
    let revision = world.driver.view(page).revision;
    world.send_event(page, action("cancel"));
    assert_eq!(world.driver.view(page).revision, revision);
}

#[test]
fn cancelling_a_series_asks_which_occurrences_none_pre_chosen_and_each_scope_writes_its_command() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    let key = format!("{series}:2099-06-16T10:00:00");
    let open = |world: &mut World| {
        world.open_event(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16")
    };

    let page = open(&mut world);
    world.send_event(page, action("cancel"));
    let state = world.event_state(page);
    assert_eq!(state.sheet, Sheet::CancelScope as i32);
    assert!(state.confirm.is_none());
    let labels: Vec<&str> = state
        .cancel_scopes
        .iter()
        .map(|s| s.label.as_str())
        .collect();
    assert_eq!(
        labels,
        [
            "Only this one",
            "This and the ones after",
            "The whole series"
        ]
    );
    assert!(state.cancel_scopes.iter().all(|s| !s.selected));
    assert!(!state.cancel_armed);
    // NOTHING PICKED, NOTHING WRITTEN.
    world.send_event(page, confirmed());
    assert!(!world.event_state(page).dismissed);
    assert!(
        world
            .event_row(&series)
            .is_some_and(|e| e.status.as_deref() != Some("cancelled"))
    );

    // Closing the sheet forgets the pick.
    world.send_event(page, scope(wire::AgendaScope::Future));
    assert!(world.event_state(page).cancel_armed);
    world.send_event(
        page,
        K::SheetClosed(wire::agenda_event_event::SheetClosed {}),
    );
    let state = world.event_state(page);
    assert_eq!(state.sheet, Sheet::None as i32);
    assert!(state.cancel_scopes.is_empty() && !state.cancel_armed);
    world.send_event(page, action("cancel"));
    assert!(
        world
            .event_state(page)
            .cancel_scopes
            .iter()
            .all(|s| !s.selected)
    );

    // THIS OCCURRENCE: a skip of that day alone.
    world.send_event(page, scope(wire::AgendaScope::Occurrence));
    let state = world.event_state(page);
    assert!(state.cancel_armed);
    assert_eq!(
        state
            .cancel_scopes
            .iter()
            .find(|s| s.selected)
            .expect("picked")
            .scope,
        wire::AgendaScope::Occurrence as i32
    );
    world.send_event(page, confirmed());
    assert!(
        world.event_state(page).dismissed,
        "a skip committed is a cancellation too"
    );
    let days: Vec<String> = world
        .window("2099-06-15T00:00:00Z", "2099-06-20T00:00:00Z")
        .into_iter()
        .filter(|e| e.event_id == series)
        .map(|e| e.local_start)
        .collect();
    assert_eq!(
        days,
        [
            "2099-06-15T10:00",
            "2099-06-17T10:00",
            "2099-06-18T10:00",
            "2099-06-19T10:00"
        ],
        "Tuesday is skipped and the rest of the week stays"
    );

    // THIS AND THE ONES AFTER.
    let page = world.open_event(
        &series,
        &format!("{series}:2099-06-17T10:00:00"),
        Some("2099-06-17T10:00:00"),
        "2099-06-17",
    );
    world.send_event(page, action("cancel"));
    world.send_event(page, scope(wire::AgendaScope::Future));
    world.send_event(page, confirmed());
    assert!(world.event_state(page).dismissed);
    let after: Vec<_> = world
        .window("2099-06-15T00:00:00Z", "2099-06-25T00:00:00Z")
        .into_iter()
        .filter(|e| e.event_id == series)
        .map(|e| e.local_start)
        .collect();
    assert_eq!(after, ["2099-06-15T10:00"]);

    // THE WHOLE SERIES is cancel-event, and closes the sheet.
    let other = world.weekdays_at("Retro", 13);
    let key = format!("{other}:2099-06-16T13:00:00");
    let page = world.open_event(&other, &key, Some("2099-06-16T13:00:00"), "2099-06-16");
    world.send_event(page, action("cancel"));
    world.send_event(page, scope(wire::AgendaScope::Series));
    world.send_event(page, confirmed());
    let state = world.event_state(page);
    assert!(state.dismissed);
    assert_eq!(state.sheet, Sheet::None as i32);
    assert_eq!(
        world.event_row(&other).expect("event").status.as_deref(),
        Some("cancelled")
    );
}

#[test]
fn a_cancel_the_vault_refuses_says_why_and_keeps_the_event_open() {
    let mut world = World::new();
    let id = world.propose(
        "Dentist",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");
    // Cancelled elsewhere already: the vault will not cancel it twice.
    world.act(act::calendar::CancelEvent {
        event_id: id.clone(),
    });
    world.send_event(page, action("cancel"));
    world.send_event(page, confirmed());
    let state = world.event_state(page);
    match &state.status {
        Some(status) if status.refused => assert!(!state.dismissed),
        // The vault treats a repeat as done: the screen is done as well, and its "Event
        // cancelled" line goes to the page beneath.
        _ => assert!(state.dismissed),
    }
}

#[test]
fn edit_carries_the_editor_route_and_is_not_an_event() {
    let mut world = World::new();
    let series = world.weekdays("Stand-up");
    let key = format!("{series}:2099-06-16T10:00:00");
    let page = world.open_event(&series, &key, Some("2099-06-16T10:00:00"), "2099-06-16");
    let edit = world.event_data(page).actions[0].clone();
    assert_eq!(edit.key, "edit");
    let route = edit.route.expect("the edit action opens the editor");
    assert_eq!(route.screen, "calendar.editor");
    let Some(wire::route::Args::AgendaEditor(args)) = route.args else {
        panic!("not the editor's arguments")
    };
    assert_eq!(args.event_id, series);
    assert_eq!(args.instance_key, key);
    assert_eq!(
        args.original_start_local.as_deref(),
        Some("2099-06-16T10:00:00")
    );
    assert_eq!(args.day, "2099-06-16");
    assert_eq!(args.kind, wire::AgendaEditorKind::Event as i32);
    assert!(world.event_data(page).actions[1].route.is_none());
    // The page changes nothing on it.
    let revision = world.driver.view(page).revision;
    world.send_event(page, action("edit"));
    assert_eq!(world.driver.view(page).revision, revision);
    // The shell can push that very route.
    let editor = world.driver.push(
        "calendar",
        wire::Route {
            sheet: false,
            screen: route.screen,
            args: Some(wire::route::Args::AgendaEditor(args)),
        },
    );
    assert!(world.driver.views.contains_key(&editor));
}

#[test]
fn a_first_read_that_fails_is_a_failure_and_a_re_read_that_fails_keeps_the_event() {
    let mut world = World::new();
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    world.zone("Not/A_Zone");
    let failed = world.open_event(&id, &id, None, "2099-06-15");
    let state = world.event_state(failed);
    let Some(wire::page_state::State::Failed(failure)) =
        state.page.as_ref().and_then(|page| page.state.as_ref())
    else {
        panic!("{:?}", state.page)
    };
    assert_eq!(failure.sentence, "Couldn't read this. Try again.");
    assert_eq!(failure.remedy, "Try again");
    assert!(!failure.permanent, "a failed read can be tried again");
    // The zone comes right and the member retries.
    world.zone(ZONE);
    world.send_event(failed, K::Refreshed(wire::agenda_event_event::Refreshed {}));
    assert_eq!(world.event_data(failed).title, "Review");

    // A re-read that fails keeps what is on screen.
    world.zone("Not/A_Zone");
    assert_eq!(world.event_data(failed).title, "Review");
    world.zone(ZONE);
}

#[test]
fn a_change_elsewhere_redraws_the_page_once() {
    let mut world = World::new();
    let id = world.propose(
        "Review",
        "2099-06-15T14:00:00",
        "2099-06-15T15:00:00",
        |_| {},
    );
    let page = world.open_event(&id, &id, None, "2099-06-15");
    world.act(act::calendar::EditEvent {
        event_id: id.clone(),
        title: Some("Design review".to_owned()),
        ..Default::default()
    });
    world.driver.pump(Duration::from_millis(300));
    assert_eq!(world.event_data(page).title, "Design review");
}

/// WAVE 2 FACTS (#1173): a second alert, free, and travel time are said when set, in the editor's
/// words; busy and no travel are the defaults and say nothing.
#[test]
fn the_detail_says_a_second_alert_free_and_travel_only_when_they_are_set() {
    let mut world = World::new();
    let plain = world.propose(
        "Standup",
        "2099-06-16T09:00:00",
        "2099-06-16T09:15:00",
        |_| {},
    );
    let page = world.open_event(&plain, &plain, None, "2099-06-16");
    let labels: Vec<&str> = facts(world.event_data(page)).iter().map(|f| f.0).collect();
    assert_eq!(
        labels,
        ["Calendar"],
        "busy, no travel, one zone: nothing to add"
    );

    let dinner = world.propose(
        "Dinner",
        "2099-06-16T19:00:00",
        "2099-06-16T20:00:00",
        |p| {
            p.reminders = Field::Is("[60, 1440]".to_owned());
            p.busy = Some(false);
            p.travel_min = Field::Is(30);
        },
    );
    let page = world.open_event(&dinner, &dinner, None, "2099-06-16");
    let (_, calendar) = world.calendar_names().remove(0);
    assert_eq!(
        facts(world.event_data(page)),
        [
            ("Reminder", "1 hour before"),
            ("Second reminder", "1 day before"),
            ("Show as", "Free"),
            ("Travel time", "30 minutes"),
            ("Calendar", calendar.as_str()),
        ]
    );
}

/// The place's name is the Location row; an event in the phone's own zone says no zone, and one in
/// another says which.
#[test]
fn the_detail_names_the_zone_only_when_it_is_not_the_phones() {
    let mut world = World::new();
    let call = world.propose(
        "Call New York",
        "2099-06-17T09:00:00",
        "2099-06-17T10:00:00",
        |p| p.zone = Field::Is("America/New_York".to_owned()),
    );
    let page = world.open_event(&call, &call, None, "2099-06-17");
    assert!(
        facts(world.event_data(page)).contains(&("Time zone", "New York, America")),
        "{:?}",
        facts(world.event_data(page))
    );

    let local = world.propose(
        "Lunch",
        "2099-06-17T12:00:00",
        "2099-06-17T13:00:00",
        |_| {},
    );
    let page = world.open_event(&local, &local, None, "2099-06-17");
    assert!(
        facts(world.event_data(page))
            .iter()
            .all(|fact| fact.0 != "Time zone"),
        "an event in the phone's own zone names none"
    );

    // The phone travels: the same event is now in another zone than the phone's.
    world.zone("Asia/Tokyo");
    let page = world.open_event(&local, &local, None, "2099-06-17");
    assert!(
        facts(world.event_data(page)).contains(&("Time zone", "London, Europe")),
        "{:?}",
        facts(world.event_data(page))
    );
}

/// The guests a phone calendar states for a followed event are listed read-only with the reply in
/// words: a name over its address, an address alone, and "Guest" for neither.
#[test]
fn followed_guests_are_a_read_only_list_with_the_reply_in_words() {
    let mut world = World::new();
    world.act(act::calendar::FollowCalendar {
        origin: serde_json::json!({
            "ref": "calendar:work", "label": "Work", "device_id": "phone-1"
        })
        .to_string(),
        records: serde_json::json!([{
            "external_id": "uid:1", "device_id": "phone-1", "fields": {
                "title": "Planning", "starts": "2099-06-19T09:00", "ends": "2099-06-19T10:00",
                "timing": "floating",
                "attendees": [
                    { "name": "Sam Rivers", "email": "sam@example.com", "state": "accepted" },
                    { "email": "lee@example.com", "state": "declined" },
                    { "state": "tentative" },
                    { "name": "Ada", "state": "needs-action" }
                ]
            }
        }])
        .to_string(),
        complete: Some(true),
        since: None,
        ..Default::default()
    });
    let found = world.window("2099-06-19T00:00:00Z", "2099-06-20T00:00:00Z");
    let id = found.first().expect("the followed event").event_id.clone();
    let page = world.open_event(&id, &id, None, "2099-06-19");
    let data = world.event_data(page);
    assert_eq!(data.followed_heading, "4 guests on your calendar");
    let rows: Vec<(&str, &str, &str)> = data
        .followed_guests
        .iter()
        .map(|g| (g.name.as_str(), g.detail.as_str(), g.reply_label.as_str()))
        .collect();
    assert_eq!(
        rows,
        [
            ("Sam Rivers", "sam@example.com", "Going"),
            ("lee@example.com", "", "Not going"),
            ("Guest", "", "Maybe"),
            ("Ada", "", "No answer yet"),
        ]
    );
    assert_eq!(data.followed_guests[0].initial, "S");
    assert_eq!(
        data.followed_guests[0].accessibility_label,
        "Sam Rivers, Going"
    );
    // An event that follows no phone calendar has no such list.
    let own = world.propose("Own", "2099-06-19T12:00:00", "2099-06-19T13:00:00", |_| {});
    let page = world.open_event(&own, &own, None, "2099-06-19");
    assert!(world.event_data(page).followed_guests.is_empty());
    assert_eq!(world.event_data(page).followed_heading, "");
}

/// A place founded through `add-place`: its id and its name.
fn a_known_place(world: &mut World) -> (String, String) {
    let done = world.act(act::calendar::AddPlace {
        title: "Café Roma".to_owned(),
        ..Default::default()
    });
    let output: serde_json::Value = serde_json::from_slice(&done.output).expect("json output");
    (
        output["id"].as_str().expect("the id").to_owned(),
        "Café Roma".to_owned(),
    )
}

#[test]
fn an_event_with_a_location_offers_it_to_the_maps_app_and_one_without_does_not() {
    let mut world = World::new();
    let (place_id, name) = a_known_place(&mut world);
    let at = world.propose(
        "Dinner",
        "2099-06-15T19:00:00",
        "2099-06-15T20:00:00",
        |p| p.place_id = Field::Is(place_id),
    );
    let page = world.open_event(&at, &at, None, "2099-06-15");
    let keys: Vec<&str> = world
        .event_data(page)
        .actions
        .iter()
        .map(|a| a.key.as_str())
        .collect();
    assert_eq!(keys, ["open_map", "edit", "cancel", "trash"]);
    let map = world.event_data(page).actions[0].clone();
    assert_eq!(map.label, "Open in Maps");
    assert!(map.route.is_none() && map.enabled && !map.destructive);
    let update = world.driver.send(
        page,
        wire::screen_event::Kind::AgendaEvent(wire::AgendaEventEvent {
            kind: Some(action("open_map")),
        }),
    );
    let asked = calendar_support::asked(&update);
    let [wire::effect::Kind::OpenMap(open)] = asked.as_slice() else {
        panic!("one OpenMap effect: {asked:?}")
    };
    assert_eq!(open.query, name);

    let bare = world.propose("Call", "2099-06-16T10:00:00", "2099-06-16T10:30:00", |_| {});
    let page = world.open_event(&bare, &bare, None, "2099-06-16");
    let keys: Vec<&str> = world
        .event_data(page)
        .actions
        .iter()
        .map(|a| a.key.as_str())
        .collect();
    assert_eq!(keys, ["edit", "cancel", "trash"]);
    // Asked anyway, a page with no location opens nothing.
    let update = world.driver.send(
        page,
        wire::screen_event::Kind::AgendaEvent(wire::AgendaEventEvent {
            kind: Some(action("open_map")),
        }),
    );
    assert!(calendar_support::asked(&update).is_empty());
}

/// The page's final failure (an occurrence that is gone), or a panic naming the page.
fn gone_of(page: &Option<wire::PageState>) -> &wire::Failure {
    match page.as_ref().and_then(|page| page.state.as_ref()) {
        Some(wire::page_state::State::Failed(failure)) if failure.permanent => failure,
        _ => panic!("not a final failure: {page:?}"),
    }
}
