//! The Custom repeat sheet of `agenda.editor` through the door a shell uses:
//! each frequency, interval, weekday, monthly and end combination writes the
//! right rule and says the right sentence; an existing rule opens in the sheet
//! when it can be shown and read-only when it cannot; an unfinished rule says
//! what is missing; a task takes the same sheet; and a series edit offers only
//! the scopes a new rule can reach.

mod agenda_event_support;

use agenda_event_support::World;
use centraid_api_proto::core_v1 as wire;
use centraid_screens::agenda::editor::repeat::{self, End, Freq, MonthMode, Spec};
use centraid_screens::field::Field;
use wire::agenda_editor_event::Kind as K;
use wire::agenda_editor_state::Sheet;
use wire::{AgendaEditorKind as Kind, AgendaScope as Scope};

use wire::agenda_editor_event as events;

/// A Wednesday.
const DAY: &str = "2099-06-17";

fn freq(key: &str) -> K {
    K::CustomFreq(events::CustomFreqPicked { key: key.into() })
}
fn every(interval: i32) -> K {
    K::CustomInterval(events::CustomIntervalChanged { interval })
}
fn weekday(key: &str) -> K {
    K::CustomWeekday(events::CustomWeekdayToggled { key: key.into() })
}
fn month_mode(key: &str) -> K {
    K::CustomMonthMode(events::CustomMonthModePicked { key: key.into() })
}
fn month_day(key: &str) -> K {
    K::CustomMonthDay(events::CustomMonthDayToggled { key: key.into() })
}
fn ordinal(key: &str) -> K {
    K::CustomOrdinal(events::CustomOrdinalPicked { key: key.into() })
}
fn nth_weekday(key: &str) -> K {
    K::CustomNthWeekday(events::CustomNthWeekdayPicked { key: key.into() })
}
fn end(key: &str) -> K {
    K::CustomEnd(events::CustomEndPicked { key: key.into() })
}
fn until(day: &str) -> K {
    K::CustomUntil(events::CustomUntilChanged { day: day.into() })
}
fn count(count: i32) -> K {
    K::CustomCount(events::CustomCountChanged { count })
}
fn done() -> K {
    K::CustomApplied(events::CustomApplied {})
}
fn replace() -> K {
    K::CustomReplace(events::CustomReplaceTapped {})
}
fn pick_repeat(key: &str) -> K {
    K::Repeat(events::RepeatPicked { key: key.into() })
}
fn scope(scope: Scope) -> K {
    K::Scope(events::ScopePicked {
        scope: scope as i32,
    })
}
fn save() -> K {
    K::Save(events::SaveTapped {})
}

fn sheet_of(world: &World, page: u64) -> wire::AgendaCustomRepeatSheet {
    world
        .editor_data(page)
        .custom_repeat
        .clone()
        .expect("the custom repeat sheet is open")
}

fn picked(choices: &[wire::AgendaChoice]) -> Vec<&str> {
    choices
        .iter()
        .filter(|c| c.selected)
        .map(|c| c.key.as_str())
        .collect()
}

/// A new event on the Wednesday with the custom sheet open.
fn open_custom(world: &mut World, kind: Kind) -> u64 {
    let page = world.open_new(DAY, kind);
    world.title(page, "Standup");
    world.send_editor(page, pick_repeat("custom"));
    page
}

#[test]
fn custom_opens_the_sheet_on_a_weekly_rule_for_the_start_weekday() {
    let mut world = World::new();
    let page = open_custom(&mut world, Kind::Event);
    assert_eq!(world.editor_state(page).sheet, Sheet::CustomRepeat as i32);
    let sheet = sheet_of(&world, page);
    assert_eq!(sheet.title, "Custom repeat");
    assert_eq!(picked(&sheet.frequencies), ["weekly"]);
    assert_eq!(picked(&sheet.weekdays), ["WE"]);
    assert_eq!(sheet.interval, 1);
    assert_eq!(sheet.unit_label, "week");
    assert_eq!(sheet.summary, "Every week on Wednesday");
    assert!(sheet.show_weekdays && !sheet.show_month_modes && sheet.can_apply);
    assert!(sheet.error.is_empty() && !sheet.read_only);
    // Nothing is in the draft until Done.
    assert_eq!(world.draft(page).repeat_key, "none");
    // The list of repeats names Custom last.
    let keys: Vec<&str> = world
        .editor_data(page)
        .repeats
        .iter()
        .map(|c| c.key.as_str())
        .collect();
    assert_eq!(keys.last(), Some(&"custom"));
}

/// One combination: the events the member sends, the sentence the sheet says,
/// and the rule Done puts in the draft.
fn combo(events: Vec<K>, summary: &str, rule: &str) {
    let mut world = World::new();
    let page = open_custom(&mut world, Kind::Event);
    for event in events {
        world.send_editor(page, event);
    }
    let sheet = sheet_of(&world, page);
    assert_eq!(sheet.summary, summary, "{rule}");
    assert!(
        sheet.can_apply && sheet.error.is_empty(),
        "{rule}: {sheet:?}"
    );
    world.send_editor(page, done());
    assert_eq!(world.editor_state(page).sheet, Sheet::None as i32);
    let draft = world.draft(page);
    assert_eq!(draft.repeat_key, "custom", "{rule}");
    assert_eq!(draft.repeat_rule, rule);
    // The Repeat row says the same sentence.
    assert_eq!(world.editor_data(page).repeat_label, summary);
}

#[test]
fn every_combination_writes_its_rule_and_says_its_sentence() {
    combo(
        vec![freq("daily"), every(3)],
        "Every 3 days",
        "FREQ=DAILY;INTERVAL=3",
    );
    combo(
        vec![weekday("MO"), weekday("FR")],
        "Every week on Monday, Wednesday and Friday",
        "FREQ=WEEKLY;BYDAY=MO,WE,FR",
    );
    combo(
        vec![every(2), weekday("WE"), weekday("SU")],
        "Every 2 weeks on Sunday",
        "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU",
    );
    combo(
        // The start's own day, the 17th, is picked already.
        vec![freq("monthly"), month_day("1"), month_day("-1")],
        "Every month on the 1st, 17th and last day",
        "FREQ=MONTHLY;BYMONTHDAY=1,17,-1",
    );
    combo(
        vec![freq("monthly"), month_day("17"), month_day("5")],
        "Every month on the 5th",
        "FREQ=MONTHLY;BYMONTHDAY=5",
    );
    combo(
        vec![
            freq("monthly"),
            every(2),
            month_mode("nth"),
            ordinal("-1"),
            nth_weekday("FR"),
        ],
        "Every 2 months on the last Friday",
        "FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR",
    );
    combo(
        vec![freq("monthly"), month_mode("nth")],
        "Every month on the third Wednesday",
        "FREQ=MONTHLY;BYDAY=3WE",
    );
    combo(
        vec![freq("yearly"), every(2)],
        "Every 2 years",
        "FREQ=YEARLY;INTERVAL=2",
    );
    combo(
        vec![end("on"), until("2099-12-31")],
        "Every week on Wednesday, until Thursday 31 December 2099",
        "FREQ=WEEKLY;BYDAY=WE;UNTIL=20991231",
    );
    combo(
        vec![freq("daily"), end("after"), count(12)],
        "Every day, 12 times",
        "FREQ=DAILY;COUNT=12",
    );
    combo(
        vec![freq("daily"), end("after"), count(1)],
        "Every day, once",
        "FREQ=DAILY;COUNT=1",
    );
}

#[test]
fn the_sheet_draws_only_the_controls_the_frequency_uses_and_keeps_the_rest() {
    let mut world = World::new();
    let page = open_custom(&mut world, Kind::Event);
    world.send_editor(page, freq("monthly"));
    let sheet = sheet_of(&world, page);
    assert!(sheet.show_month_modes && sheet.show_month_days && !sheet.show_weekdays);
    assert!(!sheet.show_nth && sheet.unit_label == "month");
    // The start's day of the month is the one picked; the list ends in "Last day".
    assert_eq!(picked(&sheet.month_days), ["17"]);
    assert_eq!(sheet.month_days.len(), 32);
    assert_eq!(
        sheet.month_days.last().map(|c| c.label.as_str()),
        Some("Last day")
    );
    world.send_editor(page, month_mode("nth"));
    let sheet = sheet_of(&world, page);
    assert!(sheet.show_nth && !sheet.show_month_days);
    // Third Wednesday: the start's own place in the month.
    assert_eq!(picked(&sheet.ordinals), ["3"]);
    assert_eq!(picked(&sheet.nth_weekdays), ["WE"]);
    assert_eq!(sheet.ordinals.len(), 5);
    world.send_editor(page, end("after"));
    assert!(sheet_of(&world, page).show_count && !sheet_of(&world, page).show_until);
    world.send_editor(page, end("on"));
    assert!(sheet_of(&world, page).show_until && !sheet_of(&world, page).show_count);
    // Back to weekly: the weekday that was picked is still there.
    world.send_editor(page, freq("weekly"));
    assert_eq!(picked(&sheet_of(&world, page).weekdays), ["WE"]);
    // An unknown key changes nothing.
    world.send_editor(page, freq("hourly"));
    assert_eq!(picked(&sheet_of(&world, page).frequencies), ["weekly"]);
}

#[test]
fn an_unfinished_rule_says_what_is_missing_and_cannot_be_applied() {
    let mut world = World::new();
    let page = open_custom(&mut world, Kind::Event);
    // Weekly with no day.
    world.send_editor(page, weekday("WE"));
    let sheet = sheet_of(&world, page);
    assert_eq!(sheet.error, "Pick at least one day of the week.");
    assert!(!sheet.can_apply && sheet.summary.is_empty());
    world.send_editor(page, done());
    assert_eq!(world.editor_state(page).sheet, Sheet::CustomRepeat as i32);
    assert_eq!(world.draft(page).repeat_key, "none");
    world.send_editor(page, weekday("TU"));
    assert!(sheet_of(&world, page).can_apply);

    // Monthly with no day.
    world.send_editor(page, freq("monthly"));
    world.send_editor(page, month_day("17"));
    assert_eq!(
        sheet_of(&world, page).error,
        "Pick at least one day of the month."
    );
    world.send_editor(page, month_mode("nth"));
    assert!(sheet_of(&world, page).can_apply);
    world.send_editor(page, month_mode("date"));
    world.send_editor(page, month_day("3"));

    // Every 0, and every 100.
    world.send_editor(page, every(0));
    assert_eq!(sheet_of(&world, page).error, "Repeat every 1 to 99 steps.");
    world.send_editor(page, every(100));
    assert_eq!(sheet_of(&world, page).error, "Repeat every 1 to 99 steps.");
    world.send_editor(page, every(4));
    assert!(sheet_of(&world, page).can_apply);

    // An end on no day, then before the start, then on it.
    world.send_editor(page, end("on"));
    assert_eq!(
        sheet_of(&world, page).error,
        "Pick the day the repeat ends on."
    );
    world.send_editor(page, until("not a day"));
    assert_eq!(sheet_of(&world, page).until_day, "");
    world.send_editor(page, until("2099-06-01"));
    assert_eq!(
        sheet_of(&world, page).error,
        "The repeat must end on or after its first day."
    );
    world.send_editor(page, until(DAY));
    assert!(sheet_of(&world, page).can_apply);

    // After zero times.
    world.send_editor(page, end("after"));
    world.send_editor(page, count(0));
    assert_eq!(
        sheet_of(&world, page).error,
        "Repeat between 1 and 999 times."
    );
    world.send_editor(page, count(5));
    world.send_editor(page, done());
    assert_eq!(
        world.draft(page).repeat_rule,
        "FREQ=MONTHLY;INTERVAL=4;BYMONTHDAY=3;COUNT=5"
    );
}

#[test]
fn closing_the_sheet_drops_the_working_rule_and_a_preset_rule_is_its_preset() {
    let mut world = World::new();
    let page = open_custom(&mut world, Kind::Event);
    world.send_editor(page, freq("daily"));
    world.send_editor(page, K::SheetClosed(events::SheetClosed {}));
    assert!(world.editor_data(page).custom_repeat.is_none());
    assert_eq!(world.draft(page).repeat_key, "none");
    // Reopened, it starts over from the draft, not from the dropped edit.
    world.send_editor(page, pick_repeat("custom"));
    assert_eq!(picked(&sheet_of(&world, page).frequencies), ["weekly"]);
    // Daily with no extras is the Daily preset, and no custom rule is kept.
    world.send_editor(page, freq("daily"));
    world.send_editor(page, done());
    let draft = world.draft(page);
    assert_eq!(
        (draft.repeat_key.as_str(), draft.repeat_rule.as_str()),
        ("daily", "")
    );
    assert_eq!(world.editor_data(page).repeat_label, "Every day");
    // Choosing a preset after a custom rule forgets the custom rule.
    world.send_editor(page, pick_repeat("custom"));
    world.send_editor(page, freq("weekly"));
    world.send_editor(page, weekday("FR"));
    world.send_editor(page, done());
    assert_eq!(world.draft(page).repeat_key, "custom");
    world.send_editor(page, pick_repeat("weekly"));
    let draft = world.draft(page);
    assert_eq!(
        (draft.repeat_key.as_str(), draft.repeat_rule.as_str()),
        ("weekly", "")
    );
}

#[test]
fn a_custom_event_rule_saves_through_event_propose_and_reopens_in_the_sheet() {
    let mut world = World::new();
    let page = open_custom(&mut world, Kind::Event);
    world.send_editor(page, every(2));
    world.send_editor(page, weekday("FR"));
    world.send_editor(page, end("after"));
    world.send_editor(page, count(6));
    world.send_editor(page, done());
    world.save(page);
    assert!(world.editor_state(page).dismissed);
    let made = world
        .window("2099-06-01T00:00:00Z", "2099-06-30T00:00:00Z")
        .into_iter()
        .find(|e| e.summary.as_deref() == Some("Standup"))
        .expect("the event was filed");
    let rule = made.rrule.clone().expect("a rule");
    assert_eq!(rule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE,FR;COUNT=6");

    // Open it again: the sheet shows the rule in its parts.
    let edit = world.open_edit(
        &made.event_id,
        &made.instance_key,
        made.original_start_local.as_deref(),
        DAY,
    );
    let draft = world.draft(edit).clone();
    assert_eq!(draft.repeat_key, "custom");
    assert_eq!(draft.repeat_rule, rule);
    world.send_editor(edit, pick_repeat("custom"));
    let sheet = sheet_of(&world, edit);
    assert!(!sheet.read_only);
    assert_eq!(picked(&sheet.frequencies), ["weekly"]);
    assert_eq!(picked(&sheet.weekdays), ["WE", "FR"]);
    assert_eq!((sheet.interval, sheet.count), (2, 6));
    assert_eq!(picked(&sheet.end_modes), ["after"]);
    // Opening it and pressing Done changes nothing the member sees as changed.
    world.send_editor(edit, done());
    assert!(!world.editor_data(edit).dirty);
}

#[test]
fn a_rule_the_sheet_cannot_show_opens_read_only_with_a_choice_to_replace_it() {
    let mut world = World::new();
    // The last weekday of the month: the vault expands it (a BYSETPOS), the
    // sheet cannot show its parts.
    let id = world.propose(
        "Imported",
        "2099-06-17T09:00:00",
        "2099-06-17T10:00:00",
        |p| p.rule = Field::Is("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1".into()),
    );
    let page = world.open_edit(&id, "", None, DAY);
    assert_eq!(world.draft(page).repeat_key, "custom");
    world.send_editor(page, pick_repeat("custom"));
    let sheet = sheet_of(&world, page);
    assert!(sheet.read_only);
    assert_eq!(sheet.replace_label, "Replace this rule");
    assert!(!sheet.summary.is_empty());
    assert!(sheet.frequencies.is_empty() && !sheet.show_weekdays);
    // Edits do nothing while it is read-only, and Done leaves the rule alone.
    world.send_editor(page, freq("weekly"));
    world.send_editor(page, weekday("MO"));
    assert!(sheet_of(&world, page).read_only);
    let before = world.draft(page).repeat_rule.clone();
    world.send_editor(page, done());
    assert_eq!(world.draft(page).repeat_rule, before);
    assert!(!world.editor_data(page).dirty);

    // Replace starts a fresh weekly rule over it.
    world.send_editor(page, pick_repeat("custom"));
    world.send_editor(page, replace());
    let sheet = sheet_of(&world, page);
    assert!(!sheet.read_only);
    assert_eq!(picked(&sheet.frequencies), ["weekly"]);
    world.send_editor(page, done());
    assert_eq!(world.draft(page).repeat_rule, "FREQ=WEEKLY;BYDAY=WE");
    assert!(world.editor_data(page).dirty);
    world.save(page);
    let row = world.event_row(&id).expect("the event");
    assert_eq!(row.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=WE"));
}

#[test]
fn a_new_rule_on_a_series_occurrence_is_offered_for_the_whole_series_alone() {
    let mut world = World::new();
    let id = world.weekdays("Standup");
    let page = world.open_edit(&id, "", Some("2099-06-17T10:00:00"), "2099-06-17");
    world.send_editor(page, pick_repeat("custom"));
    // The rule belongs to the whole series: its sheet opens on the weekdays it has.
    let sheet = sheet_of(&world, page);
    assert_eq!(picked(&sheet.weekdays), ["MO", "TU", "WE", "TH", "FR"]);
    world.send_editor(page, weekday("FR"));
    world.send_editor(page, done());
    assert!(world.editor_data(page).dirty);
    world.send_editor(page, save());
    assert_eq!(world.editor_state(page).sheet, Sheet::Scope as i32);
    let scopes = &world.editor_data(page).scopes;
    let enabled = |wanted: Scope| {
        scopes
            .iter()
            .find(|s| s.scope == wanted as i32)
            .map(|s| s.enabled)
    };
    assert_eq!(enabled(Scope::Series), Some(true));
    assert_eq!(enabled(Scope::Occurrence), Some(false));
    assert_eq!(enabled(Scope::Future), Some(false));
    world.send_editor(page, scope(Scope::Series));
    world.send_editor(page, save());
    assert!(world.editor_state(page).dismissed);
    let row = world.event_row(&id).expect("the event");
    assert_eq!(row.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH"));
}

#[test]
fn the_mapping_is_pure_and_round_trips() {
    let spec = Spec {
        freq: Freq::Monthly,
        month_mode: MonthMode::Nth,
        ordinal: 2,
        nth_day: "TU",
        end: End::After,
        count: 4,
        ..Spec::starting(DAY)
    };
    let rule = repeat::to_rrule(&spec, DAY).expect("a rule");
    assert_eq!(rule, "FREQ=MONTHLY;BYDAY=2TU;COUNT=4");
    assert_eq!(repeat::from_rrule(&rule, DAY), Some(spec));
    assert_eq!(
        repeat::from_rrule("FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR", DAY),
        None
    );
}
