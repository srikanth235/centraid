//! The Calendar's grids, through the door a shell uses (#1173): the view menu,
//! the week strip and the hour grid, the month, the year, the period steps, a
//! long press that opens the add sheet and writes nothing, and a dragged block
//! that moves or resizes an event with Undo.
//!
//! Every day here is a fixed one, so no assertion depends on the machine's
//! clock, and no assertion is on a duration: only on counts and values.

#[allow(clippy::duplicate_mod)]
#[path = "schedule_routes/mod.rs"]
mod routes;
use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::catalog::{act, load};
use centraid_screens::field::{Field, Keyed};
use centraid_screens::testing::Driver;
use centraid_screens::{Runtime, agenda};
use wire::AgendaDestination as Dest;
use wire::agenda_home_event::Kind as H;
use wire::agenda_home_state::Content;
use wire::screen_event::Kind as E;

/// Wednesday 9 June 2027: its week is 7 to 13 June from Monday, 6 to 12 June
/// from Sunday.
const WED: &str = "2027-06-09";
/// Monday 9 November 2026, 09:00 UTC. The sample's weekly run stays on Tuesday,
/// rather than moving into a test's Wednesday when the real machine's day changes.
const SCENARIO_AT: i64 = 1_794_214_800_000;

struct Rig {
    driver: Driver,
    id: u64,
    zone: String,
    seq: u64,
}

fn rig(destination: Dest) -> Rig {
    let mut driver = Driver::with_runtime_at(
        Runtime::new(
            agenda::registry(),
            vec![(agenda::TAB.to_owned(), routes::home(destination, ""))],
        ),
        SCENARIO_AT,
    );
    driver.start();
    let id = driver.navigation.as_ref().expect("navigation").tabs[0].entries[0].instance;
    Rig {
        driver,
        id,
        zone: "UTC".to_owned(),
        seq: 0,
    }
}

impl Rig {
    fn state(&self) -> &wire::AgendaHomeState {
        match &self.driver.view(self.id).kind {
            Some(wire::view_state::Kind::AgendaHome(state)) => state,
            other => panic!("not Agenda's home: {other:?}"),
        }
    }

    fn data(&self) -> &wire::AgendaHomeData {
        match &self.state().content {
            Some(Content::Data(data)) => data,
            other => panic!("expected data, found {other:?}"),
        }
    }

    fn grid(&self) -> &wire::AgendaTimeGrid {
        self.data().time_grid.as_ref().expect("the hour grid")
    }

    fn send(&mut self, kind: H) {
        self.driver.send(
            self.id,
            E::AgendaHome(wire::AgendaHomeEvent { kind: Some(kind) }),
        );
    }

    fn settle(&mut self) {
        self.driver.pump(Duration::from_millis(400));
    }

    /// The device lives in `zone` and its locale names `region`.
    fn environment(&mut self, locale: &str, zone: &str) {
        self.zone = zone.to_owned();
        self.driver
            .call(wire::screen_request::Kind::Environment(wire::Environment {
                locale: locale.to_owned(),
                zone: zone.to_owned(),
                ..Default::default()
            }));
    }

    fn destination(&mut self, destination: Dest) {
        self.send(H::Destination(
            wire::agenda_home_event::DestinationChanged {
                destination: destination as i32,
            },
        ));
    }

    fn pick(&mut self, day: &str, destination: Dest) {
        self.send(H::DayPicked(wire::agenda_home_event::DayPicked {
            day: day.to_owned(),
            destination: destination as i32,
        }));
    }

    fn period(&mut self, by: i32) {
        self.send(H::PeriodStepped(wire::agenda_home_event::PeriodStepped {
            by,
        }));
    }

    fn header(&self) -> &wire::AgendaCalendarHeader {
        self.state().calendar_header.as_ref().expect("the header")
    }

    fn chip(&mut self) {
        self.send(H::MonthChip(wire::agenda_home_event::MonthChipTapped {}));
    }

    fn layout(&mut self, layout: Dest) {
        self.send(H::LayoutToggled(wire::agenda_home_event::LayoutToggled {
            layout: layout as i32,
        }));
    }

    fn weeks(&mut self, weeks: i32) {
        self.send(H::WeekPaged(wire::agenda_home_event::WeekPaged { weeks }));
    }

    fn today_tapped(&mut self) {
        self.send(H::Today(wire::agenda_home_event::TodayRequested {}));
    }

    fn band(&mut self, key: &str) {
        self.send(H::Band(wire::agenda_home_event::BandPicked {
            key: key.to_owned(),
        }));
    }

    fn act(&mut self, request: impl Into<wire::ActRequest>) -> wire::ActResponse {
        self.seq += 1;
        let request = request.into().keyed(format!("zq-grid:{}", self.seq));
        self.driver.act(request)
    }

    fn write(&mut self, request: impl Into<wire::ActRequest>) {
        let done = self.act(request);
        assert_eq!(done.status, wire::ActStatus::Executed as i32, "{done:?}");
    }

    fn event(&mut self, id: &str, title: &str, starts: &str, ends: Option<&str>) {
        let zone = self.zone.clone();
        self.write(act::calendar::Propose {
            id: Some(id.to_owned()),
            title: title.to_owned(),
            starts: starts.to_owned(),
            ends: ends.map_or(Field::Keep, |ends| Field::Is(ends.to_owned())),
            busy: Some(false),
            zone: Field::Is(zone),
            ..Default::default()
        });
    }

    /// The occurrence the vault holds for `id` on `day`, as the core answers it.
    fn occurrence(&self, id: &str, day: &str) -> wire::AgendaEvent {
        let mut request: wire::LoadRequest = load::calendar::Upcoming {
            from: Some(format!("{}T00:00:00Z", plus(day, -1))),
            to: Some(format!("{}T00:00:00Z", plus(day, 2))),
        }
        .into();
        request.zone.clone_from(&self.zone);
        let wire::app_query_response::Answer::AgendaUpcoming(upcoming) = self
            .driver
            .handle
            .load(&request)
            .expect("the load door answers")
            .answer
            .and_then(|answer| answer.answer)
            .expect("an answer")
        else {
            panic!("upcoming");
        };
        upcoming
            .events
            .into_iter()
            .find(|event| event.event_id == id)
            .unwrap_or_else(|| panic!("no {id} on {day}"))
    }

    fn block(&self, day: &str, instance_key: &str) -> wire::AgendaGridBlock {
        self.grid()
            .days
            .iter()
            .find(|column| column.day == day)
            .unwrap_or_else(|| panic!("no column {day}"))
            .blocks
            .iter()
            .find(|block| block.instance_key == instance_key)
            .unwrap_or_else(|| panic!("no block {instance_key} on {day}"))
            .clone()
    }

    /// The route the last `OpenRoute` effect asked a shell to open.
    fn opened(&self) -> Option<wire::Route> {
        self.driver.effects.iter().rev().find_map(|request| {
            match request.effect.as_ref()?.kind.as_ref()? {
                wire::effect::Kind::OpenRoute(open) => open.route.clone(),
                _ => None,
            }
        })
    }
}

fn plus(day: &str, days: i64) -> String {
    centraid_screens::kit::civil::plus_days(day, days).expect("a real day")
}

fn minutes(clock: &str) -> i32 {
    let hours: i32 = clock[0..2].parse().expect("hours");
    let rest: i32 = clock[3..5].parse().expect("minutes");
    hours * 60 + rest
}

#[test]
fn the_view_menu_is_day_week_month_list_year_and_lights_the_calendar_tab() {
    let mut r = rig(Dest::Day);
    r.settle();
    // Day and Week carry the menu on the Calendar's header, the rest on the state.
    assert!(r.state().calendar_views.is_empty());
    let keys: Vec<&str> = r
        .header()
        .layouts
        .iter()
        .map(|view| view.key.as_str())
        .collect();
    assert_eq!(keys, ["day", "week", "month", "list", "year"]);
    let places: Vec<i32> = r
        .header()
        .layouts
        .iter()
        .map(|view| view.destination)
        .collect();
    assert_eq!(
        places,
        [
            Dest::Day as i32,
            Dest::Week as i32,
            Dest::Month as i32,
            Dest::Schedule as i32,
            Dest::Year as i32
        ]
    );
    for (key, place) in [
        ("day", Dest::Day),
        ("week", Dest::Week),
        ("month", Dest::Month),
        ("list", Dest::Schedule),
        ("year", Dest::Year),
    ] {
        r.destination(place);
        let state = r.state();
        assert!(state.band[0].current, "Calendar is lit on {key}");
        let views = if state.calendar_views.is_empty() {
            &state.calendar_header.as_ref().expect("header").layouts
        } else {
            &state.calendar_views
        };
        let current: Vec<&str> = views
            .iter()
            .filter(|view| view.current)
            .map(|view| view.key.as_str())
            .collect();
        assert_eq!(current, [key]);
    }
    // Invites is not a Calendar view: no menu, the tab dark.
    r.band("invites");
    assert!(!r.state().band[0].current);
    assert!(r.state().calendar_views.is_empty());
    // The Calendar tab returns to the view last used: Year.
    r.band("calendar");
    assert_eq!(r.state().destination, Dest::Year as i32);
    assert!(r.state().band[0].current);
}

#[test]
fn week_reads_the_whole_week_from_the_regions_first_weekday() {
    let mut r = rig(Dest::Week);
    r.event(
        "zq-sun",
        "Zq Sunday",
        "2027-06-13T10:00",
        Some("2027-06-13T11:00"),
    );
    r.event(
        "zq-wed",
        "Zq Wednesday",
        "2027-06-09T09:00",
        Some("2027-06-09T10:00"),
    );
    r.event(
        "zq-sat",
        "Zq Saturday",
        "2027-06-12T09:00",
        Some("2027-06-12T10:00"),
    );
    r.pick(WED, Dest::Week);
    // NO REGION: Monday first. The week is 7 to 13 June.
    let days: Vec<String> = r.grid().days.iter().map(|d| d.day.clone()).collect();
    assert_eq!(days.len(), 7);
    assert_eq!(
        (days[0].as_str(), days[6].as_str()),
        ("2027-06-07", "2027-06-13")
    );
    assert_eq!(r.block("2027-06-13", "zq-sun").start_minute, 600);
    assert_eq!(r.block("2027-06-09", "zq-wed").end_minute, 600);
    let strip = r.data().week_strip.as_ref().expect("the strip");
    assert_eq!(strip.days.len(), 7);
    let initials: String = strip
        .days
        .iter()
        .map(|d| d.weekday_initial.as_str())
        .collect();
    assert_eq!(initials, "MTWTFSS");
    assert!(strip.days[2].is_selected && strip.days[6].dot_hue_keys.len() == 1);
    // The seeded weekly run is on Tuesday. None of this test's own events is on Monday.
    assert!(
        r.grid().days[0]
            .blocks
            .iter()
            .all(|b| !b.instance_key.starts_with("zq-"))
    );
    assert_eq!(r.data().today.len(), 10);

    // A UNITED STATES LOCALE: Sunday first. The week is 6 to 12 June, and
    // Sunday the 13th belongs to the next one.
    r.environment("en-US", "UTC");
    let days: Vec<String> = r.grid().days.iter().map(|d| d.day.clone()).collect();
    assert_eq!(
        (days[0].as_str(), days[6].as_str()),
        ("2027-06-06", "2027-06-12")
    );
    let strip = r.data().week_strip.as_ref().expect("the strip");
    let initials: String = strip
        .days
        .iter()
        .map(|d| d.weekday_initial.as_str())
        .collect();
    assert_eq!(initials, "SMTWTFS");
    assert!(
        r.grid()
            .days
            .iter()
            .all(|d| d.blocks.iter().all(|b| b.instance_key != "zq-sun"))
    );
    assert_eq!(r.block("2027-06-12", "zq-sat").start_minute, 540);
    // The list's days are the grids' business now.
    assert!(r.data().days.is_empty());
}

#[test]
fn day_draws_one_column_and_the_strip_of_its_week() {
    let mut r = rig(Dest::Day);
    r.event("zq-a", "Zq A", "2027-06-09T09:00", Some("2027-06-09T10:00"));
    r.event("zq-b", "Zq B", "2027-06-09T09:30", Some("2027-06-09T10:15"));
    r.event("zq-c", "Zq C", "2027-06-09T13:00", None);
    r.pick(WED, Dest::Day);
    assert_eq!(r.grid().days.len(), 1);
    assert_eq!(r.grid().hours.len(), 24);
    assert_eq!(r.grid().snap_minutes, 15);
    let (a, b, c) = (
        r.block(WED, "zq-a"),
        r.block(WED, "zq-b"),
        r.block(WED, "zq-c"),
    );
    assert_eq!((a.column, a.columns, b.column, b.columns), (0, 2, 1, 2));
    assert_eq!((c.columns, c.end_minute - c.start_minute), (1, 15));
    assert!(a.movable && b.movable && c.movable);
    assert_eq!(a.time_label, "09:00 – 10:00");
    // The grid opens an hour above its first block.
    assert_eq!(r.grid().scroll_to_minute, 540 - 60);
    // The strip carries the dots of the week, and Day's step is still a day.
    let strip = r.data().week_strip.as_ref().expect("the strip");
    assert_eq!(strip.days[2].day, WED);
    assert_eq!(strip.days[2].dot_hue_keys.len(), 1);
    assert_eq!(strip.days[2].opens, Dest::Day as i32);
    // One day, then a day inside the held week.
    r.period(1);
    assert_eq!(r.state().anchor_day, "2027-06-10");
    assert!(r.grid().days[0].blocks.is_empty());
    // Day has no day bar: the header says the month and offers Today.
    assert!(!r.state().toolbar.as_ref().expect("the toolbar").shown);
    assert_eq!(r.header().month_label, "June");
    assert!(r.header().today_shown);
}

#[test]
fn month_draws_whole_weeks_and_a_start_on_the_week_start_has_no_leading_days() {
    let mut r = rig(Dest::Month);
    r.event(
        "zq-m",
        "Zq Monthly",
        "2027-06-09T09:00",
        Some("2027-06-09T10:00"),
    );
    r.pick(WED, Dest::Month);
    let month = r.data().month.as_ref().expect("the month");
    // 1 June 2027 is a Tuesday: Monday-first draws 31 May to 4 July.
    assert_eq!(month.title, "June 2027");
    assert_eq!(month.cells.len(), 35);
    assert_eq!(month.cells[0].day, "2027-05-31");
    assert!(!month.cells[0].in_month);
    assert_eq!(month.cells[34].day, "2027-07-04");
    assert!(!month.cells[34].in_month);
    assert_eq!(month.weekday_labels.concat(), "MTWTFSS");
    let cell = month.cells.iter().find(|c| c.day == WED).expect("the 9th");
    assert!(cell.is_selected && cell.in_month);
    assert_eq!(cell.chips.len(), 1);
    assert_eq!(cell.chips[0].title, "Zq Monthly");
    assert_eq!(cell.opens, Dest::Day as i32);
    assert!(r.data().days.is_empty(), "no list under the grid style");

    // Sunday first: 30 May to 3 July, still 35.
    r.environment("en-US", "UTC");
    let month = r.data().month.as_ref().expect("the month");
    assert_eq!(month.cells[0].day, "2027-05-30");
    assert_eq!(month.cells[34].day, "2027-07-03");

    // February 2027 starts on a Monday: four whole weeks, none leading.
    r.environment("en-GB", "UTC");
    r.pick("2027-02-10", Dest::Month);
    let month = r.data().month.as_ref().expect("the month");
    assert_eq!(month.cells.len(), 28);
    assert_eq!(month.cells[0].day, "2027-02-01");
    assert!(month.cells.iter().all(|c| c.in_month));

    // March 2027 starts on a Monday and ends on a Wednesday: five weeks.
    r.period(1);
    let month = r.data().month.as_ref().expect("the month");
    assert_eq!(month.cells.len(), 35);
    assert_eq!(month.cells[0].day, "2027-03-01");
    assert_eq!(month.cells[34].day, "2027-04-04");
}

#[test]
fn the_list_style_draws_dots_and_the_selected_days_rows() {
    let mut r = rig(Dest::Month);
    r.event(
        "zq-l",
        "Zq Listed",
        "2027-06-09T09:00",
        Some("2027-06-09T10:00"),
    );
    r.pick(WED, Dest::Month);
    r.send(H::MonthStyle(wire::agenda_home_event::MonthStyleChosen {
        style: wire::AgendaMonthStyle::List as i32,
    }));
    let month = r.data().month.as_ref().expect("the month");
    assert_eq!(month.style, wire::AgendaMonthStyle::List as i32);
    assert!(month.styles.iter().any(|s| s.current && s.label == "List"));
    let cell = month.cells.iter().find(|c| c.day == WED).expect("the 9th");
    assert!(cell.chips.is_empty());
    assert_eq!(cell.dot_hue_keys.len(), 1);
    assert_eq!(cell.opens, Dest::Month as i32);
    // The selected day's rows reuse the list's sections.
    assert_eq!(month.selected.len(), 1);
    assert_eq!(month.selected[0].day, WED);
    assert!(month.selected_empty.is_empty());
    // A day with nothing says so.
    r.pick("2027-06-10", Dest::Month);
    let month = r.data().month.as_ref().expect("the month");
    assert!(month.selected.is_empty());
    assert_eq!(month.selected_empty, "Nothing on this day.");
    // Back to the grid style.
    r.send(H::MonthStyle(wire::agenda_home_event::MonthStyleChosen {
        style: wire::AgendaMonthStyle::Grid as i32,
    }));
    assert!(
        r.data()
            .month
            .as_ref()
            .expect("the month")
            .selected
            .is_empty()
    );
}

#[test]
fn year_is_twelve_months_of_whole_weeks_and_a_month_opens_the_month() {
    let mut r = rig(Dest::Year);
    r.pick("2027-06-09", Dest::Year);
    let year = r.data().year.as_ref().expect("the year");
    assert_eq!(year.title, "2027");
    assert_eq!(year.months.len(), 12);
    assert_eq!(year.months[5].label, "June");
    assert_eq!(year.months[5].month, "2027-06");
    for month in &year.months {
        assert_eq!(month.days.len() % 7, 0, "{} is whole weeks", month.month);
        let drawn = month
            .days
            .iter()
            .filter(|d| !d.day_number.is_empty())
            .count();
        let want = match month.month.as_str() {
            "2027-02" => 28,
            "2027-04" | "2027-06" | "2027-09" | "2027-11" => 30,
            _ => 31,
        };
        assert_eq!(drawn, want, "{}", month.month);
    }
    // 1 June 2027 is a Tuesday: Monday-first leaves one blank first.
    assert!(year.months[5].days[0].day_number.is_empty());
    assert_eq!(year.months[5].days[1].day_number, "1");
    assert_eq!(year.months[5].first_day.len(), 10);
    assert_eq!(year.months[0].first_day, "2027-01-01");
    assert!(year.months.iter().filter(|m| m.is_current).count() <= 1);
    // No event is read for a thumbnail: the list is empty too.
    assert!(r.data().days.is_empty());
    // A month's tap sends its first day and the Month place.
    r.pick("2027-09-01", Dest::Month);
    assert_eq!(r.state().destination, Dest::Month as i32);
    assert_eq!(r.state().anchor_day, "2027-09-01");
    assert!(r.data().month.is_some() && r.data().year.is_none());
}

#[test]
fn toolbar_words_follow_the_view() {
    let mut r = rig(Dest::Week);
    r.pick(WED, Dest::Week);
    // Week has the Calendar's header and no day bar.
    assert!(!r.state().toolbar.as_ref().expect("the toolbar").shown);
    r.destination(Dest::Month);
    assert_eq!(
        r.state().toolbar.as_ref().expect("bar").range_label,
        "June 2027"
    );
    r.destination(Dest::Year);
    assert_eq!(r.state().toolbar.as_ref().expect("bar").range_label, "2027");
    // Today is in the period: Month and Year on today hide the button.
    let today = r.data().today.clone();
    r.pick(&today, Dest::Month);
    assert!(r.state().toolbar.as_ref().expect("bar").at_today);
    r.destination(Dest::Year);
    assert!(r.state().toolbar.as_ref().expect("bar").at_today);
    r.period(1);
    assert!(!r.state().toolbar.as_ref().expect("bar").at_today);
}

#[test]
fn a_period_step_is_a_day_a_week_a_month_or_a_year() {
    let mut r = rig(Dest::Day);
    r.pick("2027-03-31", Dest::Day);
    r.period(1);
    assert_eq!(r.state().anchor_day, "2027-04-01");
    r.period(-1);
    r.destination(Dest::Week);
    r.period(1);
    assert_eq!(r.state().anchor_day, "2027-04-07");
    r.period(-2);
    assert_eq!(r.state().anchor_day, "2027-03-24");
    r.pick("2027-03-31", Dest::Month);
    r.period(1);
    assert_eq!(
        r.state().anchor_day,
        "2027-04-30",
        "the month's last day is kept"
    );
    r.period(-2);
    assert_eq!(r.state().anchor_day, "2027-02-28");
    r.pick("2028-02-29", Dest::Year);
    r.period(1);
    assert_eq!(r.state().anchor_day, "2029-02-28");
    // A step of nothing, and a picked day that is not one, change nothing.
    r.period(0);
    assert_eq!(r.state().anchor_day, "2029-02-28");
    r.pick("2029-02-30", Dest::Day);
    assert_eq!(r.state().anchor_day, "2029-02-28");
    assert_eq!(r.state().destination, Dest::Year as i32);
}

#[test]
fn a_long_press_opens_the_add_sheet_at_the_snapped_time_and_writes_nothing() {
    let mut r = rig(Dest::Day);
    r.pick(WED, Dest::Day);
    r.send(H::SlotPressed(wire::agenda_home_event::SlotPressed {
        day: WED.to_owned(),
        minute: 553,
    }));
    let route = r.opened().expect("a route");
    assert_eq!(route.screen, centraid_screens::calendar::EDITOR);
    let Some(wire::route::Args::AgendaEditor(editor)) = route.args else {
        panic!("the editor's arguments");
    };
    assert_eq!(editor.start_time, "09:15");
    assert_eq!(editor.day, WED);
    assert_eq!(editor.kind, wire::AgendaEditorKind::Event as i32);
    assert!(editor.event_id.is_empty());
    // The top and the bottom of the day.
    for (minute, clock) in [(-20, "00:00"), (7, "00:00"), (8, "00:15"), (1439, "23:45")] {
        r.driver.effects.clear();
        r.send(H::SlotPressed(wire::agenda_home_event::SlotPressed {
            day: WED.to_owned(),
            minute,
        }));
        let Some(wire::route::Args::AgendaEditor(editor)) = r.opened().expect("a route").args
        else {
            panic!("the editor's arguments");
        };
        assert_eq!(editor.start_time, clock, "minute {minute}");
    }
    // A day that is not one opens nothing; and nothing was ever written.
    r.driver.effects.clear();
    r.send(H::SlotPressed(wire::agenda_home_event::SlotPressed {
        day: "nope".to_owned(),
        minute: 600,
    }));
    assert!(r.opened().is_none());
    r.settle();
    assert!(
        r.grid().days[0].blocks.is_empty(),
        "unexpected grid after long press: {:?}",
        r.grid().days[0].blocks
    );
    assert!(r.state().status.is_none());
}

#[test]
fn a_move_keeps_the_length_and_undo_puts_it_back() {
    let mut r = rig(Dest::Day);
    r.event(
        "zq-mv",
        "Zq Move",
        "2027-06-09T09:00",
        Some("2027-06-09T10:30"),
    );
    r.pick(WED, Dest::Day);
    r.send(H::EventMoved(wire::agenda_home_event::EventMoved {
        instance_key: "zq-mv".to_owned(),
        day: WED.to_owned(),
        // 14:07 snaps to 14:00.
        minute: 14 * 60 + 7,
    }));
    let block = r.block(WED, "zq-mv");
    assert_eq!((block.start_minute, block.end_minute), (840, 930));
    assert_eq!(
        r.state().status.as_ref().expect("a line").sentence,
        "Event moved"
    );
    assert_eq!(
        r.state().status.as_ref().expect("a line").action_label,
        "Undo"
    );
    let held = r.occurrence("zq-mv", WED);
    assert_eq!(held.local_start, "2027-06-09T14:00");
    assert_eq!(held.local_end, "2027-06-09T15:30");

    // Dropped on another day of the week (Week view), at 08:50 → 08:45.
    r.destination(Dest::Week);
    r.send(H::EventMoved(wire::agenda_home_event::EventMoved {
        instance_key: "zq-mv".to_owned(),
        day: "2027-06-11".to_owned(),
        minute: 8 * 60 + 50,
    }));
    let block = r.block("2027-06-11", "zq-mv");
    assert_eq!((block.start_minute, block.end_minute), (525, 615));

    // Undo writes the times before THIS move back.
    r.send(H::StatusActed(wire::agenda_home_event::StatusActed {}));
    let held = r.occurrence("zq-mv", WED);
    assert_eq!(held.local_start, "2027-06-09T14:00");
    assert_eq!(held.local_end, "2027-06-09T15:30");
    assert_eq!(r.block(WED, "zq-mv").start_minute, 840);
    assert!(r.state().status.is_none());
}

#[test]
fn a_resize_sets_the_end_and_is_never_under_fifteen_minutes() {
    let mut r = rig(Dest::Day);
    r.event(
        "zq-rs",
        "Zq Resize",
        "2027-06-09T09:00",
        Some("2027-06-09T10:00"),
    );
    r.pick(WED, Dest::Day);
    r.send(H::EventResized(wire::agenda_home_event::EventResized {
        instance_key: "zq-rs".to_owned(),
        end_minute: 11 * 60 + 40,
    }));
    let block = r.block(WED, "zq-rs");
    assert_eq!((block.start_minute, block.end_minute), (540, 705));
    assert_eq!(
        r.state().status.as_ref().expect("a line").sentence,
        "Event changed"
    );
    // A foot dragged above the top is fifteen minutes under the start.
    r.send(H::EventResized(wire::agenda_home_event::EventResized {
        instance_key: "zq-rs".to_owned(),
        end_minute: 500,
    }));
    let block = r.block(WED, "zq-rs");
    assert_eq!((block.start_minute, block.end_minute), (540, 555));
    // Undo puts the last end back.
    r.send(H::StatusActed(wire::agenda_home_event::StatusActed {}));
    let held = r.occurrence("zq-rs", WED);
    assert_eq!(held.local_end, "2027-06-09T11:45");
    // A drop where it already is writes nothing: no new line.
    r.send(H::EventResized(wire::agenda_home_event::EventResized {
        instance_key: "zq-rs".to_owned(),
        end_minute: minutes("11:45"),
    }));
    assert!(r.state().status.is_none());
}

#[test]
fn an_occurrence_of_a_series_moves_alone() {
    let mut r = rig(Dest::Day);
    r.write(act::calendar::Propose {
        id: Some("zq-series".to_owned()),
        title: "Zq Series".to_owned(),
        starts: "2027-06-02T09:00".to_owned(),
        ends: Field::Is("2027-06-02T10:00".to_owned()),
        zone: Field::Is("UTC".to_owned()),
        rule: Field::Is("FREQ=WEEKLY".to_owned()),
        busy: Some(false),
        ..Default::default()
    });
    r.pick(WED, Dest::Day);
    let key = r.occurrence("zq-series", WED).instance_key;
    assert!(key.starts_with("zq-series:"), "{key}");
    assert_eq!(r.block(WED, &key).start_minute, 540);
    r.send(H::EventMoved(wire::agenda_home_event::EventMoved {
        instance_key: key.clone(),
        day: WED.to_owned(),
        minute: 16 * 60,
    }));
    let moved = r.occurrence("zq-series", WED);
    assert_eq!(moved.local_start, "2027-06-09T16:00");
    assert_eq!(moved.local_end, "2027-06-09T17:00");
    // The week before still starts at nine: only this occurrence moved.
    let before = r.occurrence("zq-series", "2027-06-02");
    assert_eq!(before.local_start, "2027-06-02T09:00");
    r.send(H::StatusActed(wire::agenda_home_event::StatusActed {}));
    let back = r.occurrence("zq-series", WED);
    assert_eq!(back.local_start, "2027-06-09T09:00");
}

#[test]
fn a_refused_write_says_the_vaults_sentence_and_leaves_the_event() {
    let mut r = rig(Dest::Day);
    r.environment("en-US", "America/New_York");
    // 14 March 2027: the clocks skip 02:00 to 03:00.
    r.event(
        "zq-gap",
        "Zq Gap",
        "2027-03-14T09:00",
        Some("2027-03-14T10:00"),
    );
    r.pick("2027-03-14", Dest::Day);
    r.send(H::EventMoved(wire::agenda_home_event::EventMoved {
        instance_key: "zq-gap".to_owned(),
        day: "2027-03-14".to_owned(),
        minute: 150,
    }));
    let line = r.state().status.as_ref().expect("a line").clone();
    assert!(line.refused);
    assert!(!line.sentence.is_empty() && line.action_label.is_empty());
    let block = r.block("2027-03-14", "zq-gap");
    assert_eq!((block.start_minute, block.end_minute), (540, 600));
    let held = r.occurrence("zq-gap", "2027-03-14");
    assert_eq!(held.local_start, "2027-03-14T09:00");
    // A stray key moves nothing and says nothing new.
    r.send(H::EventMoved(wire::agenda_home_event::EventMoved {
        instance_key: "zq-missing".to_owned(),
        day: "2027-03-14".to_owned(),
        minute: 600,
    }));
    assert!(r.state().status.as_ref().expect("line").refused);
}

#[test]
fn an_event_with_other_guests_cannot_be_dragged_and_a_move_writes_nothing() {
    let mut r = rig(Dest::Week);
    let wire::app_query_response::Answer::AgendaParties(parties) = r
        .driver
        .handle
        .load(&load::calendar::Parties::default().into())
        .expect("parties load")
        .answer
        .and_then(|answer| answer.answer)
        .expect("an answer")
    else {
        panic!("parties");
    };
    let me = parties.me.expect("the owner has a party");
    let other = parties
        .parties
        .iter()
        .find(|party| !party.is_you)
        .expect("another person")
        .party_id
        .clone();
    let zone = r.zone.clone();
    r.write(act::calendar::Propose {
        id: Some("zq-guests".to_owned()),
        title: "Zq Guests".to_owned(),
        starts: "2027-06-09T10:00".to_owned(),
        ends: Field::Is("2027-06-09T11:00".to_owned()),
        busy: Some(false),
        zone: Field::Is(zone.clone()),
        attendees: Some(serde_json::to_string(&[&me, &other]).expect("json")),
        ..Default::default()
    });
    r.write(act::calendar::Propose {
        id: Some("zq-solo".to_owned()),
        title: "Zq Solo".to_owned(),
        starts: "2027-06-09T13:00".to_owned(),
        ends: Field::Is("2027-06-09T14:00".to_owned()),
        busy: Some(false),
        zone: Field::Is(zone),
        attendees: Some(serde_json::to_string(&[&me]).expect("json")),
        ..Default::default()
    });
    r.pick(WED, Dest::Week);
    assert!(!r.block(WED, "zq-guests").movable);
    assert!(r.block(WED, "zq-solo").movable);
    r.send(H::EventMoved(wire::agenda_home_event::EventMoved {
        instance_key: "zq-guests".to_owned(),
        day: WED.to_owned(),
        minute: 600 + 120,
    }));
    assert!(r.state().status.is_none());
    assert_eq!(
        r.occurrence("zq-guests", WED).local_start,
        "2027-06-09T10:00"
    );
}

#[test]
fn a_run_over_midnight_and_an_all_day_event_cannot_be_dragged() {
    let mut r = rig(Dest::Week);
    r.event(
        "zq-night",
        "Zq Night",
        "2027-06-09T22:00",
        Some("2027-06-10T02:00"),
    );
    r.pick(WED, Dest::Week);
    let first = r.block(WED, "zq-night");
    assert_eq!((first.start_minute, first.end_minute), (1320, 1440));
    assert_eq!(first.time_label, "From 22:00");
    assert!(!first.movable);
    let second = r.block("2027-06-10", "zq-night");
    assert_eq!((second.start_minute, second.end_minute), (0, 120));
    assert_eq!(second.time_label, "Until 02:00");
    assert!(!second.movable);
    r.send(H::EventMoved(wire::agenda_home_event::EventMoved {
        instance_key: "zq-night".to_owned(),
        day: WED.to_owned(),
        minute: 600,
    }));
    assert!(r.state().status.is_none());
    assert_eq!(
        r.occurrence("zq-night", WED).local_start,
        "2027-06-09T22:00"
    );
}

#[test]
fn a_search_term_draws_no_grid() {
    let mut r = rig(Dest::Week);
    r.event(
        "zq-s",
        "Zq Searchable",
        "2027-06-09T09:00",
        Some("2027-06-09T10:00"),
    );
    r.pick(WED, Dest::Week);
    assert!(r.data().time_grid.is_some());
    r.send(H::SearchOpened(wire::agenda_home_event::SearchOpened {}));
    r.send(H::SearchTerm(wire::agenda_home_event::SearchTermChanged {
        term: "Searchable".to_owned(),
    }));
    let data = r.data();
    assert!(data.time_grid.is_none() && data.week_strip.is_none());
    assert!(data.month.is_none() && data.year.is_none());
}

// ---- THE CALENDAR'S HEADER (#1173) -----------------------------------------

#[test]
fn day_and_week_carry_the_header_and_nothing_else_keeps_it() {
    let mut r = rig(Dest::Day);
    r.pick(WED, Dest::Day);
    let header = r.header();
    assert!(header.shown);
    assert_eq!(header.month_label, "June");
    assert_eq!(header.month_accessibility, "Month view, June");
    assert_eq!(header.layout, Dest::Day as i32);
    assert_eq!(header.layout_label, "View");
    assert_eq!(header.all_day_label, "all-day");
    assert_eq!(header.today_label, "Today");
    assert!(header.today_shown, "a past day offers Today");
    let strip = r.data().week_strip.as_ref().expect("strip");
    let selected: Vec<&str> = strip
        .days
        .iter()
        .filter(|day| day.is_selected)
        .map(|day| day.day.as_str())
        .collect();
    assert_eq!(selected, [WED]);
    r.destination(Dest::Week);
    assert!(r.header().shown);
    assert_eq!(r.header().layout, Dest::Week as i32);
    for place in [Dest::Month, Dest::Year, Dest::Schedule] {
        r.destination(place);
        assert!(!r.header().shown, "{place:?} keeps its own header");
        assert!(r.header().all_day.is_empty());
    }
    // Reminders wears the same header with its own title, no chip and no layout key.
    let t = rig(Dest::Todo);
    assert!(t.header().shown);
    assert_eq!(t.header().title, "Reminders");
    assert!(t.header().month_label.is_empty() && t.header().layouts.is_empty());
    r.destination(Dest::Month);
    assert!(
        !r.state().calendar_views.is_empty(),
        "Month keeps its view menu"
    );
}

#[test]
fn the_today_key_shows_off_today_and_the_tap_brings_the_day_back() {
    let mut r = rig(Dest::Day);
    r.settle();
    let today = r.data().today.clone();
    assert!(!r.header().today_shown, "on today there is nowhere to go");
    r.pick(&plus(&today, 3), Dest::Day);
    assert!(r.header().today_shown);
    r.today_tapped();
    assert_eq!(r.state().anchor_day, today);
    assert!(!r.header().today_shown);
    r.destination(Dest::Week);
    r.weeks(2);
    assert!(r.header().today_shown);
    r.today_tapped();
    assert!(!r.header().today_shown);
}

#[test]
fn the_all_day_lane_holds_days_chips_once_and_week_keeps_its_columns() {
    let mut r = rig(Dest::Day);
    r.write(act::calendar::Propose {
        id: Some("zq-all".to_owned()),
        title: "Zq Retreat".to_owned(),
        starts: WED.to_owned(),
        timing: Some(act::calendar::ProposeTiming::AllDay),
        ..Default::default()
    });
    r.event(
        "zq-timed",
        "Zq Timed",
        "2027-06-09T09:00",
        Some("2027-06-09T10:00"),
    );
    r.pick(WED, Dest::Day);
    let lane: Vec<&str> = r
        .header()
        .all_day
        .iter()
        .map(|chip| chip.title.as_str())
        .collect();
    assert_eq!(lane, ["Zq Retreat"]);
    assert!(
        r.grid().days[0].all_day.is_empty(),
        "drawn once: the column does not repeat the lane"
    );
    assert_eq!(r.grid().days[0].blocks.len(), 1);
    r.pick(&plus(WED, 1), Dest::Day);
    assert!(r.header().all_day.is_empty());
    r.pick(WED, Dest::Day);
    r.layout(Dest::Week);
    assert!(r.header().all_day.is_empty());
    let column = r
        .grid()
        .days
        .iter()
        .find(|day| day.day == WED)
        .expect("column");
    assert_eq!(column.all_day.len(), 1);
}

#[test]
fn the_chip_goes_back_to_the_month_of_the_anchor() {
    let mut r = rig(Dest::Day);
    r.pick("2027-03-31", Dest::Day);
    r.chip();
    assert_eq!(r.state().destination, Dest::Month as i32);
    assert_eq!(r.state().anchor_day, "2027-03-31");
    assert!(!r.header().shown);
    assert!(r.data().month.is_some());
    r.pick("2027-03-31", Dest::Week);
    r.chip();
    assert_eq!(r.state().destination, Dest::Month as i32);
    // Month has no chip: a stray tap changes nothing.
    r.chip();
    assert_eq!(r.state().destination, Dest::Month as i32);
    r.band("reminders");
    r.band("calendar");
    assert_eq!(r.state().destination, Dest::Month as i32);
}

#[test]
fn a_layout_choice_keeps_the_day_and_only_a_calendar_view_is_one() {
    let mut r = rig(Dest::Day);
    r.pick(WED, Dest::Day);
    r.layout(Dest::Week);
    assert_eq!(r.state().destination, Dest::Week as i32);
    assert_eq!(r.state().anchor_day, WED);
    assert_eq!(r.header().layout, Dest::Week as i32);
    assert_eq!(r.grid().days.len(), 7);
    r.layout(Dest::Day);
    assert_eq!(r.state().destination, Dest::Day as i32);
    assert_eq!(r.grid().days.len(), 1);
    r.layout(Dest::Schedule);
    assert_eq!(r.state().destination, Dest::Schedule as i32);
    assert_eq!(r.state().anchor_day, WED);
    r.layout(Dest::Todo);
    r.layout(Dest::Unspecified);
    assert_eq!(r.state().destination, Dest::Schedule as i32);
}

#[test]
fn a_week_page_moves_whole_weeks_and_keeps_the_weekday() {
    let mut r = rig(Dest::Day);
    r.pick(WED, Dest::Day);
    r.weeks(1);
    assert_eq!(r.state().anchor_day, "2027-06-16");
    let strip = r.data().week_strip.as_ref().expect("strip");
    assert_eq!(strip.days[0].day, "2027-06-14");
    r.weeks(-2);
    assert_eq!(r.state().anchor_day, "2027-06-02");
    r.layout(Dest::Week);
    r.weeks(1);
    assert_eq!(r.state().anchor_day, "2027-06-09");
    assert_eq!(r.grid().days[0].day, "2027-06-07");
    r.weeks(0);
    assert_eq!(r.state().anchor_day, "2027-06-09");
}

#[test]
fn a_strip_day_is_chosen_in_the_layout_it_was_picked_in() {
    let mut r = rig(Dest::Day);
    r.pick(WED, Dest::Day);
    let strip = r.data().week_strip.as_ref().expect("strip").clone();
    assert!(strip.days.iter().all(|day| day.opens == Dest::Day as i32));
    r.layout(Dest::Week);
    let strip = r.data().week_strip.as_ref().expect("strip").clone();
    assert!(strip.days.iter().all(|day| day.opens == Dest::Week as i32));
    let friday = strip.days[4].clone();
    r.pick(&friday.day, Dest::try_from(friday.opens).expect("a place"));
    assert_eq!(r.state().destination, Dest::Week as i32);
    assert_eq!(r.state().anchor_day, "2027-06-11");
    let strip = r.data().week_strip.as_ref().expect("strip");
    assert!(strip.days[4].is_selected);
}

#[test]
fn a_search_term_puts_the_header_away() {
    let mut r = rig(Dest::Day);
    r.pick(WED, Dest::Day);
    assert!(r.header().shown);
    r.send(H::SearchOpened(wire::agenda_home_event::SearchOpened {}));
    assert!(
        r.header().shown,
        "an open field with no term is still the grid"
    );
    r.send(H::SearchTerm(wire::agenda_home_event::SearchTermChanged {
        term: "zq".to_owned(),
    }));
    assert!(!r.header().shown);
}
