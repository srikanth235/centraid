use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{calendar as reads, entity as entity_reads, reminders as task_reads};
use centraid_domain::read::Args;
use serde_json::{Map, Value, json};

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::first;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::selector::{Act, Handler};
use crate::strings::{Locale, calendar as words, fill, home as home_words, shared};

pub const CALENDAR: &str = "calendar";
pub const CALENDARS: &str = "calendar/calendars";
pub const NEW_EVENT: &str = "calendar/new";
pub const NEW_CALENDAR: &str = "calendar/calendars/new";
pub const IMPORT_ICS: &str = "calendar/import-ics";
pub const TRASH: &str = "calendar/trash";

const EN: Locale = Locale::En;
const VIEW_PREF_KEY: &str = "view.calendar";
const FILTER_NEEDS_REPLY: &str = "filter/needs-reply";
const MAX_TEXT: usize = 300;
const MAX_NOTES: usize = 4_000;
const MAX_ICS: usize = 64_000;

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(CALENDAR, || Box::new(CalendarRoot::default()))
        .exact(CALENDARS, || Box::new(CalendarsPage))
        .exact(NEW_EVENT, || Box::new(EventForm::new_event(None)))
        .exact(NEW_CALENDAR, || Box::new(NewCalendarForm::default()))
        .exact(IMPORT_ICS, || Box::new(ImportIcsRoom::default()))
        .exact(TRASH, || Box::new(CalendarTrash::default()))
        .exact("calendar/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(day) = key.strip_prefix("calendar/new/") {
                return Some(Box::new(EventForm::new_event(Some(day.to_owned()))));
            }
            if let Some(id) = key.strip_prefix("calendar/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("calendar/calendar/")
                && let Some(id) = rest.strip_suffix("/trash-confirm")
            {
                return Some(Box::new(TrashCalendarConfirm { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("calendar/event/") {
                if let Some(id) = rest.strip_suffix("/edit") {
                    return Some(Box::new(EventForm::edit_event(id.to_owned())));
                }
                return Some(Box::new(EventDetailRoom {
                    id: rest.to_owned(),
                }));
            }
            None
        }))
}

fn epoch_ms_to_ymd(ms: i64) -> (i32, u32, u32) {
    let days = ms.div_euclid(86_400_000);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = (yoe as i64) + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + i64::from(m <= 2);
    (year as i32, m as u32, d as u32)
}

fn ymd_to_days(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(y) - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = (y - era * 400) as u64;
    let m_adj = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * m_adj + 2) / 5 + u64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + (doe as i64) - 719_468
}

fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    epoch_ms_to_ymd(days * 86_400_000)
}

fn parse_ymd(day: &str) -> Option<(i32, u32, u32)> {
    let parts: Vec<&str> = day.get(..10)?.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    Some((
        parts[0].parse().ok()?,
        parts[1].parse().ok()?,
        parts[2].parse().ok()?,
    ))
}

fn fmt_ymd(y: i32, m: u32, d: u32) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

fn today_iso(now_ms: i64) -> String {
    let (y, m, d) = epoch_ms_to_ymd(now_ms);
    fmt_ymd(y, m, d)
}

fn now_minute_of(now_ms: i64) -> u32 {
    let secs = now_ms.div_euclid(1_000).rem_euclid(86_400);
    u32::try_from(secs / 60).unwrap_or(0)
}

fn shift_day(day: &str, delta: i64) -> String {
    let Some((y, m, d)) = parse_ymd(day) else {
        return day.to_owned();
    };
    let (ny, nm, nd) = days_to_ymd(ymd_to_days(y, m, d) + delta);
    fmt_ymd(ny, nm, nd)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

fn day_label(day: &str) -> String {
    let Some((y, m, d)) = parse_ymd(day) else {
        return day.to_owned();
    };
    let month = match m {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        12 => "Dec",
        _ => "",
    };
    format!("{d} {month} {y}")
}

fn time_minutes(starts: &str) -> Option<(u32, String)> {
    let t = starts.split('T').nth(1)?;
    let hh: u32 = t.get(0..2)?.parse().ok()?;
    let mm: u32 = t.get(3..5)?.parse().ok()?;
    Some((hh * 60 + mm, format!("{hh:02}:{mm:02}")))
}

fn load_lens(door: &dyn Door) -> String {
    door.device_get(VIEW_PREF_KEY)
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|v| v.get("lens").and_then(Value::as_str).map(str::to_owned))
        .filter(|s| matches!(s.as_str(), "day" | "week" | "month" | "list" | "year"))
        .unwrap_or_else(|| "day".to_owned())
}

fn save_lens(door: &dyn Door, lens: &str) {
    let _ = door.device_put(VIEW_PREF_KEY, &json!({ "v": 1, "lens": lens }).to_string());
}

fn draft_key(door: &dyn Door) -> Option<String> {
    let vault = door.vault_id();
    (!vault.is_empty()).then(|| format!("draft.{vault}.event"))
}

fn calendar_band(b: &mut Build<'_>, active_tab: &str) -> wire::RoomBand {
    let follow_rows = super::follow::items(b, "calendar");
    let sel = &mut b.sel;
    let tabs = vec![
        frame::tab(
            sel,
            "tab/calendar",
            &words::tab_calendar(EN),
            "Calendar",
            active_tab == CALENDAR,
        ),
        frame::tab(
            sel,
            "tab/calendars",
            &words::tab_calendars(EN),
            "List",
            active_tab == CALENDARS,
        ),
    ];
    let mut more_trash = blocks::menu_item(
        sel,
        "more/trash",
        &shared::trash_entry(EN),
        Handler::Open(TRASH.to_owned()),
    );
    more_trash.secondary = shared::trash_entry_meta(EN);
    let mut more_items = vec![
        blocks::menu_item(
            sel,
            "more/import-ics",
            &words::more_import_ics(EN),
            Handler::Open(IMPORT_ICS.to_owned()),
        ),
        blocks::menu_item(
            sel,
            "more/export",
            &words::more_export(EN),
            Handler::Tag("more:export".to_owned()),
        ),
        more_trash,
    ];
    more_items.splice(0..0, follow_rows);
    let more_menu = blocks::menu(
        "band/more/menu",
        vec![blocks::menu_section("", more_items)],
        sel,
    );
    let mut band = frame::band(
        tabs,
        Some(Handler::Tag("nav:home".to_owned())),
        Some(Handler::SearchOpen),
        sel,
    );
    band.more_selector_id = sel.anchor("band/more");
    band.more = Some(more_menu);
    band
}

fn handle_band_tag(e: &mut Event<'_>, tag: &str) -> Option<Outcome> {
    if let Some(outcome) = super::follow::handle(e, tag) {
        return Some(outcome);
    }
    match tag {
        "nav:home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/calendar" => Some(Outcome::replace(CALENDAR)),
        "tab:tab/calendars" => Some(Outcome::replace(CALENDARS)),
        "more:export" => Some(Outcome::say(&words::export_note(EN))),
        _ => None,
    }
}

fn view_enum(lens: &str) -> wire::RoomCalendarView {
    match lens {
        "week" => wire::RoomCalendarView::Week,
        "month" => wire::RoomCalendarView::Month,
        "list" => wire::RoomCalendarView::List,
        "year" => wire::RoomCalendarView::Year,
        _ => wire::RoomCalendarView::Day,
    }
}

fn visible_days(lens: &str, anchor: &str) -> Vec<String> {
    let Some((y, m, _)) = parse_ymd(anchor) else {
        return vec![anchor.to_owned()];
    };
    match lens {
        "week" => (0..7).map(|i| shift_day(anchor, i)).collect(),
        "month" => {
            let count = days_in_month(y, m);
            (1..=count).map(|d| fmt_ymd(y, m, d)).collect()
        }
        "list" => (0..14).map(|i| shift_day(anchor, i)).collect(),
        "year" => (1..=12).map(|mo| fmt_ymd(y, mo, 1)).collect(),
        _ => vec![anchor.to_owned()],
    }
}

fn event_covers_day(ev: &reads::EventSummary, day: &str) -> bool {
    let start_day = ev.starts.get(..10).unwrap_or("");
    let end_day = ev
        .ends
        .as_deref()
        .and_then(|e| e.get(..10))
        .unwrap_or(start_day);
    start_day <= day && end_day >= day
}

#[derive(Default)]
struct CalendarRoot {
    anchor_day: Option<String>,
    lens_loaded: bool,
}

impl RoomScreen for CalendarRoot {
    fn key(&self) -> String {
        CALENDAR.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let today = today_iso(b.door.now_ms());
        if self.anchor_day.is_none() {
            self.anchor_day = Some(today.clone());
        }
        if !self.lens_loaded {
            self.lens_loaded = true;
            if b.ui.lens().is_none() {
                let saved = load_lens(b.door);
                b.ui.set_lens(&saved);
            }
        }
        let anchor = self.anchor_day.clone().unwrap_or_else(|| today.clone());
        let lens = b.ui.lens().unwrap_or("day").to_owned();
        let needs_reply_only = b.ui.is_filtered(FILTER_NEEDS_REPLY);
        let search_term = b.ui.search_term().trim().to_ascii_lowercase();

        let days = visible_days(&lens, &anchor);
        let first_day = days.first().cloned().unwrap_or_else(|| anchor.clone());
        let last_day = days.last().cloned().unwrap_or_else(|| anchor.clone());
        let low = shift_day(&first_day, -7);
        let high = format!("{last_day}T23:59:59.999Z");

        let short_events = match b.run(
            &reads::RANGE_SHORT,
            &Args::new().text("low", &low).text("high", &high),
        ) {
            Ok(ans) => ans.rows,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, CALENDAR)
                    .title(&words::app_title(EN))
                    .band(calendar_band(b, CALENDAR))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let long_events = b
            .run(
                &reads::RANGE_LONG,
                &Args::new().text("low", &first_day).text("high", &high),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let recurring_events = b
            .run(&reads::RECURRING, &Args::new().text("high", &high))
            .map(|a| a.rows)
            .unwrap_or_default();
        let tasks = b
            .run(&task_reads::OPEN_BY_DUE, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();

        let mut all_events: Vec<reads::EventSummary> = Vec::new();
        for ev in short_events
            .into_iter()
            .chain(long_events)
            .chain(recurring_events)
        {
            if !all_events.iter().any(|e| e.id == ev.id) {
                all_events.push(ev);
            }
        }

        let mut filter_items = vec![{
            let mut item = blocks::menu_item(
                &mut b.sel,
                "filter/needs-reply/item",
                &words::filter_needs_reply(EN),
                Handler::Filter(FILTER_NEEDS_REPLY.to_owned()),
            );
            item.checked = needs_reply_only;
            item
        }];
        for (v_id, v_label) in [
            ("day", words::view_day(EN)),
            ("week", words::view_week(EN)),
            ("month", words::view_month(EN)),
            ("list", words::view_list(EN)),
            ("year", words::view_year(EN)),
        ] {
            let mut item = blocks::menu_item(
                &mut b.sel,
                &format!("view/{v_id}"),
                &v_label,
                Handler::Tag(format!("view:{v_id}")),
            );
            item.checked = lens == v_id;
            filter_items.push(item);
        }
        let filter_menu = blocks::menu(
            "header/filter",
            vec![blocks::menu_section(&words::view_label(EN), filter_items)],
            &mut b.sel,
        );

        let view_choice = blocks::choice_block(blocks::choice(
            &mut b.sel,
            "choice/view",
            &words::view_label(EN),
            wire::RoomChoiceStyle::Segmented,
            false,
            vec![
                blocks::option("day", &words::view_day(EN), lens == "day"),
                blocks::option("week", &words::view_week(EN), lens == "week"),
                blocks::option("month", &words::view_month(EN), lens == "month"),
                blocks::option("list", &words::view_list(EN), lens == "list"),
            ],
            "view-choice",
        ));

        let mut grid_days: Vec<wire::RoomCalendarDay> = Vec::new();
        let mut overdue_rows: Vec<wire::RoomBlock> = Vec::new();

        for task in &tasks {
            let Some(due_day) = task.due.as_deref().and_then(|d| d.get(..10)) else {
                continue;
            };
            if due_day < today.as_str() {
                if !search_term.is_empty()
                    && !task.title.to_ascii_lowercase().contains(&search_term)
                {
                    continue;
                }
                if !needs_reply_only {
                    overdue_rows.push(
                        blocks::row(
                            &mut b.sel,
                            &format!("overdue/{}", task.id),
                            &task.title,
                            Handler::Open(format!("reminders/task/{}", task.id)),
                        )
                        .meta(due_day)
                        .chip(blocks::chip(
                            &words::overdue_heading(EN),
                            wire::RoomTone::Warning,
                        ))
                        .into_block(),
                    );
                }
            }
        }

        for day in &days {
            let mut items: Vec<wire::RoomCalendarItem> = Vec::new();
            for ev in &all_events {
                if !event_covers_day(ev, day) {
                    continue;
                }
                if needs_reply_only && !ev.needs_reply {
                    continue;
                }
                if !search_term.is_empty()
                    && !ev.title.to_ascii_lowercase().contains(&search_term)
                    && !ev
                        .location
                        .as_deref()
                        .is_some_and(|l| l.to_ascii_lowercase().contains(&search_term))
                {
                    continue;
                }
                let all_day = ev.timing == "all-day";
                let (start_minute, time_label) = if all_day {
                    (0, words::all_day_label(EN))
                } else {
                    time_minutes(&ev.starts).unwrap_or((0, String::new()))
                };
                let end_minute = if all_day {
                    0
                } else {
                    ev.ends
                        .as_deref()
                        .and_then(time_minutes)
                        .map_or(start_minute.saturating_add(60), |(m, _)| m)
                };
                let sel_id = b.sel.on(
                    format!("cal/{day}/event/{}", ev.id),
                    Handler::Open(format!("calendar/event/{}", ev.id)),
                );
                items.push(wire::RoomCalendarItem {
                    selector_id: sel_id,
                    kind: wire::RoomCalendarItemKind::Event as i32,
                    title: ev.title.clone(),
                    time_label,
                    all_day,
                    start_minute,
                    end_minute,
                    hue_key: String::new(),
                    done: false,
                    overdue: false,
                    needs_reply: ev.needs_reply,
                    a11y_label: ev.title.clone(),
                });
            }

            if !needs_reply_only {
                for task in &tasks {
                    let due_day = task.due.as_deref().and_then(|d| d.get(..10));
                    if due_day != Some(day.as_str()) {
                        continue;
                    }
                    if !search_term.is_empty()
                        && !task.title.to_ascii_lowercase().contains(&search_term)
                    {
                        continue;
                    }
                    let all_day = task.due_timing.as_deref() == Some("all-day");
                    let (start_minute, time_label) = if all_day {
                        (0, words::all_day_label(EN))
                    } else {
                        task.due
                            .as_deref()
                            .and_then(time_minutes)
                            .unwrap_or((0, words::all_day_label(EN)))
                    };
                    let sel_id = b.sel.on(
                        format!("cal/{day}/task/{}", task.id),
                        Handler::Open(format!("reminders/task/{}", task.id)),
                    );
                    items.push(wire::RoomCalendarItem {
                        selector_id: sel_id,
                        kind: wire::RoomCalendarItemKind::Task as i32,
                        title: task.title.clone(),
                        time_label,
                        all_day,
                        start_minute,
                        end_minute: start_minute.saturating_add(30),
                        hue_key: String::new(),
                        done: task.status == "done",
                        overdue: day.as_str() < today.as_str(),
                        needs_reply: false,
                        a11y_label: task.title.clone(),
                    });
                }

                if lens != "year"
                    && let Some(md) = day.get(5..10)
                    && let Ok(dates) =
                        b.run(&reads::PERSON_DATES_ON_MD, &Args::new().text("md", md))
                {
                    for pd in dates.rows {
                        let label = match pd.kind.as_str() {
                            "birthday" => {
                                fill(&words::person_birthday(EN), &[("name", &pd.person_name)])
                            }
                            "anniversary" => {
                                fill(&words::person_anniversary(EN), &[("name", &pd.person_name)])
                            }
                            _ => fill(
                                &words::person_date_labeled(EN),
                                &[
                                    ("name", &pd.person_name),
                                    ("label", pd.label.as_deref().unwrap_or(&pd.kind)),
                                ],
                            ),
                        };
                        if !search_term.is_empty()
                            && !label.to_ascii_lowercase().contains(&search_term)
                        {
                            continue;
                        }
                        let sel_id = b.sel.on(
                            format!("cal/{day}/person-date/{}", pd.id),
                            Handler::Open(format!("person/{}", pd.person_id)),
                        );
                        items.push(wire::RoomCalendarItem {
                            selector_id: sel_id,
                            kind: wire::RoomCalendarItemKind::PersonDate as i32,
                            title: label.clone(),
                            time_label: words::all_day_label(EN),
                            all_day: true,
                            start_minute: 0,
                            end_minute: 0,
                            hue_key: String::new(),
                            done: false,
                            overdue: false,
                            needs_reply: false,
                            a11y_label: label,
                        });
                    }
                }
            }

            grid_days.push(wire::RoomCalendarDay {
                day: day.clone(),
                label: day_label(day),
                today: *day == today,
                selected: *day == anchor,
                in_scope: true,
                more_count: 0,
                items,
            });
        }

        let prev_selector_id = b.sel.on("cal/prev", Handler::Tag("cal:prev".to_owned()));
        let next_selector_id = b.sel.on("cal/next", Handler::Tag("cal:next".to_owned()));
        let today_selector_id = b.sel.on("cal/today", Handler::Tag("cal:today".to_owned()));
        let create_selector_id = blocks::canvas(&mut b.sel, "cal/grid", "cal:canvas");

        let grid = blocks::calendar_grid(wire::RoomCalendarGrid {
            view: view_enum(&lens) as i32,
            anchor_day: anchor.clone(),
            days: grid_days,
            now_minute: now_minute_of(b.door.now_ms()),
            prev_selector_id,
            next_selector_id,
            today_selector_id,
            create_selector_id,
        });

        let mut content = vec![view_choice];
        if anchor == today && !overdue_rows.is_empty() {
            content.push(
                blocks::section(&mut b.sel, "section/overdue", &words::overdue_heading(EN))
                    .blocks(overdue_rows)
                    .into_block(),
            );
        }
        if !first::holds(b, "event") {
            let refused = b.door.permission_refused("calendar").then(|| {
                (
                    home_words::refused_calendar_title(EN),
                    home_words::refused_calendar_body(EN),
                )
            });
            let card = first::first_open(
                b,
                first::FirstOpen {
                    app: "calendar",
                    icon: "Calendar",
                    hue: "",
                    sentence: home_words::first_open_calendar(EN),
                    action: Some((
                        Handler::Tag(format!("{}calendar", first::IMPORT_TAG)),
                        home_words::first_open_import_calendar(EN),
                    )),
                    tail: first::Tail::OrWrite,
                    refused,
                },
            );
            content.push(card);
        }
        content.push(grid);

        let mut frame = room(wire::RoomKind::AppPlace, CALENDAR)
            .title(&words::app_title(EN))
            .filter(&mut b.sel, filter_menu, b.ui)
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_event(EN),
                Handler::Open(format!("calendar/new/{anchor}")),
            )
            .band(calendar_band(b, CALENDAR))
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN));
        if needs_reply_only {
            frame = frame.scope(
                &mut b.sel,
                &words::filter_needs_reply(EN),
                Handler::FilterClear,
            );
        }
        frame.ready(content).build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(out) = handle_band_tag(e, tag) {
            return out;
        }
        let lens = e.ui.lens().unwrap_or("day").to_owned();
        let step_days = match lens.as_str() {
            "week" => 7,
            "month" => 30,
            "list" => 14,
            "year" => 365,
            _ => 1,
        };
        match tag {
            "cal:prev" => {
                let cur = self
                    .anchor_day
                    .clone()
                    .unwrap_or_else(|| today_iso(e.door.now_ms()));
                self.anchor_day = Some(shift_day(&cur, -step_days));
                Outcome::default()
            }
            "cal:next" => {
                let cur = self
                    .anchor_day
                    .clone()
                    .unwrap_or_else(|| today_iso(e.door.now_ms()));
                self.anchor_day = Some(shift_day(&cur, step_days));
                Outcome::default()
            }
            "cal:today" => {
                self.anchor_day = Some(today_iso(e.door.now_ms()));
                Outcome::default()
            }
            "view-choice" => {
                if let Input::Option(choice) = input {
                    e.ui.set_lens(choice);
                    save_lens(e.door, choice);
                }
                Outcome::default()
            }
            "cal:canvas" => match input {
                Input::Canvas(wire::room_canvas_event::Kind::CalendarDay(pick)) => {
                    if !pick.day.is_empty() {
                        self.anchor_day = Some(pick.day.clone());
                    }
                    Outcome::default()
                }
                Input::Canvas(wire::room_canvas_event::Kind::CalendarCreate(create)) => {
                    let day = if create.day.is_empty() {
                        today_iso(e.door.now_ms())
                    } else {
                        create.day.clone()
                    };
                    Outcome::push(&format!("calendar/new/{day}"))
                }
                _ => Outcome::default(),
            },
            other => {
                if let Some(v) = other.strip_prefix("view:") {
                    e.ui.set_lens(v);
                    save_lens(e.door, v);
                }
                Outcome::default()
            }
        }
    }
}

struct CalendarsPage;

impl RoomScreen for CalendarsPage {
    fn key(&self) -> String {
        CALENDARS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let calendars = match b.run(&reads::CALENDARS, &Args::new()) {
            Ok(ans) => ans.rows,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, CALENDARS)
                    .title(&words::tab_calendars(EN))
                    .band(calendar_band(b, CALENDARS))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let content = if calendars.is_empty() {
            vec![blocks::empty(
                glyph("Calendar", ""),
                &words::empty_calendars_title(EN),
                &words::empty_calendars_body(EN),
                Some(blocks::action(
                    &mut b.sel,
                    "empty/add-calendar",
                    &words::add_calendar(EN),
                    "Plus",
                    Handler::Open(NEW_CALENDAR.to_owned()),
                )),
            )]
        } else {
            let rows: Vec<wire::RoomBlock> = calendars
                .iter()
                .map(|cal| {
                    let mut trash = blocks::menu_item(
                        &mut b.sel,
                        &format!("cal/{}/trash", cal.id),
                        &shared::trash_move(EN),
                        Handler::Open(format!("calendar/calendar/{}/trash-confirm", cal.id)),
                    );
                    trash.destructive = true;
                    let menu = blocks::menu(
                        &format!("cal/{}/menu", cal.id),
                        vec![blocks::menu_section("", vec![trash])],
                        &mut b.sel,
                    );
                    blocks::still_row(&mut b.sel, &format!("cal/{}", cal.id), &cal.title)
                        .mark(blocks::glyph_mark(
                            cal.icon.as_deref().unwrap_or("Calendar"),
                            cal.color.as_deref().unwrap_or(""),
                        ))
                        .menu(menu)
                        .swipe(
                            &mut b.sel,
                            &format!("cal/{}/swipe", cal.id),
                            &shared::trash_move(EN),
                            Handler::Open(format!("calendar/calendar/{}/trash-confirm", cal.id)),
                        )
                        .into_block()
                })
                .collect();
            vec![
                blocks::section(&mut b.sel, "section/calendars", &words::tab_calendars(EN))
                    .blocks(rows)
                    .into_block(),
            ]
        };

        room(wire::RoomKind::AppPlace, CALENDARS)
            .title(&words::tab_calendars(EN))
            .key(
                &mut b.sel,
                "key/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_calendar(EN),
                Handler::Open(NEW_CALENDAR.to_owned()),
            )
            .band(calendar_band(b, CALENDARS))
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        handle_band_tag(e, tag).unwrap_or_default()
    }
}

#[derive(Default)]
struct NewCalendarForm {
    color: String,
    error: Option<String>,
}

impl RoomScreen for NewCalendarForm {
    fn key(&self) -> String {
        NEW_CALENDAR.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if self.color.is_empty() {
            self.color = "blue".to_owned();
        }
        let mut title = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "title",
            &words::field_calendar_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        )
        .hint(&words::field_calendar_name_hint(EN))
        .required()
        .focused();
        if let Some(err) = &self.error {
            title = title.error(err);
        }
        let color = form::choice(
            &mut b.sel,
            "color",
            &words::field_color(EN),
            wire::RoomChoiceStyle::Segmented,
            vec![
                blocks::option("blue", &words::color_blue(EN), self.color == "blue"),
                blocks::option("petrol", &words::color_petrol(EN), self.color == "petrol"),
                blocks::option(
                    "mustard",
                    &words::color_mustard(EN),
                    self.color == "mustard",
                ),
                blocks::option(
                    "raspberry",
                    &words::color_raspberry(EN),
                    self.color == "raspberry",
                ),
            ],
        );
        let dirty = !b.ui.fields.value("title").unwrap_or("").trim().is_empty();
        let save_spec = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("form:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("form:cancel".to_owned()),
                save_enabled: true,
                dirty,
                drafted: false,
            },
        );
        let form_block = form::form(
            vec![title.build(), color.build()],
            Vec::new(),
            Save::Explicit(save_spec),
        );
        room(wire::RoomKind::Editor, NEW_CALENDAR)
            .title(&words::add_calendar(EN))
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "color" => {
                if let Input::Option(choice) = input {
                    choice.clone_into(&mut self.color);
                }
                Outcome::default()
            }
            "form:cancel" => Outcome::pop(),
            "form:save" => {
                let title = e.ui.fields.value("title").unwrap_or("").trim().to_owned();
                if title.is_empty() {
                    self.error = Some(words::error_title_required(EN));
                    return Outcome::default();
                }
                self.error = None;
                let act = Act::new(
                    "container.create",
                    json!({
                        "kind": "calendar",
                        "title": title,
                        "color": self.color,
                    }),
                );
                match e.door.act(&act) {
                    Ok(_) => Outcome {
                        nav: super::screen::Nav::Pop,
                        status: Some(super::screen::Status {
                            sentence: words::status_calendar_created(EN),
                            undo: true,
                            refused: false,
                        }),
                        ..Outcome::default()
                    },
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct TrashCalendarConfirm {
    id: String,
}

impl RoomScreen for TrashCalendarConfirm {
    fn key(&self) -> String {
        format!("calendar/calendar/{}/trash-confirm", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let held = b
            .run(
                &entity_reads::HELD_COUNTS,
                &Args::new().text("home", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let events: i64 = held
            .iter()
            .filter(|h| h.kind == "event")
            .map(|h| h.count)
            .sum();
        let body = if events > 0 {
            words::trash_calendar_body(EN, u64::try_from(events).unwrap_or(0))
        } else {
            words::trash_calendar_empty_body(EN)
        };
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::trash_calendar_title(EN),
                body: &body,
                warning: "",
                confirm_label: &shared::trash_move(EN),
                confirm: Handler::Tag("confirm:trash".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::trash_calendar_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "confirm:trash" {
            let act = Act::new("entity.trash", json!({ "ids": [self.id] }));
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: done.undo,
                        refused: false,
                    }),
                    ..Outcome::default()
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct EventDetailRoom {
    id: String,
}

impl RoomScreen for EventDetailRoom {
    fn key(&self) -> String {
        format!("calendar/event/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let event = match b.run(&reads::BY_ID, &Args::new().text("id", &self.id)) {
            Ok(ans) => match ans.rows.into_iter().next() {
                Some(ev) => ev,
                None => {
                    return room(wire::RoomKind::PushedPage, &self.key())
                        .title(&words::app_title(EN))
                        .back(&mut b.sel, &words::app_title(EN))
                        .failed(
                            &mut b.sel,
                            &words::error_not_found(EN),
                            &shared::kit_retry(EN),
                        )
                        .build();
                }
            },
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::app_title(EN))
                    .back(&mut b.sel, &words::app_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let guests = b
            .run(&reads::GUESTS, &Args::new().text("event_id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let alerts = b
            .run(&reads::REMINDERS, &Args::new().text("event_id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let snooze = b
            .run(&reads::SNOOZE, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next());
        let cal_title = event.calendar_id.as_deref().and_then(|cid| {
            b.run(&reads::CALENDAR_BY_ID, &Args::new().text("id", cid))
                .ok()
                .and_then(|a| a.rows.into_iter().next())
                .map(|c| c.title)
        });
        let attachments = b
            .run(
                &entity_reads::ATTACHMENTS,
                &Args::new().text("id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let linked_ids = b
            .run(&entity_reads::LINKED, &Args::new().text("id", &self.id))
            .map(|a| a.rows)
            .unwrap_or_default();
        let mentioned = b
            .run(
                &entity_reads::MENTIONED_IN,
                &Args::new().text("id", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let rev_head = b
            .run(
                &entity_reads::REVISION_HEAD,
                &Args::new().text("id", &self.id),
            )
            .ok()
            .and_then(|a| a.rows.into_iter().next());

        let starred = event.starred_at.is_some();
        let star_act = if starred {
            Act::new(
                "flag.clear/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        } else {
            Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": [self.id] }),
            )
        };
        let snooze_until = centraid_vault::clock::format_iso_ms(b.door.now_ms() + 3_600_000);
        let star_label = if starred {
            words::action_unstar(EN)
        } else {
            words::action_star(EN)
        };
        let mut menu_items = vec![
            blocks::menu_item(
                &mut b.sel,
                "menu/edit",
                &words::action_edit(EN),
                Handler::Open(format!("calendar/event/{}/edit", self.id)),
            ),
            blocks::menu_item(&mut b.sel, "menu/star", &star_label, Handler::Act(star_act)),
            blocks::menu_item(
                &mut b.sel,
                "menu/snooze",
                &words::action_snooze(EN),
                Handler::Act(Act::new(
                    "alert.snooze",
                    json!({ "entity_id": self.id, "until": snooze_until }),
                )),
            ),
        ];
        if event.rule.is_some() {
            menu_items.push(blocks::menu_item(
                &mut b.sel,
                "menu/split",
                &words::action_split(EN),
                Handler::Act(Act::new(
                    "event.split",
                    json!({ "id": self.id, "original_start": event.starts }),
                )),
            ));
        }
        menu_items.push(blocks::menu_item(
            &mut b.sel,
            "menu/cancel",
            &words::action_cancel_event(EN),
            Handler::Act(Act::new("event.cancel", json!({ "id": self.id }))),
        ));
        let mut trash = blocks::menu_item(
            &mut b.sel,
            "menu/trash",
            &shared::trash_move(EN),
            Handler::Tag("event:trash".to_owned()),
        );
        trash.destructive = true;
        menu_items.push(trash);
        let page_menu = blocks::menu(
            "event/menu",
            vec![blocks::menu_section("", menu_items)],
            &mut b.sel,
        );

        let when_text = match &event.ends {
            Some(end) if !end.is_empty() => format!("{} – {}", event.starts, end),
            _ => event.starts.clone(),
        };
        let mut hero = blocks::hero(&event.title)
            .noun("Event")
            .mark(blocks::glyph_mark("Calendar", ""))
            .line(&when_text);
        if event.timing == "all-day" {
            hero = hero.chip(blocks::chip(
                &words::all_day_label(EN),
                wire::RoomTone::Neutral,
            ));
        }
        if guests.iter().any(|g| g.status == "needs-action") {
            hero = hero.chip(blocks::chip(
                &words::needs_reply_chip(EN),
                wire::RoomTone::Seam,
            ));
        }

        let mut facts = vec![blocks::fact(
            &words::fact_when(EN),
            &when_text,
            wire::RoomFactKind::Date,
        )];
        if let Some(cal) = &cal_title {
            facts.push(blocks::fact(
                &words::fact_calendar(EN),
                cal,
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(loc) = event.location.as_deref().filter(|s| !s.is_empty()) {
            facts.push(blocks::fact(
                &words::fact_location(EN),
                loc,
                wire::RoomFactKind::Address,
            ));
        }
        if let Some(url) = event.url.as_deref().filter(|s| !s.is_empty()) {
            facts.push(blocks::fact(
                &words::fact_url(EN),
                url,
                wire::RoomFactKind::Link,
            ));
        }
        if let Some(rule) = event.rule.as_deref().filter(|s| !s.is_empty()) {
            facts.push(blocks::fact(
                &words::fact_repeat(EN),
                rule,
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(sn) = &snooze {
            facts.push(blocks::fact(
                &words::fact_snoozed(EN),
                &sn.until,
                wire::RoomFactKind::Date,
            ));
        }

        let mut content = vec![hero.block(), blocks::facts(facts)];

        if let Some(desc) = event.description.as_deref().filter(|s| !s.is_empty()) {
            content.push(
                blocks::section(&mut b.sel, "section/notes", &words::section_notes(EN))
                    .block(blocks::prose(desc))
                    .into_block(),
            );
        }

        if !guests.is_empty() {
            let guest_rows: Vec<wire::RoomBlock> = guests
                .iter()
                .map(|g| {
                    let label = g
                        .name
                        .as_deref()
                        .or(g.address.as_deref())
                        .or(g.person_id.as_deref())
                        .unwrap_or("Guest");
                    let meta = match g.address.as_deref() {
                        Some(addr) if g.name.is_some() => format!("{addr} · {}", g.status),
                        _ => g.status.clone(),
                    };
                    if let Some(pid) = &g.person_id {
                        blocks::row(
                            &mut b.sel,
                            &format!("guest/{}", g.id),
                            label,
                            Handler::Open(format!("person/{pid}")),
                        )
                        .meta(&meta)
                        .into_block()
                    } else {
                        blocks::still_row(&mut b.sel, &format!("guest/{}", g.id), label)
                            .meta(&meta)
                            .into_block()
                    }
                })
                .collect();
            let mut sec = blocks::section(&mut b.sel, "section/guests", &words::section_guests(EN))
                .blocks(guest_rows);
            if let Some(pending) = guests.iter().find(|g| g.status == "needs-action") {
                let mut payload = Map::new();
                payload.insert("id".to_owned(), Value::String(self.id.clone()));
                payload.insert("status".to_owned(), Value::String("accepted".to_owned()));
                if let Some(addr) = &pending.address {
                    payload.insert("address".to_owned(), Value::String(addr.clone()));
                }
                if let Some(pid) = &pending.person_id {
                    payload.insert("person_id".to_owned(), Value::String(pid.clone()));
                }
                sec = sec.trailing(blocks::action(
                    &mut b.sel,
                    "guest/accept",
                    &words::action_accept(EN),
                    "Check",
                    Handler::Act(Act::new("event.respond", Value::Object(payload))),
                ));
            }
            content.push(sec.into_block());
        }

        if !alerts.is_empty() {
            let alert_rows: Vec<wire::RoomBlock> = alerts
                .iter()
                .map(|a| {
                    let label = alert_label(a.offset_min);
                    blocks::still_row(&mut b.sel, &format!("alert/{}", a.id), &label).into_block()
                })
                .collect();
            let snooze_btn = blocks::action(
                &mut b.sel,
                "alert/snooze",
                &words::action_snooze(EN),
                "Bell",
                Handler::Act(Act::new(
                    "alert.snooze",
                    json!({ "entity_id": self.id, "until": snooze_until }),
                )),
            );
            content.push(
                blocks::section(&mut b.sel, "section/alerts", &words::section_alerts(EN))
                    .trailing(snooze_btn)
                    .blocks(alert_rows)
                    .into_block(),
            );
        }

        if !attachments.is_empty() {
            let rows: Vec<wire::RoomRow> = attachments
                .iter()
                .map(|att| {
                    blocks::still_row(&mut b.sel, &format!("att/{}", att.id), &att.title)
                        .meta(&att.kind)
                        .build()
                })
                .collect();
            content.push(blocks::attachments(
                &words::section_attachments(EN),
                rows,
                None,
            ));
        }

        if !linked_ids.is_empty() {
            let mut rows = Vec::new();
            for lid in &linked_ids {
                if let Ok(ans) = b.run(&entity_reads::META_BY_ID, &Args::new().text("id", lid))
                    && let Some(meta) = ans.rows.into_iter().next()
                {
                    rows.push(
                        blocks::still_row(&mut b.sel, &format!("link/{}", meta.id), &meta.title)
                            .meta(&meta.kind)
                            .build(),
                    );
                }
            }
            if !rows.is_empty() {
                content.push(blocks::linked(&words::section_linked(EN), rows, None));
            }
        }

        if !mentioned.is_empty() {
            let rows: Vec<wire::RoomRow> = mentioned
                .iter()
                .map(|m| {
                    blocks::still_row(&mut b.sel, &format!("mention/{}", m.id), &m.title).build()
                })
                .collect();
            content.push(blocks::mentioned_in(&words::section_mentioned(EN), rows));
        }

        if let Some(head) = rev_head
            && head.count > 0
        {
            content.push(blocks::earlier_versions(
                &mut b.sel,
                &words::earlier_versions_label(EN),
                u32::try_from(head.count).unwrap_or(u32::MAX),
                Handler::Tag("event:versions".to_owned()),
            ));
        }

        if let Some(via) = event.arrived_via.as_deref() {
            let line = if via == "ics" {
                words::origin_ics(EN)
            } else {
                fill(
                    &words::origin_labeled(EN),
                    &[("label", event.arrived_label.as_deref().unwrap_or(via))],
                )
            };
            content.push(blocks::origin(&mut b.sel, &line, None));
        }

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&event.title)
            .back(&mut b.sel, &words::app_title(EN))
            .menu_key(&mut b.sel, "key/menu", &shared::kit_details(EN), page_menu)
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "event:trash" {
            let act = Act::new("entity.trash", json!({ "ids": [self.id] }));
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: done.undo,
                        refused: false,
                    }),
                    ..Outcome::default()
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

fn alert_label(offset_min: i64) -> String {
    match offset_min {
        0 => words::alert_at_time(EN),
        15 => words::alert_15_min(EN),
        60 => words::alert_1_hour(EN),
        1440 => words::alert_1_day(EN),
        other => format!("{other} min before"),
    }
}

struct EventForm {
    editing_id: Option<String>,
    initial_day: Option<String>,
    loaded: bool,
    all_day: bool,
    calendar_id: String,
    repeat: String,
    alert: String,
    drafted: bool,
    title_error: Option<String>,
    starts_error: Option<String>,
}

impl EventForm {
    fn new_event(day: Option<String>) -> Self {
        Self {
            editing_id: None,
            initial_day: day,
            loaded: false,
            all_day: false,
            calendar_id: String::new(),
            repeat: "none".to_owned(),
            alert: "15".to_owned(),
            drafted: false,
            title_error: None,
            starts_error: None,
        }
    }

    fn edit_event(id: String) -> Self {
        Self {
            editing_id: Some(id),
            initial_day: None,
            loaded: false,
            all_day: false,
            calendar_id: String::new(),
            repeat: "none".to_owned(),
            alert: "none".to_owned(),
            drafted: false,
            title_error: None,
            starts_error: None,
        }
    }

    fn save_draft(&self, e: &Event<'_>) {
        if self.editing_id.is_some() {
            return;
        }
        let Some(key) = draft_key(e.door) else {
            return;
        };
        let fields = json!({
            "title": e.ui.fields.value("title").unwrap_or(""),
            "starts": e.ui.fields.value("starts").unwrap_or(""),
            "ends": e.ui.fields.value("ends").unwrap_or(""),
            "location": e.ui.fields.value("location").unwrap_or(""),
            "url": e.ui.fields.value("url").unwrap_or(""),
            "guest": e.ui.fields.value("guest").unwrap_or(""),
            "notes": e.ui.fields.value("notes").unwrap_or(""),
            "all_day": self.all_day,
            "repeat": self.repeat,
            "alert": self.alert,
        });
        let payload = json!({
            "v": 1,
            "kind": "event",
            "fields": fields,
            "saved_at": e.door.now_ms(),
        });
        let _ = e.door.device_put(&key, &payload.to_string());
    }

    fn clear_draft(&self, door: &dyn Door) {
        if self.editing_id.is_none()
            && let Some(key) = draft_key(door)
        {
            let _ = door.device_delete(&key);
        }
    }
}

impl RoomScreen for EventForm {
    fn key(&self) -> String {
        match &self.editing_id {
            Some(id) => format!("calendar/event/{id}/edit"),
            None => NEW_EVENT.to_owned(),
        }
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let calendars = b
            .run(&reads::CALENDARS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        if !self.loaded {
            self.loaded = true;
            if let Some(id) = &self.editing_id {
                if let Ok(ans) = b.run(&reads::BY_ID, &Args::new().text("id", id))
                    && let Some(ev) = ans.rows.into_iter().next()
                {
                    b.ui.fields.get_or("title", &ev.title);
                    b.ui.fields.get_or("starts", &ev.starts);
                    b.ui.fields.get_or("ends", ev.ends.as_deref().unwrap_or(""));
                    b.ui.fields
                        .get_or("location", ev.location.as_deref().unwrap_or(""));
                    b.ui.fields.get_or("url", ev.url.as_deref().unwrap_or(""));
                    b.ui.fields
                        .get_or("notes", ev.description.as_deref().unwrap_or(""));
                    self.all_day = ev.timing == "all-day";
                    self.calendar_id = ev.calendar_id.unwrap_or_default();
                    self.repeat = rule_to_choice(ev.rule.as_deref()).to_owned();
                }
            } else {
                let default_day = self
                    .initial_day
                    .clone()
                    .unwrap_or_else(|| today_iso(b.door.now_ms()));
                if let Some(key) = draft_key(b.door)
                    && let Some(raw) = b.door.device_get(&key)
                    && let Ok(parsed) = serde_json::from_str::<Value>(&raw)
                    && let Some(fields) = parsed.get("fields").and_then(Value::as_object)
                {
                    self.drafted = true;
                    for name in [
                        "title", "starts", "ends", "location", "url", "guest", "notes",
                    ] {
                        if let Some(v) = fields.get(name).and_then(Value::as_str) {
                            b.ui.fields.get_or(name, v);
                        }
                    }
                    if let Some(ad) = fields.get("all_day").and_then(Value::as_bool) {
                        self.all_day = ad;
                    }
                    if let Some(r) = fields.get("repeat").and_then(Value::as_str) {
                        self.repeat = r.to_owned();
                    }
                    if let Some(a) = fields.get("alert").and_then(Value::as_str) {
                        self.alert = a.to_owned();
                    }
                }
                b.ui.fields
                    .get_or("starts", &format!("{default_day}T09:00"));
                b.ui.fields.get_or("ends", &format!("{default_day}T10:00"));
                if self.calendar_id.is_empty()
                    && let Some(first) = calendars.first()
                {
                    self.calendar_id.clone_from(&first.id);
                }
            }
        }

        let mut title = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "title",
            &words::field_title(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_TEXT,
        )
        .hint(&words::field_title_hint(EN))
        .required()
        .focused();
        if let Some(err) = &self.title_error {
            title = title.error(err);
        }
        let all_day = form::toggle(
            &mut b.sel,
            "all_day",
            &words::field_all_day(EN),
            self.all_day,
        );
        let mut starts = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "starts",
            &words::field_starts(EN),
            wire::RoomTextKind::Line,
            "",
            40,
        )
        .required();
        if let Some(err) = &self.starts_error {
            starts = starts.error(err);
        }
        let ends = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "ends",
            &words::field_ends(EN),
            wire::RoomTextKind::Line,
            "",
            40,
        );
        let mut fields = vec![title.build(), all_day.build(), starts.build(), ends.build()];
        if !calendars.is_empty() {
            let cal_opts = calendars
                .iter()
                .map(|c| blocks::option(&c.id, &c.title, c.id == self.calendar_id))
                .collect();
            fields.push(
                form::choice(
                    &mut b.sel,
                    "calendar_id",
                    &words::field_calendar(EN),
                    wire::RoomChoiceStyle::Menu,
                    cal_opts,
                )
                .build(),
            );
        }
        fields.push(
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "location",
                &words::field_location(EN),
                wire::RoomTextKind::Line,
                "",
                MAX_TEXT,
            )
            .hint(&words::field_location_hint(EN))
            .build(),
        );
        fields.push(
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "url",
                &words::field_url(EN),
                wire::RoomTextKind::Url,
                "",
                MAX_TEXT,
            )
            .build(),
        );
        fields.push(
            form::choice(
                &mut b.sel,
                "repeat",
                &words::field_repeat(EN),
                wire::RoomChoiceStyle::Menu,
                vec![
                    blocks::option("none", &words::repeat_none(EN), self.repeat == "none"),
                    blocks::option("daily", &words::repeat_daily(EN), self.repeat == "daily"),
                    blocks::option("weekly", &words::repeat_weekly(EN), self.repeat == "weekly"),
                    blocks::option(
                        "monthly",
                        &words::repeat_monthly(EN),
                        self.repeat == "monthly",
                    ),
                    blocks::option("yearly", &words::repeat_yearly(EN), self.repeat == "yearly"),
                ],
            )
            .build(),
        );
        fields.push(
            form::choice(
                &mut b.sel,
                "alert",
                &words::field_alert(EN),
                wire::RoomChoiceStyle::Menu,
                vec![
                    blocks::option("none", &words::alert_none(EN), self.alert == "none"),
                    blocks::option("0", &words::alert_at_time(EN), self.alert == "0"),
                    blocks::option("15", &words::alert_15_min(EN), self.alert == "15"),
                    blocks::option("60", &words::alert_1_hour(EN), self.alert == "60"),
                    blocks::option("1440", &words::alert_1_day(EN), self.alert == "1440"),
                ],
            )
            .build(),
        );
        if self.editing_id.is_none() {
            fields.push(
                form::text(
                    &mut b.sel,
                    &mut b.ui.fields,
                    "guest",
                    &words::field_guest(EN),
                    wire::RoomTextKind::Line,
                    "",
                    MAX_TEXT,
                )
                .hint(&words::field_guest_hint(EN))
                .build(),
            );
        }
        fields.push(
            form::text(
                &mut b.sel,
                &mut b.ui.fields,
                "notes",
                &words::field_notes(EN),
                wire::RoomTextKind::Paragraph,
                "",
                MAX_NOTES,
            )
            .build(),
        );

        let dirty = !b.ui.fields.value("title").unwrap_or("").trim().is_empty();
        let save_spec = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &shared::kit_save(EN),
                save: Handler::Tag("form:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("form:cancel".to_owned()),
                save_enabled: true,
                dirty,
                drafted: self.drafted,
            },
        );
        let form_block = form::form(fields, Vec::new(), Save::Explicit(save_spec));
        let title_str = if self.editing_id.is_some() {
            words::edit_event(EN)
        } else {
            words::add_event(EN)
        };
        room(wire::RoomKind::Editor, &self.key())
            .title(&title_str)
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        match tag {
            "all_day" => {
                if let Input::Flag(on) = input {
                    self.all_day = *on;
                }
                self.save_draft(e);
                Outcome::default()
            }
            "calendar_id" => {
                if let Input::Option(opt) = input {
                    opt.clone_into(&mut self.calendar_id);
                }
                self.save_draft(e);
                Outcome::default()
            }
            "repeat" => {
                if let Input::Option(opt) = input {
                    opt.clone_into(&mut self.repeat);
                }
                self.save_draft(e);
                Outcome::default()
            }
            "alert" => {
                if let Input::Option(opt) = input {
                    opt.clone_into(&mut self.alert);
                }
                self.save_draft(e);
                Outcome::default()
            }
            "title" | "starts" | "ends" | "location" | "url" | "guest" | "notes" => {
                self.save_draft(e);
                Outcome::default()
            }
            "form:cancel" => {
                self.clear_draft(e.door);
                Outcome::pop()
            }
            "form:save" => {
                let title = e.ui.fields.value("title").unwrap_or("").trim().to_owned();
                let raw_starts = e.ui.fields.value("starts").unwrap_or("").trim().to_owned();
                let raw_ends = e.ui.fields.value("ends").unwrap_or("").trim().to_owned();
                if title.is_empty() {
                    self.title_error = Some(words::error_title_required(EN));
                    return Outcome::default();
                }
                self.title_error = None;
                if raw_starts.is_empty() {
                    self.starts_error = Some(words::error_starts_required(EN));
                    return Outcome::default();
                }
                self.starts_error = None;

                let (starts, ends, timing) = if self.all_day {
                    let s = raw_starts.get(..10).unwrap_or(&raw_starts).to_owned();
                    let en = (!raw_ends.is_empty())
                        .then(|| raw_ends.get(..10).unwrap_or(&raw_ends).to_owned());
                    (s, en, "all-day")
                } else {
                    let en = (!raw_ends.is_empty()).then_some(raw_ends);
                    let t = if raw_starts.ends_with('Z') {
                        "zoned"
                    } else if raw_starts.len() == 10 {
                        "all-day"
                    } else {
                        "floating"
                    };
                    (raw_starts, en, t)
                };

                let mut payload = Map::new();
                payload.insert("title".to_owned(), Value::String(title));
                payload.insert("starts".to_owned(), Value::String(starts));
                payload.insert("timing".to_owned(), Value::String(timing.to_owned()));
                if timing == "zoned" {
                    payload.insert("zone".to_owned(), Value::String("UTC".to_owned()));
                }
                if let Some(en) = ends {
                    payload.insert("ends".to_owned(), Value::String(en));
                }
                let loc = e.ui.fields.value("location").unwrap_or("").trim();
                if !loc.is_empty() {
                    payload.insert("location".to_owned(), Value::String(loc.to_owned()));
                }
                let url = e.ui.fields.value("url").unwrap_or("").trim();
                if !url.is_empty() {
                    payload.insert("url".to_owned(), Value::String(url.to_owned()));
                }
                let notes = e.ui.fields.value("notes").unwrap_or("").trim();
                if !notes.is_empty() {
                    payload.insert("description".to_owned(), Value::String(notes.to_owned()));
                }
                if let Some(rrule) = choice_to_rule(&self.repeat) {
                    payload.insert("rule".to_owned(), Value::String(rrule.to_owned()));
                }
                if let Ok(mins) = self.alert.parse::<i64>() {
                    payload.insert("reminders".to_owned(), json!([mins]));
                }

                let (action_name, success_sentence) = if let Some(id) = &self.editing_id {
                    payload.insert("id".to_owned(), Value::String(id.clone()));
                    ("event.edit", words::status_event_saved(EN))
                } else {
                    if !self.calendar_id.is_empty() {
                        payload.insert(
                            "calendar_id".to_owned(),
                            Value::String(self.calendar_id.clone()),
                        );
                    }
                    let guest = e.ui.fields.value("guest").unwrap_or("").trim();
                    if !guest.is_empty() {
                        let g = if guest.contains('@') {
                            json!({ "address": guest })
                        } else {
                            json!({ "person_id": guest })
                        };
                        payload.insert("guests".to_owned(), json!([g]));
                    }
                    ("event.propose", words::status_event_created(EN))
                };

                match e.door.act(&Act::new(action_name, Value::Object(payload))) {
                    Ok(done) => {
                        self.clear_draft(e.door);
                        Outcome {
                            nav: super::screen::Nav::Pop,
                            status: Some(super::screen::Status {
                                sentence: success_sentence,
                                undo: done.undo,
                                refused: false,
                            }),
                            ..Outcome::default()
                        }
                    }
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

fn choice_to_rule(choice: &str) -> Option<&'static str> {
    match choice {
        "daily" => Some("FREQ=DAILY"),
        "weekly" => Some("FREQ=WEEKLY"),
        "monthly" => Some("FREQ=MONTHLY"),
        "yearly" => Some("FREQ=YEARLY"),
        _ => None,
    }
}

fn rule_to_choice(rule: Option<&str>) -> &'static str {
    match rule {
        Some(r) if r.contains("FREQ=DAILY") => "daily",
        Some(r) if r.contains("FREQ=WEEKLY") => "weekly",
        Some(r) if r.contains("FREQ=MONTHLY") => "monthly",
        Some(r) if r.contains("FREQ=YEARLY") => "yearly",
        _ => "none",
    }
}

#[derive(Default)]
struct ImportIcsRoom {
    error: Option<String>,
}

impl RoomScreen for ImportIcsRoom {
    fn key(&self) -> String {
        IMPORT_ICS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let mut field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "ics",
            &words::field_ics(EN),
            wire::RoomTextKind::Paragraph,
            "",
            MAX_ICS,
        )
        .hint(&words::field_ics_hint(EN))
        .required()
        .focused();
        if let Some(err) = &self.error {
            field = field.error(err);
        }
        let dirty = !b.ui.fields.value("ics").unwrap_or("").trim().is_empty();
        let save_spec = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &words::action_import(EN),
                save: Handler::Tag("form:save".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Tag("form:cancel".to_owned()),
                save_enabled: true,
                dirty,
                drafted: false,
            },
        );
        let form_block = form::form(vec![field.build()], Vec::new(), Save::Explicit(save_spec));
        room(wire::RoomKind::PushedPage, IMPORT_ICS)
            .title(&words::more_import_ics(EN))
            .back(&mut b.sel, &words::app_title(EN))
            .ready(vec![form_block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        match tag {
            "form:cancel" => Outcome::pop(),
            "form:save" => {
                let raw = e.ui.fields.value("ics").unwrap_or("");
                let events = centraid_core::device::inbox::parse_ics_events(raw);
                if events.is_empty() {
                    self.error = Some(words::error_ics_empty(EN));
                    return Outcome::default();
                }
                self.error = None;
                let mut count = 0_u64;
                for mut ev in events {
                    if let Some(obj) = ev.as_object_mut() {
                        obj.insert("arrived_via".to_owned(), Value::String("ics".to_owned()));
                        obj.insert(
                            "arrived_label".to_owned(),
                            Value::String("calendar.ics".to_owned()),
                        );
                    }
                    if let Err(refused) = e.door.act(&Act::new("event.propose/ics", ev)) {
                        return Outcome::refuse(&refused.0);
                    }
                    count += 1;
                }
                Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: words::status_ics_imported(EN, count),
                        undo: false,
                        refused: false,
                    }),
                    ..Outcome::default()
                }
            }
            _ => Outcome::default(),
        }
    }
}

#[derive(Default)]
struct CalendarTrash {
    loaded: usize,
}

impl RoomScreen for CalendarTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let limit = self.loaded.max(50);
        let ans = match b.reload(&reads::TRASH, &Args::new(), limit) {
            Ok(ans) => ans,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&words::trash_title(EN))
                    .back(&mut b.sel, &words::app_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let block = if ans.rows.is_empty() {
            blocks::empty(
                glyph("Trash", ""),
                &shared::trash_empty_headline(EN),
                &shared::trash_empty_state_body(EN),
                None,
            )
        } else {
            let heading = shared::trash_count(EN, ans.rows.len() as u64);
            let rows: Vec<wire::RoomTrashRow> = ans
                .rows
                .iter()
                .map(|row| {
                    let meta = format!(
                        "{} {} · {} {}",
                        shared::trash_deleted(EN),
                        row.deleted_at.get(..10).unwrap_or(&row.deleted_at),
                        shared::trash_erased(EN),
                        row.purge_at.get(..10).unwrap_or(&row.purge_at),
                    );
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", row.id),
                        &row.title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [row.id] }))),
                        Handler::Open(format!("calendar/trash/purge/{}", row.id)),
                    )
                })
                .collect();
            let empty_action = blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("calendar/trash/empty".to_owned()),
            );
            blocks::trash_block(blocks::trash(
                &heading,
                &shared::trash_entry_meta(EN),
                rows,
                Some(empty_action),
            ))
        };
        room(wire::RoomKind::PushedPage, TRASH)
            .title(&words::trash_title(EN))
            .back(&mut b.sel, &words::app_title(EN))
            .ready(vec![block])
            .build()
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "calendar/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: &shared::trash_cannot_undo(EN),
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("confirm:empty".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_empty_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "confirm:empty" {
            let act = Act::new(
                "entity.empty_trash",
                json!({ "kinds": ["event", "calendar"] }),
            );
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: false,
                        refused: false,
                    }),
                    ..Outcome::default()
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("calendar/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::purge_title(EN),
                body: &words::purge_body(EN),
                warning: &shared::trash_cannot_undo(EN),
                confirm_label: &shared::kit_delete(EN),
                confirm: Handler::Tag("confirm:purge".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::purge_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _: &Input) -> Outcome {
        if tag == "confirm:purge" {
            let act = Act::new("entity.purge", json!({ "id": self.id }));
            return match e.door.act(&act) {
                Ok(done) => Outcome {
                    nav: super::screen::Nav::Pop,
                    status: Some(super::screen::Status {
                        sentence: done.sentence,
                        undo: false,
                        refused: false,
                    }),
                    ..Outcome::default()
                },
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}
