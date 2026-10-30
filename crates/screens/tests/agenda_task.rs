//! The task page (`agenda.task`), through the door a shell uses: ports of the
//! `TasksSpec` detail cases and the kit's autosave laws, which this page is the
//! law's one user in the to-do half of Agenda.

mod todo_support;

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::{self, detail, routes, todo::rows};
use centraid_screens::catalog::act;
use centraid_screens::field::Field;
use centraid_screens::strings::Locale;
use centraid_screens::testing::Driver;
use todo_support::*;
use wire::autosave::Phase;
use wire::todo_detail_event as de;

/// Longer than the autosave debounce.
const DEBOUNCED: Duration = Duration::from_millis(1400);

fn open(d: &mut Driver, id: &str) -> u64 {
    d.push(agenda::TAB, routes::task(id))
}

fn field<'a>(v: &'a wire::ViewState, key: &str) -> &'a wire::TodoField {
    detail_data(v)
        .fields
        .iter()
        .find(|f| f.key == key)
        .unwrap_or_else(|| panic!("no field `{key}`"))
}

fn selected(field: &wire::TodoField) -> &str {
    field
        .choices
        .iter()
        .find(|c| c.selected)
        .map(|c| c.key.as_str())
        .expect("a selected choice")
}

fn typed_title(d: &mut Driver, i: u64, title: &str) {
    send_detail(
        d,
        i,
        de::Kind::Title(de::TitleChanged {
            title: title.to_owned(),
        }),
    );
}

fn typed_notes(d: &mut Driver, i: u64, notes: &str) {
    send_detail(
        d,
        i,
        de::Kind::Notes(de::NotesChanged {
            notes: notes.to_owned(),
        }),
    );
}

fn autosave(v: &wire::ViewState) -> &wire::Autosave {
    detail(v).autosave.as_ref().expect("an autosave")
}

fn phase(v: &wire::ViewState) -> Phase {
    Phase::try_from(autosave(v).phase).expect("a phase")
}

fn rent(d: &Driver) -> String {
    add(
        d,
        act::agenda::AddTask {
            title: "Rent".into(),
            description: Field::Is("Standing order".into()),
            due: due(&format!("{}T09:00", day(d, 4))),
            ..Default::default()
        },
    )
}

// -----------------------------------------------------------------------------
// Reading
// -----------------------------------------------------------------------------

#[test]
fn the_fields_are_computed_and_repeats_is_the_cores_sentence() {
    let mut d = driver();
    let due_day = day(&d, 4);
    let id = add(
        &d,
        act::agenda::AddTask {
            title: "Rent".into(),
            due: due(&format!("{due_day}T09:00")),
            rule: Field::Is("FREQ=MONTHLY".into()),
            anchor: Some(act::agenda::AddTaskAnchor::Completion),
            remind_before_min: Field::Is(30),
            ..Default::default()
        },
    );
    let i = open(&mut d, &id);
    let v = d.view(i);
    let data = detail_data(v);
    assert_eq!(data.draft.as_ref().unwrap().title, "Rent");
    let keys: Vec<&str> = data.fields.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "when", "time", "reminder", "repeats", "anchor", "priority", "effort", "project",
            "tags"
        ]
    );
    let when = field(v, "when");
    assert!(when.pick_date);
    // THE PICKERS OPEN ON THE DUE DAY AND TIME, in the machine's words.
    assert_eq!(when.day, due_day);
    assert_eq!(when.pick_label, "Pick a date");
    let time = field(v, "time");
    assert_eq!(
        (
            time.time.as_str(),
            time.value.as_str(),
            time.pick_label.as_str()
        ),
        ("09:00", "09:00", "Pick a time")
    );
    assert!(time.pick_time);
    assert!(
        field(v, "reminder").value.ends_with("08:30"),
        "{}",
        field(v, "reminder").value
    );
    let repeats = field(v, "repeats");
    assert_ne!(repeats.value, "Never");
    assert!(!repeats.value.is_empty());
    // The stored rule selects its preset.
    assert_eq!(selected(repeats), "monthly");
    assert_eq!(selected(field(v, "anchor")), "completion");
    assert_eq!(field(v, "priority").value, "None");
    // SIGNAGE, NOT AN ESSAY (DESIGN.md, Copy; #1047): "None" is on the row, so
    // no note explains that priority is optional.
    assert_eq!(field(v, "priority").note, "");
    assert_eq!(data.title_placeholder, "Task name");
    assert_eq!(field(v, "project").value, "Inbox");
    assert_eq!(field(v, "tags").value, "—");
    assert!(
        data.fields
            .iter()
            .find(|f| f.key == "project")
            .unwrap()
            .sheet
    );
}

#[test]
fn a_one_off_repeats_never_and_a_date_only_reminder_is_on_the_day() {
    let mut d = driver();
    let id = add(
        &d,
        act::agenda::AddTask {
            title: "Bins".into(),
            due: due(&day(&d, 2)),
            remind_before_min: Field::Is(0),
            ..Default::default()
        },
    );
    let i = open(&mut d, &id);
    let v = d.view(i);
    assert_eq!(field(v, "repeats").value, "Never");
    assert_eq!(field(v, "reminder").value, "On the day");
    assert!(detail_data(v).fields.iter().all(|f| f.key != "anchor"));
}

#[test]
fn an_undated_task_opens_pickers_on_today_and_a_reminder_needs_a_due() {
    let mut d = driver();
    let id = task(&d, "Someday");
    let today = today(&d);
    let i = open(&mut d, &id);
    let v = d.view(i);
    assert_eq!(field(v, "when").day, today);
    let reminder = field(v, "reminder");
    assert!(!reminder.enabled);
    assert_eq!(reminder.note, "A reminder needs a due date.");
    assert_eq!(
        field(v, "repeats").note,
        "A repeating task needs a due date."
    );
}

#[test]
fn priority_chips_run_none_soon_next_now() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    let keys: Vec<(String, String)> = field(d.view(i), "priority")
        .choices
        .iter()
        .map(|c| (c.key.clone(), c.label.clone()))
        .collect();
    let expect: Vec<(String, String)> =
        [("none", "None"), ("1", "Soon"), ("2", "Next"), ("3", "Now")]
            .iter()
            .map(|(k, l)| ((*k).to_owned(), (*l).to_owned()))
            .collect();
    assert_eq!(keys, expect);
}

#[test]
fn a_task_no_live_row_has_is_drawn_as_gone_not_as_a_failed_read() {
    let mut d = driver();
    let i = open(&mut d, "no-such-task");
    let state = detail(d.view(i));
    match &state.content {
        Some(wire::todo_detail_state::Content::Gone(gone)) => {
            assert_eq!(gone.headline, "This task is gone.")
        }
        other => panic!("expected gone, got {other:?}"),
    }
    // A trashed task is gone too.
    let id = task(&d, "Doomed");
    let page = open(&mut d, &id);
    arrange(&d, act::agenda::DeleteTask { task_id: id });
    d.pump(Duration::from_millis(400));
    assert!(matches!(
        detail(d.view(page)).content,
        Some(wire::todo_detail_state::Content::Gone(_))
    ));
}

#[test]
fn the_project_field_offers_the_inbox_each_project_and_its_sections() {
    let mut d = driver();
    let garden = project(&d, "Garden");
    let beds = section(&d, &garden, "Beds");
    let id = task(&d, "Dig");
    let i = open(&mut d, &id);
    let place = field(d.view(i), "project");
    let keys: Vec<&str> = place.choices.iter().map(|c| c.key.as_str()).collect();
    assert_eq!(keys[0], "inbox");
    let at = keys
        .iter()
        .position(|k| *k == format!("project:{garden}"))
        .expect("the project");
    assert_eq!(keys[at + 1], format!("section:{beds}"));
    assert!(place.choices[at + 1].indented);
    assert_eq!(selected(place), "inbox");

    choose(&mut d, i, "project", &format!("section:{beds}"));
    let place = field(d.view(i), "project");
    assert_eq!(place.value, "Garden · Beds");
    assert_eq!(selected(place), format!("section:{beds}"));
    let stored = task_of(&d, &id);
    assert_eq!(
        (stored.project_id.as_deref(), stored.section_id.as_deref()),
        (Some(garden.as_str()), Some(beds.as_str()))
    );
    // A project with no section clears the section; the Inbox clears both.
    choose(&mut d, i, "project", &format!("project:{garden}"));
    assert_eq!(task_of(&d, &id).section_id, None);
    choose(&mut d, i, "project", "inbox");
    assert_eq!(task_of(&d, &id).project_id, None);
    assert_eq!(field(d.view(i), "project").value, "Inbox");
    // A project that is not there is nothing.
    choose(&mut d, i, "project", "project:ghost");
    assert_eq!(task_of(&d, &id).project_id, None);
}

// -----------------------------------------------------------------------------
// Autosave
// -----------------------------------------------------------------------------

#[test]
fn typing_is_dirty_then_saved_after_the_debounce_with_only_what_changed() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    assert_eq!(phase(d.view(i)), Phase::Clean);
    assert_eq!(autosave(d.view(i)).label, "Saved");
    typed_title(&mut d, i, "Rent, June");
    assert_eq!(phase(d.view(i)), Phase::Dirty);
    assert_eq!(autosave(d.view(i)).label, "Edited");
    assert_eq!(
        detail_data(d.view(i)).draft.as_ref().unwrap().title,
        "Rent, June"
    );
    // Nothing is written before the tick.
    assert_eq!(task_of(&d, &id).title, "Rent");
    d.pump(DEBOUNCED);
    // Saved; the vault's own change then reads the row back, which rests as clean.
    assert!(
        matches!(phase(d.view(i)), Phase::Saved | Phase::Clean),
        "{:?}",
        phase(d.view(i))
    );
    assert_eq!(autosave(d.view(i)).label, "Saved");
    assert_eq!(autosave(d.view(i)).saved_seq, autosave(d.view(i)).edit_seq);
    assert!(!autosave(d.view(i)).refused);
    let stored = task_of(&d, &id);
    assert_eq!(stored.title, "Rent, June");
    assert_eq!(
        stored.description.as_deref(),
        Some("Standing order"),
        "only the title was sent"
    );
    assert_eq!(
        detail_data(d.view(i)).draft.as_ref().unwrap().title,
        "Rent, June"
    );
}

#[test]
fn a_burst_of_typing_is_one_save_of_the_last_words() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    typed_title(&mut d, i, "Re");
    typed_title(&mut d, i, "Ren");
    typed_title(&mut d, i, "Rent!!");
    assert_eq!(autosave(d.view(i)).edit_seq, 3);
    d.pump(DEBOUNCED);
    assert_eq!(task_of(&d, &id).title, "Rent!!");
    assert_eq!(autosave(d.view(i)).saved_seq, 3);
    // The next edit is a new save under a new key.
    typed_title(&mut d, i, "Rent!!!");
    d.pump(DEBOUNCED);
    assert_eq!(task_of(&d, &id).title, "Rent!!!");
}

#[test]
fn an_edit_that_changes_nothing_is_not_an_edit() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    typed_title(&mut d, i, "Rent");
    assert_eq!(phase(d.view(i)), Phase::Clean);
    assert_eq!(autosave(d.view(i)).edit_seq, 0);
}

#[test]
fn a_typed_and_undone_edit_saves_with_no_write() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    let before = task_of(&d, &id).updated_at;
    typed_title(&mut d, i, "Rent!");
    typed_title(&mut d, i, "Rent");
    d.pump(DEBOUNCED);
    assert_eq!(phase(d.view(i)), Phase::Saved);
    assert_eq!(
        task_of(&d, &id).updated_at,
        before,
        "nothing changed against the baseline: no command"
    );
}

#[test]
fn closing_the_page_saves_what_was_typed_and_not_yet_ticked() {
    let mut d = driver();
    let id = rent(&d);
    let i = d.push(agenda::TAB, routes::task(&id));
    typed_notes(&mut d, i, "");
    assert_eq!(
        task_of(&d, &id).description.as_deref(),
        Some("Standing order")
    );
    // The shell pops the page: Left is the last chance to write.
    d.pop(agenda::TAB, i);
    assert_eq!(
        task_of(&d, &id).description,
        None,
        "an emptied note is cleared"
    );
}

#[test]
fn closing_a_saved_page_writes_nothing() {
    let mut d = driver();
    let id = rent(&d);
    let i = d.push(agenda::TAB, routes::task(&id));
    let before = task_of(&d, &id).updated_at;
    d.pop(agenda::TAB, i);
    assert_eq!(task_of(&d, &id).updated_at, before);
}

#[test]
fn an_emptied_title_is_kept_on_screen_and_not_sent() {
    let mut d = driver();
    let id = rent(&d);
    let i = d.push(agenda::TAB, routes::task(&id));
    typed_title(&mut d, i, " ");
    d.pump(DEBOUNCED);
    let a = autosave(d.view(i));
    assert_eq!(Phase::try_from(a.phase).unwrap(), Phase::Refused);
    assert!(a.refused);
    assert_eq!(a.failure.as_ref().unwrap().sentence, "A task needs a name.");
    assert_eq!(a.label, "A task needs a name.");
    assert_eq!(detail_data(d.view(i)).draft.as_ref().unwrap().title, " ");
    // Closing over it asks again, and is refused again: the vault keeps the name.
    d.pop(agenda::TAB, i);
    assert_eq!(task_of(&d, &id).title, "Rent");
}

#[test]
fn a_save_the_core_refuses_keeps_the_words_and_says_its_sentence() {
    let mut d = driver();
    let id = rent(&d);
    let i = d.push(agenda::TAB, routes::task(&id));
    typed_title(&mut d, i, "Rent, June");
    // The task is deleted behind the page's back, so the save is refused.
    arrange(
        &d,
        act::agenda::DeleteTask {
            task_id: id.clone(),
        },
    );
    d.pump(DEBOUNCED);
    let a = autosave(d.view(i));
    assert_eq!(Phase::try_from(a.phase).unwrap(), Phase::Refused);
    assert!(a.refused);
    assert!(!a.label.is_empty() && a.label != "Saved", "{}", a.label);
    assert_eq!(a.label, a.failure.as_ref().unwrap().sentence);
}

#[test]
fn a_vault_change_never_overwrites_typing_and_the_fields_refresh_around_the_words() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    typed_title(&mut d, i, "Rent!");
    // Another surface moves the task's priority while the member types.
    arrange(
        &d,
        act::agenda::EditTask {
            task_id: id.clone(),
            priority: Some(2),
            ..Default::default()
        },
    );
    d.pump(Duration::from_millis(300));
    let v = d.view(i);
    assert_eq!(
        detail_data(v).draft.as_ref().unwrap().title,
        "Rent!",
        "the typing stays"
    );
    assert_eq!(
        field(v, "priority").value,
        "Next",
        "the fields are the vault's"
    );
    assert!(autosave(v).remote_changed);
    // Saved, the page reads what the vault moved to, and the flag is spent.
    d.pump(DEBOUNCED);
    let v = d.view(i);
    assert!(!autosave(v).remote_changed);
    assert_eq!(task_of(&d, &id).title, "Rent!");
}

#[test]
fn a_clean_page_adopts_what_another_surface_wrote() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    arrange(
        &d,
        act::agenda::EditTask {
            task_id: id,
            title: Some("Rent (new)".into()),
            ..Default::default()
        },
    );
    d.pump(Duration::from_millis(300));
    assert_eq!(
        detail_data(d.view(i)).draft.as_ref().unwrap().title,
        "Rent (new)"
    );
    assert!(!autosave(d.view(i)).remote_changed);
}

// -----------------------------------------------------------------------------
// Fields: one write when it is chosen
// -----------------------------------------------------------------------------

#[test]
fn the_day_keeps_its_time_and_a_pick_closes_the_field() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    choose(&mut d, i, "when", "tomorrow");
    assert_eq!(task_of(&d, &id).due_local, format!("{}T09:00", day(&d, 1)));
    // The picker: opens the field, a pick writes and closes it.
    send_detail(
        &mut d,
        i,
        de::Kind::FieldOpened(de::FieldOpened {
            field: "when".into(),
        }),
    );
    assert_eq!(detail(d.view(i)).open_field, "when");
    let picked = day(&d, 9);
    send_detail(
        &mut d,
        i,
        de::Kind::DatePicked(de::DatePicked {
            day: picked.clone(),
        }),
    );
    assert_eq!(detail(d.view(i)).open_field, "");
    assert_eq!(task_of(&d, &id).due_local, format!("{picked}T09:00"));
    // A pick that is not a day is only a close.
    send_detail(
        &mut d,
        i,
        de::Kind::FieldOpened(de::FieldOpened {
            field: "when".into(),
        }),
    );
    send_detail(
        &mut d,
        i,
        de::Kind::DatePicked(de::DatePicked { day: "soon".into() }),
    );
    assert_eq!(detail(d.view(i)).open_field, "");
    assert_eq!(task_of(&d, &id).due_day, picked);
    send_detail(
        &mut d,
        i,
        de::Kind::FieldOpened(de::FieldOpened {
            field: "time".into(),
        }),
    );
    send_detail(&mut d, i, de::Kind::FieldClosed(de::FieldClosed {}));
    assert_eq!(detail(d.view(i)).open_field, "");
}

#[test]
fn when_none_clears_the_due_and_the_time_chip_clears_the_time() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    choose(&mut d, i, "time", "none");
    let stored = task_of(&d, &id);
    assert_eq!(
        (stored.due_time.as_str(), stored.due_day.as_str()),
        ("", day(&d, 4).as_str())
    );
    assert_eq!(field(d.view(i), "time").value, "No time");
    choose(&mut d, i, "when", "none");
    assert_eq!(task_of(&d, &id).due_day, "");
    assert_eq!(field(d.view(i), "when").value, "No date");
}

#[test]
fn a_time_picked_is_written_on_the_due_day_and_a_bad_one_is_nothing() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    send_detail(
        &mut d,
        i,
        de::Kind::TimePicked(de::TimePicked {
            time: "18:30".into(),
        }),
    );
    assert_eq!(task_of(&d, &id).due_local, format!("{}T18:30", day(&d, 4)));
    send_detail(
        &mut d,
        i,
        de::Kind::TimePicked(de::TimePicked {
            time: "25:99".into(),
        }),
    );
    assert_eq!(task_of(&d, &id).due_time, "18:30");
    // Undated, a time lands on the core's today.
    let loose = task(&d, "Loose");
    let j = open(&mut d, &loose);
    send_detail(
        &mut d,
        j,
        de::Kind::TimePicked(de::TimePicked {
            time: "07:15".into(),
        }),
    );
    assert_eq!(
        task_of(&d, &loose).due_local,
        format!("{}T07:15", today(&d))
    );
}

#[test]
fn reminder_repeats_priority_and_effort_are_each_one_write() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    choose(&mut d, i, "reminder", "30");
    assert_eq!(task_of(&d, &id).remind_before_min, Some(30));
    choose(&mut d, i, "reminder", "none");
    assert_eq!(task_of(&d, &id).remind_before_min, None);
    choose(&mut d, i, "repeats", "weekly");
    let stored = task_of(&d, &id);
    assert!(stored.repeats);
    assert_eq!(stored.rrule.as_deref(), Some("FREQ=WEEKLY"));
    assert_eq!(selected(field(d.view(i), "repeats")), "weekly");
    // Repeating adds the Anchor field, and choosing it writes it.
    choose(&mut d, i, "anchor", "completion");
    assert_eq!(
        task_of(&d, &id).recurrence_anchor.as_deref(),
        Some("completion")
    );
    assert_eq!(selected(field(d.view(i), "anchor")), "completion");
    choose(&mut d, i, "repeats", "none");
    assert!(!task_of(&d, &id).repeats);
    choose(&mut d, i, "priority", "3");
    assert_eq!(task_of(&d, &id).priority, 3);
    assert_eq!(field(d.view(i), "priority").value, "Now");
    choose(&mut d, i, "effort", "25");
    assert_eq!(task_of(&d, &id).effort_min, Some(25));
    assert_eq!(field(d.view(i), "effort").value, "~25 min");
    choose(&mut d, i, "effort", "none");
    assert_eq!(task_of(&d, &id).effort_min, None);
    assert_eq!(field(d.view(i), "effort").value, "—");
    choose(&mut d, i, "effort", "60");
    assert_eq!(field(d.view(i), "effort").value, "~1 hour");
}

#[test]
fn a_reminder_or_repeat_needs_a_due_date_and_writes_nothing_without_one() {
    let mut d = driver();
    let id = task(&d, "Idea");
    let i = open(&mut d, &id);
    let before = task_of(&d, &id).updated_at;
    choose(&mut d, i, "reminder", "30");
    choose(&mut d, i, "repeats", "weekly");
    assert_eq!(task_of(&d, &id).updated_at, before);
    assert!(detail(d.view(i)).status.is_none());
}

#[test]
fn a_choice_already_so_is_nothing_and_made_again_later_is_a_new_command() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    let before = task_of(&d, &id).updated_at;
    choose(&mut d, i, "priority", "none");
    choose(&mut d, i, "effort", "none");
    choose(&mut d, i, "bogus", "x");
    choose(&mut d, i, "priority", "9");
    assert_eq!(task_of(&d, &id).updated_at, before);
    // Now, Soon, Now again: each a command of its own, so none is a replay.
    choose(&mut d, i, "priority", "3");
    choose(&mut d, i, "priority", "1");
    assert_eq!(task_of(&d, &id).priority, 1);
    choose(&mut d, i, "priority", "3");
    assert_eq!(task_of(&d, &id).priority, 3);
}

#[test]
fn a_choice_reopened_on_a_later_visit_is_not_a_replay_of_an_earlier_one() {
    // The vault journals an invoke key for good: a counter a page restarts at
    // one on every visit would turn the same tap on a second visit into a
    // silent no-op.
    let mut d = driver();
    let id = rent(&d);
    let first = open(&mut d, &id);
    choose(&mut d, first, "priority", "3");
    d.pop(agenda::TAB, first);
    arrange(
        &d,
        act::agenda::EditTask {
            task_id: id.clone(),
            priority: Some(0),
            ..Default::default()
        },
    );
    let second = open(&mut d, &id);
    choose(&mut d, second, "priority", "3");
    assert_eq!(task_of(&d, &id).priority, 3);
}

#[test]
fn a_tag_is_added_and_its_chip_removes_it() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    send_detail(
        &mut d,
        i,
        de::Kind::TagAdded(de::TagAdded { label: "  ".into() }),
    );
    assert!(task_of(&d, &id).tags.is_empty());
    send_detail(
        &mut d,
        i,
        de::Kind::TagAdded(de::TagAdded {
            label: "home".into(),
        }),
    );
    let tags = field(d.view(i), "tags");
    assert_eq!(tags.value, "#home");
    assert_eq!(tags.note, "Removing a tag affects only this task.");
    assert!(tags.add_text);
    assert_eq!(tags.add_placeholder, "Add a tag");
    let chip = tags.choices[0].key.clone();
    choose(&mut d, i, "tags", &chip);
    assert!(task_of(&d, &id).tags.is_empty());
    assert_eq!(field(d.view(i), "tags").value, "—");
}

#[test]
fn a_refused_field_write_says_the_cores_sentence_on_the_status_line() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    arrange(
        &d,
        act::agenda::DeleteTask {
            task_id: id.clone(),
        },
    );
    choose(&mut d, i, "priority", "3");
    let status = detail(d.view(i)).status.clone().expect("a status line");
    assert!(status.refused);
    assert!(!status.sentence.is_empty());
}

#[test]
fn a_field_write_clears_the_old_status_line() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    send_detail(&mut d, i, de::Kind::Check(de::CheckTapped {}));
    assert!(detail(d.view(i)).status.is_some());
    choose(&mut d, i, "priority", "2");
    assert!(detail(d.view(i)).status.is_none());
}

#[test]
fn quick_picks_fall_on_the_cores_today_this_weekend_and_next_monday() {
    // Monday 2026-06-15.
    assert_eq!(
        detail::day_for("today", "2026-06-15").as_deref(),
        Some("2026-06-15")
    );
    assert_eq!(
        detail::day_for("tomorrow", "2026-06-15").as_deref(),
        Some("2026-06-16")
    );
    assert_eq!(
        detail::day_for("weekend", "2026-06-15").as_deref(),
        Some("2026-06-20")
    );
    assert_eq!(
        detail::day_for("next_week", "2026-06-15").as_deref(),
        Some("2026-06-22")
    );
    // On a Sunday this weekend is today; next week is tomorrow.
    assert_eq!(
        detail::day_for("weekend", "2026-06-21").as_deref(),
        Some("2026-06-21")
    );
    assert_eq!(
        detail::day_for("next_week", "2026-06-21").as_deref(),
        Some("2026-06-22")
    );
    assert_eq!(detail::day_for("someday", "2026-06-15"), None);
    assert_eq!(detail::day_for("today", ""), None);
}

// -----------------------------------------------------------------------------
// The box, subtasks, parent
// -----------------------------------------------------------------------------

#[test]
fn the_box_completes_the_task_and_the_page_shows_it_done_with_undo() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    assert_eq!(detail_data(d.view(i)).status_label, "");
    send_detail(&mut d, i, de::Kind::Check(de::CheckTapped {}));
    let v = d.view(i);
    assert_eq!(detail_data(v).check, wire::TodoCheck::Done as i32);
    assert_eq!(detail_data(v).status_label, "Done");
    assert!(!detail_data(v).can_release);
    let status = detail(v).status.clone().unwrap();
    assert_eq!(
        (status.sentence.as_str(), status.action_label.as_str()),
        ("Task done", "Undo")
    );
    assert_eq!(detail_data(v).check_label, "Reopen Rent");
    send_detail(&mut d, i, de::Kind::StatusActed(de::StatusActed {}));
    assert_eq!(detail_data(d.view(i)).check, wire::TodoCheck::Open as i32);
}

#[test]
fn subtasks_count_what_is_done_are_added_as_a_write_and_stay_one_level() {
    let mut d = driver();
    let parent = task(&d, "Move house");
    let boxes = add(
        &d,
        act::agenda::AddTask {
            title: "Boxes".into(),
            parent_id: Field::Is(parent.clone()),
            ..Default::default()
        },
    );
    let van = add(
        &d,
        act::agenda::AddTask {
            title: "Van".into(),
            parent_id: Field::Is(parent.clone()),
            ..Default::default()
        },
    );
    complete(&d, &van);
    let i = open(&mut d, &parent);
    let data = detail_data(d.view(i));
    assert_eq!(data.subtasks_label, "Subtasks · 1 of 2");
    assert_eq!(data.subtasks.len(), 2);
    assert!(data.can_add_subtask);
    assert!(data.subtasks.iter().all(|s| s.subtask));
    for row in &data.subtasks {
        assert_eq!(row.route, Some(routes::task(&row.task_id)));
    }

    send_detail(
        &mut d,
        i,
        de::Kind::SubtaskAdded(de::SubtaskAdded { title: "  ".into() }),
    );
    assert_eq!(detail_data(d.view(i)).subtasks.len(), 2);
    send_detail(
        &mut d,
        i,
        de::Kind::SubtaskAdded(de::SubtaskAdded {
            title: "Keys".into(),
        }),
    );
    let titles: Vec<String> = detail_data(d.view(i))
        .subtasks
        .iter()
        .map(|s| s.title.clone())
        .collect();
    assert_eq!(titles.len(), 3);
    assert!(titles.contains(&"Keys".to_owned()));
    assert_eq!(detail_data(d.view(i)).subtasks_label, "Subtasks · 1 of 3");

    // The subtask's own box.
    send_detail(
        &mut d,
        i,
        de::Kind::SubtaskChecked(de::SubtaskChecked {
            task_id: boxes.clone(),
        }),
    );
    assert_eq!(task_of(&d, &boxes).status, "done");
    assert_eq!(detail_data(d.view(i)).subtasks_label, "Subtasks · 2 of 3");
    assert_eq!(
        detail(d.view(i)).status.as_ref().unwrap().sentence,
        "Task done"
    );

    // The subtask's page: no subtasks of its own, and the way up.
    let child = open(&mut d, &boxes);
    let data = detail_data(d.view(child));
    assert!(!data.can_add_subtask);
    assert_eq!(data.subtask_note, "Subtasks can't have subtasks.");
    assert_eq!(data.parent_title, "Move house");
    assert_eq!(data.parent_route, Some(routes::task(&parent)));
    send_detail(
        &mut d,
        child,
        de::Kind::SubtaskAdded(de::SubtaskAdded {
            title: "Tape".into(),
        }),
    );
    assert!(detail_data(d.view(child)).subtasks.is_empty());
    assert!(
        !field(d.view(child), "project").enabled,
        "a subtask is filed with its parent"
    );
    // A top-level task has no way up.
    assert_eq!(detail_data(d.view(i)).parent_route, None);
}

// -----------------------------------------------------------------------------
// Delete and release
// -----------------------------------------------------------------------------

#[test]
fn delete_asks_in_full_sentences_then_trashes_and_ends_the_screen() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    send_detail(&mut d, i, de::Kind::Delete(de::DeleteRequested {}));
    let state = detail(d.view(i));
    let confirm = state.confirm.as_ref().expect("a confirm");
    assert_eq!(confirm.title, "Delete this task?");
    assert!(confirm.destructive);
    // Dismissed, nothing is written.
    send_detail(&mut d, i, de::Kind::Dismissed(de::Dismissed {}));
    assert!(detail(d.view(i)).confirm.is_none());
    assert_eq!(task_of(&d, &id).status, "open");
    send_detail(&mut d, i, de::Kind::Delete(de::DeleteRequested {}));
    send_detail(&mut d, i, de::Kind::Confirmed(de::Confirmed {}));
    let state = detail(d.view(i));
    assert!(state.finished);
    assert_eq!(state.status.as_ref().unwrap().sentence, "Task deleted");
    assert!(state.confirm.is_none());
    // It is in the trash.
    let trash_page = d.push(agenda::TAB, routes::trash());
    assert!(
        trash_data(d.view(trash_page))
            .rows
            .iter()
            .any(|row| row.id == id)
    );
}

#[test]
fn closing_a_deleted_task_does_not_save_its_unsaved_words() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    typed_title(&mut d, i, "Rent, never saved");
    send_detail(&mut d, i, de::Kind::Delete(de::DeleteRequested {}));
    send_detail(&mut d, i, de::Kind::Confirmed(de::Confirmed {}));
    d.pop(agenda::TAB, i);
    d.pump(DEBOUNCED);
    let trash_page = d.push(agenda::TAB, routes::trash());
    let row = trash_data(d.view(trash_page))
        .rows
        .iter()
        .find(|row| row.id == id)
        .cloned()
        .expect("trashed");
    assert_eq!(row.title, "Rent");
}

#[test]
fn release_destroys_nothing_and_goes_to_the_logbook_as_wont_do() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    send_detail(&mut d, i, de::Kind::Release(de::ReleaseRequested {}));
    let state = detail(d.view(i));
    let confirm = state.confirm.as_ref().unwrap();
    assert_eq!(confirm.title, "Release this task?");
    assert!(!confirm.destructive);
    assert!(detail_data(d.view(i)).can_release);
    send_detail(&mut d, i, de::Kind::Confirmed(de::Confirmed {}));
    let v = d.view(i);
    assert_eq!(detail(v).status.as_ref().unwrap().sentence, "Task released");
    assert!(!detail(v).finished);
    assert_eq!(detail_data(v).check, wire::TodoCheck::WontDo as i32);
    assert_eq!(detail_data(v).status_label, "Won't do");
    assert!(!detail_data(v).can_release);
    assert_eq!(task_of(&d, &id).status, "cancelled");
}

#[test]
fn a_confirm_that_was_never_asked_does_nothing() {
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    send_detail(&mut d, i, de::Kind::Confirmed(de::Confirmed {}));
    assert_eq!(task_of(&d, &id).status, "open");
    assert!(!detail(d.view(i)).finished);
}

#[test]
fn a_repeated_task_page_row_is_priority_and_check_words_from_the_row_law() {
    // The page's own check label is the row law's, not a second copy.
    let mut d = driver();
    let id = rent(&d);
    let i = open(&mut d, &id);
    assert_eq!(
        detail_data(d.view(i)).check_label,
        rows::check_label(Locale::En, "Rent", true)
    );
}
