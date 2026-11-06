//! Calendar geometry is civil-day arithmetic in Rust; shells only lay out these cells.
use centraid_api_proto::core_v1 as wire;

use super::{Home, fold};
use crate::agenda::{routes, todo::rows};
use crate::kit::civil;
use crate::strings::{Locale, agenda as words};

pub const VIEWS: [&str; 6] = ["day", "week", "month", "month_list", "year", "list"];

pub fn window(view: &str, anchor: &str) -> (String, i64) {
    let first = format!("{}-01", anchor.get(..7).unwrap_or_default());
    let monday = |day: &str| {
        civil::plus_days(day, 1 - i64::from(civil::iso_weekday_of(day).unwrap_or(1)))
            .unwrap_or_else(|| day.to_owned())
    };
    match view {
        "day" | "week" => (monday(anchor), 7),
        "month" | "month_list" => (monday(&first), 42),
        "year" => (
            format!("{}-01-01", anchor.get(..4).unwrap_or_default()),
            366,
        ),
        _ => (anchor.to_owned(), super::held::LIST_DAYS),
    }
}

pub fn build(home: &Home, locale: Locale, zone: &str) -> wire::AgendaCalendarGrid {
    let key = home.calendar_view.as_str();
    let labels = [
        words::view_day(locale),
        words::view_week(locale),
        words::view_month(locale),
        words::view_month_list(locale),
        words::view_year(locale),
        words::view_list(locale),
    ];
    let choices = VIEWS
        .into_iter()
        .zip(labels)
        .map(|(view, label)| wire::TodoChoice {
            key: view.to_owned(),
            label,
            selected: view == key,
            enabled: true,
            ..Default::default()
        })
        .collect();
    let mut result = wire::AgendaCalendarGrid {
        view_key: key.to_owned(),
        view_label: words::calendar_view(locale),
        view_choices: choices,
        today_label: words::today(locale),
        previous_days: -7,
        next_days: 7,
        ..Default::default()
    };
    if civil::epoch_day_of(&home.anchor).is_none() {
        return result;
    }
    let (start, span) = window(key, &home.anchor);
    match key {
        "year" => {
            result.previous_days = period_step(&home.anchor, -12);
            result.next_days = period_step(&home.anchor, 12);
            for month in 1..=12 {
                let first = format!("{}-{month:02}-01", &home.anchor[..4]);
                let (start, _) = window("month", &first);
                result.panels.push(panel(
                    home,
                    locale,
                    &start,
                    42,
                    &first,
                    civil::month_name(locale, month),
                ));
            }
        }
        "month" | "month_list" => {
            result.previous_days = period_step(&home.anchor, -1);
            result.next_days = period_step(&home.anchor, 1);
            result.panels.push(panel(
                home,
                locale,
                &start,
                span,
                &home.anchor,
                rows::month_year(locale, &home.anchor),
            ));
        }
        "list" => {
            result.previous_days = -1;
            result.next_days = 1;
        }
        _ => result.panels.push(panel(
            home,
            locale,
            &start,
            span,
            &home.anchor,
            String::new(),
        )),
    }
    if matches!(key, "day" | "week") {
        let days = if key == "week" {
            (0..7).filter_map(|n| civil::plus_days(&start, n)).collect()
        } else {
            vec![home.anchor.clone()]
        };
        result.hour_days = days
            .iter()
            .map(|day| hours(home, locale, day, zone))
            .collect();
    }
    result
}

fn month_length(day: &str, offset: i32) -> i32 {
    let year: i32 = day[..4].parse().unwrap_or(1970);
    let month: i32 = day[5..7].parse().unwrap_or(1);
    let total = year * 12 + month - 1 + offset;
    let first = format!(
        "{:04}-{:02}-01",
        total.div_euclid(12),
        total.rem_euclid(12) + 1
    );
    let next = total + 1;
    let end = format!(
        "{:04}-{:02}-01",
        next.div_euclid(12),
        next.rem_euclid(12) + 1
    );
    (civil::epoch_day_of(&end).unwrap_or_default()
        - civil::epoch_day_of(&first).unwrap_or_default()) as i32
}

/// Preserve the selected day when possible, clamping 31st/leap days to the
/// destination month's last day. Adding the old month's length can skip a month.
fn period_step(day: &str, months: i32) -> i32 {
    let year: i32 = day[..4].parse().unwrap_or(1970);
    let month: i32 = day[5..7].parse().unwrap_or(1);
    let total = year * 12 + month - 1 + months;
    let first = format!(
        "{:04}-{:02}-01",
        total.div_euclid(12),
        total.rem_euclid(12) + 1
    );
    let date = civil::day_of_month_of(day)
        .unwrap_or(1)
        .min(month_length(&first, 0) as u32);
    let target = format!("{}-{date:02}", &first[..7]);
    (civil::epoch_day_of(&target).unwrap_or_default()
        - civil::epoch_day_of(day).unwrap_or_default()) as i32
}

fn panel(
    home: &Home,
    locale: Locale,
    start: &str,
    span: i64,
    month: &str,
    title: String,
) -> wire::AgendaCalendarPanel {
    let days = (0..span)
        .filter_map(|n| civil::plus_days(start, n))
        .map(|day| {
            let has_event = home.held.upcoming.as_ref().is_some_and(|upcoming| {
                upcoming.events.iter().any(|event| {
                    event.local_days.contains(&day)
                        && event
                            .calendar_id
                            .as_ref()
                            .is_none_or(|id| !home.hidden.contains(id))
                })
            });
            let has_task = home
                .held
                .tasks()
                .iter()
                .any(|task| task.due_day == day && rows::is_open(task));
            wire::AgendaCalendarDay {
                label: civil::day_of_month_of(&day).unwrap_or_default().to_string(),
                weekday: civil::weekday_short(locale, &day),
                accessibility_label: fold::long_day(locale, &day),
                selected: day == home.anchor,
                today: day == home.today,
                in_month: day.get(..7) == month.get(..7),
                has_items: has_event || has_task,
                day,
            }
        })
        .collect();
    wire::AgendaCalendarPanel { title, days }
}

const DAY_MS: i64 = 86_400_000;

fn event_offsets(event: &wire::AgendaEvent, day: &str, zone: &str) -> Option<(i64, i64, bool)> {
    use centraid_vault::time::{
        recurrence::{Semantics, parse_instant_ms},
        zone::{FireZone, parse_wall_iso, wall_epoch},
    };
    if event.all_day {
        return None;
    }
    let semantics = Semantics::from_stored(event.recurrence_semantics.as_deref());
    let zone = FireZone::named(zone).ok()?;
    let wall = |value: &str| match semantics {
        Semantics::Zoned => parse_instant_ms(value).map(|instant| zone.zoned_parts(instant)),
        Semantics::Floating => parse_wall_iso(value),
        Semantics::AllDay => None,
    };
    let midnight = wall_epoch(parse_wall_iso(day)?);
    let start = wall_epoch(wall(&event.dtstart)?) - midnight;
    let mut end = event
        .dtend
        .as_deref()
        .and_then(wall)
        .map_or(start, |value| wall_epoch(value) - midnight);
    // The second occurrence of a fall-back hour can end before its start on
    // the civil ruler. Draw its positive elapsed span instead of an empty
    // block; the row still states both original wall-clock labels. Gesture
    // deltas remain civil minutes, as adjusted_times requires.
    if end <= start
        && semantics == Semantics::Zoned
        && let Some(elapsed) = event
            .dtend
            .as_deref()
            .and_then(parse_instant_ms)
            .zip(parse_instant_ms(&event.dtstart))
            .map(|(end, start)| end - start)
            .filter(|elapsed| *elapsed > 0)
    {
        end = start + elapsed;
    }
    Some((
        start.clamp(0, DAY_MS),
        end.max(start).clamp(0, DAY_MS),
        end <= DAY_MS,
    ))
}

/// Reuse lanes only after an item ends; all members of an overlapping group
/// share its maximum lane count so multi-hour blocks never cover one another.
fn lanes(items: &mut [wire::AgendaTimelineItem]) {
    let mut order: Vec<usize> = (0..items.len())
        .filter(|&i| {
            !matches!(
                items[i].row.as_ref().and_then(|row| row.kind.as_ref()),
                Some(wire::agenda_row_item::Kind::NowLine(_))
            )
        })
        .collect();
    order.sort_by_key(|&i| (items[i].start_offset_ms, items[i].end_offset_ms, i));
    let mut group = Vec::new();
    let mut ends: Vec<i64> = Vec::new();
    let finish = |group: &mut Vec<usize>, count: usize, items: &mut [wire::AgendaTimelineItem]| {
        for index in group.drain(..) {
            items[index].lane_count = u32::try_from(count).unwrap_or(u32::MAX);
        }
    };
    for index in order {
        let start = items[index].start_offset_ms;
        if !ends.is_empty() && ends.iter().all(|end| *end <= start) {
            finish(&mut group, ends.len(), items);
            ends.clear();
        }
        let lane = ends
            .iter()
            .position(|end| *end <= start)
            .unwrap_or(ends.len());
        let end = items[index].end_offset_ms.max(start + 1);
        if lane == ends.len() {
            ends.push(end);
        } else {
            ends[lane] = end;
        }
        items[index].lane = u32::try_from(lane).unwrap_or(u32::MAX);
        group.push(index);
    }
    finish(&mut group, ends.len(), items);
}

fn clock_offset(day: &str, time: &str) -> Option<i64> {
    use centraid_vault::time::zone::{parse_wall_iso, wall_epoch};
    Some(wall_epoch(parse_wall_iso(&format!("{day}T{time}"))?) - wall_epoch(parse_wall_iso(day)?))
}

fn hours(home: &Home, locale: Locale, day: &str, zone: &str) -> wire::AgendaHourDay {
    let mut result = wire::AgendaHourDay {
        day: day.to_owned(),
        heading: fold::long_day(locale, day),
        duration_ms: DAY_MS,
        ..Default::default()
    };
    for hour in 0..24 {
        let time = format!("{hour:02}:00");
        let mut route = routes::editor("", "", None, day, wire::AgendaEditorKind::Event);
        if let Some(wire::route::Args::AgendaEditor(args)) = &mut route.args {
            args.start_time.clone_from(&time);
        }
        result.hours.push(wire::AgendaHourSlot {
            key: format!("{day}T{time}"),
            label: time,
            create_route: Some(route),
            offset_ms: hour * 3_600_000,
        });
    }
    let data = fold::events(&fold::Fold {
        locale,
        destination: wire::AgendaDestination::Day,
        anchor: day,
        term: None,
        hidden: &home.hidden,
        held: &home.held,
    });
    for mut item in data
        .into_iter()
        .flat_map(|data| data.days)
        .flat_map(|section| section.items)
    {
        let offsets = match &mut item.kind {
            Some(wire::agenda_row_item::Kind::Event(row)) => home
                .held
                .upcoming
                .as_ref()
                .and_then(|upcoming| {
                    upcoming
                        .events
                        .iter()
                        .find(|event| event.instance_key == row.instance_key)
                })
                .and_then(|event| event_offsets(event, day, zone))
                .map(|(start, end, ends_here)| {
                    // A clipped continuation has no end handle on this day.
                    if !ends_here {
                        row.adjustments.retain(|option| !option.resize);
                    }
                    (start, end)
                }),
            Some(wire::agenda_row_item::Kind::Task(row)) => home
                .held
                .find(&row.task_id)
                .and_then(|task| clock_offset(day, &task.due_time))
                .map(|offset| (offset, offset)),
            Some(wire::agenda_row_item::Kind::NowLine(now)) => {
                clock_offset(day, &now.label).map(|offset| (offset, offset))
            }
            None => None,
        };
        if let Some((start_offset_ms, end_offset_ms)) = offsets {
            result.timeline.push(wire::AgendaTimelineItem {
                row: Some(item),
                start_offset_ms,
                end_offset_ms,
                lane: 0,
                lane_count: 1,
            });
        } else {
            result.all_day.push(item);
        }
    }
    lanes(&mut result.timeline);
    result
}

pub fn adjusted_times(
    event: &wire::AgendaEvent,
    display_zone: &str,
    delta: i32,
    resize: bool,
) -> Option<(String, String)> {
    use centraid_vault::time::{
        recurrence::{Semantics, parse_instant_ms},
        zone::{FireZone, parse_wall_iso, wall_epoch, wall_from_epoch, wall_iso},
    };
    let semantics = Semantics::from_stored(event.recurrence_semantics.as_deref());
    if semantics == Semantics::AllDay {
        return None;
    }
    let zone = FireZone::named(display_zone).ok()?;
    // Local display strings intentionally stop at minutes. Move the canonical
    // occurrence times so an imported event's seconds and fractions survive.
    let wall = |value: &str| match semantics {
        Semantics::Zoned => parse_instant_ms(value).map(|instant| zone.zoned_parts(instant)),
        Semantics::Floating => parse_wall_iso(value),
        Semantics::AllDay => None,
    };
    let start = wall_epoch(wall(&event.dtstart)?);
    let end = event
        .dtend
        .as_deref()
        .and_then(wall)
        .map(wall_epoch)
        .unwrap_or(start + 3_600_000);
    let offset = i64::from(delta) * 60_000;
    let moved_start = if resize { start } else { start + offset };
    let moved_end = end + offset;
    if moved_end <= moved_start {
        return None;
    }
    Some((
        wall_iso(wall_from_epoch(moved_start), true),
        wall_iso(wall_from_epoch(moved_end), true),
    ))
}

/// A drag is expressed in the visible zone. Preserve the event's named zone
/// when saving its changed wall clock; a London view must not re-zone a New
/// York event. Spring-gap wall clocks are refused by the one zone resolver.
pub fn in_event_zone(value: &str, display_zone: &str, event_zone: &str) -> Option<String> {
    use centraid_vault::time::{
        recurrence::parse_instant_ms,
        zone::{FireZone, parse_wall_iso, wall_iso},
    };
    if display_zone == event_zone {
        return Some(value.to_owned());
    }
    let instant = FireZone::named(display_zone)
        .ok()?
        .resolve_wall_time(parse_wall_iso(value)?)?;
    let target = FireZone::named(event_zone).ok()?;
    Some(wall_iso(
        target.zoned_parts(parse_instant_ms(&instant.instant)?),
        true,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn now_line_uses_the_core_clock_label_and_untimed_tasks_stay_outside_the_axis() {
        let now = civil::clock("2026-06-17T09:42");
        assert_eq!(clock_offset("2026-06-17", &now), Some(34_920_000));
        assert_eq!(clock_offset("2026-06-17", ""), None);
    }

    #[test]
    fn timeline_clips_each_day_without_rounding_canonical_milliseconds() {
        let event = wire::AgendaEvent {
            dtstart: "2026-06-16T23:15:30.125".into(),
            dtend: Some("2026-06-17T01:45:15.750".into()),
            recurrence_semantics: Some("floating".into()),
            ..Default::default()
        };
        assert_eq!(
            event_offsets(&event, "2026-06-16", "UTC"),
            Some((83_730_125, DAY_MS, false))
        );
        assert_eq!(
            event_offsets(&event, "2026-06-17", "UTC"),
            Some((0, 6_315_750, true))
        );
        let zoned = wire::AgendaEvent {
            dtstart: "2026-06-17T03:15:30.125Z".into(),
            dtend: Some("2026-06-17T05:45:15.750Z".into()),
            recurrence_semantics: Some("zoned".into()),
            ..event
        };
        assert_eq!(
            event_offsets(&zoned, "2026-06-16", "America/New_York"),
            Some((83_730_125, DAY_MS, false))
        );
        assert_eq!(
            event_offsets(&zoned, "2026-06-17", "America/New_York"),
            Some((0, 6_315_750, true))
        );
    }

    #[test]
    fn a_positive_duration_across_the_repeated_hour_never_collapses() {
        let event = wire::AgendaEvent {
            dtstart: "2026-11-01T05:45:00.125Z".into(),
            dtend: Some("2026-11-01T06:15:00.750Z".into()),
            recurrence_semantics: Some("zoned".into()),
            ..Default::default()
        };
        let (start, end, ends_here) =
            event_offsets(&event, "2026-11-01", "America/New_York").expect("placed");
        assert!(ends_here);
        assert_eq!(start, 6_300_125);
        assert_eq!(end - start, 1_800_625);
    }

    #[test]
    fn overlap_groups_get_distinct_lanes_and_touching_events_reuse_them() {
        let block = |start, end| wire::AgendaTimelineItem {
            start_offset_ms: start,
            end_offset_ms: end,
            row: Some(wire::AgendaRowItem {
                kind: Some(wire::agenda_row_item::Kind::Event(
                    wire::AgendaEventRow::default(),
                )),
            }),
            ..Default::default()
        };
        let mut items = vec![block(9, 12), block(10, 11), block(11, 13), block(13, 14)];
        lanes(&mut items);
        assert_eq!(
            items
                .iter()
                .map(|item| (item.lane, item.lane_count))
                .collect::<Vec<_>>(),
            vec![(0, 2), (1, 2), (1, 2), (0, 1)]
        );
    }

    #[test]
    fn moving_keeps_duration_and_resizing_cannot_reverse_an_event() {
        let event = wire::AgendaEvent {
            dtstart: "2026-01-31T23:30:00.000Z".into(),
            dtend: Some("2026-02-01T00:30:00.000Z".into()),
            recurrence_semantics: Some("zoned".into()),
            local_start: "2026-01-31T23:30".into(),
            local_end: "2026-02-01T00:30".into(),
            ..Default::default()
        };
        assert_eq!(
            adjusted_times(&event, "UTC", 45, false),
            Some(("2026-02-01T00:15:00".into(), "2026-02-01T01:15:00".into()))
        );
        assert_eq!(adjusted_times(&event, "UTC", -60, true), None);
        let precise = wire::AgendaEvent {
            dtstart: "2026-01-31T23:30:15.250".into(),
            dtend: Some("2026-02-01T00:30:45.500".into()),
            recurrence_semantics: Some("floating".into()),
            local_start: "2026-01-31T23:30".into(),
            local_end: "2026-02-01T00:30".into(),
            ..Default::default()
        };
        assert_eq!(
            adjusted_times(&precise, "America/New_York", 45, false),
            Some((
                "2026-02-01T00:15:15.250".into(),
                "2026-02-01T01:15:45.500".into()
            ))
        );
        assert_eq!(
            adjusted_times(&precise, "America/New_York", 15, true),
            Some((
                "2026-01-31T23:30:15.250".into(),
                "2026-02-01T00:45:45.500".into()
            ))
        );
        let zoned = wire::AgendaEvent {
            dtstart: "2026-02-01T04:30:15.250Z".into(),
            dtend: Some("2026-02-01T05:30:45.500Z".into()),
            recurrence_semantics: Some("zoned".into()),
            ..precise
        };
        assert_eq!(
            adjusted_times(&zoned, "America/New_York", 45, false),
            Some((
                "2026-02-01T00:15:15.250".into(),
                "2026-02-01T01:15:45.500".into()
            ))
        );
    }

    #[test]
    fn dragging_in_a_different_zone_preserves_the_events_zone() {
        assert_eq!(
            in_event_zone("2099-06-17T14:30:00", "Europe/London", "America/New_York"),
            Some("2099-06-17T09:30:00".into())
        );
        assert_eq!(
            in_event_zone("2026-03-29T01:30:00", "Europe/London", "America/New_York"),
            None
        );
    }

    #[test]
    fn weeks_and_months_start_on_monday_across_years() {
        assert_eq!(window("week", "2026-01-01"), ("2025-12-29".into(), 7));
        assert_eq!(window("month", "2026-02-28"), ("2026-01-26".into(), 42));
        assert_eq!(month_length("2024-02-29", 0), 29);
        assert_eq!(month_length("2026-01-31", -1), 31);
        assert_eq!(period_step("2100-01-01", 12), 365);
        assert_eq!(
            civil::plus_days("2026-01-31", i64::from(period_step("2026-01-31", 1))),
            Some("2026-02-28".into())
        );
        assert_eq!(
            civil::plus_days("2024-02-29", i64::from(period_step("2024-02-29", 12))),
            Some("2025-02-28".into())
        );
    }
}
